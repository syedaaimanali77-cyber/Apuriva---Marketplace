/**
 * Spec 029 §3 — review creation (AC-1, AC-2, AC-4, AC-5, AC-7).
 *
 * WHAT THE CLIENT CONTROLS, AND WHAT IT DOES NOT. The body carries a rating, optional text and
 * optional media ids. It carries no provider id, no service id, no customer id, no author id and no
 * status. `provider_profile_id` and `service_id` are copied from the booking row inside this
 * transaction, so there is no interface through which a caller could attribute a review to a
 * different provider or review on someone else's behalf (AC-2).
 *
 * AC-7 IS THE DATABASE'S TO DECIDE. `reviews_booking_id_uq` resolves the race: two concurrent
 * submissions both pass the eligibility read, exactly one INSERT succeeds, and the loser's `23505`
 * becomes `409 REVIEW_ALREADY_EXISTS`. A read-then-write could not promise that, so the pre-insert
 * check here exists only to produce the friendly error on the ordinary, uncontended path.
 *
 * AC-4/AC-5. Signals are evaluated by the PURE `evaluateReviewSignals`, which never sees the rating.
 * A hit yields `flagged` — publicly visible, queued for a human — and nothing else. This module
 * cannot produce `removed`: `reviews_removal_pairing_ck` requires a named admin, an instant and a
 * reason, none of which exists on this path.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import type { ReviewDto } from '@/lib/types/reviews';
import {
  bookingNotEligibleForReviewError,
  bookingNotFoundError,
  idempotencyKeyConflictError,
  reviewAlreadyExistsError,
  reviewMediaAssetInvalidError,
  reviewWindowClosedError,
} from './errors';
import { resolveReviewEligibility } from './eligibility';
import {
  BURST_SUBMISSION_WINDOW_HOURS,
  REPEAT_PAIR_WINDOW_DAYS,
  REVIEW_MEDIA_CONTEXT,
} from './limits';
import { notifyReviewReceived } from './notifications';
import { loadOneReviewRelations } from './read';
import { REVIEW_COLUMNS, toReviewDto, type ReviewRow } from './rows';
import { evaluateReviewSignals } from './signals';
import type { ParsedReview } from './validation';

/**
 * Creates the one review a completed booking may have.
 *
 * Runs in a single transaction so eligibility, the history counts the manipulation signals need,
 * the insert and the media links all describe the same moment.
 */
export async function createReview(
  userId: string,
  bookingId: string,
  input: ParsedReview,
  idempotency: { key: string; fingerprint: string },
): Promise<{ review: ReviewDto; replayed: boolean }> {
  const created = await getDb().transaction(async (tx) => {
    /**
     * The idempotency replay is resolved BEFORE eligibility, and that order matters. A client
     * retrying the very request that succeeded would otherwise be told `409 REVIEW_ALREADY_EXISTS`
     * by the eligibility check — technically true, but the wrong answer: the review it is being
     * told about is its own. Scoped to `(author, key)`, so this can only ever return the caller's
     * own row.
     */
    const replay = await findByIdempotencyKey(tx, userId, idempotency.key);
    if (replay) {
      if (replay.fingerprint !== idempotency.fingerprint) throw idempotencyKeyConflictError();
      return { row: replay.row, replayed: true };
    }

    const eligibility = await resolveReviewEligibility(userId, bookingId, tx);
    // Not a participant, or no such booking — indistinguishable, so ids cannot be probed.
    if (!eligibility) throw bookingNotFoundError();

    if (!eligibility.eligible) {
      if (eligibility.reason === 'already_reviewed') throw reviewAlreadyExistsError();
      if (eligibility.reason === 'window_closed') throw reviewWindowClosedError(eligibility.windowClosesAt!);
      // `not_customer` and `not_completed` both mean "no verified completed booking of yours".
      throw bookingNotEligibleForReviewError(eligibility.reason!);
    }

    // Validated BEFORE the insert and against the identical predicate the read path uses, so a
    // foreign, unscanned or soft-deleted asset can only ever cause a request to fail — never widen
    // what is published (spec 028's rule for `evidenceFileAssetIds`).
    await assertMediaBelongsToBooking(tx, userId, bookingId, input.mediaFileAssetIds);

    const history = await loadHistoryCounts(tx, userId, eligibility.providerProfileId);
    const { codes } = evaluateReviewSignals(input.text, history);
    const status = codes.length > 0 ? 'flagged' : 'published';

    let row: ReviewRow;
    try {
      const inserted = await queryRows<ReviewRow>(
        tx,
        sql`INSERT INTO reviews AS r
              (booking_id, author_user_id, provider_profile_id, service_id, rating, text, status,
               flag_signals, idempotency_key, idempotency_fingerprint)
            VALUES (${bookingId}, ${userId}, ${eligibility.providerProfileId}, ${eligibility.serviceId},
                    ${input.rating}, ${input.text}, ${status},
                    ${JSON.stringify(codes)}::jsonb, ${idempotency.key}, ${idempotency.fingerprint})
            RETURNING ${REVIEW_COLUMNS}`,
      );
      row = inserted[0]!;
    } catch (err) {
      // AC-7: the concurrent loser. Both callers passed eligibility; the index decided.
      if (isUniqueViolation(err, 'reviews_booking_id_uq')) throw reviewAlreadyExistsError();

      /**
       * A same-key request that was in flight when this one started. The replay lookup above
       * already handled every SEQUENTIAL retry, so reaching here means two identical requests
       * raced. Nothing is re-queried: a unique violation has ABORTED this transaction
       * (PostgreSQL `25P02`), so any further statement on it would fail. The caller is told to
       * retry, and that retry takes the replay path cleanly.
       */
      if (isUniqueViolation(err, 'reviews_author_idempotency_uq')) throw idempotencyKeyConflictError();
      throw err;
    }

    await linkMedia(tx, row.id, input.mediaFileAssetIds);
    return { row, replayed: false };
  });

  const review = toReviewDto(created.row, await loadOneReviewRelations(created.row.id));

  if (!created.replayed) {
    console.log(
      JSON.stringify({
        event: 'review.created',
        reviewId: review.id,
        bookingId,
        status: review.status,
        // Observability (§9): the flag RATE and its signal breakdown. Never the text, never the
        // author, and never the rating — a counter must not become a back door to the content.
        flagSignals: evaluateSignalCodes(created.row),
        mediaCount: review.media.length,
      }),
    );
    // Best-effort, and deliberately outside the transaction: a notification failure must never
    // roll back a published review.
    await notifyReviewReceived(review.id, bookingId).catch(() => undefined);
  }

  return { review, replayed: created.replayed };
}

