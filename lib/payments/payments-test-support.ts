/**
 * Spec 021 §6 fixtures.
 *
 * Built on spec 020's `seedBookingScenario`, which itself runs the REAL spec 015→019 path
 * (registration → matching → offer → accept). Nothing here fakes an accepted offer, a booking or a
 * provider outcome — which is what makes these suites a test of spec 021 against the approved
 * specs rather than against a convenient fixture.
 *
 * Every suite that touches the payment domain must call `usePaymentIntegration()` in `beforeEach`:
 * Vitest gives each test file its own module registry, so the spec 020 seams `lib/payments/index.ts`
 * registers have to be re-registered per file (and torn down in `afterEach`, so a spec 020 suite in
 * another worker is never affected).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { queryRows } from '@/lib/offers/db';
import {
  applyBookingTransition,
  registerBookingTransitions,
  resetBookingConfirmationGate,
  resetRegisteredBookingTransitions,
  registerBookingConfirmationGate,
} from '@/lib/bookings';
import type { BookingStatus } from '@/lib/types/bookings';
import type { PaymentProtectionState, PaymentStatus, PriceAdjustmentStatus } from '@/lib/types/payments';
import { getSandboxPaymentProvider, PAYMENT_PROVIDER_ENV_VAR } from './provider';
import { resetDisputeGate } from './protection-window';

export {
  createBookingBody,
  driveToInProgress,
  seedBookingScenario,
  seedStranger,
  storedBooking,
  bookingHistory,
  type BookingScenario,
} from '@/lib/bookings/bookings-test-support';
export { authenticatedRequest, isDatabaseReachable, sessionGet, sessionMutate } from '@/lib/offers/offers-test-support';

/**
 * Registers spec 021's two spec 020 seams for this test file, and points the adapter factory at the
 * sandbox. Mirrors what `instrumentation.ts` does once per server instance in production.
 */
export function usePaymentIntegration(): void {
  process.env[PAYMENT_PROVIDER_ENV_VAR] = 'sandbox';
  resetRegisteredBookingTransitions();
  registerBookingTransitions('spec 021 (payments)', [
    ['pending', 'failed'],
    ['completed', 'protected'],
    ['protected', 'settled'],
  ]);
  registerBookingConfirmationGate(async () => ({ confirmNow: false }));
  getSandboxPaymentProvider().reset();
  resetDisputeGate();
  resetRateLimitState();
}

/** Restores the inert spec 020 defaults so no other suite inherits this file's registrations. */
export function resetPaymentIntegration(): void {
  resetBookingConfirmationGate();
  resetRegisteredBookingTransitions();
  resetDisputeGate();
  getSandboxPaymentProvider().reset();
}

/**
 * An amount whose last four minor-unit digits steer the sandbox adapter's outcome, while staying a
 * realistic booking price. `offset` lets one suite create several distinct-but-equivalent amounts.
 */
export function amountWithSandboxSuffix(suffix: number, thousands = 32): number {
  return thousands * 10_000 + suffix;
}

export function freshKey(): string {
  return randomUUID();
}

export async function storedPayment(bookingId: string) {
  const [row] = await queryRows<{
    id: string;
    status: PaymentStatus;
    charge_amount_minor_units: number;
    charge_currency_code: string;
    protection_state: PaymentProtectionState | null;
    protection_window_started_at: Date | null;
    protection_window_hours: number;
    provider_name: string;
    provider_reference: string | null;
    idempotency_key: string;
    version: number;
  }>(
    getDb(),
    sql`SELECT id, status, charge_amount_minor_units, charge_currency_code, protection_state,
               protection_window_started_at, protection_window_hours, provider_name,
               provider_reference, idempotency_key, version
          FROM payments WHERE booking_id = ${bookingId}`,
  );
  return row;
}

export async function paymentAttempts(bookingId: string) {
  return queryRows<{ status: string; failure_code: string | null; provider_reference: string | null }>(
    getDb(),
    sql`SELECT a.status, a.failure_code, a.provider_reference
          FROM payment_attempts a JOIN payments p ON p.id = a.payment_id
         WHERE p.booking_id = ${bookingId}
         ORDER BY a.attempted_at ASC, a.created_at ASC`,
  );
}

