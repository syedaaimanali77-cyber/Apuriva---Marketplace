/**
 * Spec 029 §3 "Review reporting" (AC-6) — a user's report, and the queue signal it produces.
 *
 * THE INVARIANT: a report NEVER hides anything. It moves a `published` review to `flagged`, which
 * is publicly visible and identical to `published` for every reader, and it is counted for the
 * admin who will look. No report count anywhere removes, hides or down-weights a review — a brigade
 * of reports produces a queue entry, not a takedown. Removal requires
 * `reviews_removal_pairing_ck`'s named human admin, an instant and a reason, none of which this
 * module has or can obtain.
 *
 * No generic reporting infrastructure existed to reuse: `no_show_reports` is booking-attendance
 * specific (spec 023) and `safety_reports` is spec 030's unimplemented skeleton. `review_reports` is
 * spec 003's purpose-built table, and this fills it in rather than building a second system.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { rateLimitedError } from '@/lib/api/errors';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import type { ReviewReportDto, ReviewReportReason } from '@/lib/types/reviews';
import { cannotReportOwnReviewError, idempotencyKeyConflictError, reviewNotFoundError } from './errors';
import { MAX_REPORTS_PER_WINDOW, REPORT_WINDOW_HOURS } from './limits';
import { requireReviewRow } from './read';
import { REVIEW_REPORT_COLUMNS, toReviewReportDto, type ReviewReportRow } from './rows';

/**
 * Files one report.
 *
 * A repeat by the same reporter returns the EXISTING report with `replayed: true` (`200`), not an
 * error: the reporter owns that row, so telling them it already exists enumerates nothing, and an
 * error would only teach people to file under a second reason to be heard.
 */
export async function createReviewReport(
  userId: string,
  reviewId: string,
  input: { reason: ReviewReportReason; details: string | null },
  idempotency: { key: string; fingerprint: string },
): Promise<{ report: ReviewReportDto; replayed: boolean }> {
  const created = await getDb().transaction(async (tx) => {
    const review = await requireReviewRow(reviewId, tx);

    // Already removed by a human: there is nothing left to report, and revealing that it once
    // existed would leak a moderation outcome to a stranger.
    if (review.status === 'removed') throw reviewNotFoundError();
    if (review.author_user_id === userId) throw cannotReportOwnReviewError();

    await assertUnderReportCap(tx, userId);

    /**
     * `ON CONFLICT DO NOTHING` rather than catch-then-query. A unique violation ABORTS the
     * surrounding transaction in PostgreSQL (`25P02`), so the "read the existing row and replay it"
     * step could not run afterwards — it would fail with "current transaction is aborted". Letting
     * the insert return nothing instead keeps the transaction healthy and makes the ordinary
     * duplicate and the concurrent race the same code path.
     */
    const inserted = await queryRows<ReviewReportRow>(
      tx,
      sql`INSERT INTO review_reports AS rp
            (review_id, reporter_user_id, reason, details, status, idempotency_key, idempotency_fingerprint)
          VALUES (${reviewId}, ${userId}, ${input.reason}, ${input.details}, 'open',
                  ${idempotency.key}, ${idempotency.fingerprint})
          ON CONFLICT (review_id, reporter_user_id) DO NOTHING
          RETURNING ${REVIEW_REPORT_COLUMNS}`,
    );

    let row: ReviewReportRow;
    let replayed = false;
    if (inserted.length > 0) {
      row = inserted[0]!;
    } else {
      const existing = await findExistingReport(tx, reviewId, userId);
      // Nothing inserted and nothing there: a genuine failure, not a duplicate.
      if (!existing) throw idempotencyKeyConflictError();
      row = existing;
      replayed = true;
    }

    // The ONLY status effect a report may have, and it is a widening one: `published -> flagged`.
    // A review already `flagged` stays `flagged`; a `removed` one was refused above. There is
    // deliberately no branch here that could narrow visibility.
    if (!replayed && review.status === 'published') {
      await tx.execute(
        sql`UPDATE reviews SET status = 'flagged', updated_at = clock_timestamp(), version = version + 1
             WHERE id = ${reviewId} AND status = 'published'`,
      );
    }

    return { row, replayed };
  });

  if (!created.replayed) {
    console.log(JSON.stringify({ event: 'review.reported', reviewId, reason: created.row.reason }));
  }

  return { report: toReviewReportDto(created.row), replayed: created.replayed };
}

/**
 * §3 "Abuse limiting" — a per-user cap on top of the `reviews` rate-limit domain.
 *
 * The domain budget bounds request RATE; this bounds sustained volume, which is what a determined
 * queue-flooder would otherwise use. Counted against the database clock, not the app server's.
 */
async function assertUnderReportCap(tx: Executor, userId: string): Promise<void> {
  const [row] = await queryRows<{ recent: number }>(
    tx,
    sql`SELECT count(*)::int AS recent FROM review_reports rp
         WHERE rp.reporter_user_id = ${userId}
           AND rp.created_at > clock_timestamp() - (${REPORT_WINDOW_HOURS} * interval '1 hour')`,
  );
  if ((row?.recent ?? 0) >= MAX_REPORTS_PER_WINDOW) {
    throw rateLimitedError(REPORT_WINDOW_HOURS * 3600);
  }
}

async function findExistingReport(tx: Executor, reviewId: string, userId: string): Promise<ReviewReportRow | null> {
  const [row] = await queryRows<ReviewReportRow>(
    tx,
    sql`SELECT ${REVIEW_REPORT_COLUMNS} FROM review_reports rp
         WHERE rp.review_id = ${reviewId} AND rp.reporter_user_id = ${userId}`,
  );
  return row ?? null;
}

/** The reports attached to a set of reviews, for the moderation queue. One batched query. */
export async function loadReportsForReviews(
  reviewIds: readonly string[],
  tx?: Executor,
): Promise<Map<string, ReviewReportRow[]>> {
  const byReview = new Map<string, ReviewReportRow[]>();
  for (const id of reviewIds) byReview.set(id, []);
  if (reviewIds.length === 0) return byReview;

  const rows = await queryRows<ReviewReportRow>(
    tx ?? getDb(),
    sql`SELECT ${REVIEW_REPORT_COLUMNS} FROM review_reports rp
         WHERE rp.review_id IN (${sql.join(
           reviewIds.map((id) => sql`${id}`),
           sql`, `,
         )})
         ORDER BY rp.created_at ASC, rp.id ASC`,
  );
  for (const row of rows) byReview.get(row.review_id)?.push(row);
  return byReview;
}

/** The reports a user filed — the only report data their own data export may contain (AC-10). */
export async function listReportsFiledBy(userId: string, tx?: Executor): Promise<ReviewReportRow[]> {
  return queryRows<ReviewReportRow>(
    tx ?? getDb(),
    sql`SELECT ${REVIEW_REPORT_COLUMNS} FROM review_reports rp
         WHERE rp.reporter_user_id = ${userId}
         ORDER BY rp.created_at ASC, rp.id ASC`,
  );
}
