/**
 * Spec 022 §6 fixtures.
 *
 * Built on spec 021's payment fixtures, which are built on spec 020's booking scenario, which runs
 * the REAL spec 015→019 path. Nothing here fakes a captured payment: a refundable booking is one
 * that genuinely went through authorization and capture, so the refundable position these suites
 * assert against is the one the application actually produces.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { createBooking } from '@/lib/bookings/create';
import { completeBooking } from '@/lib/bookings/complete';
import { driveToInProgress } from '@/lib/bookings/bookings-test-support';
import { authorizePayment } from '@/lib/payments/authorize';
import { getSandboxPaymentProvider } from '@/lib/payments/provider';
import {
  createBookingBody,
  freshKey,
  resetPaymentIntegration,
  seedBookingScenario,
  usePaymentIntegration,
  type BookingScenario,
} from '@/lib/payments/payments-test-support';
import type { RefundReconciliationState, RefundStatus } from '@/lib/types/refunds';
import { resetRegisteredPaymentTransitions, registerPaymentTransitions } from '@/lib/payments/state-machine';
import { registerBookingTransitions } from '@/lib/bookings';
import { resetRefundEligibilityGate, registerRefundEligibilityGate } from './eligibility';

/**
 * Vitest gives each test file its own module registry, so the transitions `lib/refunds/index.ts`
 * registers at import have to be re-registered per file — and re-registered AFTER spec 021's own
 * reset, which clears them.
 */
function registerRefundIntegrationForTests(): void {
  registerPaymentTransitions('spec 022 (refunds)', [
    ['captured', 'refunded'],
    ['captured', 'partially_refunded'],
    ['partially_refunded', 'refunded'],
  ]);
  registerBookingTransitions('spec 022 (refunds)', [
    ['completed', 'refunded'],
    ['protected', 'refunded'],
    ['settled', 'refunded'],
    ['cancelled', 'refunded'],
  ]);
}
import { resetRefundNotificationSink } from './notifications';
import { resetRefundReconciliationSink } from './reconciliation';

export {
  createBookingBody,
  freshKey,
  seedBookingScenario,
  seedStranger,
  sessionGet,
  sessionMutate,
  isDatabaseReachable,
  type BookingScenario,
} from '@/lib/payments/payments-test-support';
export { registerRefundEligibilityGate } from './eligibility';

/** Registers spec 021's seams plus this spec's inert ports, and points the adapter at the sandbox. */
export function useRefundIntegration(): void {
  usePaymentIntegration();
  resetRegisteredPaymentTransitions();
  registerRefundIntegrationForTests();
  resetRefundEligibilityGate();
  resetRefundReconciliationSink();
  resetRefundNotificationSink();
}

export function resetRefundIntegration(): void {
  resetPaymentIntegration();
  resetRefundEligibilityGate();
  resetRefundReconciliationSink();
  resetRefundNotificationSink();
}

/** Registers an eligibility gate that always approves the given amount — spec 023's stand-in. */
export function allowRefund(amountMinorUnits: number, reason = 'Cancelled within the free window'): void {
  registerRefundEligibilityGate(async () => ({
    eligible: true,
    amountMinorUnits,
    currencyCode: 'PKR',
    reason,
    decisionRef: `decision-${randomUUID()}`,
  }));
}

/**
 * A booking whose payment is genuinely captured, so it has a real refundable position.
 *
 * `priceAmountMinorUnits` also selects the sandbox's PAYMENT outcome, so callers wanting an
 * ordinary capture should leave it at a neutral amount.
 */
export async function seedCapturedBooking(options?: { priceAmountMinorUnits?: number }): Promise<{
  scenario: BookingScenario;
  bookingId: string;
  paymentId: string;
  capturedAmountMinorUnits: number;
}> {
  const priceAmountMinorUnits = options?.priceAmountMinorUnits ?? 320_000;
  const scenario = await seedBookingScenario({ priceAmountMinorUnits });

  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  const payment = await authorizePayment(scenario.customer.userId, booking.id, freshKey());

  return {
    scenario,
    bookingId: booking.id,
    paymentId: payment.id,
    capturedAmountMinorUnits: payment.chargeAmountMinorUnits,
  };
}

/** Drives a captured booking through to `completed`, the state most refunds happen in. */
export async function completeBookingFor(scenario: BookingScenario, bookingId: string): Promise<void> {
  await driveToInProgress(scenario, bookingId);
  await completeBooking(scenario.provider.userId, bookingId, 'provider');
}

export async function storedRefunds(bookingId: string) {
  return queryRows<{
    id: string;
    status: RefundStatus;
    total_amount_minor_units: number;
    total_currency_code: string;
    source: string;
    is_override: boolean;
    admin_action_id: string | null;
    refund_reference: string | null;
    failure_code: string | null;
    reconciliation_state: RefundReconciliationState;
    reconciled_at: Date | null;
    completed_at: Date | null;
    version: number;
  }>(
    getDb(),
    sql`SELECT id, status, total_amount_minor_units, total_currency_code, source, is_override,
               admin_action_id, refund_reference, failure_code, reconciliation_state, reconciled_at,
               completed_at, version
          FROM refunds WHERE booking_id = ${bookingId} ORDER BY created_at ASC`,
  );
}

export async function storedRefundLines(refundId: string) {
  return queryRows<{ line_amount_minor_units: number; line_currency_code: string; reason: string }>(
    getDb(),
    sql`SELECT line_amount_minor_units, line_currency_code, reason
          FROM refund_lines WHERE refund_id = ${refundId} ORDER BY created_at ASC`,
  );
}

export async function refundHistory(refundId: string) {
  return queryRows<{ from_status: string | null; to_status: string; actor_role: string; actor_user_id: string | null }>(
    getDb(),
    sql`SELECT from_status, to_status, actor_role, actor_user_id
          FROM refunds_status_history WHERE refund_id = ${refundId}
         ORDER BY occurred_at ASC, created_at ASC`,
  );
}

export async function bookingStatusOf(bookingId: string): Promise<string> {
  const [row] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM bookings WHERE id = ${bookingId}`);
  return row!.status;
}

export async function paymentStatusOf(bookingId: string): Promise<string> {
  const [row] = await queryRows<{ status: string }>(
    getDb(),
    sql`SELECT status FROM payments WHERE booking_id = ${bookingId}`,
  );
  return row!.status;
}

/** Backdates a refund's `updated_at` so the sweep treats it as stale enough to escalate. */
export async function ageRefund(refundId: string, minutesAgo: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE refunds SET updated_at = clock_timestamp() - make_interval(mins => ${minutesAgo}) WHERE id = ${refundId}
  `);
}

/** Makes a refund's provider reference unresolvable, so the sweep keeps reporting `unknown`. */
export function makeRefundUnresolvable(refundReference: string): void {
  getSandboxPaymentProvider().markRefundStatusUnresolvable(refundReference);
}

/**
 * The sandbox amount suffixes, re-exported so suites can steer refund outcomes without importing
 * the adapter directly.
 */
export { SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX, SANDBOX_REFUND_UNKNOWN_AMOUNT_SUFFIX } from '@/lib/payments/provider';

/** An amount whose last four minor-unit digits steer the sandbox's REFUND outcome. */
export function refundAmountWithSuffix(suffix: number, thousands = 4): number {
  return thousands * 10_000 + suffix;
}
