import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { GET as adminPayouts } from '@/app/api/v1/admin/payouts/route';
import { GET as adminPayoutDetail } from '@/app/api/v1/admin/payouts/[id]/route';
import { POST as adminRetry } from '@/app/api/v1/admin/payouts/[id]/retry/route';
import { GET as adminAdjustmentsList, POST as adminAdjustments } from '@/app/api/v1/admin/earnings-adjustments/route';
import { GET as providerEarnings } from '@/app/api/v1/providers/me/earnings/route';
import { GET as providerPayoutDetail } from '@/app/api/v1/providers/me/payouts/[id]/route';
import { GET as providerMethods } from '@/app/api/v1/providers/me/payout-methods/route';
import { decideAction } from '@/lib/admin-rbac/actions';
import { initiateEarningsAdjustment } from './admin';
import { financeAdmin, isDatabaseReachable, payBooking, resetPayoutIntegration, seedSettledBooking, sessionGet, usePayoutIntegration } from './payouts-test-support';
import type { AdminRole } from '@/lib/types/admin-rbac';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 150_000;
const API = 'http://localhost/api/v1';

afterAll(async () => {
  await getPool().end();
});

const get = (url: string, session: { sessionId: string; csrfToken: string; userId: string }) => sessionGet(url, session);
function post(url: string, session: { sessionId: string; csrfToken: string }, body: unknown): Request {
  const base = authenticatedRequest(url, session.sessionId, session.csrfToken, { body });
  const headers = new Headers(base.headers);
  headers.set('Idempotency-Key', crypto.randomUUID());
  return new Request(base, { headers });
}

/** Spec 024 §3.14 — the RBAC matrix, row by row (AC-13). */
describe.skipIf(!dbReachable)('payout RBAC matrix (spec 024 §3.14)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
    resetRateLimitState();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('a provider reads their own resources; a customer-mode session is 403; a guest is 401', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    expect((await providerEarnings(get(`${API}/providers/me/earnings`, settled.scenario.provider))).status).toBe(200);
    expect((await providerMethods(get(`${API}/providers/me/payout-methods`, settled.scenario.provider))).status).toBe(200);
    expect((await providerEarnings(get(`${API}/providers/me/earnings`, settled.scenario.customer))).status).toBe(403);
    expect((await providerEarnings(new Request(`${API}/providers/me/earnings`))).status).toBe(401);
  });

  it("another provider's payout id is 404, not 403", async () => {
    const mine = await seedSettledBooking();
    const payoutId = await payBooking(mine);
    const other = await seedSettledBooking();
    resetRateLimitState();
    const res = await providerPayoutDetail(get(`${API}/providers/me/payouts/${payoutId}`, other.scenario.provider));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('PAYOUT_NOT_FOUND');
    expect((await providerPayoutDetail(get(`${API}/providers/me/payouts/${payoutId}`, mine.scenario.provider))).status).toBe(200);
  });

  const REFUSED: AdminRole[] = ['support_admin', 'operations_admin', 'trust_safety_admin', 'content_admin', 'analytics_admin'];
  for (const role of REFUSED) {
    it(`${role} is refused every payout surface`, async () => {
      const settled = await seedSettledBooking();
      const payoutId = await payBooking(settled);
      const admin = await financeAdmin(role);
      resetRateLimitState();
      expect((await adminPayouts(get(`${API}/admin/payouts`, admin))).status).toBe(403);
      expect((await adminAdjustmentsList(get(`${API}/admin/earnings-adjustments`, admin))).status).toBe(403);
      expect((await adminPayoutDetail(get(`${API}/admin/payouts/${payoutId}`, admin))).status).toBe(404);
      expect((await adminRetry(post(`${API}/admin/payouts/${payoutId}/retry`, admin, { reason: 'x' }))).status).toBe(404);
      if (role !== 'analytics_admin') {
        const adjust = await adminAdjustments(
          post(`${API}/admin/earnings-adjustments`, admin, { providerProfileId: settled.providerProfileId, kind: 'credit', amountMinorUnits: 1, currencyCode: 'PKR', reason: 'x' }),
        );
        expect(adjust.status).toBe(403);
      }
    });
  }

  it('finance_admin reads with the mask only, and cannot approve their own adjustment; a different finance admin or super_admin can', async () => {
    const settled = await seedSettledBooking();
    const payoutId = await payBooking(settled);
    const finance = await financeAdmin();
    resetRateLimitState();

    const list = await adminPayouts(get(`${API}/admin/payouts?providerProfileId=${settled.providerProfileId}`, finance));
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain('****');
    expect(text).not.toContain('sandbox_payout_');
    expect((await adminPayoutDetail(get(`${API}/admin/payouts/${payoutId}`, finance))).status).toBe(200);

    const { pending } = await initiateEarningsAdjustment({
      adminUserId: finance.userId,
      idempotencyKey: crypto.randomUUID(),
      body: { providerProfileId: settled.providerProfileId, kind: 'credit', amountMinorUnits: 100, currencyCode: 'PKR', reason: 'x' },
    });
    await expect(decideAction({ approverUserId: finance.userId, adminActionId: pending.adminActionId, decision: 'approved' })).rejects.toMatchObject({ code: 'SELF_APPROVAL_NOT_ALLOWED' });
    const superAdmin = await financeAdmin('super_admin');
    const decided = await decideAction({ approverUserId: superAdmin.userId, adminActionId: pending.adminActionId, decision: 'approved' });
    expect(decided.status).toBe('Approved');
  });
});
