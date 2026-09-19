import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, or } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  bookingCancellations,
  bookings,
  bookingsStatusHistory,
  conversationParticipants,
  conversations,
  noShowReports,
  customerProfiles,
  fileAssets,
  messages,
  notificationPreferences,
  offerMessages,
  offerRevisions,
  offers,
  providerAvailabilities,
  providerAvailabilityNotificationRequests,
  providerAvailabilityOverrides,
  providerServiceAreas,
  payments,
  priceAdjustments,
  providerProfiles,
  refundLines,
  refunds,
  requestProviderMatches,
  requests,
  reviewReports,
  reviewResponses,
  reviews,
  users,
} from '@/lib/db/schema';
import type { DataExportStatusDto } from '@/lib/types/privacy';
import { exportProviderEarnings, type ExportedProviderEarnings } from '@/lib/payouts/privacy';
import { exportNotificationData } from '@/lib/notifications/privacy';
import { exportFileAssetData, type ExportedFileAsset } from '@/lib/files/privacy';
import type { CategoryChannelMap, NotificationDto } from '@/lib/types/notifications';
import { buildDownloadUrl, verifyDownloadToken } from './download-token';
import { getFileAssetStorage } from './file-asset-storage';
import { NOT_FOUND_ERROR } from './not-found';

export interface ExportedOffer {
  id: string;
  requestId: string;
  status: string;
  priceAmountMinorUnits: number;
  currencyCode: string;
  includedItems: string[];
  providerMessage: string | null;
  estimatedDurationMinutes: number | null;
  sentAt: string | null;
  expiresAt: string | null;
  decidedAt: string | null;
}

