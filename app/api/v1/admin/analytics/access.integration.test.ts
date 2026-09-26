import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
import { adminWithRole, isDatabaseReachable, roleHoldsPermission } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import { ANALYTICS_RESOURCE } from '@/lib/analytics/access';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { GET as FUNNEL } from './funnel/route';
import { GET as REVENUE } from './revenue/route';
import { GET as SUPPLY_DEMAND } from './supply-demand/route';
import { GET as PROVIDER_PERFORMANCE } from './provider-performance/route';
import { GET as MATCHING_FAIRNESS } from './matching-fairness/route';
import { GET as RETENTION } from './retention/route';
import { GET as SERVICE_TRENDS } from './service-trends/route';

/**
 * Spec 040 §3.7 / AC-3 — every role × route. Authorization is decided server-side by spec 009's
 * `resolvePermission` against the permissions 0035 seeded; nothing here seeds a grant.
 */
const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/admin/analytics';
const ROLES: AdminRole[] = ['super_admin', 'operations_admin', 'support_admin', 'finance_admin', 'trust_safety_admin', 'content_admin', 'analytics_admin'];

const ROUTES = [
  { name: 'funnel', handler: FUNNEL, action: 'read' },
  { name: 'revenue', handler: REVENUE, action: 'read_revenue' },
  { name: 'supply-demand', handler: SUPPLY_DEMAND, action: 'read' },
  { name: 'provider-performance', handler: PROVIDER_PERFORMANCE, action: 'read_provider_performance' },
  { name: 'matching-fairness', handler: MATCHING_FAIRNESS, action: 'read_provider_performance' },
  { name: 'retention', handler: RETENTION, action: 'read' },
  { name: 'service-trends', handler: SERVICE_TRENDS, action: 'read' },
] as const;

/** The pristine §3.7 matrix 0035 seeds. */
const SEEDED: Record<string, AdminRole[]> = {
  read: ['analytics_admin', 'super_admin'],
  read_revenue: ['analytics_admin', 'finance_admin', 'super_admin'],
  read_provider_performance: ['analytics_admin', 'operations_admin', 'super_admin'],
};

function get(session: TestSession, url: string): Request {
  return authenticatedRequest(url, session.sessionId, session.csrfToken, { method: 'GET' });
}

describe.skipIf(!dbReachable)('analytics report access (spec 040 §3.7, AC-3)', { timeout: 240_000 }, () => {
  const admins = new Map<AdminRole, TestSession>();

  beforeAll(async () => {
    for (const role of ROLES) admins.set(role, await adminWithRole(role));
  });

  beforeEach(() => resetRateLimitState());

  it('the live permission table holds the seeded §3.7 matrix', async () => {
    for (const [action, holders] of Object.entries(SEEDED)) {
      for (const role of ROLES) {
        expect(await roleHoldsPermission(role, ANALYTICS_RESOURCE, action), `${role} ${action}`).toBe(holders.includes(role));
      }
    }
  });

  for (const role of ROLES) {
    it(`${role}: 200 exactly on the routes §3.7 grants it, 403 elsewhere`, async () => {
      const admin = admins.get(role)!;
      for (const route of ROUTES) {
        const res = await route.handler(get(admin, `${BASE}/${route.name}`));
        const allowed = SEEDED[route.action]!.includes(role);
        expect(res.status, `${role} → ${route.name}`).toBe(allowed ? 200 : 403);
        if (!allowed) expect(((await res.json()) as { code: string }).code).toBe('FORBIDDEN');
      }
    });
  }

  it('Support, Content and Trust & Safety admins get no analytics report at all', () => {
    for (const role of ['support_admin', 'content_admin', 'trust_safety_admin'] as AdminRole[]) {
      for (const holders of Object.values(SEEDED)) expect(holders).not.toContain(role);
    }
  });

  it('a signed-in non-admin is 403 and no session is 401 on every route', async () => {
    const user = await registerAndLogin();
    for (const route of ROUTES) {
      expect((await route.handler(get(user, `${BASE}/${route.name}`))).status, route.name).toBe(403);
      const anonymous = await route.handler(new Request(`${BASE}/${route.name}`));
      expect(anonymous.status, route.name).toBe(401);
      expect(((await anonymous.json()) as { code: string }).code).toBe('UNAUTHENTICATED');
    }
  });

  it('authorization is decided before validation: a forbidden caller never learns about the range', async () => {
    const support = admins.get('support_admin')!;
    const res = await FUNNEL(get(support, `${BASE}/funnel?from=not-a-date`));
    expect(res.status).toBe(403);
  });
});
