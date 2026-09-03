/**
 * Baseline schema — docs/specs/2026-08-28-003-database-core-data-model.md.
 *
 * Every table here is deliberately minimal: identity (`id`), audit (`created_at`/`updated_at`),
 * optimistic-concurrency (`version`), and structural foreign keys only. Feature-specific columns
 * (an Offer's price, a Booking's schedule, a Payment's amount, ...) are added by each entity's
 * owning spec — this file is the shared foundation they build on, not the finished schema.
 *
 * Conventions encoded below (see docs/specs/2026-08-28-003-database-core-data-model.md §4):
 *   - `id`/`auditColumns`/`version()`/`baseColumns()` — identity/audit/concurrency baseline for
 *     every table.
 *   - `moneyColumns()` + `moneyPairChecks()` — AC-1: minor-units + currency-code pair, never
 *     numeric/float/double, with a DB CHECK tying the pair together. Not used by any table yet
 *     (no baseline table has a real monetary value) — ready for the owning spec that adds one.
 *   - `scheduledTimeColumns()` — AC-2: a timestamptz instant paired with the original IANA
 *     timezone identifier. Not used by any table yet, for the same reason as money.
 *   - `status` column + `*_status_history` + `*_status_transitions` tables (AC-3) for the five
 *     state-machine entities (Request, Offer, Booking, Payment, Payout). The DB trigger that
 *     enforces transitions against the `*_status_transitions` whitelist is appended by hand to
 *     drizzle/0001_baseline_schema's generated SQL — Drizzle's schema DSL has no
 *     function/trigger builder. This spec does not decide or populate any entity's actual
 *     states/transitions; the transition tables start empty.
 *   - Every FK below is `onDelete: 'restrict'` and has its own covering index, per AC-4.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Shared conventions
// ---------------------------------------------------------------------------

/** `id uuid primary key default gen_random_uuid()` */
export const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/** `created_at` / `updated_at timestamptz not null default now()` */
export const auditColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** AC-6 optimistic concurrency: paired with `UPDATE ... WHERE id = $1 AND version = $2`. */
export const version = () => integer('version').notNull().default(1);

/** Every baseline table gets id + audit + version; nothing else, per spec 003 §4. */
export const baseColumns = () => ({
  id: id(),
  ...auditColumns(),
  version: version(),
});

/**
 * AC-1 money convention: call with a semantic base name (e.g. "deposit") to get that value's
 * own `<base>_amount_minor_units integer` + `<base>_currency_code text` pair — never a single
 * `amount`/`currency` pair reused across more than one monetary value on the same row.
 */
export function moneyColumns<Base extends string>(base: Base) {
  return {
    [`${base}AmountMinorUnits`]: integer(`${base}_amount_minor_units`),
    [`${base}CurrencyCode`]: text(`${base}_currency_code`),
  } as Record<`${Base}AmountMinorUnits`, ReturnType<typeof integer>> &
    Record<`${Base}CurrencyCode`, ReturnType<typeof text>>;
}

/**
 * AC-1 DB constraints for a `moneyColumns(base)` pair: both columns null together or set
 * together, and the currency code (when set) is a 3-letter uppercase ISO-4217-shaped code.
 * `tableName` + `base` must match what `moneyColumns` was called with, for the raw SQL
 * identifiers to line up.
 */
export function moneyPairChecks(tableName: string, base: string) {
  const amountCol = `${base}_amount_minor_units`;
  const currencyCol = `${base}_currency_code`;
  return [
    check(
      `${tableName}_${base}_pair_ck`,
      sql`(${sql.raw(`"${amountCol}"`)} is null) = (${sql.raw(`"${currencyCol}"`)} is null)`,
    ),
    check(
      `${tableName}_${base}_currency_format_ck`,
      sql`${sql.raw(`"${currencyCol}"`)} is null or ${sql.raw(`"${currencyCol}"`)} ~ '^[A-Z]{3}$'`,
    ),
  ];
}

/**
 * AC-2 scheduled/appointment-local-time convention: call with a semantic base name (e.g.
 * "scheduled") to get `<base>_at timestamptz` (the instant, UTC) + `<base>_timezone text` (the
 * original IANA identifier, e.g. "Asia/Karachi") so the local wall-clock time is reconstructible
 * regardless of server timezone.
 */
