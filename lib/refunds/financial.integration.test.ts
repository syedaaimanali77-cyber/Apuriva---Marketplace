import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import type { ApiRouteError } from '@/lib/api/errors';
import { readRefundablePosition } from './amounts';
import { requestPolicyRefund } from './execute';
import { registerRefundEligibilityGate } from './eligibility';
import {
  SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX,
  allowRefund,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  refundAmountWithSuffix,
  resetRefundIntegration,
  seedCapturedBooking,
  storedRefunds,
  useRefundIntegration,
} from './refunds-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

async function expectError(fn: () => Promise<unknown>, code: string): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

/**
 * Spec 022 §6 "Financial (mandatory)" — master spec §113's list, restricted to what this spec owns.
 *
 * Cancellation fee is spec 023's, payout pending/failure are spec 024's, and neither is tested here
 * because this spec implements neither.
 */
describe.skipIf(!dbReachable)('refund financial flows (spec 022 §6, master spec §113)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** §113 "Full refund". */
  it('full refund: the whole captured amount is returned exactly once', async () => {
    const { scenario, bookingId, paymentId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(capturedAmountMinorUnits);

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(refund.status).toBe('completed');

    const position = await readRefundablePosition(getDb(), paymentId);
    expect(position.completedRefundedMinorUnits).toBe(capturedAmountMinorUnits);
    expect(position.remainingRefundableMinorUnits).toBe(0);
  });

  /** §113 "Partial refund". */
  it('partial refund: only the decided amount is returned, and the rest stays refundable', async () => {
    const { scenario, bookingId, paymentId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const part = Math.floor(capturedAmountMinorUnits / 3);
    allowRefund(part);

    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const position = await readRefundablePosition(getDb(), paymentId);
    expect(position.completedRefundedMinorUnits).toBe(part);
    expect(position.remainingRefundableMinorUnits).toBe(capturedAmountMinorUnits - part);
  });

  /** §113 "Failed refund". */
  it('failed refund: nothing is returned and the amount stays refundable', async () => {
    const { scenario, bookingId, paymentId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(refundAmountWithSuffix(SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX));

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(refund.status).toBe('failed');

    // I-7 — a failed refund releases its reservation entirely.
    const position = await readRefundablePosition(getDb(), paymentId);
    expect(position.completedRefundedMinorUnits).toBe(0);
    expect(position.inFlightRefundedMinorUnits).toBe(0);
    expect(position.remainingRefundableMinorUnits).toBe(capturedAmountMinorUnits);
  });

  /**
   * AC-5 — THE BOUNDARY. Refunding exactly what remains succeeds; one minor unit more is refused.
   * This is the assertion that would catch an off-by-one anywhere in the cap.
   */
  it('the exact captured amount is refundable and one minor unit more is not', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    // One minor unit over: refused outright.
    allowRefund(capturedAmountMinorUnits + 1);
    const error = await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      'REFUND_EXCEEDS_CAPTURED_AMOUNT',
    );
    expect(error.status).toBe(422);
    expect(error.details).toMatchObject({ remainingRefundableMinorUnits: capturedAmountMinorUnits });
    expect(await storedRefunds(bookingId)).toEqual([]);

    // Exactly the captured amount: accepted.
    allowRefund(capturedAmountMinorUnits);
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(refund.status).toBe('completed');
  });

  /** AC-5 — an over-cap request is never silently truncated to fit. */
  it('an over-cap request is rejected, never truncated', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    const half = Math.floor(capturedAmountMinorUnits / 2);
    allowRefund(half);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    // Now ask for the full amount again — only `capturedAmount - half` remains.
    allowRefund(capturedAmountMinorUnits);
    await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      'REFUND_EXCEEDS_CAPTURED_AMOUNT',
    );

    // Exactly one refund exists, for exactly the first amount. Nothing was clipped down to fit.
    const refunds = await storedRefunds(bookingId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.total_amount_minor_units).toBe(half);
  });

  /** AC-5 — cumulative refunds can never exceed the captured amount. */
  it('cumulative completed and in-flight refunds never exceed the captured amount', async () => {
    const { scenario, bookingId, paymentId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    const chunk = Math.floor(capturedAmountMinorUnits / 4);
    for (let i = 0; i < 4; i += 1) {
      allowRefund(chunk);
      await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    }

    // A fifth chunk has nowhere to go.
    allowRefund(chunk);
    await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      capturedAmountMinorUnits - chunk * 4 === 0 ? 'ALREADY_FULLY_REFUNDED' : 'REFUND_EXCEEDS_CAPTURED_AMOUNT',
    );

    const position = await readRefundablePosition(getDb(), paymentId);
    expect(position.completedRefundedMinorUnits).toBeLessThanOrEqual(capturedAmountMinorUnits);
  });

  /** AC-5 — a fully refunded payment refuses a further refund with its own, specific code. */
  it('a fully refunded payment rejects a further refund with ALREADY_FULLY_REFUNDED', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(capturedAmountMinorUnits);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    allowRefund(1);
    const error = await expectError(
      () => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()),
      'ALREADY_FULLY_REFUNDED',
    );
    expect(error.status).toBe(422);
  });

  /** I-3 — a zero-value refund is refused. "Nothing is owed" is `eligible: false`, not a zero refund. */
  it('rejects a zero-value refund', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    registerRefundEligibilityGate(async () => ({
      eligible: true,
      amountMinorUnits: 0,
      currencyCode: 'PKR',
      reason: 'x',
    }));

    await expectError(() => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()), 'REFUND_ELIGIBILITY_INVALID');
    expect(await storedRefunds(bookingId)).toEqual([]);
  });

  /** I-4 — a negative refund is refused. */
  it('rejects a negative refund', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    registerRefundEligibilityGate(async () => ({
      eligible: true,
      amountMinorUnits: -5_000,
      currencyCode: 'PKR',
      reason: 'x',
    }));

    await expectError(() => requestPolicyRefund(scenario.customer.userId, bookingId, freshKey()), 'REFUND_ELIGIBILITY_INVALID');
  });

  /** §113 "Duplicate refund attempts" / "Idempotency" — same key replays, no second provider call. */
  it('idempotency: same key and fingerprint replays without a second refund', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const key = freshKey();

    const first = await requestPolicyRefund(scenario.customer.userId, bookingId, key);
    const replay = await requestPolicyRefund(scenario.customer.userId, bookingId, key);

    expect(replay.created).toBe(false);
    expect(replay.refund.id).toBe(first.refund.id);
    expect(replay.refund.version).toBe(first.refund.version);
    expect(await storedRefunds(bookingId)).toHaveLength(1);
  });

  /**
   * §113 "Idempotency" — on the CUSTOMER path the client supplies no amount, so two calls under one
   * key are the same client request however the server-side policy may have changed in between.
   * Replaying the stored refund is therefore both correct and the safe answer: it is structurally
   * incapable of refunding twice, which a "the policy changed, so refund again" reading would not be.
   *
   * (The conflicting-fingerprint path is exercised on the admin override route, where the client
   * does supply an amount — see `override.integration.test.ts`.)
   */
  it('idempotency: a same-key retry replays even if the policy decision changed', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    const key = freshKey();

    allowRefund(50_000);
    const first = await requestPolicyRefund(scenario.customer.userId, bookingId, key);

    // The policy now says a different amount; the retry must still NOT refund a second time.
    allowRefund(60_000);
    const replay = await requestPolicyRefund(scenario.customer.userId, bookingId, key);

    expect(replay.created).toBe(false);
    expect(replay.refund.id).toBe(first.refund.id);
    expect(replay.refund.totalAmountMinorUnits).toBe(50_000);
    expect(await storedRefunds(bookingId)).toHaveLength(1);
  });

  /** §4 I-4 — money constraints are enforced at the database, not only in application code. */
  it('refuses a non-positive refund total at the database', async () => {
    const { scenario, bookingId, paymentId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);

    for (const amount of [0, -1]) {
      await expect(
        getDb().execute(sql`
          INSERT INTO refunds (payment_id, booking_id, status, total_amount_minor_units, total_currency_code,
                               source, idempotency_key, idempotency_fingerprint)
          VALUES (${paymentId}, ${bookingId}, 'requested', ${amount}, 'PKR', 'policy', ${freshKey()}, 'x')
        `),
      ).rejects.toThrow();
    }
  });

  /** §4 — the spec 003 transition trigger is the independent second line of defence. */
  it('refuses an unseeded refund status transition at the database', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    // `completed -> processing` is not seeded; a completed refund is terminal.
    await expect(
      getDb().execute(sql`UPDATE refunds SET status = 'processing' WHERE id = ${refund.id}`),
    ).rejects.toThrow();
  });
});
