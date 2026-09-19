/**
 * Spec 029 §3 "Provider response" (AC-3) — the provider's single, immutable reply.
 *
 * OWNERSHIP IS RESOLVED SERVER-SIDE, TWICE. The route proves the caller owns *a* provider profile
 * (`requireOwnProviderProfile`); this module proves that profile is the one the review is ABOUT, by
 * comparing it against `reviews.provider_profile_id` — which was itself copied from the booking, not
 * from any client. A caller who owns a different provider profile gets `404`, indistinguishable
 * from a review that does not exist, so review ids cannot be probed.
 *
 * IMMUTABLE BY DESIGN. There is no update path and no delete path here, the stance spec 025 takes
 * for messages and spec 028 for milestones. It also closes an obvious abuse: a provider who could
 * edit could post an innocuous reply, wait for the review to be reported, and silently rewrite
 * history. A response is removed only by an authorized moderation decision (`moderation.ts`).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import type { ReviewResponseDto } from '@/lib/types/reviews';
import {
  idempotencyKeyConflictError,
  responseAlreadyExistsError,
  reviewNotFoundError,
  reviewNotRespondableError,
} from './errors';
import { notifyReviewResponsePosted } from './notifications';
import { requireReviewRow } from './read';
import { REVIEW_RESPONSE_COLUMNS, toReviewResponseDto, type ReviewResponseRow } from './rows';
import { evaluateReviewSignals } from './signals';

/**
 * Posts the one response a review may have.
 *
 * AC-3's "exactly one" is the database's to decide: `review_responses_review_id_uq` resolves the
 * race between two concurrent posts, and the pre-insert check exists only for the friendly error on
 * the uncontended path.
 *
 * A response runs through the SAME pure signal evaluation a review does, so an abusive reply is
 * flagged for a human — and, exactly as with a review, `flagged` stays visible. This module cannot
 * produce `removed`: `review_responses_removal_pairing_ck` requires a named admin and a reason.
 */
export async function createReviewResponse(
  userId: string,
  providerProfileId: string,
  reviewId: string,
  input: { text: string },
  idempotency: { key: string; fingerprint: string },
): Promise<{ response: ReviewResponseDto; replayed: boolean }> {
  const created = await getDb().transaction(async (tx) => {
    const review = await requireReviewRow(reviewId, tx);

    // The profile the route proved this caller owns must be the one the review is about.
    if (review.provider_profile_id !== providerProfileId) throw reviewNotFoundError();

    /**
     * Resolved BEFORE the "already responded" check, and that order matters. A client retrying the
     * request that succeeded violates BOTH unique indexes, and the database reports whichever it
     * reaches first — so without this, an honest retry would sometimes be told
     * `409 RESPONSE_ALREADY_EXISTS` about its own reply. Scoped to `(review, key)`, so it can only
     * ever return this caller's own row.
     */
    const replay = await findByIdempotencyKey(tx, reviewId, idempotency.key);
    if (replay) {
      if (replay.fingerprint !== idempotency.fingerprint) throw idempotencyKeyConflictError();
      return { row: replay.row, replayed: true };
    }

    if (review.status === 'removed') throw reviewNotRespondableError(review.status);

    const { codes } = evaluateReviewSignals(input.text);
    const status = codes.length > 0 ? 'flagged' : 'published';

    try {
      const rows = await queryRows<ReviewResponseRow>(
        tx,
        sql`INSERT INTO review_responses AS rr
              (review_id, responder_user_id, text, status, flag_signals, idempotency_key, idempotency_fingerprint)
            VALUES (${reviewId}, ${userId}, ${input.text}, ${status}, ${JSON.stringify(codes)}::jsonb,
                    ${idempotency.key}, ${idempotency.fingerprint})
            RETURNING ${REVIEW_RESPONSE_COLUMNS}`,
      );
      return { row: rows[0]!, replayed: false };
    } catch (err) {
      if (isUniqueViolation(err, 'review_responses_review_id_uq')) throw responseAlreadyExistsError();

      /**
       * A same-key request that was in flight when this one started. Every SEQUENTIAL retry was
       * already handled by the replay lookup above, so reaching here means two identical requests
       * raced. Nothing is re-queried: a unique violation has ABORTED this transaction (PostgreSQL
       * `25P02`), so any further statement on it would fail.
       */
      if (isUniqueViolation(err, 'review_responses_idempotency_uq')) throw idempotencyKeyConflictError();
      throw err;
    }
  });

  const response = toReviewResponseDto(created.row);

  if (!created.replayed) {
    console.log(JSON.stringify({ event: 'review.response_created', reviewId, status: response.status }));
    // Best-effort and outside the transaction: a notification failure must never roll back a reply.
    await notifyReviewResponsePosted(reviewId).catch(() => undefined);
  }

  return { response, replayed: created.replayed };
}

async function findByIdempotencyKey(
  tx: Executor,
  reviewId: string,
  key: string,
): Promise<{ row: ReviewResponseRow; fingerprint: string } | null> {
  const [row] = await queryRows<ReviewResponseRow & { idempotency_fingerprint: string }>(
    tx,
    sql`SELECT ${REVIEW_RESPONSE_COLUMNS}, rr.idempotency_fingerprint FROM review_responses rr
         WHERE rr.review_id = ${reviewId} AND rr.idempotency_key = ${key}`,
  );
  return row ? { row, fingerprint: row.idempotency_fingerprint } : null;
}
