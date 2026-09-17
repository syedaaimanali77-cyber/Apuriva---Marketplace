/**
 * Spec 026 §3 "Request and response types" — docs/specs/2026-08-28-026-notifications.md.
 *
 * `lib/types/notifications.ts`, not `packages/types` (which does not exist in this repository).
 */

/** Master spec §57's seven categories, verbatim (AC-4). Enforced again by `notifications_category_ck`. */
export const NOTIFICATION_CATEGORIES = [
  'booking',
  'messages',
  'payments',
  'security',
  'promotions',
  'provider_activity',
  'operational',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Non-overridable per master §57. A closed set, not a per-type flag (AC-2). */
export const CRITICAL_CATEGORIES = ['security', 'payments', 'operational'] as const;
export type CriticalCategory = (typeof CRITICAL_CATEGORIES)[number];

export function isCriticalCategory(category: NotificationCategory): category is CriticalCategory {
  return (CRITICAL_CATEGORIES as readonly string[]).includes(category);
}

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export type OutboundChannel = Exclude<NotificationChannel, 'in_app'>;
/** The FIXED fallback order for a critical delivery (AC-6): push → email → sms. */
export const OUTBOUND_CHANNELS = ['push', 'email', 'sms'] as const satisfies readonly OutboundChannel[];

/**
 * The closed catalogue this spec owns (AC-4). Each type maps to exactly one category in
 * `lib/notifications/catalogue.ts`; a producing spec can only hand over one of these.
 */
export const NOTIFICATION_TYPES = [
  // booking — spec 016 / 023
  'provider_available',
  'booking_cancelled',
  'no_show_reported',
  'no_show_resolved',
  // messages — spec 025
  'message_received',
  // payments — specs 022 / 024
  'refund_completed',
  'refund_failed',
  'payout_paid',
  'payout_failed',
  // provider_activity — spec 015
  'request_cancelled',
  // operational — spec 023 (a response deadline that affects the recipient's account standing)
  'no_show_response_requested',
  'service_notice',
  // security
  'security_alert',
  // promotions — consent-gated (AC-3) and capped (AC-5)
  'promotion',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationParams = Record<string, string | number | null>;

/** What a producing spec hands over — four fields and nothing else (§3). */
export interface NotificationEventInput {
  /** The recipient. Always a user id — never a profile id, never a role. */
  recipientUserId: string;
  /** From this spec's closed catalogue; determines category, template and criticality. */
  type: NotificationType;
  /**
   * The producing spec's DETERMINISTIC key for this event — e.g. `refund_completed:{refundId}`.
   * The same event retried must produce the same key (AC-7). Never a timestamp or a random value.
   */
  eventKey: string;
  /**
   * Template variables only — ids, amounts, instants, statuses. NEVER free text from another user,
   * and never another party's personal data (§4 "Retention and privacy").
   */
  params?: NotificationParams;
}

export interface NotificationDto {
  id: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface ChannelToggles {
  email: boolean;
  push: boolean;
  sms: boolean;
}

/** Per-category outbound channel map. In-app is absent because it is never optional. */
export type CategoryChannelMap = Record<NotificationCategory, ChannelToggles>;

/** A PATCH body's `categories`: any subset of categories, each any subset of channels. */
export type CategoryChannelPatch = Partial<Record<NotificationCategory, Partial<ChannelToggles>>>;

export interface NotificationPreferencesDto {
  categories: CategoryChannelMap;
  /** Which categories the UI must render as locked, with an explanation (§5). */
  nonOverridableCategories: NotificationCategory[];
  marketingConsentAt: string | null;
  /** `0` while no preference row exists yet — the value a first PATCH must send. */
  version: number;
}

export interface UpdateNotificationPreferencesRequest {
  categories: CategoryChannelPatch;
  version: number;
}

export interface MarketingConsentRequest {
  consent: boolean;
}

export interface MarketingConsentDto {
  marketingConsentAt: string | null;
}

export const NOTIFICATION_DELIVERY_STATUSES = ['pending', 'retrying', 'delivered', 'failed', 'skipped'] as const;
export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];
