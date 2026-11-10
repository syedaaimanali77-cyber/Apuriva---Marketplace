import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
import { adminWithRole, isDatabaseReachable, roleHoldsPermission } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import { AUDIT_RESOURCE_READ_PERMISSION, isResourceInScope, resolveAuditScope } from '@/lib/audit/scope';
import { FEATURE_FLAG_REGISTRY } from '@/lib/feature-flags/registry';
import type { AdminRole } from '@/lib/types/admin-rbac';
import type { FeatureFlagDto } from '@/lib/types/feature-flags';
import { useFlagEnvironment } from '@/lib/feature-flags/feature-flags-test-support';
import { GET as LIST } from './route';
import { PATCH } from './[key]/route';

/**
 * Spec 041 §3.5 / AC-2 — every role × list × toggle × business/developer flag. The toggle probe uses a
 * stale `expectedVersion`: an authorized caller gets `409 CONFLICT` (authorization passed, nothing
 * changed), an unauthorized one `403` — so no stored value is ever touched by this file.
 */
const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/admin/feature-flags';
const ROLES: AdminRole[] = ['super_admin', 'operations_admin', 'support_admin', 'finance_admin', 'trust_safety_admin', 'content_admin', 'analytics_admin'];
const BUSINESS_TOGGLERS: AdminRole[] = ['content_admin', 'operations_admin', 'super_admin'];
const BUSINESS_KEYS = FEATURE_FLAG_REGISTRY.filter((f) => f.controlledBy === 'business').map((f) => f.key);
const DEVELOPER_KEYS = FEATURE_FLAG_REGISTRY.filter((f) => f.controlledBy === 'developer').map((f) => f.key);

function get(session: TestSession): Request {
  return authenticatedRequest(BASE, session.sessionId, session.csrfToken, { method: 'GET' });
}

function probe(session: TestSession, key: string): Request {
  return authenticatedRequest(`${BASE}/${key}`, session.sessionId, session.csrfToken, {
    method: 'PATCH',
    body: { environment: 'staging', enabled: true, expectedVersion: 999_999, reason: 'access probe' },
  });
}

describe.skipIf(!dbReachable)('feature-flag access (spec 041 §3.5, AC-2)', { timeout: 240_000 }, () => {
  useFlagEnvironment('staging');
  const admins = new Map<AdminRole, TestSession>();

  beforeAll(async () => {
    for (const role of ROLES) admins.set(role, await adminWithRole(role));
  }, 120_000);

  beforeEach(() => resetRateLimitState());

  it('the live permission table holds exactly the §3.5 grants', async () => {
    for (const role of ROLES) {
      expect(await roleHoldsPermission(role, 'feature_flags', 'read'), `${role} read`).toBe(BUSINESS_TOGGLERS.includes(role));
      expect(await roleHoldsPermission(role, 'feature_flags', 'toggle'), `${role} toggle`).toBe(BUSINESS_TOGGLERS.includes(role));
      expect(await roleHoldsPermission(role, 'feature_flags', 'read_technical'), `${role} read_technical`).toBe(role === 'super_admin');
      expect(await roleHoldsPermission(role, 'feature_flags', 'toggle_technical'), `${role} toggle_technical`).toBe(role === 'super_admin');
    }
  });

  for (const role of ROLES) {
    it(`${role}: sees and toggles exactly what §3.5 grants`, async () => {
      const admin = admins.get(role)!;
      const list = await LIST(get(admin));
      if (!BUSINESS_TOGGLERS.includes(role)) {
        expect(list.status).toBe(403);
        for (const key of [...BUSINESS_KEYS, ...DEVELOPER_KEYS]) expect((await PATCH(probe(admin, key))).status, `${role} ${key}`).toBe(403);
        return;
      }
      expect(list.status).toBe(200);
      const keys = ((await list.json()) as { data: FeatureFlagDto[] }).data.map((f) => f.key);
      const technical = role === 'super_admin';
      expect(keys).toEqual(FEATURE_FLAG_REGISTRY.filter((f) => technical || f.controlledBy === 'business').map((f) => f.key));
      for (const key of BUSINESS_KEYS) expect((await PATCH(probe(admin, key))).status, `${role} ${key}`).toBe(409);
      for (const key of DEVELOPER_KEYS) {
        const res = await PATCH(probe(admin, key));
        expect(res.status, `${role} ${key}`).toBe(technical ? 409 : 403);
        if (!technical) expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
      }
    });
  }

  it('a signed-in non-admin is 403 and no session is 401', async () => {
    const user = await registerAndLogin();
    expect((await LIST(get(user))).status).toBe(403);
    expect((await PATCH(probe(user, 'onboarding-intro-v1'))).status).toBe(403);
    expect((await LIST(new Request(BASE))).status).toBe(401);
    expect((await PATCH(new Request(`${BASE}/onboarding-intro-v1`, { method: 'PATCH', body: '{}' }))).status).toBe(401);
  });

  it('audit visibility (X-7): business-flag entries to flag readers, technical entries to Super Admin only', async () => {
    expect(AUDIT_RESOURCE_READ_PERMISSION.feature_flags).toEqual({ resource: 'feature_flags', action: 'read' });
    expect(AUDIT_RESOURCE_READ_PERMISSION['feature_flags.technical']).toEqual({ resource: 'feature_flags', action: 'read_technical' });
    for (const role of ROLES) {
      if (!(await roleHoldsPermission(role, 'audit_logs', 'read'))) continue;
      const scope = await resolveAuditScope(admins.get(role)!.userId);
      expect(isResourceInScope(scope, 'feature_flags'), `${role} business`).toBe(BUSINESS_TOGGLERS.includes(role));
      expect(isResourceInScope(scope, 'feature_flags.technical'), `${role} technical`).toBe(role === 'super_admin');
    }
  });
});
