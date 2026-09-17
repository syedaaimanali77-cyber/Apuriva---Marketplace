/**
 * Spec 026 §1 / §3 — registers this spec with the notification PORTS other specs already shipped with an
 * inert default. The ports are REGISTERED, never modified:
 *   - spec 022 `registerRefundNotificationSink`       (lib/refunds/notifications.ts)
 *   - spec 023 `registerCancellationNotificationSink` (lib/cancellation/notifications.ts)
 *   - spec 024 `registerPayoutNotificationSink`       (lib/payouts/ports.ts)
 *   - spec 025 `registerMessagingNotificationSink`    (lib/messaging/notifications.ts)
 *
 * Only those PORT modules are imported — never a producing spec's domain module (`boundaries.test.ts`).
 * Each mapping supplies a deterministic `eventKey` (AC-7) and only ids/amounts/statuses as params.
 *
 * Events with no USER recipient (spec 022's approval events and spec 024's finance-audience events) are
 * admin work-queue signals, not a user's notification; this spec has no admin inbox, so they stay logged.
 * Spec 015 (request cancellation) and spec 016 (availability opt-in) have no port: they call `notify()`
 * directly from `lib/requests/cancellation-notification.ts` and `lib/availability/notify-dispatch.ts`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { registerCancellationNotificationSink, type CancellationNotificationEvent } from '@/lib/cancellation/notifications';
import { registerMessagingNotificationSink, type MessagingNotificationEvent } from '@/lib/messaging/notifications';
import { registerPayoutNotificationSink, type PayoutNotificationEvent } from '@/lib/payouts/ports';
import { registerRefundNotificationSink, type RefundNotificationEvent } from '@/lib/refunds/notifications';
import type { NotificationEventInput } from '@/lib/types/notifications';
import { notify } from './create';
import { queryRows } from './sql';

function logUnrouted(source: string, kind: string): void {
  console.log(JSON.stringify({ event: 'notification.not_user_addressed', source, kind }));
}

export function formatMinorUnits(amountMinorUnits: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currencyCode }).format(amountMinorUnits / 100);
  } catch {
    return `${currencyCode} ${(amountMinorUnits / 100).toFixed(2)}`;
  }
}

export function refundEventToNotification(event: RefundNotificationEvent): NotificationEventInput | null {
  switch (event.kind) {
    case 'refund_completed':
    case 'refund_failed':
      return {
        recipientUserId: event.recipientUserId,
        type: event.kind,
        eventKey: `${event.kind}:${event.refundId}`,
        params: { refundId: event.refundId, bookingId: event.bookingId },
      };
    default:
      return null;
  }
}

export function cancellationEventToNotification(event: CancellationNotificationEvent): NotificationEventInput {
  switch (event.kind) {
    case 'booking_cancelled':
      return {
        recipientUserId: event.recipientUserId,
        type: 'booking_cancelled',
        eventKey: `booking_cancelled:${event.bookingId}`,
        params: {
          bookingId: event.bookingId,
          refundAmount: formatMinorUnits(event.refundAmountMinorUnits, event.currencyCode),
          feeAmount: formatMinorUnits(event.feeAmountMinorUnits, event.currencyCode),
        },
      };
    case 'no_show_reported':
      return {
        recipientUserId: event.recipientUserId,
        type: 'no_show_reported',
        eventKey: `no_show_reported:${event.reportId}`,
        params: { reportId: event.reportId, bookingId: event.bookingId },
      };
    case 'no_show_response_requested':
      return {
        recipientUserId: event.recipientUserId,
        type: 'no_show_response_requested',
        eventKey: `no_show_response_requested:${event.reportId}`,
        params: { reportId: event.reportId, respondByAt: event.respondByAt },
      };
    case 'no_show_resolved':
      return {
        recipientUserId: event.recipientUserId,
        type: 'no_show_resolved',
        eventKey: `no_show_resolved:${event.reportId}`,
        params: { reportId: event.reportId, outcome: event.outcome },
      };
  }
}

export function messagingEventToNotification(event: MessagingNotificationEvent): NotificationEventInput {
  return {
    recipientUserId: event.recipientUserId,
    type: 'message_received',
    eventKey: `message_received:${event.messageId}`,
    // Identifiers only — never a message body (spec 025's port already guarantees none is carried).
    params: { conversationId: event.conversationId, bookingId: event.bookingId },
  };
}

async function payoutEventToNotification(event: PayoutNotificationEvent): Promise<NotificationEventInput | null> {
  if (event.kind === 'payout_escalated' || (event.kind === 'payout_failed' && event.audience !== 'provider')) return null;
  const [row] = await queryRows<{ user_id: string; attempt_count: number }>(
    getDb(),
    sql`SELECT pp.user_id, p.attempt_count FROM payouts p
          JOIN provider_profiles pp ON pp.id = ${event.providerProfileId}
         WHERE p.id = ${event.payoutId}`,
  );
  if (!row) return null;
  return {
    recipientUserId: row.user_id,
    type: event.kind,
    // A payout may fail, be retried and fail again: the attempt number keeps each failure its own event.
    eventKey: event.kind === 'payout_paid' ? `payout_paid:${event.payoutId}` : `payout_failed:${event.payoutId}:${row.attempt_count}`,
    params: { payoutId: event.payoutId },
  };
}

let registered = false;

export function registerNotificationIntegration(): void {
  if (registered) return;
  registered = true;

  registerRefundNotificationSink(async (event) => {
    const input = refundEventToNotification(event);
    if (!input) return logUnrouted('refunds', event.kind);
    await notify(input);
  });
  registerCancellationNotificationSink(async (event) => {
    await notify(cancellationEventToNotification(event));
  });
  registerMessagingNotificationSink(async (event) => {
    await notify(messagingEventToNotification(event));
  });
  registerPayoutNotificationSink(async (event) => {
    const input = await payoutEventToNotification(event);
    if (!input) return logUnrouted('payouts', event.kind);
    await notify(input);
  });
}

/** Test-only: allows a suite to re-register after a producing spec's reset restored its inert default. */
export function resetNotificationIntegrationRegistration(): void {
  registered = false;
}
