/**
 * Spec 026 — the notifications domain barrel. `registerNotificationIntegration()` is called from
 * `instrumentation.ts`. Dependency direction: spec 026 → the four notification PORTS only; a producing
 * spec never learns whether the recipient has email enabled.
 */
export { NOTIFICATION_CATALOGUE, renderNotification, isNotificationType } from './catalogue';
export { notify, toNotificationDto, type NotifyResult } from './create';
export { NOTIFICATION_DEFAULTS, defaultCategoryChannelMap } from './defaults';
export { runNotificationDispatchSweep, type DispatchSweepResult } from './dispatch';
export { countUnreadNotifications, listNotifications, markAllNotificationsRead, markNotificationRead } from './inbox';
export {
  getNotificationPreferences,
  resolveOutboundChannels,
  setMarketingConsent,
  updateNotificationPreferences,
  validateCategoryChannelMap,
} from './preferences';
export { exportNotificationData, redactNotificationsForDeletedUser, sweepNotificationRetention } from './privacy';
export { registerNotificationIntegration, resetNotificationIntegrationRegistration } from './sinks';
