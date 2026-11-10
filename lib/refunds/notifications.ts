/**
 * Spec 022 §3 "Notification seam" — spec 026 owns notification infrastructure.
 *
 * The `notifications` table is still a spec 003 skeleton and spec 026 has not shipped, so this spec
 * ships a PORT with an inert default and no delivery mechanism, no template, no channel and no
 * preference handling of its own. Spec 026 registers the real sink when it ships; nothing else in
 * this spec changes.
 *
 * Emission is fire-and-forget AFTER the transaction commits, and a throwing sink is swallowed: a
 * notification failure must never roll back or fail a refund the provider has already executed.
 */

export type RefundNotificationEvent =
  | { kind: 'refund_completed'; refundId: string; bookingId: string; recipientUserId: string }
  | { kind: 'refund_failed'; refundId: string; bookingId: string; recipientUserId: string }
  | { kind: 'refund_approval_required'; adminActionId: string }
  | { kind: 'refund_approval_decided'; adminActionId: string; decision: 'approved' | 'rejected' };

export type RefundNotificationSink = (event: RefundNotificationEvent) => Promise<void>;

/** The pre-spec-026 default: a structured log line, so the event is observable but not delivered. */
const LOG_ONLY: RefundNotificationSink = async (event) => {
  console.log(JSON.stringify({ event: `refund_notification.${event.kind}`, ...event }));
};

let currentSink: RefundNotificationSink = LOG_ONLY;

/** Called once by spec 026 at startup to make the sink real. */
export function registerRefundNotificationSink(sink: RefundNotificationSink): void {
  currentSink = sink;
}

export function getRefundNotificationSink(): RefundNotificationSink {
  return currentSink;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetRefundNotificationSink(): void {
  currentSink = LOG_ONLY;
}

/** Emits without ever letting the emission fail the refund. */
export async function emitRefundNotification(event: RefundNotificationEvent): Promise<void> {
  try {
    await getRefundNotificationSink()(event);
  } catch (err) {
    console.error(JSON.stringify({ event: 'refund.notification_sink_failed', kind: event.kind, error: String(err) }));
  }
}
