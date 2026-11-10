import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { AUDIT_RESOURCE_READ_PERMISSION } from '@/lib/audit/scope';
import { auditRowsByEventType, uniqueTag } from '@/lib/audit/audit-test-support';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { adminWithRole, isDatabaseReachable, roleHoldsPermission } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import type { TestSession } from '@/app/api/v1/users/me/privacy-test-support';
import type { AdminRole } from '@/lib/types/admin-rbac';
import type { AuditLogDto } from '@/lib/types/audit';
import { GET as LIST } from './route';
import { GET as DETAIL } from './[id]/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/admin/audit-logs';
const ROLES: AdminRole[] = ['super_admin', 'operations_admin', 'support_admin', 'finance_admin', 'trust_safety_admin', 'content_admin', 'analytics_admin'];
const MAPPED = Object.keys(AUDIT_RESOURCE_READ_PERMISSION);
const SUPER_ONLY = ['admin_rbac.role', 'mcp', 'spec039.unmapped'];
const ALL = [...MAPPED, ...SUPER_ONLY].sort();

function get(session: TestSession, url: string): Request {
  return authenticatedRequest(url, session.sessionId, session.csrfToken, { method: 'GET' });
}

/**
 * The resources `role` should see, derived from the LIVE permissions table — other suites add
 * grants to the shared test database, so a pristine-seed assumption would be wrong (spec 037 idiom).
 */
async function expectedScope(role: AdminRole): Promise<string[]> {
  if (role === 'super_admin') return ALL;
  if (!(await roleHoldsPermission(role, 'audit_logs', 'read'))) return [];
  const visible: string[] = [];
  for (const [entry, required] of Object.entries(AUDIT_RESOURCE_READ_PERMISSION)) {
    if (await roleHoldsPermission(role, required.resource, required.action)) visible.push(entry);
  }
  return visible.sort();
}

/**
 * Spec 039 AC-4 / §3.7 — `audit_logs/read` opens the log for all seven roles (D-2), but each sees
 * only its own domain; super_admin sees everything; role-change, MCP and unmapped entries are
 * super_admin only; nothing is widened by query parameters.
 */
describe.skipIf(!dbReachable)('audit log read scope (spec 039 AC-4)', { timeout: 240_000 }, () => {
  const tag = uniqueTag('spec039access');
  const idByResource = new Map<string, string>();

  beforeAll(async () => {
    resetRateLimitState();
    const actor = await adminWithRole('super_admin');
    for (const resource of ALL) {
      await recordAdminAuditEvent({
        actorUserId: actor.userId,
        actorRoles: ['super_admin'],
        eventType: `${tag}.entry`,
        resource,
        action: 'fixture',
        targetType: tag,
        targetId: resource,
        approvalChain: [],
      });
    }
    for (const row of await auditRowsByEventType(`${tag}.entry`)) idByResource.set(row.resource, row.id);
    expect(idByResource.size).toBe(ALL.length);
  });

  beforeEach(() => resetRateLimitState());

  for (const role of ROLES) {
    it(`${role}: sees exactly its domain scope, and nothing outside it`, async () => {
      const admin = await adminWithRole(role);
      const res = await LIST(get(admin, `${BASE}?targetType=${tag}&limit=100`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: AuditLogDto[]; page: { total: number } };
      const seen = body.data.map((row) => row.resource).sort();
      const expected = await expectedScope(role);
      expect(seen).toEqual(expected);
      expect(body.page.total).toBe(expected.length);

      // Detail: in-scope ids are readable; out-of-scope ids are the same 404 as an unknown id.
      for (const resource of ALL) {
        const detail = await DETAIL(get(admin, `${BASE}/${idByResource.get(resource)}`));
        expect(detail.status, `${role} → ${resource}`).toBe(expected.includes(resource) ? 200 : 404);
      }

      // A resource filter can never widen the scope: outside it is 403, inside it is 200.
      const outside = SUPER_ONLY[0]!;
      const filtered = await LIST(get(admin, `${BASE}?targetType=${tag}&resource=${encodeURIComponent(outside)}`));
      expect(filtered.status).toBe(role === 'super_admin' ? 200 : 403);
      if (expected.length > 0) {
        const inside = await LIST(get(admin, `${BASE}?targetType=${tag}&resource=${encodeURIComponent(expected[0]!)}`));
        expect(inside.status).toBe(200);
        expect(((await inside.json()) as { data: AuditLogDto[] }).data.map((r) => r.resource)).toEqual([expected[0]]);
      }
    });
  }

  it('the role-scope matrix of §3.7 holds against the seeded permissions', async () => {
    // The pristine seeds give at least these grants; the live table may only add to them.
    expect(await expectedScope('finance_admin')).toEqual(expect.arrayContaining(['payouts', 'refunds']));
    expect(await expectedScope('finance_admin')).not.toContain('moderation'); // freeze_payout is not moderation/read
    expect(await expectedScope('trust_safety_admin')).toEqual(
      expect.arrayContaining(['disputes', 'fraud_signal', 'messaging', 'moderation', 'no_show_reports', 'reviews', 'safety_reports']),
    );
    expect(await expectedScope('operations_admin')).toEqual(expect.arrayContaining(['cancellation_policy', 'disputes', 'matching.config', 'moderation', 'support']));
    expect(await expectedScope('support_admin')).toEqual(expect.arrayContaining(['messaging', 'support']));
    expect(await expectedScope('content_admin')).toEqual(expect.arrayContaining(MAPPED.filter((r) => r.startsWith('catalog.'))));
    for (const role of ROLES.filter((r) => r !== 'super_admin')) {
      for (const superOnly of SUPER_ONLY) expect(await expectedScope(role)).not.toContain(superOnly);
    }
  });

  it('a signed-in non-admin is refused 403 on both routes; an unknown id is 404; no session is 401', async () => {
    const user = await registerAndLogin();
    expect((await LIST(get(user, BASE))).status).toBe(403);
    expect((await DETAIL(get(user, `${BASE}/${idByResource.get('support')}`))).status).toBe(403);

    const admin = await adminWithRole('super_admin');
    expect((await DETAIL(get(admin, `${BASE}/00000000-0000-4000-8000-000000000000`))).status).toBe(404);
    expect((await DETAIL(get(admin, `${BASE}/not-a-uuid`))).status).toBe(404);

    expect((await LIST(new Request(BASE))).status).toBe(401);
  });
});