function evaluateSignalCodes(row: ReviewRow): string[] {
  const raw = typeof row.flag_signals === 'string' ? JSON.parse(row.flag_signals) : row.flag_signals;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

/**
 * The two manipulation signals master §52 names, counted from this author's own history.
 *
 * Read inside the creating transaction so a burst of concurrent submissions is judged against a
 * consistent snapshot, and against `clock_timestamp()` rather than `now()` — the latter is frozen
 * at transaction start, which would make the window drift on a slow transaction.
 */
async function loadHistoryCounts(
  tx: Executor,
  userId: string,
  providerProfileId: string,
): Promise<{ authorRecentReviews: number; pairRecentReviews: number }> {
  const [row] = await queryRows<{ author_recent: number; pair_recent: number }>(
    tx,
    sql`SELECT
          count(*) FILTER (
            WHERE r.created_at > clock_timestamp() - (${BURST_SUBMISSION_WINDOW_HOURS} * interval '1 hour')
          )::int AS author_recent,
          count(*) FILTER (
            WHERE r.provider_profile_id = ${providerProfileId}
              AND r.created_at > clock_timestamp() - (${REPEAT_PAIR_WINDOW_DAYS} * interval '1 day')
          )::int AS pair_recent
        FROM reviews r
       WHERE r.author_user_id = ${userId}`,
  );
  return { authorRecentReviews: row?.author_recent ?? 0, pairRecentReviews: row?.pair_recent ?? 0 };
}

/**
 * Every id the caller listed must be a live `ready` `review_media` asset of THIS booking that THIS
 * caller uploaded. The ownership term matters: without it, a customer could publish another
 * customer's photo of their own home by quoting its id.
 */
async function assertMediaBelongsToBooking(
  tx: Executor,
  userId: string,
  bookingId: string,
  fileAssetIds: readonly string[],
): Promise<void> {
  if (fileAssetIds.length === 0) return;

  const rows = await queryRows<{ id: string }>(
    tx,
    sql`SELECT fa.id FROM file_assets fa
         WHERE fa.id IN (${sql.join(
           fileAssetIds.map((id) => sql`${id}`),
           sql`, `,
         )})
           AND fa.context_type = ${REVIEW_MEDIA_CONTEXT}
           AND fa.context_id = ${bookingId}
           AND fa.uploaded_by_user_id = ${userId}
           AND fa.status = 'ready'
           AND fa.deleted_at IS NULL`,
  );

  const found = new Set(rows.map((row) => row.id));
  const invalid = fileAssetIds.filter((id) => !found.has(id));
  if (invalid.length > 0) throw reviewMediaAssetInvalidError(invalid);
}

/** Binds the validated assets to the review, in the order the customer chose. */
async function linkMedia(tx: Executor, reviewId: string, fileAssetIds: readonly string[]): Promise<void> {
  for (const [position, fileAssetId] of fileAssetIds.entries()) {
    await tx.execute(
      sql`INSERT INTO review_media (review_id, file_asset_id, position)
          VALUES (${reviewId}, ${fileAssetId}, ${position})`,
    );
  }
}

async function findByIdempotencyKey(
  tx: Executor,
  userId: string,
  key: string,
): Promise<{ row: ReviewRow; fingerprint: string } | null> {
  const [row] = await queryRows<ReviewRow & { idempotency_fingerprint: string }>(
    tx,
    sql`SELECT ${REVIEW_COLUMNS}, r.idempotency_fingerprint FROM reviews r
         WHERE r.author_user_id = ${userId} AND r.idempotency_key = ${key}`,
  );
  return row ? { row, fingerprint: row.idempotency_fingerprint } : null;
}
