/**
 * Spec 029 §3 — the review read surface, shared by the public list, the participant view and the
 * moderation queue.
 *
 * ONE definition of "visible" (`VISIBLE_REVIEW_STATUSES` = `published` + `flagged`) is used by every
 * read path and by the rating aggregate, so a flag can never accidentally become a hide in one
 * place and not another. `removed` is the only status that hides anything, and it is reachable only
 * through `moderation.ts`.
 *
 * Bytes are NEVER served from here. Media is returned as spec 027 `FileAssetDto` metadata; a client
 * fetches each asset through `GET /api/v1/files/{id}`, which re-runs `canRead` on every URL issue
 * and every content fetch — so even a leaked id cannot be turned into a download, and this module
 * can never become a second, weaker read path.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import { toFileAssetDto, type FileAssetRow } from '@/lib/files/assets';
import type { PageParams } from '@/lib/api/pagination';
import type { BookingReviewStateDto, ProviderRatingAggregate, PublicReviewDto, ReviewDto } from '@/lib/types/reviews';
import { VISIBLE_REVIEW_STATUSES } from '@/lib/types/reviews';
import { getProviderRatingAggregate } from './aggregate';
import { resolveReviewEligibility } from './eligibility';
import { reviewNotFoundError } from './errors';
import {
  REVIEW_COLUMNS,
  REVIEW_RESPONSE_COLUMNS,
  toPublicReviewDto,
  toReviewDto,
  type ReviewRelations,
  type ReviewResponseRow,
  type ReviewRow,
} from './rows';

/** The visibility predicate, written once and reused everywhere. `flagged` is included (AC-4). */
export const VISIBLE_REVIEW_SQL: SQL = sql`r.status IN (${sql.join(
  VISIBLE_REVIEW_STATUSES.map((status) => sql`${status}`),
  sql`, `,
)})`;

/** Loads one review by id, regardless of status. Callers decide who may see what. */
export async function loadReviewRow(reviewId: string, tx?: Executor): Promise<ReviewRow | null> {
  if (!isUuid(reviewId)) return null;
  const [row] = await queryRows<ReviewRow>(
    tx ?? getDb(),
    sql`SELECT ${REVIEW_COLUMNS} FROM reviews r WHERE r.id = ${reviewId}`,
  );
  return row ?? null;
}

export async function requireReviewRow(reviewId: string, tx?: Executor): Promise<ReviewRow> {
  const row = await loadReviewRow(reviewId, tx);
  if (!row) throw reviewNotFoundError();
  return row;
}

/**
 * Loads the media and response of a set of reviews in two batched queries, so a page of reviews is
 * three statements rather than 2N+1.
 *
 * A `removed` response is excluded here rather than filtered by each caller: a moderated-away reply
 * must disappear from the author's view and the admin's view too, not only from the public list.
 * A media asset is included only when it is still `ready` and not soft-deleted, so spec 027's
 * delete takes effect on this surface with no code here.
 */
export async function loadReviewRelations(
  reviewIds: readonly string[],
  tx?: Executor,
): Promise<Map<string, ReviewRelations>> {
  const relations = new Map<string, ReviewRelations>();
  for (const id of reviewIds) relations.set(id, { media: [], response: null });
  if (reviewIds.length === 0) return relations;

  const db = tx ?? getDb();
  const idList = sql.join(
    reviewIds.map((id) => sql`${id}`),
    sql`, `,
  );

  const mediaRows = await queryRows<FileAssetRow & { review_id: string }>(
    db,
    // `fa.*` rather than spec 027's unqualified `FILE_ASSET_COLUMNS`: both joined tables carry an
    // `id`, so the unqualified list is ambiguous here. The projection is still
    // `toFileAssetDto`'s, which is the only thing that reaches a client.
    sql`SELECT rm.review_id, fa.*
          FROM review_media rm
          JOIN file_assets fa ON fa.id = rm.file_asset_id
         WHERE rm.review_id IN (${idList})
           AND fa.status = 'ready'
           AND fa.deleted_at IS NULL
         ORDER BY rm.position ASC, rm.id ASC`,
  );
  for (const row of mediaRows) {
    relations.get(row.review_id)?.media.push(toFileAssetDto(row));
  }

  const responseRows = await queryRows<ReviewResponseRow>(
    db,
    sql`SELECT ${REVIEW_RESPONSE_COLUMNS} FROM review_responses rr
         WHERE rr.review_id IN (${idList}) AND rr.status <> 'removed'`,
  );
  for (const row of responseRows) {
    const entry = relations.get(row.review_id);
    if (entry) entry.response = row;
  }

  return relations;
}

/** Convenience for the single-review paths. */
export async function loadOneReviewRelations(reviewId: string, tx?: Executor): Promise<ReviewRelations> {
  const map = await loadReviewRelations([reviewId], tx);
  return map.get(reviewId) ?? { media: [], response: null };
}

export interface ProviderReviewsPage {
  items: PublicReviewDto[];
  total: number;
  aggregate: ProviderRatingAggregate;
}

/**
 * R3 — the public, guest-readable list for one provider.
 *
 * Returns `published` AND `flagged` (AC-4). A reader cannot tell them apart: `PublicReviewDto`
 * carries no `status` field at all, so there is no channel through which a flag could leak onto a
 * public surface and be mistaken for a verdict.
 */
export async function listProviderReviews(
  providerProfileId: string,
  page: PageParams,
): Promise<ProviderReviewsPage> {
  const empty: ProviderReviewsPage = { items: [], total: 0, aggregate: { average: 0, count: 0 } };
  if (!isUuid(providerProfileId)) return empty;

  const db = getDb();

  const [countRow] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM reviews r
         WHERE r.provider_profile_id = ${providerProfileId} AND ${VISIBLE_REVIEW_SQL}`,
  );
  const total = countRow?.total ?? 0;

  const rows = await queryRows<ReviewRow>(
    db,
    sql`SELECT ${REVIEW_COLUMNS} FROM reviews r
         WHERE r.provider_profile_id = ${providerProfileId} AND ${VISIBLE_REVIEW_SQL}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  const relations = await loadReviewRelations(rows.map((row) => row.id));
  return {
    items: rows.map((row) => toPublicReviewDto(row, relations.get(row.id))),
    total,
    aggregate: await getProviderRatingAggregate(providerProfileId),
  };
}

/**
 * R2 — the server-authoritative answer to "can I review this booking, and until when".
 *
 * Both participants may call it: the provider sees the review that was left about them and gets
 * `eligible: false, reason: 'not_customer'`, which is the truth rather than a `403`. The customer
 * gets the deadline, which the client renders and NEVER computes — spec 018's rule for offer expiry,
 * applied here (architecture §5.4).
 */
export async function getBookingReviewState(userId: string, bookingId: string): Promise<BookingReviewStateDto> {
  const eligibility = await resolveReviewEligibility(userId, bookingId);
  // Not a participant, or no such booking — indistinguishable on purpose.
  if (!eligibility) throw (await import('./errors')).bookingNotFoundError();

  let review: ReviewDto | null = null;
  if (eligibility.existingReviewId) {
    const row = await loadReviewRow(eligibility.existingReviewId);
    // A `removed` review is not shown back to the participants as content; its author still learns
    // that it was removed, through `status`, which is why the row is projected rather than dropped.
    if (row) review = toReviewDto(row, await loadOneReviewRelations(row.id));
  }

  return {
    bookingId,
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    windowClosesAt: eligibility.windowClosesAt,
    review,
  };
}
