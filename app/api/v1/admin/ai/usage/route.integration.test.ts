import { beforeEach, describe, expect, it } from 'vitest';
import { GET as USAGE } from './route';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import {
  authenticatedRequest,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  type TestAdmin,
} from '@/app/api/v1/admin/admin-rbac-test-support';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { createAiUser, seedUsage, uniqueGuest } from '@/lib/ai/ai-test-support';
import type { AiSubject } from '@/lib/ai';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/admin/ai/usage';

/**
 * Spec 033 AC-6 / §3.2 — `GET /api/v1/admin/ai/usage`. The `ai/read_usage` permission rows come
 * from `0025_add_ai_usage_tracking.sql`, already applied to this test database, so nothing here
 * seeds them: this asserts against the REAL seed, which is what AC-6 is about.
 */
describe.skipIf(!dbReachable)('GET /api/v1/admin/ai/usage (spec 033 AC-6, integration)', () => {
  beforeEach(() => resetRateLimitState());

  const get = (admin: TestAdmin, query = '') =>
    authenticatedRequest(`${BASE}${query}`, admin.sessionId, admin.csrfToken, { method: 'GET' });

  async function adminWith(role: AdminRole): Promise<TestAdmin> {
    const admin = await registerAdmin();
    await grantRole(admin, role);
    return admin;
  }

  it('requires a session', async () => {
    const res = await USAGE(new Request(BASE));
    expect(res.status).toBe(401);
  });

  it('Analytics, Finance and Super Admin may read', async () => {
    for (const role of ['analytics_admin', 'finance_admin', 'super_admin'] as const) {
      const admin = await adminWith(role);
      const res = await USAGE(get(admin));
      expect(res.status, `${role} should be allowed`).toBe(200);
    }
  });

  it('every other admin role is forbidden, and an admin with no role at all is too', async () => {
    for (const role of ['operations_admin', 'support_admin', 'trust_safety_admin', 'content_admin'] as const) {
      const admin = await adminWith(role);
      const res = await USAGE(get(admin));
      expect(res.status, `${role} should be forbidden`).toBe(403);
      expect((await res.json()).code).toBe('FORBIDDEN');
    }
    const roleless = await registerAdmin();
    expect((await USAGE(get(roleless))).status).toBe(403);
  });

  it('returns the aggregate envelope with a correlation id', async () => {
    const admin = await adminWith('analytics_admin');
    const res = await USAGE(get(admin));
    const body = await res.json();
    expect(body.correlationId).toBeTruthy();
    expect(body.data).toMatchObject({
      from: expect.any(String),
      to: expect.any(String),
      totalRequests: expect.any(Number),
      totalTokens: expect.any(Number),
      estimatedCostMinorUnits: expect.any(Number),
      currencyCode: 'PKR',
      costAlertThresholds: { dailyMinorUnits: 500_000, monthlyMinorUnits: 10_000_000, dailyTokens: 500_000 },
    });
  });

  it('the payload carries no user identifier, guest hash, fingerprint, prompt or response', async () => {
    const user: AiSubject = { kind: 'user', userId: await createAiUser() };
    const guest = uniqueGuest();
    await seedUsage(user, { tokensUsed: 11, inputFingerprint: 'd'.repeat(64) });
    await seedUsage(guest, { tokensUsed: 13, inputFingerprint: 'c'.repeat(64) });

    const admin = await adminWith('finance_admin');
    const serialised = JSON.stringify((await (await USAGE(get(admin))).json()).data);

    expect(serialised).not.toContain(user.kind === 'user' ? user.userId : 'unreachable');
    expect(serialised).not.toContain(guest.kind === 'guest' ? guest.ipHash : 'unreachable');
    expect(serialised).not.toContain('d'.repeat(64));
    expect(serialised).not.toMatch(/userId|subjectHash|inputFingerprint|prompt|response/i);
  });

  it('reports the provider breakdown to an admin — the one place a provider name is ever shown', async () => {
    await seedUsage({ kind: 'system', label: `route-${Date.now()}` }, { tokensUsed: 5, providerName: 'sandbox' });
    const admin = await adminWith('super_admin');
    const { data } = await (await USAGE(get(admin))).json();
    expect(Object.keys(data.byProvider).length).toBeGreaterThan(0);
  });

  it('validates the range: malformed dates, inverted bounds and spans over 366 days', async () => {
    const admin = await adminWith('analytics_admin');
    for (const query of [
      '?from=yesterday',
      '?to=31-12-2026',
      '?from=2026-06-01&to=2026-01-01',
      '?from=2020-01-01&to=2026-01-01',
    ]) {
      const res = await USAGE(get(admin, query));
      expect(res.status, `${query} should be rejected`).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_ERROR');
    }
  });

  it('honours an explicit valid range', async () => {
    const admin = await adminWith('analytics_admin');
    const res = await USAGE(get(admin, '?from=2026-01-01&to=2026-02-01'));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.from).toBe('2026-01-01T00:00:00.000Z');
    expect(data.to).toBe('2026-02-01T00:00:00.000Z');
  });

  it('is registered in the OpenAPI route registry (spec 004 AC-7)', () => {
    expect(OPENAPI_ROUTES).toContainEqual(
      expect.objectContaining({ method: 'GET', path: '/admin/ai/usage', tags: ['ai'] }),
    );
  });
});
