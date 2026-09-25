import { afterAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { authenticatedRequest, isDatabaseReachable } from '@/app/api/v1/auth/test-support';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { adminWithRole, roleHoldsPermission } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import { GET as GET_OVERVIEW } from './overview/route';
import { GET as GET_QUEUE } from './operations/queue/route';
import { GET as GET_CONFIG } from './marketplace/config/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/admin';

const ROUTES = [
  { name: 'overview', handler: GET_OVERVIEW, url: `${BASE}/overview` },
  { name: 'queue', handler: GET_QUEUE, url: `${BASE}/operations/queue?limit=5` },
  { name: 'config', handler: GET_CONFIG, url: `${BASE}/marketplace/config` },
] as const;

const ALL_ROLES: AdminRole[] = [
  'super_admin',
  'operations_admin',
  'support_admin',
  'finance_admin',
  'trust_safety_admin',
  'content_admin',
  'analytics_admin',
];

function get(url: string, session: { sessionId: string; csrfToken: string }): Request {
  return authenticatedRequest(url, session.sessionId, session.csrfToken, { method: 'GET' });
}

describe.skipIf(!dbReachable)('spec 037 dashboard routes (AC-3, AC-4, AC-6, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('a non-admin gets 403 and no session gets 401 on every endpoint', async () => {
    const user = await registerAndLogin();
    for (const route of ROUTES) {
      const anonymous = await route.handler(new Request(route.url));
      expect(anonymous.status, route.name).toBe(401);
      expect((await anonymous.json()).code).toBe('UNAUTHENTICATED');

      const forbidden = await route.handler(get(route.url, user));
      expect(forbidden.status, route.name).toBe(403);
      const body = await forbidden.json();
      expect(body.code).toBe('FORBIDDEN');
      expect(body.data).toBeUndefined();
    }
  });

  it('every admin role reaches the Overview and the queue; only operations/super admin reach the configuration', async () => {
    // Seven registrations, one after another: given the budget a seven-role sweep needs.
    for (const role of ALL_ROLES) {
      const admin = await adminWithRole(role);
      expect((await GET_OVERVIEW(get(`${BASE}/overview`, admin))).status, role).toBe(200);
      expect((await GET_QUEUE(get(`${BASE}/operations/queue`, admin))).status, role).toBe(200);
      const config = await GET_CONFIG(get(`${BASE}/marketplace/config`, admin));
      // 200 exactly when the role holds a configuration read permission right now (the migrations
      // grant it to operations_admin and super_admin only; other tests may add grants).
      const mayRead =
        (await roleHoldsPermission(role, 'matching.config', 'read')) || (await roleHoldsPermission(role, 'cancellation_policy', 'read'));
      if (role === 'operations_admin' || role === 'super_admin') expect(mayRead, role).toBe(true);
      expect(config.status, role).toBe(mayRead ? 200 : 403);
    }
  }, 60_000);

  it('content admin is refused the configuration', async () => {
    const content = await adminWithRole('content_admin');
    const res = await GET_CONFIG(get(`${BASE}/marketplace/config`, content));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN');
  });

  it('DTOs are the closed allow-list (AC-4): exact keys, and no environment value anywhere', async () => {
    const admin = await adminWithRole('super_admin');

    const overview = (await (await GET_OVERVIEW(get(`${BASE}/overview`, admin))).json()).data;
    expect(Object.keys(overview).sort()).toEqual(['activeBookings', 'activeRequests', 'alerts', 'generatedAt', 'revenueToday']);
    for (const alert of overview.alerts) expect(Object.keys(alert).sort()).toEqual(['count', 'linkTo', 'message', 'rule', 'severity']);
    for (const money of overview.revenueToday) expect(Object.keys(money).sort()).toEqual(['amountMinorUnits', 'currencyCode']);

    const queue = await (await GET_QUEUE(get(`${BASE}/operations/queue?limit=3`, admin))).json();
    expect(Object.keys(queue.page).sort()).toEqual(['limit', 'nextOffset', 'offset', 'total']);
    expect(queue.page.limit).toBe(3);
    for (const item of queue.data) expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'linkTo', 'priority', 'status', 'type']);

    const config = (await (await GET_CONFIG(get(`${BASE}/marketplace/config`, admin))).json()).data;
    expect(Object.keys(config).sort()).toEqual(['cancellation', 'generatedAt', 'matching']);
    expect(Object.keys(config.matching).sort()).toEqual(['linkTo', 'platformDefaultWeights', 'serviceOverrideCount']);
    expect(Object.keys(config.cancellation).sort()).toEqual(['activePlatformPolicy', 'linkTo']);

    const everything = JSON.stringify([overview, queue, config]);
    for (const secret of [process.env.AUTH_SECRET, process.env.DATABASE_URL, process.env.CRON_SECRET]) {
      if (secret) expect(everything).not.toContain(secret);
    }
  });

  it('the configuration endpoint accepts no write: there is no PATCH, POST, PUT or DELETE handler', async () => {
    const configRoute = await import('./marketplace/config/route');
    expect(Object.keys(configRoute).sort()).toEqual(['GET']);
  });
});
