/**
 * Spec 023 — the no-show domain barrel.
 *
 * No composition root of its own: the booking transitions and the refund eligibility gate are
 * registered by `lib/cancellation/index.ts`, because a no-show resolution reaches them THROUGH the
 * cancellation path rather than independently. Importing this module therefore registers nothing and
 * has no side effect beyond loading the modules below.
 */
export {
  NO_SHOW_REPORT_CLOSES_HOURS,
  NO_SHOW_REPORT_OPENS_MINUTES,
  NO_SHOW_RESPONSE_WINDOW_HOURS,
  listReportsForBooking,
  reportNoShow,
  respondToNoShow,
  withdrawNoShow,
} from './report';
export {
  NO_SHOW_READ_ACTION,
  NO_SHOW_RESOLVE_ACTION,
  NO_SHOW_RESOURCE,
  listNoShowReportsForAdmin,
  readNoShowReportForAdmin,
  requireNoShowReadPermission,
  requireNoShowResolvePermission,
  resolveNoShowReport,
} from './resolution';
export {
  countVerifiedNoShows,
  getNoShowReliabilitySink,
  registerNoShowReliabilitySink,
  resetNoShowReliabilitySink,
  subjectRoleForOutcome,
  type NoShowReliabilitySink,
  type VerifiedNoShowSignal,
} from './reliability';
export {
  deriveLocationSignal,
  gatherEvidence,
  registerNoShowCommunicationsEvidence,
  resetNoShowCommunicationsEvidence,
  type NoShowCommunicationsEvidence,
} from './evidence';
export {
  NO_SHOW_TRANSITIONS,
  isAllowedNoShowTransition,
  isTerminalNoShowStatus,
  recordNoShowTransition,
} from './state-machine';
export { runNoShowResponseSweep, type NoShowSweepResult } from './sweep';
export { NO_SHOW_EVIDENCE_RETENTION_DAYS, sweepNoShowEvidence, type NoShowRetentionResult } from './retention';
