/**
 * Spec 022 §3 "Financial invariants" (AC-2, AC-5, AC-8) — the money rules, isolated and pure where
 * they can be so they are testable without a database.
 *
 * The authoritative captured amount is `payment_authorizations.captured_amount_minor_units`, NOT
 * `bookings.price_amount_minor_units` and NOT `payments.charge_amount_minor_units`: only the
 * authorization row records what the provider actually took. A partial capture, or a payment that
 * was authorized but never captured, would make the other two wrong.
 *
 * I-1, the single invariant everything else serves:
 *
 *     completedRefunded + inFlightRefunded  ≤  captured
 *
 * The cap is against BOTH the captured amount and everything already completed or in flight.
 * Expressing it as one inequality is what stops a burst of concurrent requests, or a long-running
 * `processing` refund, from opening a gap — and it is evaluated under the payment row lock, so it
 * is a database serialization rather than an application-only check (I-2).
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { RefundablePosition } from '@/lib/types/refunds';

export type { RefundablePosition };

export interface RefundLineInput {
  lineAmountMinorUnits: number;
  lineCurrencyCode: string;
  reason: string;
}

/** I-3/I-4 — a refund amount must be a positive whole number of minor units. */
export function isValidRefundAmount(amountMinorUnits: unknown): amountMinorUnits is number {
  return typeof amountMinorUnits === 'number' && Number.isInteger(amountMinorUnits) && amountMinorUnits > 0;
}

export function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code);
}

/** I-5 — the stored total must equal the sum of its lines, so the total cannot drift from its explanation. */
export function linesSumTo(lines: readonly RefundLineInput[], totalAmountMinorUnits: number): boolean {
  if (lines.length === 0) return false;
  return lines.reduce((sum, line) => sum + line.lineAmountMinorUnits, 0) === totalAmountMinorUnits;
}

/** I-6 — every line shares the refund's currency, which shares the payment's and the booking's. */
export function linesShareCurrency(lines: readonly RefundLineInput[], currencyCode: string): boolean {
  return lines.every((line) => line.lineCurrencyCode === currencyCode);
}

/**
 * I-1/I-2 — whether a proposed refund fits in what remains.
 *
 * Pure, so the exact captured-amount boundary is unit-testable: refunding precisely the remaining
 * amount is allowed, one minor unit more is not.
 */
export function fitsWithinRemaining(amountMinorUnits: number, position: RefundablePosition): boolean {
  return amountMinorUnits <= position.remainingRefundableMinorUnits;
}

export function isFullyRefunded(position: RefundablePosition): boolean {
  return position.capturedAmountMinorUnits > 0 && position.completedRefundedMinorUnits >= position.capturedAmountMinorUnits;
}

/**
 * Reads the refundable position of one payment.
 *
 * MUST be called with the `payments` row already locked `FOR UPDATE` in the same transaction when
 * it is being used to admit a refund (I-2) — otherwise two concurrent callers can both read a
 * position that permits their own request and together exceed the captured amount (AC-8). It is
 * also used unlocked on read-only paths, where a stale figure is harmless.
 *
 * `failed` refunds contribute to neither sum (I-7): their reservation is released the moment they
 * reach `failed`, which is exactly why AC-7 must never mark an ambiguous outcome `failed`.
 */
export async function readRefundablePosition(tx: Executor, paymentId: string): Promise<RefundablePosition> {
  const [row] = await queryRows<{
    captured: number | null;
    currency: string | null;
    completed: string;
    in_flight: string;
  }>(
    tx,
    sql`SELECT
          (SELECT SUM(z.captured_amount_minor_units)::int
             FROM payment_authorizations z
            WHERE z.payment_id = ${paymentId} AND z.captured_at IS NOT NULL)          AS captured,
          (SELECT MAX(z.captured_currency_code)
             FROM payment_authorizations z
            WHERE z.payment_id = ${paymentId} AND z.captured_at IS NOT NULL)          AS currency,
          COALESCE((SELECT SUM(r.total_amount_minor_units)
                      FROM refunds r
                     WHERE r.payment_id = ${paymentId} AND r.status = 'completed'), 0)::text AS completed,
          COALESCE((SELECT SUM(r.total_amount_minor_units)
                      FROM refunds r
                     WHERE r.payment_id = ${paymentId} AND r.status IN ('requested','processing')), 0)::text AS in_flight`,
  );

  const captured = row?.captured ?? 0;
  const completed = Number(row?.completed ?? 0);
  const inFlight = Number(row?.in_flight ?? 0);

  return {
    capturedAmountMinorUnits: captured,
    completedRefundedMinorUnits: completed,
    inFlightRefundedMinorUnits: inFlight,
    // Never negative: a defect elsewhere must surface as "nothing refundable", not as a negative
    // budget that would make `fitsWithinRemaining` behave strangely.
    remainingRefundableMinorUnits: Math.max(0, captured - completed - inFlight),
    currencyCode: row?.currency ?? '',
  };
}

/**
 * Whether this payment is now fully refunded by COMPLETED refunds alone.
 *
 * Deliberately ignores in-flight refunds: `bookings.status = 'refunded'` and
 * `payments.status = 'refunded'` mean the money is actually back, not that it is on its way.
 */
export async function isPaymentFullyRefunded(tx: Executor, paymentId: string): Promise<boolean> {
  const position = await readRefundablePosition(tx, paymentId);
  return isFullyRefunded(position);
}
