/**
 * Spec 038 §3.11 — emission through spec 026's `notify()`, and nothing else.
 *
 * CONTENT-FREE: no params at all. The notification says an action exists (or an appeal was decided)
 * and points at /account/moderation — never the internal reason, the evidence or who acted.
 *
 * FIRE-AND-FORGET AFTER COMMIT (the spec 022/024/031 shape): a failing sink logs and is swallowed,
 * because a notification must never undo an enforcement decision. The deterministic `eventKey`
 * makes a retried emission a no-op under spec 026's duplicate suppression.
 */
import { notify } from '@/lib/notifications';

export type ModerationNotificationEvent =
  | { kind: 'moderation_action_applied'; moderationActionId: string; recipientUserId: string }
  | { kind: 'moderation_appeal_decided'; appealId: string; recipientUserId: string };

export async function emitModerationNotification(event: ModerationNotificationEvent): Promise<void> {
  const id = event.kind === 'moderation_action_applied' ? event.moderationActionId : event.appealId;
  try {
    await notify({
      recipientUserId: event.recipientUserId,
      type: event.kind,
      eventKey: `${event.kind}:${id}:${event.recipientUserId}`,
      params: {},
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'moderation.notification_failed', kind: event.kind, id, error: err instanceof Error ? err.name : 'error' }));
  }
}
