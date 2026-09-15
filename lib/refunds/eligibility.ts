/**
 * Spec 022 §3 "Eligibility seam" (AC-1) — spec 023 owns the policy, this spec executes the decision.
 *
 * There is NO cancellation rule, free-window arithmetic or fee calculation anywhere in
 * `lib/refunds/**` — `no-policy-leak.test.ts` asserts that at source level. Spec 023 does not exist
 * yet, so this ships the PORT with an inert default, the same idiom spec 020 used for
 * `CompletionEvidenceGate` and spec 021 for `DisputeGate`.
 *
 * The shipped default returns `{ eligible: false }`. That is CORRECT rather than a stub: with no
 * policy defined, nothing is automatically refundable, and the admin-override path — which never
 * consults this gate — remains fully usable. A default-allow here would refund money on a rule
 * nobody has written.
 *
 * STALENESS is structurally impossible rather than merely unlikely: the gate is consulted INSIDE
 * the refund transaction, under the payment row lock, immediately before the reservation is
 * written. There is no window in which a decision read earlier can be acted on later.
 */
import type { Executor } from '@/lib/offers/db';

export interface RefundEligibility {
  eligible: boolean;
  /** Required and > 0 when `eligible`. In the booking's own currency. */
  amountMinorUnits?: number;
  currencyCode?: string;
  /** Required when `eligible` — recorded verbatim on the refund line, immutably. */
  reason?: string;
  /** The spec 023 decision this came from, stored for audit. Opaque to this spec. */
  decisionRef?: string;
}

export type RefundEligibilityGate = (tx: Executor, bookingId: string) => Promise<RefundEligibility>;

/** The pre-spec-023 default: nothing is automatically refundable, because no policy exists. */
const NOT_ELIGIBLE: RefundEligibilityGate = async () => ({ eligible: false });

let currentGate: RefundEligibilityGate = NOT_ELIGIBLE;

/** Called once by spec 023 at startup to make the gate real. */
export function registerRefundEligibilityGate(gate: RefundEligibilityGate): void {
  currentGate = gate;
}

export function getRefundEligibilityGate(): RefundEligibilityGate {
  return currentGate;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetRefundEligibilityGate(): void {
  currentGate = NOT_ELIGIBLE;
}

/**
 * Which field of an `eligible: true` decision is unusable, or `null` when the decision is complete.
 *
 * Validating the SHAPE here (rather than trusting the supplier) is what turns "contradictory or
 * half-specified decision" from an undefined behaviour into `422 REFUND_ELIGIBILITY_INVALID`. A
 * missing amount is never defaulted and a mismatched currency is never coerced.
 */
export function invalidEligibilityField(decision: RefundEligibility, bookingCurrencyCode: string): string | null {
  if (!decision.eligible) return null;
  if (typeof decision.amountMinorUnits !== 'number' || !Number.isInteger(decision.amountMinorUnits)) {
    return 'amountMinorUnits';
  }
  if (decision.amountMinorUnits <= 0) return 'amountMinorUnits';
  if (typeof decision.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(decision.currencyCode)) return 'currencyCode';
  if (decision.currencyCode !== bookingCurrencyCode) return 'currencyCode';
  if (typeof decision.reason !== 'string' || decision.reason.trim().length === 0) return 'reason';
  return null;
}
