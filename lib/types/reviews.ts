/**
 * Spec 029 §3 "Request and response types" — reviews, responses, reports and the rating aggregate.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`, the same as spec
 * 020's `bookings.ts`, spec 025's `messaging.ts` and spec 027's `files.ts`.
 *
 * Every DTO exposes PROFILE ids, never user ids (spec 020 §4), and the PUBLIC projection carries
 * neither a reviewer identity nor a `status` — `published` and `flagged` are indistinguishable to a
 * reader by construction, which is what makes AC-4's "never suppressed before human review"
 * observable rather than merely promised.
 */
import type { FileAssetDto } from './files';

/** §3 "Moderation" — three states, no more. A fourth "pending" would mean an invisible review. */
export const REVIEW_STATUSES = ['published', 'flagged', 'removed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** The statuses a reader may see. `flagged` is here on purpose (AC-4). */
export const VISIBLE_REVIEW_STATUSES: readonly ReviewStatus[] = ['published', 'flagged'];

/**
 * §3 "Deterministic MVP flagging" — the closed set of rule-based signal codes.
 * NONE of these is derived from the rating (AC-5).
 */
export const REVIEW_SIGNAL_CODES = [
  'profanity',
  'contact_sharing',
  'spam_shape',
  'burst_submission',
  'repeat_pair',
] as const;
export type ReviewSignalCode = (typeof REVIEW_SIGNAL_CODES)[number];

export const REVIEW_REPORT_REASONS = [
  'spam',
  'offensive',
  'false_information',
  'personal_information',
  'off_topic',
  'other',
] as const;
export type ReviewReportReason = (typeof REVIEW_REPORT_REASONS)[number];

export const REVIEW_REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReviewReportStatus = (typeof REVIEW_REPORT_STATUSES)[number];

export const REVIEW_MODERATION_DECISIONS = ['keep', 'remove', 'reinstate'] as const;
export type ReviewModerationDecision = (typeof REVIEW_MODERATION_DECISIONS)[number];

export type ReviewRating = 1 | 2 | 3 | 4 | 5;

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value);
}

export function isReviewReportReason(value: unknown): value is ReviewReportReason {
  return typeof value === 'string' && (REVIEW_REPORT_REASONS as readonly string[]).includes(value);
}

export function isReviewModerationDecision(value: unknown): value is ReviewModerationDecision {
  return typeof value === 'string' && (REVIEW_MODERATION_DECISIONS as readonly string[]).includes(value);
}

export interface CreateReviewRequest {
  rating: ReviewRating;
  /** Optional. Normalized server-side; 10..2000 chars when present, otherwise null. */
  text?: string | null;
  /**
   * OPTIONAL. Each id must be a live `ready` `file_assets` row with
   * `context_type = 'review_media'`, `context_id` = this booking, uploaded by the caller.
   * Anything else fails the whole request with `422 REVIEW_MEDIA_ASSET_INVALID`.
   */
  mediaFileAssetIds?: string[];
}

/**
 * What a guest or any reader sees. Deliberately carries NO reviewer identity (this repository has
 * no customer display-name field at all) and NO `status` (AC-4).
 */
export interface PublicReviewDto {
  id: string;
  providerProfileId: string;
  serviceId: string;
  rating: ReviewRating;
  text: string | null;
  /** Spec 027 `FileAssetDto`s — public, `ready` images only. */
  media: FileAssetDto[];
  response: { text: string; createdAt: string } | null;
  createdAt: string;
}

/** The author's / participant's view. Adds the fields only they may see. */
export interface ReviewDto extends PublicReviewDto {
  bookingId: string;
  status: ReviewStatus;
  version: number;
}

/** Why a booking cannot be reviewed right now. */
export type ReviewIneligibilityReason = 'not_completed' | 'window_closed' | 'already_reviewed' | 'not_customer';

/** R2 — the server-authoritative eligibility answer the UI renders. Never computed client-side. */
export interface BookingReviewStateDto {
  bookingId: string;
  eligible: boolean;
  reason: ReviewIneligibilityReason | null;
  /** ISO-8601. Null when the booking never completed. */
  windowClosesAt: string | null;
  /** The booking's review, if it exists. */
  review: ReviewDto | null;
}

export interface CreateReviewResponseRequest {
  text: string;
}

export interface ReviewResponseDto {
  id: string;
  reviewId: string;
  text: string;
  status: ReviewStatus;
  createdAt: string;
}

export interface CreateReviewReportRequest {
  reason: ReviewReportReason;
  /** Required when `reason` is 'other'; 10..2000 chars. */
  details?: string | null;
}

export interface ReviewReportDto {
  id: string;
  reviewId: string;
  reason: ReviewReportReason;
  status: ReviewReportStatus;
  createdAt: string;
}

/**
 * R6/R7 only. `flagSignals` and report detail never leave the admin surface, and a reporter's
 * identity is never returned by ANY route (§4 "Retention and privacy").
 */
export interface AdminReviewDto extends ReviewDto {
  flagSignals: ReviewSignalCode[];
  reportCount: number;
  reports: Array<{ id: string; reason: ReviewReportReason; details: string | null; createdAt: string }>;
  moderatedAt: string | null;
  removalReason: string | null;
}

export interface ResolveReviewRequest {
  decision: ReviewModerationDecision;
  /** Required, 10..2000 chars (master §68: a moderation action always carries a reason). */
  reason: string;
  /** Optimistic concurrency: the status the admin was looking at. */
  expectedStatus: ReviewStatus;
}

/** Spec 017's port payload, and what `GET /providers/{id}/reviews` returns in `meta`. */
export interface ProviderRatingAggregate {
  /** One decimal place, matching what `ui/components/marketplace/Rating` renders. */
  average: number;
  /** Visible reviews only — `published` and `flagged`, never `removed`. */
  count: number;
}
