/**
 * Spec 025 §7 "Out of scope" — spec 026 owns notification delivery.
 *
 * The same fire-and-forget, never-fail-the-write port contract as `lib/refunds/notifications.ts`:
 * emitted AFTER the send transaction commits, and a throwing sink is swallowed, so a notification
 * failure can never roll back or fail a message the server already stored. The event carries
 * identifiers only — never a message body.
 */

export type MessagingNotificationEvent = {
  kind: 'message_received';
  conversationId: string;
  bookingId: string;
  messageId: string;
  recipientUserId: string;
};

export type MessagingNotificationSink = (event: MessagingNotificationEvent) => Promise<void>;

/** The pre-spec-026 default: a structured log line, so the event is observable but not delivered. */
const LOG_ONLY: MessagingNotificationSink = async (event) => {
  console.log(JSON.stringify({ event: `messaging_notification.${event.kind}`, ...event }));
};

let currentSink: MessagingNotificationSink = LOG_ONLY;

/** Called once by spec 026 at startup to make the sink real. */
export function registerMessagingNotificationSink(sink: MessagingNotificationSink): void {
  currentSink = sink;
}

export function getMessagingNotificationSink(): MessagingNotificationSink {
  return currentSink;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetMessagingNotificationSink(): void {
  currentSink = LOG_ONLY;
}

/** Emits without ever letting the emission fail the send. */
export async function emitMessagingNotification(event: MessagingNotificationEvent): Promise<void> {
  try {
    await getMessagingNotificationSink()(event);
  } catch (err) {
    console.error(JSON.stringify({ event: 'messaging.notification_sink_failed', kind: event.kind, error: String(err) }));
  }
}
