/**
 * Spec 026 §3 "Ownership boundary" — the closed notification catalogue: type → category → template.
 *
 * Bodies are RENDERED, never relayed (§4 "Retention and privacy"): a producing spec passes ids, amounts
 * and statuses, and the words come from here. That is what stops a notification becoming a channel for
 * one user to send another arbitrary content, and keeps another party's personal data out of the row.
 *
 * Criticality is a property of the CATEGORY (AC-2), so nothing here carries a per-type override.
 *
 * Spec 042 §3.8 (X-6, D-5): the WORDS live in the locale dictionaries (`notifications.<type>.title|body`),
 * so one row renders in each reader's locale. A money param is typed `{ amountMinorUnits, currencyCode }`
 * and formatted per locale; a historical row's plain-string param renders exactly as stored.
 */
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n/config';
import { formatMoney } from '@/lib/i18n/format';
import { en } from '@/lib/i18n/dictionaries/en';
import { translate } from '@/lib/i18n/translate';
import {
  isMoneyParam,
  type NotificationCategory,
  type NotificationParamValue,
  type NotificationParams,
  type NotificationType,
} from '@/lib/types/notifications';

interface CatalogueDefinition {
  category: NotificationCategory;
  /** Every `{name}` placeholder the templates use. Rendering fails if one is missing. */
  params: readonly string[];
}

export interface CatalogueEntry extends CatalogueDefinition {
  /** The canonical ENGLISH templates (spec 042 §3.8: from the `en` dictionary, the source of truth). */
  title: string;
  body: string;
}

const CATALOGUE_DEFINITIONS: Readonly<Record<NotificationType, CatalogueDefinition>> = {
  provider_available: {
    category: 'booking',
    params: [],
  },
  booking_cancelled: {
    category: 'booking',
    params: ['refundAmount', 'feeAmount'],
  },
  no_show_reported: {
    category: 'booking',
    params: [],
  },
  no_show_resolved: {
    category: 'booking',
    params: ['outcome'],
  },
  message_received: {
    category: 'messages',
    params: [],
  },
  refund_completed: {
    category: 'payments',
    params: [],
  },
  refund_failed: {
    category: 'payments',
    params: [],
  },
  payout_paid: {
    category: 'payments',
    params: [],
  },
  payout_failed: {
    category: 'payments',
    params: [],
  },
  request_cancelled: {
    category: 'provider_activity',
    params: [],
  },
  /**
   * Spec 029 §9. Carries the review id and NOTHING of the review: no rating, no text, no author.
   * A notification must never become a channel for one user's words to reach another (§3
   * "Ownership boundary"), and a body that quoted a one-star review would be exactly that.
   */
  review_received: {
    category: 'provider_activity',
    params: [],
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
  },
  /**
   * Spec 038 §3.11. CONTENT-FREE: tells the affected user an action exists and where to read it —
   * never the internal reason, the evidence, the origin or which admin acted. The account page shows
   * the standard explanation for the action type and any message the admin chose to share.
   */
  moderation_action_applied: {
    category: 'security',
    params: [],
  },
  moderation_appeal_decided: {
    category: 'security',
    params: [],
  },
  /**
   * Spec 031 §8 "Notifications". Tells the counterparty a dispute exists and where to read it, and
   * NOTHING of its substance: not the reason, not who is arguing what. The reason is one party's
   * words about another and must reach them inside the dispute, where both sides are visible.
   */
  dispute_opened: {
    category: 'booking',
    params: [],
  },
  /**
   * Carries that a decision exists, never the decision. A body reading "resolved in the
   * provider's favour" would deliver a verdict through a channel that cannot show the reasoning
   * master §2.3 requires alongside it.
   */
  dispute_resolved: {
    category: 'booking',
    params: [],
  },
  dispute_closed: {
    category: 'booking',
    params: [],
  },
  review_response_posted: {
    category: 'booking',
    params: [],
  },
  // Spec 032 §8. Content-free by design: the ticket is where the content lives, and a
  // notification must never become the channel it travels through.
  support_ticket_created: {
    category: 'operational',
    params: [],
  },
  support_reply_posted: {
    category: 'operational',
    params: [],
  },
  support_info_requested: {
    category: 'operational',
    params: [],
  },
  support_ticket_resolved: {
    category: 'operational',
    params: ['reopenBy'],
  },
  no_show_response_requested: {
    category: 'operational',
    params: ['respondByAt'],
  },
  service_notice: {
    category: 'operational',
    params: [],
  },
  security_alert: {
    category: 'security',
    params: [],
  },
  promotion: {
    category: 'promotions',
    params: ['headline'],
  },
};

export const NOTIFICATION_CATALOGUE: Readonly<Record<NotificationType, CatalogueEntry>> = Object.fromEntries(
  (Object.keys(CATALOGUE_DEFINITIONS) as NotificationType[]).map((type) => [
    type,
    { ...CATALOGUE_DEFINITIONS[type], title: en.notifications[type].title, body: en.notifications[type].body },
  ]),
) as Record<NotificationType, CatalogueEntry>;

export class NotificationTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationTemplateError';
  }
}

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOGUE, value);
}

function renderParam(value: NotificationParamValue | undefined, locale: Locale): string {
  if (value === null || value === undefined) return '—';
  if (isMoneyParam(value)) return formatMoney(value.amountMinorUnits, value.currencyCode, locale);
  return String(value);
}

/**
 * Renders a type's title and body for `locale` (default `en`, the canonical stored record). Throws on an
 * unknown type or a missing declared param.
 */
export function renderNotification(
  type: NotificationType,
  params: NotificationParams = {},
  locale: Locale = DEFAULT_LOCALE,
): { category: NotificationCategory; title: string; body: string } {
  if (!isNotificationType(type)) throw new NotificationTemplateError(`Unknown notification type "${String(type)}"`);
  const entry = NOTIFICATION_CATALOGUE[type];
  for (const name of entry.params) {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new NotificationTemplateError(`Notification type "${type}" requires param "${name}"`);
    }
  }
  const values = Object.fromEntries(Object.entries(params).map(([name, value]) => [name, renderParam(value, locale)]));
  // A placeholder with no value (never a declared one — checked above) renders as a dash.
  const fill = (text: string) => text.replace(/\{([a-zA-Z0-9_]+)\}/g, '—');
  return {
    category: entry.category,
    title: fill(translate(locale, `notifications.${type}.title`, values)),
    body: fill(translate(locale, `notifications.${type}.body`, values)),
  };
}
