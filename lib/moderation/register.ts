/**
 * Spec 038 — the LIGHTWEIGHT composition-root registration, imported by `instrumentation.ts`.
 *
 * `registerModerationIntegration()` makes three ports real that shipped inert on purpose:
 *   - spec 030's `SafetyRestrictionGate` (default: refuses with `422 RESTRICTION_UNAVAILABLE`);
 *   - spec 024's `PayoutHoldGate` (default: nothing is ever held);
 *   - spec 027's `moderation_evidence` file context (default: `422 FILE_CONTEXT_NOT_AVAILABLE`).
 *
 * It must run AFTER specs 024, 027 and 030 register theirs (spec 027 resets its registry).
 * Rolling spec 038 back returns all three ports to those documented defaults.
 *
 * WHY THIS IS NOT THE `@/lib/moderation` BARREL. That barrel re-exports the whole moderation
 * implementation (actions, appeals, fraud signals, rules, validation…), and `instrumentation.ts` is
 * recompiled — for Node AND Edge — whenever anything in its import graph changes. Only these three
 * registrations are needed at startup, so this module imports only what they need:
 *   - the payout-hold gate is a single small query, registered directly;
 *   - the evidence policy must be a registered object from the start, registered directly;
 *   - the safety restriction gate needs the full moderation action engine, so it is registered as
 *     a thin wrapper that loads `./restriction-gate` on first use — when a Trust & Safety admin
 *     actually requests a restriction — and then behaves identically (same result, same errors).
 */
import { registerPayoutHoldGate, resetPayoutHoldGate } from '@/lib/payouts/ports';
import {
  registerSafetyRestrictionGate,
  resetSafetyRestrictionGate,
  type SafetyRestrictionGate,
} from '@/lib/safety/restriction-gate';
import { registerModerationEvidenceContext } from './evidence-policy';
import { moderationPayoutHoldGate } from './payout-hold';

/**
 * Spec 030's port, backed by `restrictFromSafetyReport`. Not wrapped in a try/catch: a refusal or
 * failure must still reach the resolving admin and fail spec 030's surrounding transaction.
 */
export const lazySafetyRestrictionGate: SafetyRestrictionGate = async (request) => {
  const { restrictFromSafetyReport } = await import('./restriction-gate');
  return restrictFromSafetyReport(request);
};

/** Called once from `instrumentation.ts`. Idempotent: each registration replaces, never accumulates. */
export function registerModerationIntegration(): void {
  registerSafetyRestrictionGate(lazySafetyRestrictionGate);
  registerPayoutHoldGate(moderationPayoutHoldGate);
  registerModerationEvidenceContext();
}

/** Returns spec 030's and spec 024's ports to their documented pre-038 defaults. For tests. */
export function resetModerationIntegration(): void {
  resetSafetyRestrictionGate();
  resetPayoutHoldGate();
}
