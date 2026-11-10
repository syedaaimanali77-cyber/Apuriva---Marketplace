import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { getSandboxPaymentProvider } from '@/lib/payments/provider';
import { requestPolicyRefund } from './execute';
import { runRefundReconcileSweep } from './sweep';
import { readRefundablePosition } from './amounts';
import { getDb } from '@/lib/db';
import {
  SANDBOX_REFUND_UNKNOWN_AMOUNT_SUFFIX,
  ageRefund,
  allowRefund,
  bookingStatusOf,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  makeRefundUnresolvable,
  paymentStatusOf,
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

/** The amount that makes the sandbox report `unknown` while having actually refunded. */
const AMBIGUOUS = refundAmountWithSuffix(SANDBOX_REFUND_UNKNOWN_AMOUNT_SUFFIX);

/**
 * Spec 022 §3 "Provider ambiguity and recovery" (AC-7).
 *
 * This is the suite that proves the most dangerous failure mode is handled: a refund whose outcome
 * the provider never reported must not be guessed at in EITHER direction. Auto-failing it would
 * strand the customer's money if the provider did pay; auto-retrying it could pay twice.
 */
describe.skipIf(!dbReachable)('refund provider ambiguity (spec 022 AC-7)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    vi.restoreAllMocks();
  });

  /** AC-7 — the core assertion: `unknown` leaves the refund `processing`, never `failed`. */
  it('an unknown provider outcome leaves the refund processing, never failed', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(AMBIGUOUS);

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(refund.status).toBe('processing');
    expect(refund.completedAt).toBeNull();

    const [stored] = await storedRefunds(bookingId);
    expect(stored!.status).toBe('processing');
    expect(stored!.failure_code).toBeNull();
    // The provider DID issue a reference — that is what the sweep will look up.
    expect(stored!.refund_reference).not.toBeNull();

    // Neither the payment nor the booking moved on an unconfirmed refund.
    expect(await paymentStatusOf(bookingId)).toBe('captured');
    expect(await bookingStatusOf(bookingId)).not.toBe('refunded');
  });

  /** AC-7 — a transport failure tells us nothing either, and is treated identically. */
  it('a transport error leaves the refund processing, never failed', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    vi.spyOn(getSandboxPaymentProvider(), 'refund').mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(refund.status).toBe('processing');

    const [stored] = await storedRefunds(bookingId);
    expect(stored!.status).toBe('processing');
    expect(stored!.failure_code).toBeNull();
  });

  /** AC-7 / I-7 — the reservation stays HELD, so the money cannot be refunded twice meanwhile. */
  it('holds the reservation while the outcome is unknown', async () => {
    const { scenario, bookingId, paymentId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(AMBIGUOUS);

    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const position = await readRefundablePosition(getDb(), paymentId);
    expect(position.inFlightRefundedMinorUnits).toBe(AMBIGUOUS);
    expect(position.completedRefundedMinorUnits).toBe(0);
    expect(position.remainingRefundableMinorUnits).toBe(capturedAmountMinorUnits - AMBIGUOUS);
  });

  /** AC-7 — a retry while the outcome is unknown is refused; no second provider refund is sent. */
  it('refuses a retry while an outcome is still unknown, sending no second refund', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(AMBIGUOUS);

    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const refundSpy = vi.spyOn(getSandboxPaymentProvider(), 'refund');
    await expect(requestPolicyRefund(scenario.customer.userId, bookingId, freshKey())).rejects.toMatchObject({
      code: 'REFUND_ALREADY_PROCESSING',
      status: 409,
    });
    expect(refundSpy).not.toHaveBeenCalled();
    expect(await storedRefunds(bookingId)).toHaveLength(1);
  });

  /**
   * AC-7 — the sweep resolves it through a status READ. The sandbox reports `refunded`, because it
   * really had refunded; the refund now completes exactly as the live path would have.
   */
  it('the sweep resolves an unknown outcome through getRefundStatus', async () => {
    const { scenario, bookingId, capturedAmountMinorUnits } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(AMBIGUOUS);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const refundSpy = vi.spyOn(getSandboxPaymentProvider(), 'refund');
    await runRefundReconcileSweep();

    // Recovery is a READ: the sweep never issues a second provider refund.
    expect(refundSpy).not.toHaveBeenCalled();

    const [stored] = await storedRefunds(bookingId);
    expect(stored!.status).toBe('completed');
    expect(stored!.completed_at).not.toBeNull();
    expect(stored!.reconciliation_state).toBe('pending');

    // A partial refund still leaves the booking alone.
    expect(await paymentStatusOf(bookingId)).toBe(AMBIGUOUS >= capturedAmountMinorUnits ? 'refunded' : 'partially_refunded');
  });

  /** AC-7 — and if the provider reports a definitive failure on the read, the refund fails then. */
  it('the sweep fails a refund the provider definitively reports as failed', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    // Force ambiguity on the live call, then make the provider report a definitive failure.
    vi.spyOn(getSandboxPaymentProvider(), 'refund').mockResolvedValueOnce({
      outcome: 'unknown',
      refundReference: 'sandbox_refund_probe',
    });
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect((await storedRefunds(bookingId))[0]!.status).toBe('processing');

    // Keyed on the reference, not `...Once`: this suite shares a database, so the sweep may inspect
    // rows other tests left behind and a one-shot mock could be consumed by the wrong one.
    const real = getSandboxPaymentProvider().getRefundStatus.bind(getSandboxPaymentProvider());
    vi.spyOn(getSandboxPaymentProvider(), 'getRefundStatus').mockImplementation(async (reference) =>
      reference === 'sandbox_refund_probe'
        ? { outcome: 'failed', refundReference: reference, failureCode: 'refund_declined' }
        : real(reference),
    );

    await runRefundReconcileSweep();

    const [stored] = await storedRefunds(bookingId);
    expect(stored!.status).toBe('failed');
    expect(stored!.failure_code).toBe('refund_declined');
  });

  /**
   * AC-7 — a refund the provider still cannot resolve is ESCALATED for a human, never auto-failed
   * and never auto-retried. This is the assertion that a "tidy up stuck rows" refactor would break.
   */
  it('escalates an unresolved refund rather than auto-failing it', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(AMBIGUOUS);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const [stored] = await storedRefunds(bookingId);
    makeRefundUnresolvable(stored!.refund_reference!);
    await ageRefund(stored!.id, 120);

    const refundSpy = vi.spyOn(getSandboxPaymentProvider(), 'refund');
    const result = await runRefundReconcileSweep();

    // Counts are database-wide (this suite shares one), so assert at-least semantics here and the
    // exact outcome on THIS refund below — which is the guarantee that actually matters.
    expect(result.stillUnknown).toBeGreaterThanOrEqual(1);
    expect(result.escalated).toBeGreaterThanOrEqual(1);
    expect(refundSpy).not.toHaveBeenCalled();

    // Still processing — untouched, reservation still held.
    expect((await storedRefunds(bookingId))[0]!.status).toBe('processing');
  });

  /** A not-yet-stale unknown refund is left entirely alone, and not escalated prematurely. */
  it('does not escalate an unknown refund before the threshold', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(AMBIGUOUS);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const [stored] = await storedRefunds(bookingId);
    makeRefundUnresolvable(stored!.refund_reference!);

    const before = (await storedRefunds(bookingId))[0]!;
    await runRefundReconcileSweep();

    // Untouched: same status, same version — nothing was escalated or changed before the threshold.
    const after = (await storedRefunds(bookingId))[0]!;
    expect(after.status).toBe('processing');
    expect(after.version).toBe(before.version);
  });

  /** The sweep is idempotent: once resolved, a second run finds nothing to do. */
  it('is idempotent across repeated runs', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(AMBIGUOUS);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    await runRefundReconcileSweep();
    const completedOnce = (await storedRefunds(bookingId))[0]!;
    expect(completedOnce.status).toBe('completed');

    // A second run neither re-completes it nor creates another refund row.
    await runRefundReconcileSweep();
    const afterSecond = (await storedRefunds(bookingId))[0]!;
    expect(afterSecond.status).toBe('completed');
    expect(afterSecond.version).toBe(completedOnce.version);
    expect(await storedRefunds(bookingId)).toHaveLength(1);
  });
});
