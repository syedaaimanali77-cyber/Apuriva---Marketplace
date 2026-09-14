/**
 * Spec 021 §3 "Payment timing" (AC-1, AC-2, AC-3) — when a booking's money moves.
 *
 * Grounded on what this repository actually models rather than on three hypothetical paths:
 * EVERY booking is created from an accepted offer (`bookings.offer_id` is NOT NULL with a unique
 * index) whose price is copied verbatim (spec 020 §3 step 14), and `services.pricing_model` is
 * `fixed | package | hourly | quote | custom` (spec 010). There is no deposit column, deposit table
 * or payment-model table anywhere in `lib/db/schema.ts`.
 *
 * So the resolver has exactly one reachable outcome today, and says so honestly:
 *
 *   - `at_booking_confirmation` — what every pricing model resolves to. For a fixed/scheduled
 *     service (AC-1) and for an offer-based service (AC-2) this is the SAME instant, because offer
 *     acceptance is what creates the booking. Authorization happens at the booking's payment step,
 *     never at offer acceptance.
 *   - `deposit_then_remainder` — typed, unit-tested and unreachable. Master spec §133.5 forbids
 *     inventing the deposit data that would make it reachable, so this ships the shape a later spec
 *     will fill in, the same way spec 020 shipped its completion-evidence GATE without spec 028's
 *     requirement. `chargeRemainder()` in `price-adjustment.ts` enforces AC-3's substantive rule —
 *     the remainder is never charged without explicit customer approval — and that IS testable now.
 */
import type { PaymentTiming } from '@/lib/types/payments';

export type { PaymentTiming };

/** Spec 010's `services.pricing_model` vocabulary, restated as the resolver's input. */
export type PricingModel = 'fixed' | 'package' | 'hourly' | 'quote' | 'custom';

export const PRICING_MODELS: readonly PricingModel[] = ['fixed', 'package', 'hourly', 'quote', 'custom'] as const;

export interface ResolvePaymentTimingInput {
  pricingModel: PricingModel;
  /**
   * Present ONLY when a later spec has added real deposit data. Absent today for every service in
   * this repository — no default is supplied, because a fabricated default would be an invented
   * deposit amount.
   */
  depositAmountMinorUnits?: number | null;
}

export function resolvePaymentTiming(input: ResolvePaymentTimingInput): PaymentTiming {
  const deposit = input.depositAmountMinorUnits;
  if (typeof deposit === 'number' && deposit > 0) {
    return { kind: 'deposit_then_remainder', depositAmountMinorUnits: deposit };
  }
  return { kind: 'at_booking_confirmation' };
}

/**
 * The amount to authorize at the booking's payment step, given the booking's agreed price.
 *
 * For `at_booking_confirmation` that is the whole price. For `deposit_then_remainder` it is the
 * deposit only — the remainder is a separate, approval-gated charge.
 */
export function initialChargeAmountMinorUnits(timing: PaymentTiming, priceAmountMinorUnits: number): number {
  return timing.kind === 'deposit_then_remainder' ? timing.depositAmountMinorUnits : priceAmountMinorUnits;
}
