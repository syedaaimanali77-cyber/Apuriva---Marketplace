/**
 * Spec 023 §3 "Notifications" — the port, with an inert default.
 *
 * Spec 026 owns notification infrastructure and has not shipped; `notifications` is still a spec 003
 * skeleton. Inventing a channel here would be a fake integration (master spec §132.21), so this
 * ships the seam and nothing else — the same idiom specs 020/021/022 used for their own ports.
 *
 * Emission is FIRE-AND-FORGET AFTER COMMIT. A notification failure must never roll back a completed
 * cancellation or a Trust & Safety resolution, so `emitCancellationNotification` never throws.
 */
import type { NoShowOutcome } from '@/lib/types/no-show';

export type CancellationNotificationEvent =
  | {
      kind: 'booking_cancelled';
      bookingId: string;
      recipientUserId: string;
      feeAmountMinorUnits: number;
      refundAmountMinorUnits: number;
      currencyCode: string;
    }
  | { kind: 'no_show_reported'; reportId: string; bookingId: string; recipientUserId: string }
  | { kind: 'no_show_response_requested'; reportId: string; recipientUserId: string; respondByAt: string }
  | { kind: 'no_show_resolved'; reportId: string; recipientUserId: string; outcome: NoShowOutcome };

export type CancellationNotificationSink = (event: CancellationNotificationEvent) => Promise<void>;

/** Logs a structured line and delivers nothing — there is nothing yet to deliver through. */
const LOG_ONLY: CancellationNotificationSink = async (event) => {
  console.log(JSON.stringify({ event: `notification.${event.kind}`, ...event }));
};

let currentSink: CancellationNotificationSink = LOG_ONLY;

/** Called once by spec 026 at startup to make delivery real. */
export function registerCancellationNotificationSink(sink: CancellationNotificationSink): void {
  currentSink = sink;
}

export function getCancellationNotificationSink(): CancellationNotificationSink {
  return currentSink;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetCancellationNotificationSink(): void {
  currentSink = LOG_ONLY;
}

export async function emitCancellationNotification(event: CancellationNotificationEvent): Promise<void> {
  try {
    await currentSink(event);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'notification.emit_failed',
        kind: event.kind,
        message: err instanceof Error ? err.message : 'unknown',
      }),
    );
  }
}
