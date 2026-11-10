/**
 * Spec 025 — post-booking messaging & conversations. The public surface the route handlers use.
 *
 * Nothing here registers at startup: the block gate (spec 030) and the notification sink (spec 026) ship
 * with inert defaults, and their owning specs register the real implementations when they ship.
 */
export { getConversation, resolveConversationAccess } from './conversations';
export { listMessagesForParticipant, markConversationRead, sendMessage } from './messages';
export {
  listConversationMessagesForAdmin,
  readConversationForAdmin,
  requireConversationReadPermission,
  validateAdminReason,
} from './admin';
export { runMessageRetentionSweep } from './retention';
export { registerConversationBlockGate, resetConversationBlockGate, type ConversationBlockGate } from './block-gate';
export { registerMessagingNotificationSink, resetMessagingNotificationSink } from './notifications';
