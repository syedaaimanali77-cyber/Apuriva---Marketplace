/**
 * Spec 031 — the public face of `lib/disputes`, and the spec's composition-root registration.
 *
 * `registerDisputeIntegration()` makes TWO ports real that shipped inert on purpose, and registers
 * the two booking transitions spec 020 reserved for this spec:
 *
 *   - spec 020's transition registry: `protected -> disputed` and `disputed -> protected`. Spec
 *     020's `SPEC_020_TRANSITIONS` is untouched, so `isAllowedBookingTransition()` still answers
 *     "does spec 020 own this pair?" exactly as before, and the database
 *     `bookings_status_transitions` rows seeded by migration 0028 remain the real authority.
 *   - spec 021's `DisputeGate` (default: no booking is ever disputed). Its own comment says "Spec
 *     031 registers the real gate when it ships"; this is that registration, and it is the whole
 *     of AC-2's payout hold.
 *   - spec 027's `dispute_evidence` file context (default: `422 FILE_CONTEXT_NOT_AVAILABLE`).
 *
 * IT DELIBERATELY DOES NOT REGISTER two other ports it could reach:
 *
 *   - spec 024's `PayoutHoldGate` — that slot is SPEC 038's (fraud, abuse, safety holds). This
 *     spec holds payouts through spec 021's protection state instead, which spec 024 already
 *     refuses to pay out from. Registering it here would be a second, redundant hold mechanism.
 *   - spec 022's `RefundEligibilityGate` — ALREADY OCCUPIED by spec 023 (`lib/cancellation/index.ts`)
 *     and single-valued. This spec reaches refunds only through spec 022's admin-override route,
 *     which never consults that gate.
 *
 * It must run AFTER spec 027, which resets and registers its own shipped policies, and after the
 * other specs that register contexts.
 */
import { registerBookingTransitions } from '@/lib/bookings';
import { registerDisputeGate, resetDisputeGate } from '@/lib/payments/protection-window';
import { disputeGate } from './gate';
import { registerDisputeEvidenceContext } from './evidence-policy';

export { openDispute, evaluateDisputeEligibility } from './create';
export {
  getDisputeForParticipant,
  listDisputesForUser,
  getDisputeForAdmin,
  listDisputeQueue,
  loadDisputeOwnership,
  loadBookingParties,
  loadBookingDisputePointer,
  isDisputeParticipant,
  resolveParticipantAccess,
  resolveAdminAccess,
  resolveRefundState,
  auditDispute,
  DISPUTE_EVENT_TYPES,
} from './read';
export {
  postParticipantMessage,
  postAdminMessage,
  listMessagesForParticipant,
  listMessagesForAdmin,
} from './messages';
export {
  linkEvidence,
  listEvidenceForParticipant,
  listEvidenceForAdmin,
  holdEvidenceFor,
  evidenceDescriptors,
} from './evidence';
export { disputeEvidencePolicy, registerDisputeEvidenceContext } from './evidence-policy';
export { claimDispute, resolveDispute, linkRefundApproval, setLegalHold } from './resolve';
export { fileAppeal, decideAppeal, readAppealForAdmin } from './appeal';
export { closeDispute, waiveAppeal, runDisputeAppealSweep, isRefundTerminal } from './close';
export { escalateToSafety } from './escalate';
export { disputeGate } from './gate';
export { summarizeForTriage } from './ai-assist';
export {
  requireDisputeReadPermission,
  requireDisputeResolvePermission,
  requireDisputeReviewAppealPermission,
  hasDisputeReadPermission,
  DISPUTES_RESOURCE,
  DISPUTES_READ_ACTION,
  DISPUTES_RESOLVE_ACTION,
  DISPUTES_REVIEW_APPEAL_ACTION,
} from './permissions';
export {
  canTransition,
  DISPUTE_TRANSITIONS,
  isResolvable,
  isContributable,
  isCloseable,
  isDisputeFinanciallyOpen,
  RESOLVABLE_STATUSES,
  CONTRIBUTABLE_STATUSES,
  CLOSEABLE_STATUSES,
  FINANCIALLY_OPEN_STATUSES,
} from './transitions';
export {
  parseOpenDisputeRequest,
  parseDisputeMessageRequest,
  parseEvidenceLinkRequest,
  parseResolveRequest,
  parseAppealRequest,
  parseAppealDecisionRequest,
  parseLinkRefundRequest,
  parseLegalHoldRequest,
  parseSafetyEscalationRequest,
  normalizeDisputeText,
} from './validation';
export {
  DEFAULT_DISPUTE_APPEAL_WINDOW_DAYS,
  MIN_DISPUTE_APPEAL_WINDOW_DAYS,
  MAX_DISPUTE_APPEAL_WINDOW_DAYS,
  disputeAppealWindowDays,
  appealWindowEndsAt,
  hasAppealWindowElapsed,
  isValidAppealWindowDays,
  MAX_DISPUTE_EVIDENCE,
  MAX_DISPUTE_MESSAGES,
  MIN_DISPUTE_REASON_LENGTH,
  MAX_DISPUTE_REASON_LENGTH,
  MIN_DISPUTE_REASONING_LENGTH,
  MAX_DISPUTE_REASONING_LENGTH,
  DISPUTE_EVIDENCE_CONTEXT,
} from './limits';

/** The two booking transitions this spec owns and seeds. */
export const SPEC_031_BOOKING_TRANSITIONS = [
  ['protected', 'disputed'],
  ['disputed', 'protected'],
] as const;

/** Called once from `instrumentation.ts` — the composition root specs 021–030 already use. */
export function registerDisputeIntegration(): void {
  registerBookingTransitions('spec 031 (disputes)', SPEC_031_BOOKING_TRANSITIONS);
  registerDisputeGate(disputeGate);
  registerDisputeEvidenceContext();
}

/** Returns spec 021's port to its documented pre-031 default. For tests and for rollback. */
export function resetDisputeIntegration(): void {
  resetDisputeGate();
}
