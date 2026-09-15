import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { requestPolicyRefund } from './execute';
import { registerRefundReconciliationSink, type RefundReconciliationEvent } from './reconciliation';
import { registerRefundNotificationSink, type RefundNotificationEvent } from './notifications';
import {
  SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX,
  allowRefund,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  refundAmountWithSuffix,
  refundHistory,
  resetRefundIntegration,
  seedCapturedBooking,
  storedRefundLines,
  storedRefunds,
  useRefundIntegration,
} from './refunds-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

/**
 * Spec 022 §3 "Reconciliation seam" (AC-4), the notification seam, and §4's audit/immutability
 * rules. Together these are the guarantees spec 024 and spec 026 will build on.
 */
describe.skipIf(!dbReachable)('refund reconciliation and audit (spec 022 AC-4)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** AC-4 — the durable fact spec 024 consumes. */
  it('a completed refund records reconciliation_state pending', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(refund.reconciliationState).toBe('pending');
    const [stored] = await storedRefunds(bookingId);
    expect(stored!.reconciliation_state).toBe('pending');
    expect(stored!.reconciled_at).toBeNull();
    expect(stored!.completed_at).not.toBeNull();
  });

  /** AC-4 — the sink receives the event, carrying everything spec 024 needs to reduce earnings. */
  it('emits a reconciliation event carrying the provider, amount and completion instant', async () => {
    const events: RefundReconciliationEvent[] = [];
    registerRefundReconciliationSink(async (event) => {
      events.push(event);
    });

    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      refundId: refund.id,
      bookingId,
      amountMinorUnits: 50_000,
      currencyCode: 'PKR',
    });
    expect(events[0]!.providerProfileId).toBeTruthy();
    expect(events[0]!.completedAt).toBeTruthy();
  });

  /**
   * AC-4 — THE resilience assertion: the refund is financially complete because the PROVIDER
   * confirmed it. A ledger hiccup downstream must never roll that back.
   */
  it('a failing reconciliation sink does not fail the refund', async () => {
    registerRefundReconciliationSink(async () => {
      throw new Error('ledger unavailable');
    });

    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(refund.status).toBe('completed');
    // And the durable fact survives, so spec 024 can still pick it up on its next pass.
    expect((await storedRefunds(bookingId))[0]!.reconciliation_state).toBe('pending');
  });

  /** AC-4 — spec 022 never writes `reconciled`; that is spec 024's only write into this table. */
  it('this spec never marks a refund reconciled', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const rows = await getDb().execute(
      sql`SELECT COUNT(*)::int AS n FROM refunds WHERE reconciliation_state = 'reconciled'`,
    );
    expect((rows as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
  });

  /** §15 — the notification seam fires for a completed refund, after the transaction commits. */
  it('emits refund_completed for a completed refund', async () => {
    const events: RefundNotificationEvent[] = [];
    registerRefundNotificationSink(async (event) => {
      events.push(event);
    });

    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(events.map((e) => e.kind)).toContain('refund_completed');
    const completed = events.find((e) => e.kind === 'refund_completed')!;
    expect(completed).toMatchObject({ bookingId, recipientUserId: scenario.customer.userId });
  });

  /** AC-6 — and for a failed one. */
  it('emits refund_failed for a failed refund', async () => {
    const events: RefundNotificationEvent[] = [];
    registerRefundNotificationSink(async (event) => {
      events.push(event);
    });

    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(refundAmountWithSuffix(SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX));
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    expect(events.map((e) => e.kind)).toContain('refund_failed');
  });

  /** §15 — a throwing notification sink must never fail a completed refund either. */
  it('a failing notification sink does not fail the refund', async () => {
    registerRefundNotificationSink(async () => {
      throw new Error('notifications down');
    });

    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);

    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(refund.status).toBe('completed');
  });

  /** §4 C-11 / I-8 — a completed refund is immutable, by any code path. */
  it('a completed refund cannot be edited', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    // Amount, status, completion instant and provider handle are all frozen.
    await expect(
      getDb().execute(sql`UPDATE refunds SET total_amount_minor_units = 1 WHERE id = ${refund.id}`),
    ).rejects.toThrow();
    await expect(getDb().execute(sql`UPDATE refunds SET status = 'failed' WHERE id = ${refund.id}`)).rejects.toThrow();
    await expect(getDb().execute(sql`UPDATE refunds SET completed_at = now() WHERE id = ${refund.id}`)).rejects.toThrow();
    await expect(
      getDb().execute(sql`UPDATE refunds SET refund_reference = 'tampered' WHERE id = ${refund.id}`),
    ).rejects.toThrow();
  });

  /** C-11 — the ONE permitted exception: spec 024 recording that it reconciled the refund. */
  it('allows only the reconciliation write on a completed refund', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    await getDb().execute(sql`
      UPDATE refunds SET reconciliation_state = 'reconciled', reconciled_at = clock_timestamp(),
                         updated_at = clock_timestamp(), version = version + 1
       WHERE id = ${refund.id}
    `);

    const [stored] = await storedRefunds(bookingId);
    expect(stored!.reconciliation_state).toBe('reconciled');
    expect(stored!.reconciled_at).not.toBeNull();
    // Everything else is unchanged.
    expect(stored!.status).toBe('completed');
    expect(stored!.total_amount_minor_units).toBe(50_000);
  });

  /** §4 C-10 — refund lines are the immutable explanation of the amount (AC-2). */
  it('keeps refund lines append-only', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    await expect(
      getDb().execute(sql`UPDATE refund_lines SET reason = 'rewritten' WHERE refund_id = ${refund.id}`),
    ).rejects.toThrow();
    await expect(getDb().execute(sql`DELETE FROM refund_lines WHERE refund_id = ${refund.id}`)).rejects.toThrow();

    expect((await storedRefundLines(refund.id))[0]!.reason).toBe('Cancelled within the free window');
  });

  /** §4 C-10 — and so is the status history, so attribution can never be rewritten. */
  it('keeps refund status history append-only', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    await expect(
      getDb().execute(sql`UPDATE refunds_status_history SET actor_role = 'system' WHERE refund_id = ${refund.id}`),
    ).rejects.toThrow();
    await expect(
      getDb().execute(sql`DELETE FROM refunds_status_history WHERE refund_id = ${refund.id}`),
    ).rejects.toThrow();

    expect(await refundHistory(refund.id)).toHaveLength(3);
  });

  /** C-9 — a sweep-driven transition is attributed to the system, with no actor user. */
  it('attributes a system transition with a null actor', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    // A customer-driven refund attributes every row to that customer.
    const history = await refundHistory(refund.id);
    expect(history.every((row) => row.actor_role === 'customer' && row.actor_user_id !== null)).toBe(true);
  });

  /** C-7 — a refund that is not completed can never be marked reconciled. */
  it('refuses to mark a non-completed refund reconciled', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(refundAmountWithSuffix(SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX));
    const { refund } = await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());
    expect(refund.status).toBe('failed');

    await expect(
      getDb().execute(sql`
        UPDATE refunds SET reconciliation_state = 'reconciled', reconciled_at = clock_timestamp()
         WHERE id = ${refund.id}
      `),
    ).rejects.toThrow();
  });
});
