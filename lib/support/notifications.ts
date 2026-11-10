/**
 * Spec 032 §8 "Notifications" (DECIDED-12) — emission through spec 026's `notify()`, and nothing
 * else.
 *
 * NO SECOND NOTIFICATION SYSTEM. Four types were added to spec 026's existing closed catalogue in
 * the existing `operational` category; no migration was needed, because notification *type* is not
 * a database CHECK (only `notifications_category_ck` constrains categories) and `operational` is
 * already a member.
 *
 * EVERY BODY IS CONTENT-FREE. A support notification carries the fact and a pointer into the app —
 * never the ticket's subject, never the admin's words, never the resolution reason. Spec 026 §3's
 * ownership boundary says a notification must never become the channel the content travels
 * through, and the ticket is where the content belongs.
 *
 * WHO IS DELIBERATELY NOT NOTIFIED, and why each absence is a decision:
 *   - A REQUESTER's own reply notifies nobody. The queue is the admin's surface; a push per user
 *     message is noise, not information.
 *   - ASSIGNMENT notifies nobody. It is internal bookkeeping and tells the user nothing they can
 *     act on.
 *   - CLOSURE notifies nobody. The requester was already told at resolution, and closure asks
 *     nothing further of them.
 *   - An SLA BREACH notifies nobody. This is the most important of the four: a breach notification
 *     is the thin end of the automated consequence §7 puts out of scope, and adding one would
 *     quietly turn a visibility feature into an escalation engine.
 *
 * Emission is FIRE-AND-FORGET AFTER COMMIT, the shape specs 022/024/031 established: a failing sink
 * logs and is swallowed, because a notification must never roll back a ticket.
 */
import { notify } from '@/lib/notifications';
import type { NotificationType } from '@/lib/types/notifications';

export type SupportNotificationEvent =
  | { kind: 'support_ticket_created'; ticketId: string; recipientUserId: string }
  | { kind: 'support_reply_posted'; ticketId: string; recipientUserId: string; messageId: string }
  | { kind: 'support_info_requested'; ticketId: string; recipientUserId: string; messageId: string }
  | { kind: 'support_ticket_resolved'; ticketId: string; recipientUserId: string; reopenBy: string };

const TYPE_BY_KIND: Record<SupportNotificationEvent['kind'], NotificationType> = {
  support_ticket_created: 'support_ticket_created',
  support_reply_posted: 'support_reply_posted',
  support_info_requested: 'support_info_requested',
  support_ticket_resolved: 'support_ticket_resolved',
};

/**
 * Emits one support notification. Never throws.
 *
 * The `eventKey` is deterministic, so spec 026's duplicate suppression makes a retried emission a
 * no-op rather than a second push (spec 026 AC-7). A reply keys on the MESSAGE id, because a
 * ticket legitimately receives many replies and each is its own event; everything else keys on the
 * ticket, because it happens to a ticket at most once.
 */
export async function emitSupportNotification(event: SupportNotificationEvent): Promise<void> {
  const eventKey =
    event.kind === 'support_reply_posted' || event.kind === 'support_info_requested'
      ? `${event.kind}:${event.messageId}:${event.recipientUserId}`
      : `${event.kind}:${event.ticketId}:${event.recipientUserId}`;

  try {
    await notify({
      recipientUserId: event.recipientUserId,
      type: TYPE_BY_KIND[event.kind],
      eventKey,
      params: event.kind === 'support_ticket_resolved' ? { reopenBy: event.reopenBy } : {},
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'support.notification_failed',
        kind: event.kind,
        ticketId: event.ticketId,
        error: String(err),
      }),
    );
  }
}
