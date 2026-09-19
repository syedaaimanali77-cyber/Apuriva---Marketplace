/**
 * Spec 029 §4 — the `reviews` / `review_responses` / `review_reports` rows as this spec sees them,
 * and the THREE projections any route may return.
 *
 * The projections are the whole of §4 "Retention and privacy", expressed as code:
 *
 *   - `toPublicReviewDto` carries no reviewer identity, no `bookingId` and **no `status`** — so a
 *     `flagged` review is byte-for-byte indistinguishable from a `published` one to a reader, which
 *     is what makes AC-4's "never suppressed before human review" observable rather than promised.
 *   - `toReviewDto` adds `bookingId`, `status` and `version`, for the author and the provider.
 *   - `toAdminReviewDto` adds the flag signals, the moderation record and the reports — and still
 *     never a reporter's identity, because a reporter whose identity can leak to the reviewed
 *     provider will not report.
 */
import { sql } from 'drizzle-orm';
import type { FileAssetDto } from '@/lib/types/files';
import type {
  AdminReviewDto,
  PublicReviewDto,
  ReviewDto,
  ReviewRating,
  ReviewReportDto,
  ReviewReportReason,
  ReviewReportStatus,
  ReviewResponseDto,
  ReviewSignalCode,
  ReviewStatus,
} from '@/lib/types/reviews';

export interface ReviewRow {
  id: string;
  booking_id: string;
  author_user_id: string;
  provider_profile_id: string;
  service_id: string;
  rating: number;
  text: string | null;
  status: ReviewStatus;
  flag_signals: unknown;
  moderated_by_admin_id: string | null;
  moderated_at: Date | string | null;
  removal_reason: string | null;
  created_at: Date | string;
  version: number;
}

export interface ReviewResponseRow {
  id: string;
  review_id: string;
  responder_user_id: string;
  text: string;
  status: ReviewStatus;
  created_at: Date | string;
}

export interface ReviewReportRow {
  id: string;
  review_id: string;
  reporter_user_id: string;
  reason: ReviewReportReason;
  details: string | null;
  status: ReviewReportStatus;
  created_at: Date | string;
}

/** Every column this domain reads. Listed explicitly so a later column cannot leak by `SELECT *`. */
export const REVIEW_COLUMNS = sql`r.id, r.booking_id, r.author_user_id, r.provider_profile_id, r.service_id,
  r.rating, r.text, r.status, r.flag_signals, r.moderated_by_admin_id, r.moderated_at,
  r.removal_reason, r.created_at, r.version`;

export const REVIEW_RESPONSE_COLUMNS = sql`rr.id, rr.review_id, rr.responder_user_id, rr.text, rr.status, rr.created_at`;

export const REVIEW_REPORT_COLUMNS = sql`rp.id, rp.review_id, rp.reporter_user_id, rp.reason, rp.details, rp.status, rp.created_at`;

/** What a caller passes alongside the row: the pieces stored in other tables. */
export interface ReviewRelations {
  media: FileAssetDto[];
  /** Only a VISIBLE response is ever attached — a `removed` one is gone from every read. */
  response: ReviewResponseRow | null;
}

const NO_RELATIONS: ReviewRelations = { media: [], response: null };

function iso(value: Date | string): string {
  // `db.execute` hands raw driver values back, so timestamps arrive as strings on some paths and
  // Dates on others — normalised the same way spec 026's `toNotificationDto` does.
  return new Date(value).toISOString();
}

export function toPublicReviewDto(row: ReviewRow, relations: ReviewRelations = NO_RELATIONS): PublicReviewDto {
  return {
    id: row.id,
    providerProfileId: row.provider_profile_id,
    serviceId: row.service_id,
    rating: row.rating as ReviewRating,
    text: row.text,
    media: relations.media,
    response:
      relations.response === null
        ? null
        : { text: relations.response.text, createdAt: iso(relations.response.created_at) },
    createdAt: iso(row.created_at),
  };
}

export function toReviewDto(row: ReviewRow, relations: ReviewRelations = NO_RELATIONS): ReviewDto {
  return {
    ...toPublicReviewDto(row, relations),
    bookingId: row.booking_id,
    status: row.status,
    version: row.version,
  };
}

export function toAdminReviewDto(
  row: ReviewRow,
  relations: ReviewRelations,
  reports: ReviewReportRow[],
): AdminReviewDto {
  return {
    ...toReviewDto(row, relations),
    flagSignals: parseFlagSignals(row.flag_signals),
    reportCount: reports.length,
    // Reason, details and instant only — `reporter_user_id` deliberately does not appear here.
    reports: reports.map((report) => ({
      id: report.id,
      reason: report.reason,
      details: report.details,
      createdAt: iso(report.created_at),
    })),
    moderatedAt: row.moderated_at === null ? null : iso(row.moderated_at),
    removalReason: row.removal_reason,
  };
}

export function toReviewResponseDto(row: ReviewResponseRow): ReviewResponseDto {
  return {
    id: row.id,
    reviewId: row.review_id,
    text: row.text,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

export function toReviewReportDto(row: ReviewReportRow): ReviewReportDto {
  return {
    id: row.id,
    reviewId: row.review_id,
    reason: row.reason,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

/** `jsonb` arrives as a parsed array on most driver paths and as a string on some. */
export function parseFlagSignals(value: unknown): ReviewSignalCode[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  return Array.isArray(raw) ? (raw.filter((entry) => typeof entry === 'string') as ReviewSignalCode[]) : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