export function scheduledTimeColumns<Base extends string>(base: Base) {
  return {
    [`${base}At`]: timestamp(`${base}_at`, { withTimezone: true }),
    [`${base}Timezone`]: text(`${base}_timezone`),
  } as Record<`${Base}At`, ReturnType<typeof timestamp>> & Record<`${Base}Timezone`, ReturnType<typeof text>>;
}

// ---------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------

export const users = pgTable('users', { ...baseColumns() });

export const customerProfiles = pgTable(
  'customer_profiles',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('customer_profiles_user_id_idx').on(t.userId)],
);

export const providerProfiles = pgTable(
  'provider_profiles',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('provider_profiles_user_id_idx').on(t.userId)],
);

export const adminProfiles = pgTable(
  'admin_profiles',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('admin_profiles_user_id_idx').on(t.userId)],
);

export const roles = pgTable('roles', { ...baseColumns() });

export const permissions = pgTable('permissions', { ...baseColumns() });

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const categories = pgTable('categories', { ...baseColumns() });

export const subcategories = pgTable(
  'subcategories',
  {
    ...baseColumns(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
  },
  (t) => [index('subcategories_category_id_idx').on(t.categoryId)],
);

export const services = pgTable(
  'services',
  {
    ...baseColumns(),
    subcategoryId: uuid('subcategory_id')
      .notNull()
      .references(() => subcategories.id, { onDelete: 'restrict' }),
  },
  (t) => [index('services_subcategory_id_idx').on(t.subcategoryId)],
);

export const serviceFields = pgTable(
  'service_fields',
  {
    ...baseColumns(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
  },
  (t) => [index('service_fields_service_id_idx').on(t.serviceId)],
);

export const serviceRequirements = pgTable(
  'service_requirements',
  {
    ...baseColumns(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
  },
  (t) => [index('service_requirements_service_id_idx').on(t.serviceId)],
);

export const serviceFaqs = pgTable(
  'service_faqs',
  {
    ...baseColumns(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
  },
  (t) => [index('service_faqs_service_id_idx').on(t.serviceId)],
);

export const servicePackages = pgTable(
  'service_packages',
  {
    ...baseColumns(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
  },
  (t) => [index('service_packages_service_id_idx').on(t.serviceId)],
);

// ---------------------------------------------------------------------------
// Provider catalog & availability
// ---------------------------------------------------------------------------

export const providerServices = pgTable(
  'provider_services',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('provider_services_provider_profile_id_idx').on(t.providerProfileId),
    index('provider_services_service_id_idx').on(t.serviceId),
    uniqueIndex('provider_services_provider_service_uq').on(t.providerProfileId, t.serviceId),
  ],
);

export const providerAvailabilities = pgTable(
  'provider_availabilities',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
  },
  (t) => [index('provider_availabilities_provider_profile_id_idx').on(t.providerProfileId)],
);

export const providerAvailabilityOverrides = pgTable(
  'provider_availability_overrides',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
  },
  (t) => [index('provider_availability_overrides_provider_profile_id_idx').on(t.providerProfileId)],
);

export const providerServiceAreas = pgTable(
  'provider_service_areas',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
  },
  (t) => [index('provider_service_areas_provider_profile_id_idx').on(t.providerProfileId)],
);

// ---------------------------------------------------------------------------
// Requests (state machine: AC-3)
// ---------------------------------------------------------------------------

export const requests = pgTable(
  'requests',
  {
    ...baseColumns(),
    customerProfileId: uuid('customer_profile_id')
      .notNull()
      .references(() => customerProfiles.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
  },
  (t) => [
    index('requests_customer_profile_id_idx').on(t.customerProfileId),
    index('requests_service_id_idx').on(t.serviceId),
  ],
);

export const requestFieldValues = pgTable(
  'request_field_values',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    serviceFieldId: uuid('service_field_id')
      .notNull()
      .references(() => serviceFields.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('request_field_values_request_id_idx').on(t.requestId),
    index('request_field_values_service_field_id_idx').on(t.serviceFieldId),
    uniqueIndex('request_field_values_request_field_uq').on(t.requestId, t.serviceFieldId),
  ],
);

export const requestAttachments = pgTable(
  'request_attachments',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
  },
  (t) => [index('request_attachments_request_id_idx').on(t.requestId)],
);

export const requestProviderMatches = pgTable(
  'request_provider_matches',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('request_provider_matches_request_id_idx').on(t.requestId),
    index('request_provider_matches_provider_profile_id_idx').on(t.providerProfileId),
    uniqueIndex('request_provider_matches_request_provider_uq').on(t.requestId, t.providerProfileId),
  ],
);

