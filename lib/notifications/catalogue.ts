/**
 * Spec 026 §3 "Ownership boundary" — the closed notification catalogue: type → category → template.
 *
 * Bodies are RENDERED, never relayed (§4 "Retention and privacy"): a producing spec passes ids, amounts
 * and statuses, and the words come from here. That is what stops a notification becoming a channel for
 * one user to send another arbitrary content, and keeps another party's personal data out of the row.
 *
 * Criticality is a property of the CATEGORY (AC-2), so nothing here carries a per-type override.
 */
import type { NotificationCategory, NotificationParams, NotificationType } from '@/lib/types/notifications';

export interface CatalogueEntry {
  category: NotificationCategory;
  /** Every `{name}` placeholder the templates use. Rendering fails if one is missing. */
  params: readonly string[];
  title: string;
  body: string;
}

export const NOTIFICATION_CATALOGUE: Readonly<Record<NotificationType, CatalogueEntry>> = {
  provider_available: {
    category: 'booking',
    params: [],
    title: 'A provider you follow is available',
    body: 'A provider you asked about is now accepting bookings. Open their profile to book.',
  },
  booking_cancelled: {
    category: 'booking',
    params: ['refundAmount', 'feeAmount'],
    title: 'Booking cancelled',
    body: 'A booking you are part of was cancelled. Refund: {refundAmount}. Cancellation fee: {feeAmount}.',
  },
  no_show_reported: {
    category: 'booking',
    params: [],
    title: 'No-show reported',
    body: 'A no-show was reported for one of your bookings. Trust & Safety will review it.',
  },
  no_show_resolved: {
    category: 'booking',
    params: ['outcome'],
    title: 'No-show report resolved',
    body: 'A no-show report on one of your bookings was resolved. Outcome: {outcome}.',
  },
  message_received: {
    category: 'messages',
    params: [],
    title: 'New message',
    body: 'You have a new message about one of your bookings.',
  },
  refund_completed: {
    category: 'payments',
    params: [],
    title: 'Refund completed',
    body: 'Your refund has been completed and is on its way back to your payment method.',
  },
  refund_failed: {
    category: 'payments',
    params: [],
    title: 'Refund could not be completed',
    body: 'We could not complete your refund. Our team has been alerted and will follow up.',
  },
  payout_paid: {
    category: 'payments',
    params: [],
    title: 'Payout sent',
    body: 'A payout has been sent to your payout method.',
  },
  payout_failed: {
    category: 'payments',
    params: [],
    title: 'Payout failed',
    body: 'A payout to your payout method failed. Check your payout details in Earnings.',
  },
  request_cancelled: {
    category: 'provider_activity',
    params: [],
    title: 'Request cancelled',
    body: 'A customer cancelled a request you were notified about. No action is needed.',
  },
  /**
   * Spec 029 §9. Carries the review id and NOTHING of the review: no rating, no text, no author.
   * A notification must never become a channel for one user's words to reach another (§3
   * "Ownership boundary"), and a body that quoted a one-star review would be exactly that.
   */
  review_received: {
    category: 'provider_activity',
    params: [],
    title: 'You received a review',
    body: 'A customer left a review for one of your completed bookings. You can read it and reply once.',
  },
  /**
   * Spec 030 §9. Confirms to the REPORTER that their report reached a human. Carries the report id
   * and NOTHING of its content: no category, no description, no target. It promises no timeline and
   * no outcome, because master §64's restricted workflow means we can honestly promise neither.
   *
   * There is deliberately NO notification to the reported user, here or anywhere.
   */
  safety_report_received: {
    category: 'security',
    params: [],
    title: 'We received your safety report',
    body: 'Your report has been sent to our Trust & Safety team. We review every report; we cannot share the outcome.',
  },
  /**
   * Spec 031 §8 "Notifications". Tells the counterparty a dispute exists and where to read it, and
   * NOTHING of its substance: not the reason, not who is arguing what. The reason is one party's
   * words about another and must reach them inside the dispute, where both sides are visible.
   */
  dispute_opened: {
    category: 'booking',
    params: [],
    title: 'A dispute was opened on your booking',
    body: 'A dispute was opened on one of your bookings. Open the booking to see it and respond.',
  },
  /**
   * Carries that a decision exists, never the decision. A body reading "resolved in the
   * provider's favour" would deliver a verdict through a channel that cannot show the reasoning
   * master §2.3 requires alongside it.
   */
  dispute_resolved: {
    category: 'booking',
    params: [],
    title: 'Your dispute has been decided',
    body: 'A decision was recorded on a dispute you are part of. Open the booking to read it in full.',
  },
  dispute_closed: {
    category: 'booking',
    params: [],
    title: 'Your dispute is closed',
    body: 'A dispute you are part of is now closed. Open the booking to read the final outcome.',
  },
  review_response_posted: {
    category: 'booking',
    params: [],
    title: 'Your provider replied to your review',
    body: 'The provider replied to a review you left. Open the booking to read their response.',
  },
  no_show_response_requested: {
    category: 'operational',
    params: ['respondByAt'],
    title: 'Your response is needed',
    body: 'A no-show was reported on one of your bookings. Respond before {respondByAt}.',
  },
  service_notice: {
    category: 'operational',
    params: [],
    title: 'Important service notice',
    body: 'There is an important notice about your account or our service. Open the app for details.',
  },
  security_alert: {
    category: 'security',
    params: [],
    title: 'Security alert',
    body: 'There was important security activity on your account. Review Privacy & Security.',
  },
  promotion: {
    category: 'promotions',
    params: ['headline'],
    title: 'Something new for you',
    body: '{headline}',
  },
};

export class NotificationTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationTemplateError';
  }
}

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOGUE, value);
}

function substitute(template: string, params: NotificationParams): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === null || value === undefined ? '—' : String(value);
  });
}

/** Renders a type's title and body. Throws on an unknown type or a missing declared param. */
export function renderNotification(
  type: NotificationType,
  params: NotificationParams = {},
): { category: NotificationCategory; title: string; body: string } {
  if (!isNotificationType(type)) throw new NotificationTemplateError(`Unknown notification type "${String(type)}"`);
  const entry = NOTIFICATION_CATALOGUE[type];
  for (const name of entry.params) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new NotificationTemplateError(`Notification type "${type}" requires param "${name}"`);
    }
  }
  return { category: entry.category, title: substitute(entry.title, params), body: substitute(entry.body, params) };
}
