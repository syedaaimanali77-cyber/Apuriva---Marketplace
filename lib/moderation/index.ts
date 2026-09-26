/**
 * Spec 038 — the public face of `lib/moderation`, and the spec's composition-root registration.
 *
 * `registerModerationIntegration()` makes three ports real that shipped inert on purpose:
 *   - spec 030's `SafetyRestrictionGate` (default: refuses with `422 RESTRICTION_UNAVAILABLE`);
 *   - spec 024's `PayoutHoldGate` (default: nothing is ever held);
 *   - spec 027's `moderation_evidence` file context (default: `422 FILE_CONTEXT_NOT_AVAILABLE`).
 *
 * It must run AFTER specs 024, 027 and 030 register theirs (spec 027 resets its registry).
 * Rolling spec 038 back returns all three ports to those documented defaults.
 *
 * NOTE: marketplace entry points and spec 005's session gate import the LEAF
 * `@/lib/moderation/standing`, never this barrel, because this barrel pulls in payouts and safety.
 */
// The composition-root registration lives in the lightweight `./register` (imported directly by
// `instrumentation.ts`); it is re-exported here so existing callers keep one import path.
export { registerModerationIntegration, resetModerationIntegration, lazySafetyRestrictionGate } from './register';

export {
  initiateModerationAction,
  executeModerationAction,
  requestReversal,
  executeReversal,
  reverseModerationActionInTx,
  reconcileRejected,
  type InitiateOutcome,
} from './actions';
export { listModerationActions, getModerationActionDetail, listMyModerationActions, parseModerationListFilters } from './read';
export { fileModerationAppeal, listModerationAppeals, decideModerationAppeal } from './appeals';
export {
  recordFraudSignal,
  listFraudSignals,
  triageFraudSignal,
  loadFraudSignalDto,
  AiFraudSignalsDisabledError,
} from './fraud-signals';
export { runFraudSignalSweep, activeRules, type FraudSignalSweepResult } from './rules';
export { isAiFraudSignalsEnabled } from './flags';
export { moderationPayoutHoldGate } from './payout-hold';
export { restrictFromSafetyReport } from './restriction-gate';
export { moderationEvidencePolicy, registerModerationEvidenceContext } from './evidence-policy';
export { listEvidenceIds, holdModerationEvidence } from './evidence';
export { MODERATION_EVENT_TYPES } from './audit';
export {
  parseCreateModerationActionRequest,
  parseReasonOnly,
  parseTriageRequest,
  parseAppealRequest,
  parseDecideAppealRequest,
} from './validation';
export * from './catalogue';