export interface DataExportPayload {
  generatedAt: string;
  profile: {
    id: string;
    email: string | null;
    phoneNumber: string | null;
    createdAt: string;
    customerProfile: { id: string; createdAt: string } | null;
    providerProfile: { id: string; businessName: string | null; lifecycleStatus: string; createdAt: string } | null;
  };
  /** Spec 015 §4 "Retention and privacy": the caller's own requests, with an explicit column
   * allowlist — never internal matching data (`request_provider_matches`, ranking, pool). */
  requests: Array<{
    id: string;
    status: string;
    serviceId: string;
    description: string;
    urgency: string;
    preferredAt: string | null;
    createdAt: string;
  }>;
  /**
   * Spec 020 §4 "Retention and privacy": the caller's own bookings (as customer or as provider),
   * with an explicit column allowlist plus the status history that proves who did what and when.
   * Never `idempotency_key`/`idempotency_fingerprint`, and never a counterparty user id — history
   * rows carry `actorRole` only.
   */
  bookings: Array<{
    id: string;
    status: string;
    serviceId: string;
    scheduledAt: string;
    scheduledTimezone: string;
    durationMinutes: number;
    priceAmountMinorUnits: number;
    currencyCode: string;
    createdAt: string;
    statusHistory: Array<{ fromStatus: string | null; toStatus: string; actorRole: string; occurredAt: string }>;
  }>;
  /**
   * Spec 029 §4 "Retention and privacy" (AC-10) — the reviews this user AUTHORED, the responses
   * they WROTE and the reports they FILED.
   *
   * Deliberately absent: `flag_signals` (a moderation signal, not the user's data), any OTHER
   * user's report on their review, any reporter identity, the moderation record and every
   * idempotency column. A review's `status` IS included, because being told a review of yours was
   * removed is information about you.
   */
  reviews: Array<{
    id: string;
    bookingId: string;
    rating: number | null;
    text: string | null;
    status: string | null;
    createdAt: string;
  }>;
  reviewResponses: Array<{ id: string; reviewId: string; text: string; status: string; createdAt: string }>;
  reviewReports: Array<{
    id: string;
    reviewId: string;
    reason: string;
    details: string | null;
    status: string;
    createdAt: string;
  }>;
  /** "Permitted messages" (spec 008 §3): messages in a conversation `userId` participates in —
   * the same participant boundary spec 025 uses to authorize a messaging read, never a broader
   * query (e.g. never all messages the user merely sent, if they'd since left the conversation).
   * Spec 025 §4 extends it to the user's actual correspondence: the stored body (masked or verbatim, per
   * AC-2) and its flags, counterparty messages included, in the conversation's total order. */
  messages: Array<{
    id: string;
    conversationId: string;
    bookingId: string | null;
    senderUserId: string;
    senderRole: string;
    body: string;
    contactRedacted: boolean;
    contactFlagged: boolean;
    redactedByRetention: boolean;
    createdAt: string;
  }>;
  /**
   * Spec 026 §4 extends the notification-preference row to the resolved per-category channel map and the
   * marketing-consent instant (a compliance record the user is entitled to see).
   */
  preferences: { id: string; createdAt: string; categories: CategoryChannelMap; marketingConsentAt: string | null } | null;
  /**
   * Spec 026 §4 — the caller's OWN notifications, as they were told them. Never exported: `event_key`,
   * `params`, and every delivery column (internal routing and diagnostics).
   */
  notifications: NotificationDto[];
  /**
   * Spec 027 §4 — METADATA for the files the caller uploaded. Never the bytes: those are already
   * reachable through their own authorized, expiring URLs, and copying them here would create a
   * second, unexpiring copy of exactly the material spec 027 exists to keep behind authorization.
   * Never exported: `storage_key`, `checksum_sha256`, every scan column and both idempotency
   * columns — server-side routing and diagnostics. Never another party's asset.
   */
  files: ExportedFileAsset[];
  /**
   * Spec 016 §4 "Retention and privacy": the exporting user's OWN provider schedule and coverage
   * configuration, ownership-scoped through `provider_profiles.user_id`. `centerAddressId` is
   * exported as the address id spec 012's own address data already covers — never raw
   * coordinates. `availabilityNotifications` is the CUSTOMER side of AC-6's opt-in, since that
   * row's data subject is the customer who asked to be told.
   */
  providerAvailability: {
    timezone: string | null;
    weeklyEntries: Array<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
    overrides: Array<{ date: string; isAvailable: boolean; startMinute: number | null; endMinute: number | null }>;
    serviceAreas: Array<{
      serviceId: string | null;
      mode: string;
      radiusMeters: number | null;
      centerAddressId: string | null;
      cities: string[] | null;
    }>;
  } | null;
  availabilityNotifications: Array<{ id: string; providerProfileId: string; status: string; createdAt: string }>;
  /**
   * Spec 017 §4 "Retention and privacy": the existence and outcome of matching, never the
   * competitive-intelligence fields (`scoreMicros`, `scoreBreakdown`, `exclusionReason`) that are
   * admin-only (AC-6). `asCustomer` covers matching on the caller's OWN requests
   * (ownership-scoped through `customer_profiles`, the same join `requests` above uses);
   * `asProvider` covers rows where the caller is the `provider_profile_id`. A caller with neither
   * profile exports two empty arrays rather than being asked to distinguish the two cases.
   */
  matching: {
    asCustomer: Array<{ requestId: string; rank: number | null; providerResponse: string; notifiedAt: string | null }>;
    asProvider: Array<{ requestId: string; rank: number | null; providerResponse: string; notifiedAt: string | null }>;
  };
  /**
   * Spec 018 §4 "Retention and privacy": offers made on the caller's own requests (`asCustomer` — offers
   * made TO them, from any provider) and offers the caller sent (`asProvider` — only their own, never
   * another provider's). Explicit column allowlist: idempotency keys and fingerprints are never exported.
   */
  offers: {
    asCustomer: ExportedOffer[];
    asProvider: ExportedOffer[];
  };
  /**
   * Spec 019 §4 "Retention and privacy": pre-selection threads the caller took part in (as the request's
   * customer or as the thread's provider — counterparty messages included, since they were sent to the
   * caller) and revisions on the caller's requests / by the caller's provider profile. Explicit column
   * allowlists: never `sender_user_id`/`actor_user_id`, idempotency keys or fingerprints, and a provider
   * never exports another provider's thread.
   */
  negotiation: {
    messages: Array<{
      id: string;
      requestId: string;
      providerProfileId: string;
      offerId: string | null;
      kind: string;
      senderRole: string;
      body: string;
      contactRedacted: boolean;
      proposedPrice: { amountMinorUnits: number; currencyCode: string } | null;
      createdAt: string;
    }>;
    revisions: Array<{
      id: string;
      previousOfferId: string;
      offerId: string;
      revisionNumber: number;
      previousPrice: { amountMinorUnits: number; currencyCode: string };
      newPrice: { amountMinorUnits: number; currencyCode: string };
      createdAt: string;
    }>;
  };
  /**
   * Spec 021 §4 "Retention and privacy" — the export boundary for payment data.
   *
   * Exported: the caller's own payment amount, currency, status and protection window, plus the
   * price adjustments proposed on their bookings. NEVER exported, by simply not being selected:
   * `provider_reference`, `provider_name`, `idempotency_key`, `idempotency_fingerprint` and
   * attempt-level `failure_code`/`failure_reason` — internal reconciliation and anti-abuse data,
   * not the user's own personal data.
   */
  receipts: {
    payments: Array<{
      id: string;
      bookingId: string;
      status: string;
      chargeAmountMinorUnits: number | null;
      chargeCurrencyCode: string | null;
      protectionState: string | null;
      protectionWindowStartedAt: string | null;
      createdAt: string;
    }>;
    /**
     * Spec 022 §4 "Retention and privacy" — the export boundary for refund data.
     *
     * Exported: the caller's own refund amount, currency, status, completion instant and each
     * line's reason. NEVER exported, by simply not being selected: `provider_reference`,
     * `refund_reference`, `failure_code`, `failure_reason`, `idempotency_key`,
     * `idempotency_fingerprint`, `admin_action_id`, `initiated_by_user_id` and
     * `eligibility_decision_ref` — provider handles, internal reconciliation data, and
     * admin/security detail beyond the user's own record.
     */
    refunds: Array<{
      id: string;
      paymentId: string;
      bookingId: string;
      status: string;
      totalAmountMinorUnits: number | null;
      totalCurrencyCode: string | null;
      completedAt: string | null;
      createdAt: string;
      lines: Array<{ lineAmountMinorUnits: number | null; lineCurrencyCode: string | null; reason: string }>;
    }>;
    priceAdjustments: Array<{
      id: string;
      bookingId: string;
      additionalAmountMinorUnits: number | null;
      additionalCurrencyCode: string | null;
      reason: string;
      status: string;
      approvedAt: string | null;
      createdAt: string;
    }>;
    /**
     * Spec 023 §4 "Retention and privacy" (AC-10) — the export boundary for a cancellation.
     *
     * Exported: what the caller was charged and refunded, which tier applied and why. NEVER
     * exported, by simply not being selected: `decision_ref`, `policy_version_id`,
     * `idempotency_key`, `idempotency_fingerprint`, `cancelled_by_user_id`, `hours_before_milli`
     * and `no_show_report_id` — internal decision handles and the link to another party's report.
     */
    cancellations: Array<{
      id: string;
      bookingId: string;
      cancelledByRole: string;
      reasonCode: string | null;
      tierFeePercent: number;
      capturedAmountMinorUnits: number | null;
      capturedCurrencyCode: string | null;
      feeAmountMinorUnits: number;
      refundAmountMinorUnits: number;
      createdAt: string;
    }>;
  };
  /**
   * Spec 023 §4 "Retention and privacy" (AC-10) — the export boundary for no-show reports.
   *
   * Exported: the reports the caller is a party to, their neutral status and outcome, and — only
   * when the caller filed it — their OWN statement. NEVER exported, by simply not being selected:
   * the other party's statement, the evidence bundle, the coarse location signal, the resolution
   * reason, `resolved_by_admin_id`, `counterpart_report_id` and both idempotency columns. A party
   * receives their own record, never the other side's evidence or the reviewer's private notes.
   */
  noShowReports: Array<{
    id: string;
    bookingId: string;
    reporterRole: string;
    isOwnReport: boolean;
    status: string;
    outcome: string | null;
    ownStatement: string | null;
    respondByAt: string;
    resolvedAt: string | null;
    createdAt: string;
  }>;
  /**
   * Spec 024 §4.4 "Retention, privacy and audit" — the export boundary for the caller's OWN provider
   * ledger: earnings lines, payouts with their items, APPLIED adjustments, and payout methods by mask
   * only. Never exported: destination tokens, rail references and names, failure reasons, idempotency
   * data, approval-chain ids, refund ids, or an unapplied adjustment. `null` for a user with no
   * provider profile.
   */
  providerEarnings: ExportedProviderEarnings | null;
}

