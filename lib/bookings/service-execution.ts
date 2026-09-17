/**
 * Spec 028 §9 "Migration order" — the composition-root wiring, in one place.
 *
 * Two registrations, into two ports that shipped inert on purpose:
 *   - spec 020's `CompletionEvidenceGate`, whose default returns `{ required: false }`;
 *   - spec 027's `booking_evidence` context, which is `422 FILE_CONTEXT_NOT_AVAILABLE` until a
 *     policy is registered for it.
 *
 * Doing it here, from `instrumentation.ts`, rather than at module-import time is what keeps the
 * dependency one-directional in production as well as in tests — the same shape specs 021–027 use.
 * Both registrations REPLACE rather than accumulate, so a hot-reloaded dev server and a repeated
 * call converge on the same state.
 *
 * Rolling spec 028 back returns spec 020's gate to its inert default and `booking_evidence` to
 * unavailable — each port's documented pre-028 behaviour, so no shipped spec breaks (§9).
 */
import { registerCompletionEvidenceGate } from './completion-evidence';
import { completionEvidenceGate } from './evidence';
import { registerBookingEvidenceContext } from './evidence-policy';

export function registerServiceExecutionIntegration(): void {
  registerCompletionEvidenceGate(completionEvidenceGate);
  registerBookingEvidenceContext();
}