export const requestsStatusHistory = pgTable(
  'requests_status_history',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('requests_status_history_request_id_idx').on(t.requestId),
    index('requests_status_history_actor_user_id_idx').on(t.actorUserId),
  ],
);

export const requestsStatusTransitions = pgTable(
  'requests_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('requests_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

// ---------------------------------------------------------------------------
// Offers (state machine: AC-3)
// ---------------------------------------------------------------------------

export const offers = pgTable(
  'offers',
  {
    ...baseColumns(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => requests.id, { onDelete: 'restrict' }),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
  },
  (t) => [
    index('offers_request_id_idx').on(t.requestId),
    index('offers_provider_profile_id_idx').on(t.providerProfileId),
  ],
);

export const offerRevisions = pgTable(
  'offer_revisions',
  {
    ...baseColumns(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
  },
  (t) => [index('offer_revisions_offer_id_idx').on(t.offerId)],
);

export const offerMessages = pgTable(
  'offer_messages',
  {
    ...baseColumns(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('offer_messages_offer_id_idx').on(t.offerId),
    index('offer_messages_sender_user_id_idx').on(t.senderUserId),
  ],
);

export const offersStatusHistory = pgTable(
  'offers_status_history',
  {
    ...baseColumns(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('offers_status_history_offer_id_idx').on(t.offerId),
    index('offers_status_history_actor_user_id_idx').on(t.actorUserId),
  ],
);

export const offersStatusTransitions = pgTable(
  'offers_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('offers_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

// ---------------------------------------------------------------------------
// Bookings (state machine: AC-3)
// ---------------------------------------------------------------------------

export const bookings = pgTable(
  'bookings',
  {
    ...baseColumns(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
  },
  (t) => [index('bookings_offer_id_idx').on(t.offerId)],
);

export const bookingMilestones = pgTable(
  'booking_milestones',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
  },
  (t) => [index('booking_milestones_booking_id_idx').on(t.bookingId)],
);

export const bookingsStatusHistory = pgTable(
  'bookings_status_history',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bookings_status_history_booking_id_idx').on(t.bookingId),
    index('bookings_status_history_actor_user_id_idx').on(t.actorUserId),
  ],
);

export const bookingsStatusTransitions = pgTable(
  'bookings_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('bookings_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

// ---------------------------------------------------------------------------
// Payments & payouts (state machines: AC-3)
// ---------------------------------------------------------------------------

export const payments = pgTable(
  'payments',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
  },
  (t) => [index('payments_booking_id_idx').on(t.bookingId)],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    ...baseColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
  },
  (t) => [index('payment_attempts_payment_id_idx').on(t.paymentId)],
);

export const paymentAuthorizations = pgTable(
  'payment_authorizations',
  {
    ...baseColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
  },
  (t) => [index('payment_authorizations_payment_id_idx').on(t.paymentId)],
);

export const refunds = pgTable(
  'refunds',
  {
    ...baseColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
  },
  (t) => [index('refunds_payment_id_idx').on(t.paymentId)],
);

export const refundLines = pgTable(
  'refund_lines',
  {
    ...baseColumns(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
  },
  (t) => [index('refund_lines_refund_id_idx').on(t.refundId)],
);

export const payouts = pgTable(
  'payouts',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
  },
  (t) => [index('payouts_provider_profile_id_idx').on(t.providerProfileId)],
);

export const payoutMethods = pgTable(
  'payout_methods',
  {
    ...baseColumns(),
    providerProfileId: uuid('provider_profile_id')
      .notNull()
      .references(() => providerProfiles.id, { onDelete: 'restrict' }),
  },
  (t) => [index('payout_methods_provider_profile_id_idx').on(t.providerProfileId)],
);

export const paymentsStatusHistory = pgTable(
  'payments_status_history',
  {
    ...baseColumns(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payments_status_history_payment_id_idx').on(t.paymentId),
    index('payments_status_history_actor_user_id_idx').on(t.actorUserId),
  ],
);

export const paymentsStatusTransitions = pgTable(
  'payments_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('payments_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

export const payoutsStatusHistory = pgTable(
  'payouts_status_history',
  {
    ...baseColumns(),
    payoutId: uuid('payout_id')
      .notNull()
      .references(() => payouts.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payouts_status_history_payout_id_idx').on(t.payoutId),
    index('payouts_status_history_actor_user_id_idx').on(t.actorUserId),
  ],
);

export const payoutsStatusTransitions = pgTable(
  'payouts_status_transitions',
  {
    ...baseColumns(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
  },
  (t) => [uniqueIndex('payouts_status_transitions_from_to_uq').on(t.fromStatus, t.toStatus)],
);

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    ...baseColumns(),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'restrict' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('conversations_request_id_idx').on(t.requestId),
    index('conversations_booking_id_idx').on(t.bookingId),
  ],
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    ...baseColumns(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('conversation_participants_conversation_id_idx').on(t.conversationId),
    index('conversation_participants_user_id_idx').on(t.userId),
    uniqueIndex('conversation_participants_conversation_user_uq').on(t.conversationId, t.userId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    ...baseColumns(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('messages_conversation_id_idx').on(t.conversationId),
    index('messages_sender_user_id_idx').on(t.senderUserId),
  ],
);

export const messageAttachments = pgTable(
  'message_attachments',
  {
    ...baseColumns(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'restrict' }),
  },
  (t) => [index('message_attachments_message_id_idx').on(t.messageId)],
);

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const reviews = pgTable(
  'reviews',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('reviews_booking_id_idx').on(t.bookingId), index('reviews_author_user_id_idx').on(t.authorUserId)],
);

export const reviewResponses = pgTable(
  'review_responses',
  {
    ...baseColumns(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    responderUserId: uuid('responder_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('review_responses_review_id_idx').on(t.reviewId),
    index('review_responses_responder_user_id_idx').on(t.responderUserId),
  ],
);

export const reviewReports = pgTable(
  'review_reports',
  {
    ...baseColumns(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('review_reports_review_id_idx').on(t.reviewId),
    index('review_reports_reporter_user_id_idx').on(t.reporterUserId),
  ],
);

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export const disputes = pgTable(
  'disputes',
  {
    ...baseColumns(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    openedByUserId: uuid('opened_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('disputes_booking_id_idx').on(t.bookingId),
    index('disputes_opened_by_user_id_idx').on(t.openedByUserId),
  ],
);

export const disputeEvidence = pgTable(
  'dispute_evidence',
  {
    ...baseColumns(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    submittedByUserId: uuid('submitted_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('dispute_evidence_dispute_id_idx').on(t.disputeId),
    index('dispute_evidence_submitted_by_user_id_idx').on(t.submittedByUserId),
  ],
);

export const disputeMessages = pgTable(
  'dispute_messages',
  {
    ...baseColumns(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('dispute_messages_dispute_id_idx').on(t.disputeId),
    index('dispute_messages_sender_user_id_idx').on(t.senderUserId),
  ],
);

export const disputeResolutions = pgTable(
  'dispute_resolutions',
  {
    ...baseColumns(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
  },
  (t) => [index('dispute_resolutions_dispute_id_idx').on(t.disputeId)],
);

export const disputeAppeals = pgTable(
  'dispute_appeals',
  {
    ...baseColumns(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'restrict' }),
    appellantUserId: uuid('appellant_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('dispute_appeals_dispute_id_idx').on(t.disputeId),
    index('dispute_appeals_appellant_user_id_idx').on(t.appellantUserId),
  ],
);

// ---------------------------------------------------------------------------
// Support & safety
// ---------------------------------------------------------------------------

export const safetyReports = pgTable(
  'safety_reports',
  {
    ...baseColumns(),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('safety_reports_reporter_user_id_idx').on(t.reporterUserId),
    index('safety_reports_booking_id_idx').on(t.bookingId),
  ],
);

export const supportTickets = pgTable(
  'support_tickets',
  {
    ...baseColumns(),
    requesterUserId: uuid('requester_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('support_tickets_requester_user_id_idx').on(t.requesterUserId)],
);

export const supportMessages = pgTable(
  'support_messages',
  {
    ...baseColumns(),
    supportTicketId: uuid('support_ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'restrict' }),
    senderUserId: uuid('sender_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('support_messages_support_ticket_id_idx').on(t.supportTicketId),
    index('support_messages_sender_user_id_idx').on(t.senderUserId),
  ],
);

export const supportNotes = pgTable(
  'support_notes',
  {
    ...baseColumns(),
    supportTicketId: uuid('support_ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'restrict' }),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('support_notes_support_ticket_id_idx').on(t.supportTicketId),
    index('support_notes_author_user_id_idx').on(t.authorUserId),
  ],
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    ...baseColumns(),
    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('notifications_recipient_user_id_idx').on(t.recipientUserId)],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('notification_preferences_user_id_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export const aiConversations = pgTable(
  'ai_conversations',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_conversations_user_id_idx').on(t.userId)],
);

export const aiMessages = pgTable(
  'ai_messages',
  {
    ...baseColumns(),
    aiConversationId: uuid('ai_conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_messages_ai_conversation_id_idx').on(t.aiConversationId)],
);

export const aiMemories = pgTable(
  'ai_memories',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_memories_user_id_idx').on(t.userId)],
);

export const aiActions = pgTable(
  'ai_actions',
  {
    ...baseColumns(),
    aiConversationId: uuid('ai_conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_actions_ai_conversation_id_idx').on(t.aiConversationId)],
);

export const aiToolCalls = pgTable(
  'ai_tool_calls',
  {
    ...baseColumns(),
    aiActionId: uuid('ai_action_id')
      .notNull()
      .references(() => aiActions.id, { onDelete: 'restrict' }),
  },
  (t) => [index('ai_tool_calls_ai_action_id_idx').on(t.aiActionId)],
);

// ---------------------------------------------------------------------------
// Platform / admin
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    ...baseColumns(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('audit_logs_actor_user_id_idx').on(t.actorUserId)],
);

export const featureFlags = pgTable('feature_flags', { ...baseColumns() });

export const policies = pgTable('policies', { ...baseColumns() });

export const policyVersions = pgTable(
  'policy_versions',
  {
    ...baseColumns(),
    policyId: uuid('policy_id')
      .notNull()
      .references(() => policies.id, { onDelete: 'restrict' }),
  },
  (t) => [index('policy_versions_policy_id_idx').on(t.policyId)],
);

export const policyAcceptances = pgTable(
  'policy_acceptances',
  {
    ...baseColumns(),
    policyVersionId: uuid('policy_version_id')
      .notNull()
      .references(() => policyVersions.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('policy_acceptances_policy_version_id_idx').on(t.policyVersionId),
    index('policy_acceptances_user_id_idx').on(t.userId),
    uniqueIndex('policy_acceptances_policy_version_user_uq').on(t.policyVersionId, t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Security, files, location, analytics
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    ...baseColumns(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const securityEvents = pgTable(
  'security_events',
  {
    ...baseColumns(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('security_events_user_id_idx').on(t.userId)],
);

export const fileAssets = pgTable(
  'file_assets',
  {
    ...baseColumns(),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('file_assets_uploaded_by_user_id_idx').on(t.uploadedByUserId)],
);

export const locations = pgTable('locations', { ...baseColumns() });

export const addresses = pgTable(
  'addresses',
  {
    ...baseColumns(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'restrict' }),
  },
  (t) => [index('addresses_user_id_idx').on(t.userId), index('addresses_location_id_idx').on(t.locationId)],
);

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    ...baseColumns(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
  },
  (t) => [index('analytics_events_actor_user_id_idx').on(t.actorUserId)],
);