/**
 * Every entity here is fetched with an explicit column allowlist and an ownership-scoped join —
 * never `select *` — so a future spec adding an internal-only column (fraud/ranking signal,
 * moderation note) to one of these tables doesn't silently start flowing into an export just
 * because it exists on the row. Only entities/columns already implemented are included; there is
 * nothing yet to accidentally leak from specs not yet built (payments/reviews/etc. are still
 * their spec-003 baseline shape).
 */
export async function generateExportPayload(userId: string): Promise<DataExportPayload> {
  const db = getDb();

  const [user] = await db
    .select({ id: users.id, email: users.email, phoneNumber: users.phoneNumber, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw NOT_FOUND_ERROR();

  const [customerProfile] = await db
    .select({ id: customerProfiles.id, createdAt: customerProfiles.createdAt })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId));

  const [providerProfile] = await db
    .select({
      id: providerProfiles.id,
      businessName: providerProfiles.businessName,
      lifecycleStatus: providerProfiles.lifecycleStatus,
      createdAt: providerProfiles.createdAt,
      // Spec 016 §3 R1 — the provider's own scheduling timezone is theirs to export.
      schedulingTimezone: providerProfiles.schedulingTimezone,
    })
    .from(providerProfiles)
    .where(eq(providerProfiles.userId, userId));

  // Spec 015 §4: ownership-scoped through the caller's own `CustomerProfile`, the same join shape
  // the booking/receipt sections below use, with an explicit column allowlist (never `select *`).
  const requestRows = customerProfile
    ? await db
        .select({
          id: requests.id,
          status: requests.status,
          serviceId: requests.serviceId,
          description: requests.description,
          urgency: requests.urgency,
          preferredAt: requests.preferredAt,
          createdAt: requests.createdAt,
        })
        .from(requests)
        .where(eq(requests.customerProfileId, customerProfile.id))
    : [];

  // Spec 020 §4: `bookings` now carries its own `customer_profile_id`/`provider_profile_id`, so the
  // participant test no longer has to travel through `offers` -> `requests`. Same rows, one join
  // each, and the explicit allowlist below still excludes idempotency data and every user id.
  const bookingRows = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      serviceId: bookings.serviceId,
      scheduledAt: bookings.scheduledAt,
      scheduledTimezone: bookings.scheduledTimezone,
      durationMinutes: bookings.durationMinutes,
      priceAmountMinorUnits: bookings.priceAmountMinorUnits,
      priceCurrencyCode: bookings.priceCurrencyCode,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .innerJoin(customerProfiles, eq(customerProfiles.id, bookings.customerProfileId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, bookings.providerProfileId))
    .where(or(eq(customerProfiles.userId, userId), eq(providerProfiles.userId, userId)));

  const bookingHistoryRows = bookingRows.length
    ? await db
        .select({
          bookingId: bookingsStatusHistory.bookingId,
          fromStatus: bookingsStatusHistory.fromStatus,
          toStatus: bookingsStatusHistory.toStatus,
          actorRole: bookingsStatusHistory.actorRole,
          occurredAt: bookingsStatusHistory.occurredAt,
        })
        .from(bookingsStatusHistory)
        .where(inArray(bookingsStatusHistory.bookingId, bookingRows.map((b) => b.id)))
        .orderBy(asc(bookingsStatusHistory.occurredAt))
    : [];

  // Spec 029 §4 — an explicit column allowlist, ownership-scoped, exactly like every section
  // above. `flag_signals`, `removal_reason`, `moderated_by_admin_id` and the idempotency columns
  // are never selected, so they cannot reach an export even by accident.
  const reviewRows = await db
    .select({
      id: reviews.id,
      bookingId: reviews.bookingId,
      rating: reviews.rating,
      text: reviews.text,
      status: reviews.status,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(eq(reviews.authorUserId, userId));

  const reviewResponseRows = await db
    .select({
      id: reviewResponses.id,
      reviewId: reviewResponses.reviewId,
      text: reviewResponses.text,
      status: reviewResponses.status,
      createdAt: reviewResponses.createdAt,
    })
    .from(reviewResponses)
    .where(eq(reviewResponses.responderUserId, userId));

  // The reports this user FILED. Reports filed by OTHERS on this user's reviews are deliberately
  // not here: they are another person's statement, and returning them would let a reviewed party
  // work out who reported them.
  const reviewReportRows = await db
    .select({
      id: reviewReports.id,
      reviewId: reviewReports.reviewId,
      reason: reviewReports.reason,
      details: reviewReports.details,
      status: reviewReports.status,
      createdAt: reviewReports.createdAt,
    })
    .from(reviewReports)
    .where(eq(reviewReports.reporterUserId, userId));

  const messageRows = await db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      bookingId: conversations.bookingId,
      senderUserId: messages.senderUserId,
      senderRole: messages.senderRole,
      body: messages.body,
      contactRedacted: messages.contactRedacted,
      contactFlagged: messages.contactFlagged,
      redactedByRetention: messages.redactedByRetention,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(
      conversationParticipants,
      and(eq(conversationParticipants.conversationId, messages.conversationId), eq(conversationParticipants.userId, userId)),
    )
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .orderBy(asc(messages.conversationId), asc(messages.createdAt), asc(messages.id));

  const [preferences] = await db
    .select({ id: notificationPreferences.id, createdAt: notificationPreferences.createdAt })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  const notificationData = await exportNotificationData(userId);
  // Spec 027 §4: metadata for the caller's own file assets, ownership-scoped by uploader.
  const fileAssetData = await exportFileAssetData(userId);

  const paymentRows = await db
    .select({
      id: payments.id,
      bookingId: payments.bookingId,
      status: payments.status,
      // Spec 021 §4 "Retention and privacy": the caller's own money, and nothing provider-facing.
      chargeAmountMinorUnits: payments.chargeAmountMinorUnits,
      chargeCurrencyCode: payments.chargeCurrencyCode,
      protectionState: payments.protectionState,
      protectionWindowStartedAt: payments.protectionWindowStartedAt,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .innerJoin(offers, eq(offers.id, bookings.offerId))
    .innerJoin(requests, eq(requests.id, offers.requestId))
    .innerJoin(customerProfiles, eq(customerProfiles.id, requests.customerProfileId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, offers.providerProfileId))
    .where(or(eq(customerProfiles.userId, userId), eq(providerProfiles.userId, userId)));

  const paymentIds = paymentRows.map((p) => p.id);
  const refundRows = paymentIds.length
    ? await db
        .select({
          id: refunds.id,
          paymentId: refunds.paymentId,
          // Spec 022 §4: the caller's own money and its explanation — nothing provider-facing,
          // nothing about the admin approval chain.
          bookingId: refunds.bookingId,
          status: refunds.status,
          totalAmountMinorUnits: refunds.totalAmountMinorUnits,
          totalCurrencyCode: refunds.totalCurrencyCode,
          completedAt: refunds.completedAt,
          createdAt: refunds.createdAt,
        })
        .from(refunds)
        .where(inArray(refunds.paymentId, paymentIds))
    : [];

  // Spec 023 §4: the caller's own cancellations, scoped by the bookings already resolved above —
  // so the ownership test is the same one every other booking-derived section uses.
  const exportBookingIds = bookingRows.map((b) => b.id);
  const cancellationRows = exportBookingIds.length
    ? await db
        .select({
          id: bookingCancellations.id,
          bookingId: bookingCancellations.bookingId,
          cancelledByRole: bookingCancellations.cancelledByRole,
          reasonCode: bookingCancellations.reasonCode,
          tierFeePercent: bookingCancellations.tierFeePercent,
          capturedAmountMinorUnits: bookingCancellations.capturedAmountMinorUnits,
          capturedCurrencyCode: bookingCancellations.capturedCurrencyCode,
          feeAmountMinorUnits: bookingCancellations.feeAmountMinorUnits,
          refundAmountMinorUnits: bookingCancellations.refundAmountMinorUnits,
          createdAt: bookingCancellations.createdAt,
        })
        .from(bookingCancellations)
        .where(inArray(bookingCancellations.bookingId, exportBookingIds))
    : [];

  // Spec 023 §4 / AC-10: `reporter_statement` is selected because it is exported ONLY when the
  // caller is the reporter — the mapping below drops it otherwise. `response_statement`,
  // `evidence`, `location_signal` and `resolution_reason` are not selected at all, so no future
  // change to the mapping could leak them by accident.
  const noShowRows = exportBookingIds.length
    ? await db
        .select({
          id: noShowReports.id,
          bookingId: noShowReports.bookingId,
          reporterUserId: noShowReports.reporterUserId,
          reporterRole: noShowReports.reporterRole,
          status: noShowReports.status,
          outcome: noShowReports.outcome,
          reporterStatement: noShowReports.reporterStatement,
          respondByAt: noShowReports.respondByAt,
          resolvedAt: noShowReports.resolvedAt,
          createdAt: noShowReports.createdAt,
        })
        .from(noShowReports)
        .where(inArray(noShowReports.bookingId, exportBookingIds))
    : [];

  const refundIds = refundRows.map((r) => r.id);
  const refundLineRows = refundIds.length
    ? await db
        .select({
          refundId: refundLines.refundId,
          lineAmountMinorUnits: refundLines.lineAmountMinorUnits,
          lineCurrencyCode: refundLines.lineCurrencyCode,
          reason: refundLines.reason,
        })
        .from(refundLines)
        .where(inArray(refundLines.refundId, refundIds))
    : [];

  // Spec 021 §4 "Retention and privacy": the price adjustments proposed on the caller's own
  // bookings — the same ownership-scoped join the payments query above uses, and the same explicit
  // column allowlist (no idempotency columns, no proposer/approver user ids).
  const priceAdjustmentRows = await db
    .select({
      id: priceAdjustments.id,
      bookingId: priceAdjustments.bookingId,
      additionalAmountMinorUnits: priceAdjustments.additionalAmountMinorUnits,
      additionalCurrencyCode: priceAdjustments.additionalCurrencyCode,
      reason: priceAdjustments.reason,
      status: priceAdjustments.status,
      approvedAt: priceAdjustments.approvedAt,
      createdAt: priceAdjustments.createdAt,
    })
    .from(priceAdjustments)
    .innerJoin(bookings, eq(bookings.id, priceAdjustments.bookingId))
    .innerJoin(offers, eq(offers.id, bookings.offerId))
    .innerJoin(requests, eq(requests.id, offers.requestId))
    .innerJoin(customerProfiles, eq(customerProfiles.id, requests.customerProfileId))
    .innerJoin(providerProfiles, eq(providerProfiles.id, offers.providerProfileId))
    .where(or(eq(customerProfiles.userId, userId), eq(providerProfiles.userId, userId)));

  // Spec 016 §4: the caller's own provider-side schedule/coverage, with an explicit column
  // allowlist and an ownership-scoped filter, exactly like every section above. A user with no
  // provider profile exports `null` here rather than an empty shape, so the two cases stay
  // distinguishable in the payload.
  const weeklyRows = providerProfile
    ? await db
        .select({
          dayOfWeek: providerAvailabilities.dayOfWeek,
          startMinute: providerAvailabilities.startMinute,
          endMinute: providerAvailabilities.endMinute,
        })
        .from(providerAvailabilities)
        .where(eq(providerAvailabilities.providerProfileId, providerProfile.id))
    : [];

  const overrideRows = providerProfile
    ? await db
        .select({
          date: providerAvailabilityOverrides.date,
          isAvailable: providerAvailabilityOverrides.isAvailable,
          startMinute: providerAvailabilityOverrides.startMinute,
          endMinute: providerAvailabilityOverrides.endMinute,
        })
        .from(providerAvailabilityOverrides)
        .where(eq(providerAvailabilityOverrides.providerProfileId, providerProfile.id))
    : [];

  const serviceAreaRows = providerProfile
    ? await db
        .select({
          serviceId: providerServiceAreas.serviceId,
          mode: providerServiceAreas.mode,
          radiusMeters: providerServiceAreas.radiusMeters,
          centerAddressId: providerServiceAreas.centerAddressId,
          cities: providerServiceAreas.cities,
        })
        .from(providerServiceAreas)
        .where(eq(providerServiceAreas.providerProfileId, providerProfile.id))
    : [];

  // Spec 017 §4: explicit column allowlist, excluding `scoreMicros`/`scoreBreakdown`/
  // `exclusionReason` — those are admin-only (AC-6) and a provider learning why a competitor was
  // excluded, or what a competitor scored, is a competitive-intelligence leak.
  const matchingAsCustomerRows = customerProfile
    ? await db
        .select({
          requestId: requestProviderMatches.requestId,
          rank: requestProviderMatches.rank,
          providerResponse: requestProviderMatches.providerResponse,
          notifiedAt: requestProviderMatches.notifiedAt,
        })
        .from(requestProviderMatches)
        .innerJoin(requests, eq(requests.id, requestProviderMatches.requestId))
        .where(eq(requests.customerProfileId, customerProfile.id))
    : [];

  const matchingAsProviderRows = providerProfile
    ? await db
        .select({
          requestId: requestProviderMatches.requestId,
          rank: requestProviderMatches.rank,
          providerResponse: requestProviderMatches.providerResponse,
          notifiedAt: requestProviderMatches.notifiedAt,
        })
        .from(requestProviderMatches)
        .where(eq(requestProviderMatches.providerProfileId, providerProfile.id))
    : [];

  // Spec 018 §4: explicit allowlist; `draft` never commits, so it is excluded defensively.
  const offerColumns = {
    id: offers.id,
    requestId: offers.requestId,
    status: offers.status,
    priceAmountMinorUnits: offers.priceAmountMinorUnits,
    currencyCode: offers.priceCurrencyCode,
    includedItems: offers.includedItems,
    providerMessage: offers.providerMessage,
    estimatedDurationMinutes: offers.estimatedDurationMinutes,
    sentAt: offers.sentAt,
    expiresAt: offers.expiresAt,
    decidedAt: offers.decidedAt,
  };
  const offersAsCustomerRows = customerProfile
    ? await db
        .select(offerColumns)
        .from(offers)
        .innerJoin(requests, eq(requests.id, offers.requestId))
        .where(and(eq(requests.customerProfileId, customerProfile.id), ne(offers.status, 'draft')))
    : [];
  const offersAsProviderRows = providerProfile
    ? await db
        .select(offerColumns)
        .from(offers)
        .where(and(eq(offers.providerProfileId, providerProfile.id), ne(offers.status, 'draft')))
    : [];
  const toExportedOffer = (row: (typeof offersAsProviderRows)[number]): ExportedOffer => ({
    ...row,
    includedItems: row.includedItems ?? [],
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  });

  // Spec 019 §4: threads and revisions, ownership-scoped through the same profile joins as `offers`.
  const messageScopes = [
    ...(customerProfile ? [eq(requests.customerProfileId, customerProfile.id)] : []),
    ...(providerProfile ? [eq(offerMessages.providerProfileId, providerProfile.id)] : []),
  ];
  const negotiationMessageRows =
    messageScopes.length > 0
      ? await db
          .select({
            id: offerMessages.id,
            requestId: offerMessages.requestId,
            providerProfileId: offerMessages.providerProfileId,
            offerId: offerMessages.offerId,
            kind: offerMessages.kind,
            senderRole: offerMessages.senderRole,
            body: offerMessages.body,
            contactRedacted: offerMessages.contactRedacted,
            proposedAmount: offerMessages.proposedPriceAmountMinorUnits,
            proposedCurrency: offerMessages.proposedPriceCurrencyCode,
            createdAt: offerMessages.createdAt,
          })
          .from(offerMessages)
          .innerJoin(requests, eq(requests.id, offerMessages.requestId))
          .where(or(...messageScopes))
          .orderBy(offerMessages.createdAt, offerMessages.id)
      : [];
  const revisionScopes = [
    ...(customerProfile ? [eq(requests.customerProfileId, customerProfile.id)] : []),
    ...(providerProfile ? [eq(offerRevisions.providerProfileId, providerProfile.id)] : []),
  ];
  const negotiationRevisionRows =
    revisionScopes.length > 0
      ? await db
          .select({
            id: offerRevisions.id,
            previousOfferId: offerRevisions.offerId,
            offerId: offerRevisions.newOfferId,
            revisionNumber: offerRevisions.revisionNumber,
            previousAmount: offerRevisions.previousPriceAmountMinorUnits,
            previousCurrency: offerRevisions.previousPriceCurrencyCode,
            newAmount: offerRevisions.newPriceAmountMinorUnits,
            newCurrency: offerRevisions.newPriceCurrencyCode,
            createdAt: offerRevisions.createdAt,
          })
          .from(offerRevisions)
          .innerJoin(requests, eq(requests.id, offerRevisions.requestId))
          .where(or(...revisionScopes))
          .orderBy(offerRevisions.createdAt, offerRevisions.id)
      : [];

  const availabilityNotificationRows = customerProfile
    ? await db
        .select({
          id: providerAvailabilityNotificationRequests.id,
          providerProfileId: providerAvailabilityNotificationRequests.providerProfileId,
          status: providerAvailabilityNotificationRequests.status,
          createdAt: providerAvailabilityNotificationRequests.createdAt,
        })
        .from(providerAvailabilityNotificationRequests)
        .where(eq(providerAvailabilityNotificationRequests.customerProfileId, customerProfile.id))
    : [];

  return {
    generatedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      createdAt: user.createdAt.toISOString(),
      customerProfile: customerProfile ? { id: customerProfile.id, createdAt: customerProfile.createdAt.toISOString() } : null,
      providerProfile: providerProfile
        ? {
            id: providerProfile.id,
            businessName: providerProfile.businessName,
            lifecycleStatus: providerProfile.lifecycleStatus,
            createdAt: providerProfile.createdAt.toISOString(),
          }
        : null,
    },
    requests: requestRows.map((r) => ({
      id: r.id,
      status: r.status,
      serviceId: r.serviceId,
      description: r.description,
      urgency: r.urgency,
      preferredAt: r.preferredAt ? r.preferredAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    bookings: bookingRows.map((b) => ({
      id: b.id,
      status: b.status,
      serviceId: b.serviceId,
      scheduledAt: b.scheduledAt.toISOString(),
      scheduledTimezone: b.scheduledTimezone,
      durationMinutes: b.durationMinutes,
      priceAmountMinorUnits: b.priceAmountMinorUnits,
      currencyCode: b.priceCurrencyCode,
      createdAt: b.createdAt.toISOString(),
      statusHistory: bookingHistoryRows
        .filter((h) => h.bookingId === b.id)
        .map((h) => ({
          fromStatus: h.fromStatus,
          toStatus: h.toStatus,
          actorRole: h.actorRole,
          occurredAt: h.occurredAt.toISOString(),
        })),
    })),
    reviews: reviewRows.map((r) => ({
      id: r.id,
      bookingId: r.bookingId,
      rating: r.rating ?? null,
      text: r.text ?? null,
      status: r.status ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    reviewResponses: reviewResponseRows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    reviewReports: reviewReportRows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    messages: messageRows.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    preferences: preferences
      ? {
          id: preferences.id,
          createdAt: preferences.createdAt.toISOString(),
          categories: notificationData.preferences!.categories,
          marketingConsentAt: notificationData.preferences!.marketingConsentAt,
        }
      : null,
    notifications: notificationData.notifications,
    files: fileAssetData,
    providerAvailability: providerProfile
      ? {
          timezone: providerProfile.schedulingTimezone,
          weeklyEntries: weeklyRows,
          overrides: overrideRows,
          serviceAreas: serviceAreaRows,
        }
      : null,
    availabilityNotifications: availabilityNotificationRows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
    matching: {
      asCustomer: matchingAsCustomerRows.map((row) => ({
        ...row,
        notifiedAt: row.notifiedAt ? row.notifiedAt.toISOString() : null,
      })),
      asProvider: matchingAsProviderRows.map((row) => ({
        ...row,
        notifiedAt: row.notifiedAt ? row.notifiedAt.toISOString() : null,
      })),
    },
    offers: {
      asCustomer: offersAsCustomerRows.map(toExportedOffer),
      asProvider: offersAsProviderRows.map(toExportedOffer),
    },
    negotiation: {
      messages: negotiationMessageRows.map(({ proposedAmount, proposedCurrency, createdAt, ...row }) => ({
        ...row,
        proposedPrice: proposedAmount !== null && proposedCurrency !== null ? { amountMinorUnits: proposedAmount, currencyCode: proposedCurrency } : null,
        createdAt: createdAt.toISOString(),
      })),
      revisions: negotiationRevisionRows.map(({ previousAmount, previousCurrency, newAmount, newCurrency, createdAt, ...row }) => ({
        ...row,
        previousPrice: { amountMinorUnits: previousAmount, currencyCode: previousCurrency },
        newPrice: { amountMinorUnits: newAmount, currencyCode: newCurrency },
        createdAt: createdAt.toISOString(),
      })),
    },
    receipts: {
      payments: paymentRows.map((p) => ({
        ...p,
        protectionWindowStartedAt: p.protectionWindowStartedAt ? p.protectionWindowStartedAt.toISOString() : null,
        createdAt: p.createdAt.toISOString(),
      })),
      refunds: refundRows.map((r) => ({
        ...r,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        lines: refundLineRows
          .filter((line) => line.refundId === r.id)
          .map(({ lineAmountMinorUnits, lineCurrencyCode, reason }) => ({ lineAmountMinorUnits, lineCurrencyCode, reason })),
      })),
      priceAdjustments: priceAdjustmentRows.map((a) => ({
        ...a,
        approvedAt: a.approvedAt ? a.approvedAt.toISOString() : null,
        createdAt: a.createdAt.toISOString(),
      })),
      cancellations: cancellationRows.map((c) => ({
        ...c,
        createdAt: c.createdAt.toISOString(),
      })),
    },
    noShowReports: noShowRows.map((r) => ({
      id: r.id,
      bookingId: r.bookingId,
      reporterRole: r.reporterRole,
      isOwnReport: r.reporterUserId === userId,
      status: r.status,
      outcome: r.outcome,
      // AC-10: a party's own words are theirs to export; the other party's are not.
      ownStatement: r.reporterUserId === userId ? r.reporterStatement : null,
      respondByAt: r.respondByAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    providerEarnings: await exportProviderEarnings(userId, db),
  };
}

/** `POST /users/me/data-export` (AC-3) — idempotent while non-terminal: a pending/processing
 * export already in flight for this user returns that same id instead of starting a duplicate. */
export async function requestExport(userId: string): Promise<{ exportRequestId: string }> {
  const db = getDb();
  const [user] = await db
    .select({ dataExportRequestId: users.dataExportRequestId, dataExportStatus: users.dataExportStatus })
    .from(users)
    .where(eq(users.id, userId));

  if (user?.dataExportRequestId && (user.dataExportStatus === 'pending' || user.dataExportStatus === 'processing')) {
    return { exportRequestId: user.dataExportRequestId };
  }

  const exportRequestId = randomUUID();
  await db
    .update(users)
    .set({ dataExportRequestId: exportRequestId, dataExportStatus: 'pending', dataExportFileAssetId: null })
    .where(eq(users.id, userId));
  return { exportRequestId };
}

/** `GET /users/me/data-export/{id}` — `id` must belong to the caller; otherwise (including a
 * nonexistent id) throws the same `NOT_FOUND` as any other id that isn't this user's. */
export async function getExportStatusDto(userId: string, exportRequestId: string): Promise<DataExportStatusDto> {
  const db = getDb();
  const [user] = await db
    .select({
      dataExportRequestId: users.dataExportRequestId,
      dataExportStatus: users.dataExportStatus,
      dataExportFileAssetId: users.dataExportFileAssetId,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!user || user.dataExportRequestId !== exportRequestId || !user.dataExportStatus) throw NOT_FOUND_ERROR();

  if (user.dataExportStatus !== 'ready' || !user.dataExportFileAssetId) {
    return { status: user.dataExportStatus };
  }

  const { url, expiresAt } = buildDownloadUrl(exportRequestId);
  return { status: 'ready', downloadUrl: url, expiresAt: expiresAt.toISOString() };
}

export interface ExportDownload {
  filename: string;
  contentType: string;
  body: string;
}

/** Backs `GET /users/me/data-export/{id}/download` — a real signed URL, verified purely by
 * signature + expiry (no session required), scoped to the one user it was issued for. */
export async function getExportDownload(
  exportRequestId: string,
  expiresAtMsRaw: string | null,
  sig: string | null,
): Promise<ExportDownload> {
  if (!verifyDownloadToken(exportRequestId, expiresAtMsRaw, sig)) throw NOT_FOUND_ERROR();

  const db = getDb();
  const [user] = await db
    .select({ dataExportStatus: users.dataExportStatus, dataExportFileAssetId: users.dataExportFileAssetId })
    .from(users)
    .where(eq(users.dataExportRequestId, exportRequestId));
  if (!user || user.dataExportStatus !== 'ready' || !user.dataExportFileAssetId) throw NOT_FOUND_ERROR();

  const payload = await getFileAssetStorage().retrieve(user.dataExportFileAssetId);
  if (!payload) throw NOT_FOUND_ERROR();

  return { filename: 'apuriva-data-export.json', contentType: 'application/json', body: payload };
}

/**
 * Scheduled sweep (`app/api/v1/cron/data-export-sweep`) — server-side, asynchronous generation;
 * never depends on the requester's browser staying open. Idempotent/retry-safe: only
 * pending/processing rows are selected, and a crash after marking a row `processing` just means
 * the next run retries generation for that same row (the eventual `ready`/`failed` write is what
 * ends the loop, so re-running mid-way never produces duplicate file_assets — each user has at
 * most one referenced by `data_export_file_asset_id` at a time).
 *
 * The `file_assets` row inserted here is a bare reference (spec 008's data model: "adds no
 * storage fields of its own beyond referencing a FileAsset per export") — the generated content
 * itself is handed to spec 027's storage capability (lib/privacy/file-asset-storage.ts), never a
 * spec-008-invented column or storage backend of its own. If no implementation of that capability
 * is registered (spec 027 isn't built yet), `store` throws, this loop's catch below marks the
 * export `failed`, and the real cause is logged — export generation is honestly blocked on that
 * dependency rather than silently faked via a parallel storage mechanism.
 */
export async function runExportSweep(): Promise<{ processed: number }> {
  const db = getDb();
  const due = await db.select({ id: users.id }).from(users).where(inArray(users.dataExportStatus, ['pending', 'processing']));

  let processed = 0;
  for (const { id } of due) {
    try {
      await db.update(users).set({ dataExportStatus: 'processing' }).where(eq(users.id, id));
      const payload = await generateExportPayload(id);
      const [asset] = await db.insert(fileAssets).values({ uploadedByUserId: id }).returning({ id: fileAssets.id });
      await getFileAssetStorage().store(asset!.id, JSON.stringify(payload));
      await db.update(users).set({ dataExportStatus: 'ready', dataExportFileAssetId: asset!.id }).where(eq(users.id, id));
      processed += 1;
    } catch (err) {
      console.error(JSON.stringify({ event: 'privacy.data_export_sweep_failed', userId: id, error: String(err) }));
      await db.update(users).set({ dataExportStatus: 'failed' }).where(eq(users.id, id));
    }
  }
  return { processed };
}
