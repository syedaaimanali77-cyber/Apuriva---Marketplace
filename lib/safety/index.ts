/**
 * Spec 030 — the public face of `lib/safety`, and the spec's composition-root registration.
 *
 * `registerSafetyIntegration()` makes three ports real that shipped inert on purpose:
 *   - spec 025's `ConversationBlockGate` (default: nobody is blocked);
 *   - spec 017's `ProviderBlockSource` (default: nobody is blocked);
 *   - spec 027's `safety_evidence` file context (default: `422 FILE_CONTEXT_NOT_AVAILABLE`).
 *
 * IT DELIBERATELY DOES NOT REGISTER `SafetyRestrictionGate` (DECIDED-3). That registration is
 * SPEC 038's, from this same composition root, when it ships. Spec 030 owns no enforcement action,
 * so leaving that port unregistered is not an oversight — it is the design, and the refusing
 * default is what tells an admin the capability is not installed.
 *
 * It must run AFTER spec 027, which resets and registers its own shipped policies.
 */
import { registerConversationBlockGate, resetConversationBlockGate } from '@/lib/messaging/block-gate';
import { registerProviderBlockSource, resetProviderBlockSource } from '@/lib/matching/block-source';
import { blockedProviderProfileIds, conversationBlockStatus } from './blocks';
import { registerSafetyEvidenceContext } from './evidence-policy';

export { createBlock, listBlocks, removeBlock, conversationBlockStatus, blockedProviderProfileIds } from './blocks';
export {
  createSafetyReport,
  getSafetyReportForReporter,
  getSafetyReportForAdmin,
  listSafetyQueue,
  claimSafetyReport,
  escalateSafetyReport,
  resolveSafetyReport,
  setSafetyPriority,
  loadReportOwnership,
  auditSafety,
  SAFETY_EVENT_TYPES,
} from './reports';
export { listEvidenceFor, holdEvidenceFor } from './evidence';
export { safetyEvidencePolicy, registerSafetyEvidenceContext } from './evidence-policy';
export {
  requireSafetyReadPermission,
  requireSafetyEscalatePermission,
  requireSafetyResolvePermission,
  hasSafetyReadPermission,
  SAFETY_RESOURCE,
  SAFETY_READ_ACTION,
  SAFETY_ESCALATE_ACTION,
  SAFETY_RESOLVE_ACTION,
} from './permissions';
export {
  registerSafetyRestrictionGate,
  resetSafetyRestrictionGate,
  requestRestriction,
  type SafetyRestrictionGate,
  type RestrictionRequest,
  type RestrictionResult,
} from './restriction-gate';
export { canTransition, SAFETY_TRANSITIONS, isOpenSafetyStatus, OPEN_SAFETY_STATUSES } from './transitions';
export {
  parseCreateBlockRequest,
  parseCreateSafetyReportRequest,
  parseTransitionRequest,
  parseSetPriorityRequest,
  normalizeSafetyText,
} from './validation';
export {
  DEFAULT_SAFETY_PRIORITY,
  MAX_SAFETY_EVIDENCE,
  MIN_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MIN_SAFETY_REASON_LENGTH,
  MAX_SAFETY_REASON_LENGTH,
  SAFETY_EVIDENCE_CONTEXT,
} from './limits';

/** Called once from `instrumentation.ts` — the composition root specs 021–029 already use. */
export function registerSafetyIntegration(): void {
  registerConversationBlockGate(conversationBlockStatus);
  registerProviderBlockSource(blockedProviderProfileIds);
  registerSafetyEvidenceContext();
}

/** Returns spec 025's and spec 017's ports to their documented pre-030 defaults. For tests. */
export function resetSafetyIntegration(): void {
  resetConversationBlockGate();
  resetProviderBlockSource();
}
