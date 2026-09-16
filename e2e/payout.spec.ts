import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { sandboxSetupToken } from '@/lib/payments/provider';
import { POST as STEP_UP } from '@/app/api/v1/auth/step-up/route';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { POST as CREATE_METHOD } from '@/app/api/v1/providers/me/payout-methods/route';
import { GET as EARNINGS } from '@/app/api/v1/providers/me/earnings/route';
import { GET as PAYOUTS } from '@/app/api/v1/providers/me/payouts/route';
import { runPayoutSweep } from '@/lib/payouts';
import type { EarningsSummaryDto, PayoutDto } from '@/lib/types/payouts';
import {
  refundBooking,
  resetPayoutIntegration,
  seedSettledBooking,
  sessionGet,
  usePayoutIntegration,
} from '@/lib/payouts/payouts-test-support';

/**
 * Spec 024 §6 "E2E (Vitest)" — no Playwright; the real route handlers against the isolated `*_test`
 * database, no module mocked. A settled booking becomes earnings, accrues, closes and is paid by the
 * payout sweep through the sandbox rail; a spec 022 refund then reduces the next payout. The sweep is
 * driven scoped to this journey's provider, because an unscoped sweep in a shared test database would
 * act on other suites' rows; the cron route's own bearer-secret contract is covered by
 * `lib/payouts/routes.integration.test.ts`.
 */
const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;
const BASE = 'http://localhost/api/v1';

afterAll(async () => {
  await getPool().end();
});

describe.skipIf(!dbReachable)('provider payout journey (spec 024)', { timeout: SUITE_TIMEOUT_MS }, () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
    process.env.CRON_SECRET = 'e2e-cron-secret';
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it('a settled booking is paid out through the payout sweep, and a later refund reduces the next payout', async () => {
    const settled = await seedSettledBooking();
    const provider = settled.scenario.provider;
    resetRateLimitState();

    const stepUpRes = await STEP_UP(authenticatedRequest(`${BASE}/auth/step-up`, provider.sessionId, provider.csrfToken, { body: { action: 'manage_payout_method' } }));
    const stepUpToken = ((await stepUpRes.json()) as { data: { stepUpToken: string } }).data.stepUpToken;
    const createReq = authenticatedRequest(`${BASE}/providers/me/payout-methods`, provider.sessionId, provider.csrfToken, {
      body: { setupToken: sandboxSetupToken('bank', '4455') },
    });
    const headers = new Headers(createReq.headers);
    headers.set('x-step-up-token', stepUpToken);
    headers.set('Idempotency-Key', crypto.randomUUID());
    expect((await CREATE_METHOD(new Request(createReq, { headers }))).status).toBe(201);

    const cron = () => runPayoutSweep({ providerProfileIds: [settled.providerProfileId] });
    expect((await cron()).transfersPaid).toBe(1);

    const payouts = ((await (await PAYOUTS(sessionGet(`${BASE}/providers/me/payouts`, provider))).json()) as { data: PayoutDto[] }).data;
    const paid = payouts.find((p) => p.status === 'paid');
    expect(paid).toBeDefined();
    expect(paid!.payoutMethodMaskedDetail).toBe('****4455');

    const before = ((await (await EARNINGS(sessionGet(`${BASE}/providers/me/earnings`, provider))).json()) as { data: EarningsSummaryDto }).data;
    expect(before.paidAmountMinorUnits).toBe(paid!.amountMinorUnits);
    expect(before.pendingAmountMinorUnits + before.upcomingAmountMinorUnits + before.paidAmountMinorUnits).toBe(before.netAmountMinorUnits);

    await refundBooking(settled, 40_000);
    await cron();

    resetRateLimitState();
    const after = ((await (await EARNINGS(sessionGet(`${BASE}/providers/me/earnings`, provider))).json()) as { data: EarningsSummaryDto }).data;
    expect(after.refundsAmountMinorUnits).toBe(40_000);
    expect(after.balanceAmountMinorUnits).toBeLessThan(0);
    expect(after.pendingAmountMinorUnits + after.upcomingAmountMinorUnits + after.paidAmountMinorUnits).toBe(after.netAmountMinorUnits);
    expect(after.paidAmountMinorUnits).toBe(before.paidAmountMinorUnits);
  });
});
