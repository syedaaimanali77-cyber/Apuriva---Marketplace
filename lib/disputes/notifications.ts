/**
 * Spec 031 §8 "Notifications" — emission through spec 026's `notify()`, and nothing else.
 *
 * NO SECOND NOTIFICATION SYSTEM. Three types were added to spec 026's existing closed catalogue in
 * the existing `booking` category; no migration was needed, because notification *type* is not a
 * database CHECK (only `notifications_category_ck` constrains categories) and `booking` is already
 * a member.
 *
 * EVERY BODY IS CONTENT-FREE. A dispute notification carries the booking pointer and nothing of the
 * argument: not the reason, not the decision, not the reasoning, not an amount. Spec 026 §3's
 * ownership boundary says a notification must never become a channel for one user's words to reach
 * another, and a dispute is the single place where that would do the most damage — the reason is
 * one party's account of the other's conduct, and it belongs inside the dispute where both sides
 * are visible and the reasoning sits next to it.
 *
 * FILING AN APPEAL NOTIFIES NOBODY, deliberately. The counterparty sees it in the dispute view, and
 * a push saying "you are being appealed" adds pressure without adding information. Admin-facing
 * alerting is the queue's job, not the notification system's.
 *
 * Emission is FIRE-AND-FORGET AFTER COMMIT, the shape specs 022/024 established: a failing sink
 * logs and is swallowed, because a notification must never roll back a dispute.
 */
import { notify } from '@/lib/notifications';
import type { NotificationType } from '@/lib/types/notifications';

export type DisputeNotificationEvent =
  | { kind: 'dispute_opened'; disputeId: string; recipientUserId: string }
  | { kind: 'dispute_resolved'; disputeId: string; recipientUserId: string }
  | { kind: 'dispute_closed'; disputeId: string; recipientUserId: string };

const TYPE_BY_KIND: Record<DisputeNotificationEvent['kind'], NotificationType> = {
  dispute_opened: 'dispute_opened',
  dispute_resolved: 'dispute_resolved',
  dispute_closed: 'dispute_closed',
};

/**
 * Emits one dispute notification. Never throws.
 *
 * The `eventKey` is deterministic (`<kind>:<disputeId>:<recipient>`), so spec 026's duplicate
 * suppression makes a retried emission a no-op rather than a second push — AC-7 of spec 026.
 */
export async function emitDisputeNotification(event: DisputeNotificationEvent): Promise<void> {
  try {
    await notify({
      recipientUserId: event.recipientUserId,
      type: TYPE_BY_KIND[event.kind],
      eventKey: `${event.kind}:${event.disputeId}:${event.recipientUserId}`,
      params: {},
    });
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'disputes.notification_failed', kind: event.kind, disputeId: event.disputeId, error: String(err) }),
    );
  }
}

/** Notifies both parties. Used by resolution and closure, which concern both sides equally. */
export async function emitToBothParties(
  kind: 'dispute_resolved' | 'dispute_closed',
  disputeId: string,
  parties: { customerUserId: string; providerUserId: string },
): Promise<void> {
  await emitDisputeNotification({ kind, disputeId, recipientUserId: parties.customerUserId });
  await emitDisputeNotification({ kind, disputeId, recipientUserId: parties.providerUserId });
}