export async function paymentAuthorizations(bookingId: string) {
  return queryRows<{
    authorized_amount_minor_units: number;
    authorized_currency_code: string;
    captured_amount_minor_units: number | null;
    captured_at: Date | null;
    provider_reference: string;
  }>(
    getDb(),
    sql`SELECT z.authorized_amount_minor_units, z.authorized_currency_code, z.captured_amount_minor_units,
               z.captured_at, z.provider_reference
          FROM payment_authorizations z JOIN payments p ON p.id = z.payment_id
         WHERE p.booking_id = ${bookingId}`,
  );
}

export async function paymentHistory(bookingId: string) {
  return queryRows<{ from_status: string | null; to_status: string; actor_role: string; actor_user_id: string | null }>(
    getDb(),
    sql`SELECT h.from_status, h.to_status, h.actor_role, h.actor_user_id
          FROM payments_status_history h JOIN payments p ON p.id = h.payment_id
         WHERE p.booking_id = ${bookingId}
         ORDER BY h.occurred_at ASC, h.created_at ASC`,
  );
}

export async function storedAdjustments(bookingId: string) {
  return queryRows<{
    id: string;
    status: PriceAdjustmentStatus;
    additional_amount_minor_units: number;
    additional_currency_code: string;
    payment_id: string | null;
    approved_at: Date | null;
    approved_by_user_id: string | null;
  }>(
    getDb(),
    sql`SELECT id, status, additional_amount_minor_units, additional_currency_code, payment_id,
               approved_at, approved_by_user_id
          FROM price_adjustments WHERE booking_id = ${bookingId} ORDER BY created_at ASC`,
  );
}

export async function bookingStatus(bookingId: string): Promise<BookingStatus> {
  const [row] = await queryRows<{ status: BookingStatus }>(
    getDb(),
    sql`SELECT status FROM bookings WHERE id = ${bookingId}`,
  );
  return row!.status;
}

/**
 * Drives a booking to `completed` the way spec 020's own suites do, then returns the exact
 * `bookings_status_history.occurred_at` of that transition — the instant AC-5a anchors the
 * protection window to.
 */
export async function completionInstantOf(bookingId: string): Promise<Date> {
  const [row] = await queryRows<{ occurred_at: Date }>(
    getDb(),
    sql`SELECT occurred_at FROM bookings_status_history
         WHERE booking_id = ${bookingId} AND to_status = 'completed'
         ORDER BY occurred_at ASC LIMIT 1`,
  );
  return new Date(row!.occurred_at);
}

/**
 * Backdates a booking's creation on the DATABASE clock so AC-9's authorization window has elapsed,
 * without sleeping. The same one-statement approach spec 018's `shiftOfferWindow` established.
 *
 * `bookings_terms_immutable_trg` guards the booking's TERMS, not `created_at`, so this is a legal
 * write rather than a trigger workaround.
 */
export async function backdateBookingCreation(bookingId: string, minutesAgo: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE bookings SET created_at = clock_timestamp() - make_interval(mins => ${minutesAgo})
     WHERE id = ${bookingId}
  `);
}

/** Backdates an open protection window so it has elapsed, again on the database clock. */
export async function backdateProtectionWindow(bookingId: string, hoursAgo: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE payments
       SET protection_window_started_at = clock_timestamp() - make_interval(hours => ${hoursAgo}),
           version = version + 1
     WHERE booking_id = ${bookingId}
  `);
}

/** Sets a non-default protection window, to prove the configured duration is honoured over 48h. */
export async function setProtectionWindowHours(bookingId: string, hours: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE payments SET protection_window_hours = ${hours}, version = version + 1 WHERE booking_id = ${bookingId}
  `);
}

/**
 * Moves a booking `completed -> protected` the way the sweep does, for suites that need a protected
 * booking without re-testing pass A. Uses spec 020's primitive, never raw SQL on `bookings.status`.
 */
export async function forceProtected(bookingId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [row] = await queryRows<{ version: number }>(tx, sql`SELECT version FROM bookings WHERE id = ${bookingId}`);
    await applyBookingTransition(tx, {
      bookingId,
      from: 'completed',
      to: 'protected',
      actorRole: 'system',
      actorUserId: null,
      expectedVersion: row!.version,
    });
  });
}
