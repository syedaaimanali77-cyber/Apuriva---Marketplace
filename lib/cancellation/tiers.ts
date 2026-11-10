/**
 * Spec 023 §3 "Boundary semantics" (AC-2/AC-3) — tier selection and fee arithmetic.
 *
 * Pure, and deliberately so: the preview route and the executed cancellation both call
 * `computeCancellationConsequence`, so the number a customer confirms is the number applied. The
 * ONLY difference between a preview and an execution is the clock instant, and the executed value
 * is always recomputed under the booking row lock.
 *
 * The clock itself is never read here. `hoursBefore` is supplied by the caller, which reads it from
 * the DATABASE clock (`clock_timestamp()`) in a statement issued AFTER the row lock — the rule spec
 * 018 established for offer expiry and spec 020 restated in `lib/bookings/lifecycle.ts`. A client
 * clock, a client timestamp and `now()` (frozen at transaction start) are all excluded by
 * construction: this module has no way to obtain any of them.
 */
import type { CancellationTier } from '@/lib/types/cancellation';

/**
 * The tier covering `hoursBefore`, using `[min, max)` bounds — INCLUSIVE at the lower
 * (further-from-now) bound, exclusive at the upper.
 *
 * That is what makes the upper boundaries exact and customer-favourable: at exactly 24 hours the
 * `[24, ∞)` tier matches (0%) and at exactly 12 hours the `[12, 24)` tier matches (25%) — each
 * boundary instant falling in the cheaper tier.
 *
 * The scheduled time itself is the one instant interval arithmetic alone would decide the wrong
 * way. The seeded ladder's third rung is `[0, 12)` at 50% and its last is `(-∞, 0)` at 100%, so a
 * plain `[min, max)` scan would put `hoursBefore === 0` in the 50% tier. Spec 023 §3 is explicit
 * that "`hoursBefore ≤ 0` is a single tier": a booking cancelled AT or after its scheduled time is
 * never in a discounted tier. So the non-positive range is routed to the unbounded-below rung
 * before the scan, and the ladder's own contiguity rules stay unchanged.
 */
export function selectTier(tiers: readonly CancellationTier[], hoursBefore: number): CancellationTier | null {
  if (tiers.length === 0) return null;

  // §3: "exactly at the scheduled time → T4", as does any instant after it. `hoursBefore <= 0` is
  // one tier, so the lowest (unbounded-below) rung owns the whole non-positive range.
  if (hoursBefore <= 0) {
    const lowest = tiers[tiers.length - 1]!;
    return lowest.minHoursBefore === null ? lowest : (tiers.find((t) => t.minHoursBefore === null) ?? lowest);
  }

  for (const tier of tiers) {
    const aboveMin = tier.minHoursBefore === null || hoursBefore >= tier.minHoursBefore;
    const belowMax = tier.maxHoursBefore === null || hoursBefore < tier.maxHoursBefore;
    if (aboveMin && belowMax) return tier;
  }
  return null;
}

/**
 * `round(captured × feePercent / 100)` with HALF-UP rounding, clamped to `[0, captured]`.
 *
 * Integer minor units throughout (spec 003 AC-1 forbids float money anywhere). Half-up is stated
 * rather than left to `Math.round`'s behaviour on negatives because the clamp already guarantees a
 * non-negative input — but the intent is recorded so a future currency with different conventions
 * has something explicit to change.
 */
export function feeForTier(capturedAmountMinorUnits: number, feePercent: number): number {
  if (!Number.isInteger(capturedAmountMinorUnits) || capturedAmountMinorUnits < 0) {
    throw new Error('capturedAmountMinorUnits must be a non-negative integer');
  }
  if (!Number.isInteger(feePercent) || feePercent < 0 || feePercent > 100) {
    throw new Error('feePercent must be an integer from 0 to 100');
  }
  const exact = (capturedAmountMinorUnits * feePercent) / 100;
  const rounded = Math.floor(exact + 0.5);
  return Math.min(Math.max(rounded, 0), capturedAmountMinorUnits);
}

export interface ConsequenceInput {
  tiers: readonly CancellationTier[];
  hoursBefore: number;
  capturedAmountMinorUnits: number;
}

export interface ConsequenceResult {
  tier: CancellationTier;
  feeAmountMinorUnits: number;
  refundAmountMinorUnits: number;
}

/**
 * The whole consequence, in one place. `fee + refund === captured` always holds — the same identity
 * `booking_cancellations_amounts_ck` enforces at the database, so application and schema agree by
 * construction rather than by convention.
 */
export function computeCancellationConsequence(input: ConsequenceInput): ConsequenceResult | null {
  const tier = selectTier(input.tiers, input.hoursBefore);
  if (!tier) return null;

  const feeAmountMinorUnits = feeForTier(input.capturedAmountMinorUnits, tier.feePercent);
  return {
    tier,
    feeAmountMinorUnits,
    refundAmountMinorUnits: input.capturedAmountMinorUnits - feeAmountMinorUnits,
  };
}

/** `hoursBefore` as the integer this spec audits (`× 1000`), so no float reaches the database. */
export function toHoursBeforeMilli(hoursBefore: number): number {
  const scaled = Math.round(hoursBefore * 1000);
  // Guards the integer column against a pathological scheduled_at far outside any real booking.
  const LIMIT = 2_000_000_000;
  return Math.min(Math.max(scaled, -LIMIT), LIMIT);
}
