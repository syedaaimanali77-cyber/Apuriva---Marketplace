/**
 * Spec 032 — the public face of `lib/support`. Routes and other specs import from here.
 *
 * `registerSupportIntegration()` is what `instrumentation.ts` calls. It registers exactly ONE
 * thing: spec 027's `support_attachment` file context, which ships inert (`422
 * FILE_CONTEXT_NOT_AVAILABLE`) until this runs. Rolling spec 032 back returns it to that documented
 * default, so no shipped spec breaks.
 *
 * NOTE WHAT IS NOT REGISTERED. This spec registers no booking transition (spec 020's table is
 * untouched), no payment or payout gate, no refund eligibility gate and no safety restriction
 * gate — because no support action is consequential. `lib/support/no-consequential-action.test.ts`
 * asserts the absence at source level.
 */
export { createSupportTicket } from './create';
export { getTicketForRequester, isRequesterOf, listMessages, listTicketsForUser, loadOwnTicketRow } from './read';
export { getTicketForAdmin, isRequesterOfTicket, listSupportInbox, type SupportInboxFilters } from './admin-read';
export { postAdminMessage, postRequesterMessage } from './messages';
export { addInternalNote, listNotes } from './notes';
export { assignTicket } from './assign';
export { setTicketPriority } from './triage';
export {
  assertResolutionAllowed,
  closeTicketAsAdmin,
  closeTicketAsRequester,
  reopenTicketAsAdmin,
  reopenTicketAsRequester,
  resolveTicket,
} from './resolve';
export { handOffTicket } from './handoff';
export { runSupportReopenSweep } from './sweep';
export { answerCommonQuestion, summarizeForTriage } from './ai-assist';
export { registerSupportAttachmentContext, supportAttachmentPolicy } from './attachment-policy';
export { auditSupport, SUPPORT_EVENT_TYPES, type SupportEventType } from './audit';
export { emitSupportNotification, type SupportNotificationEvent } from './notifications';
export {
  hasSupportReadPermission,
  hasSupportRespondPermission,
  requireSupportAssignPermission,
  requireSupportReadPermission,
  requireSupportResolvePermission,
  requireSupportRespondPermission,
  requireSupportTriagePermission,
  SUPPORT_RESOURCE,
} from './permissions';
export {
  supportContextNotAvailableError,
  supportParticipantConflictError,
  supportStatusConflictError,
  supportTicketClosedError,
  supportTicketNotFoundError,
} from './errors';
export { authorizeContext, projectContext } from './context';
export {
  CATEGORY_PRIORITY,
  MAX_SUPPORT_ATTACHMENTS,
  MAX_SUPPORT_BODY_LENGTH,
  MAX_SUPPORT_MESSAGES,
  priorityForCategory,
  SUPPORT_ATTACHMENT_CONTEXT,
} from './limits';
export {
  assertSlaTableValid,
  initialSlaDeadline,
  isSlaBreached,
  recomputeSlaDeadline,
  resumeSlaDeadline,
  SLA_HOURS_BY_PRIORITY,
  slaHoursFor,
} from './sla';
export {
  DEFAULT_SUPPORT_REOPEN_WINDOW_DAYS,
  hasReopenWindowElapsed,
  MAX_REQUESTER_REOPENS,
  reopenWindowEndsAt,
  supportReopenWindowDays,
} from './reopen-window';
export { canTransition, isLiveSupportStatus, isTerminalSupportStatus, SUPPORT_TRANSITIONS, type SupportActor } from './transitions';
export {
  parseAssignRequest,
  parseAssistantRequest,
  parseCreateTicketRequest,
  parseHandOffRequest,
  parsePriorityChangeRequest,
  parseResolveRequest,
  parseSupportMessageRequest,
  parseSupportNoteRequest,
} from './validation';

import { registerSupportAttachmentContext } from './attachment-policy';

/** Called from `instrumentation.ts`, AFTER spec 027 registers its own shipped policies. */
export function registerSupportIntegration(): void {
  registerSupportAttachmentContext();
}
