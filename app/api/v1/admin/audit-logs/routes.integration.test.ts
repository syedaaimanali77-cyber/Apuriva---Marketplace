import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { runWithRequestContext } from '@/lib/audit/request-context';
import { auditRowsByEventType, uniqueTag } from '@/lib/audit/audit-test-support';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { adminWithRole, isDatabaseReachable } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import type { TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import type { AuditLogDto } from '@/lib/types/audit';
import { GET as LIST } from './route';
import { GET as DETAIL } from './[id]/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/admin/audit-logs';

function get(admin: TestAdmin, url: string, headers: Record<string, string> = {}): Request {
  const base = authenticatedRequest(url, admin.sessionId, admin.csrfToken, { method: 'GET' });
  const merged = new Headers(base.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Request(base, { headers: merged });
}

describe('audit-log routes are registered in OpenAPI (spec 039 §3.8)', () => {
  it('lists L1 and L2, and no write method', () => {
    const audit = OPENAPI_ROUTES.filter((r) => r.path.startsWith('/admin/audit-logs'));
    expect(audit.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /admin/audit-logs', 'GET /admin/audit-logs/{id}']);
  });
});

/** Spec 039 §3.8 — envelopes, pagination, filters, validation, ordering and rate limiting. */
describe.skipIf(!dbReachable)('audit-log routes (spec 039 §3.8)', { timeout: 120_000 }, () => {
  const tag = uniqueTag('spec039routes');
  let admin: TestAdmin;
  let actor: TestAdmin;

  beforeAll(async () => {
    resetRateLimitState();
    admin = await adminWithRole('super_admin');
    actor = await adminWithRole('support_admin');
    for (const [i, correlationId] of ['route-c1', 'route-c2', 'route-c3'].entries()) {
      await runWithRequestContext({ correlationId }, () =>
        recordAdminAuditEvent({
          actorUserId: actor.userId,
          actorRoles: ['support_admin'],
          eventType: `${tag}.step${i}`,
          resource: 'support',
          action: 'respond',
          targetType: tag,
          targetId: `ticket-${i}`,
          reason: `reason ${i}`,
          approvalChain: [],
          before: i === 0 ? undefined : { step: i - 1 },
          after: { step: i },
        }),
      );
    }
  });

  beforeEach(() => resetRateLimitState());

  it('L1 returns the paged envelope, newest first, with limit/offset/total/nextOffset', async () => {
    const first = await LIST(get(admin, `${BASE}?targetType=${tag}&limit=2`, { 'x-correlation-id': 'list-corr' }));
    expect(first.status).toBe(200);
    expect(first.headers.get('x-correlation-id')).toBe('list-corr');
    const page1 = (await first.json()) as { data: AuditLogDto[]; page: Record<string, number | null>; correlationId: string };
    expect(page1.correlationId).toBe('list-corr');
    expect(page1.page).toEqual({ limit: 2, offset: 0, total: 3, nextOffset: 2 });
    expect(page1.data.map((r) => r.targetId)).toEqual(['ticket-2', 'ticket-1']);

    const second = (await (await LIST(get(admin, `${BASE}?targetType=${tag}&limit=2&offset=2`))).json()) as {
      data: AuditLogDto[];
      page: Record<string, number | null>;
    };
    expect(second.page).toEqual({ limit: 2, offset: 2, total: 3, nextOffset: null });
    expect(second.data.map((r) => r.targetId)).toEqual(['ticket-0']);
  });

  it('the DTO carries every §3.9 field', async () => {
    const [row] = await auditRowsByEventType(`${tag}.step1`);
    const res = await DETAIL(get(admin, `${BASE}/${row!.id}`));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: AuditLogDto };
    expect(data).toEqual({
      id: row!.id,
      actorType: 'admin',
      actorUserId: actor.userId,
      actorRoles: ['support_admin'],
      eventType: `${tag}.step1`,
      resource: 'support',
      action: 'respond',
      targetType: tag,
      targetId: 'ticket-1',
      beforeValue: { step: 0 },
      afterValue: { step: 1 },
      reason: 'reason 1',
      approvalRef: null,
      approvalChain: [],
      isEmergencyBypass: false,
      correlationId: 'route-c2',
      createdAt: row!.createdAt.toISOString(),
    });
  });

  it('every filter narrows the result', async () => {
    const one = async (query: string) =>
      ((await (await LIST(get(admin, `${BASE}?targetType=${tag}&${query}`))).json()) as { data: AuditLogDto[] }).data.map((r) => r.targetId);
    expect(await one(`eventType=${tag}.step0`)).toEqual(['ticket-0']);
    expect(await one('targetId=ticket-1')).toEqual(['ticket-1']);
    expect(await one('correlationId=route-c3')).toEqual(['ticket-2']);
    expect(await one(`actorUserId=${actor.userId}`)).toEqual(['ticket-2', 'ticket-1', 'ticket-0']);
    expect(await one(`actorUserId=${admin.userId}`)).toEqual([]);
    expect(await one('resource=support')).toHaveLength(3);
    expect(await one('from=2000-01-01T00:00:00Z&to=2999-01-01T00:00:00Z')).toHaveLength(3);
    expect(await one('to=2000-01-01T00:00:00Z')).toEqual([]);
    expect(await one(`from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toEqual([]);
  });

  it('malformed filters are 400 VALIDATION_ERROR naming each field', async () => {
    const res = await LIST(get(admin, `${BASE}?actorUserId=nope&correlationId=${encodeURIComponent('bad id!')}&from=yesterday&resource=%20%20`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; errors: { field: string }[] };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors.map((e) => e.field).sort()).toEqual(['actorUserId', 'correlationId', 'from', 'resource']);

    const range = await LIST(get(admin, `${BASE}?from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z`));
    expect(range.status).toBe(400);
    const badTo = await LIST(get(admin, `${BASE}?to=2030-13-45`));
    expect(badTo.status).toBe(400);
  });

  it('both routes are rate-limited by the default bucket (429)', async () => {
    for (let i = 0; i < 100; i += 1) checkRateLimit('default', admin.userId);
    const list = await LIST(get(admin, BASE));
    expect(list.status).toBe(429);
    const [row] = await auditRowsByEventType(`${tag}.step0`);
    expect((await DETAIL(get(admin, `${BASE}/${row!.id}`))).status).toBe(429);
  });
});
