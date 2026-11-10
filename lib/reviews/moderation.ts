/**
 * Spec 029 §3 "Moderation" (AC-4, AC-5, AC-8, AC-9) — the moderation queue and the ONE resolution
 * path.
 *
 * THIS IS THE ONLY MODULE IN THE REPOSITORY THAT MAY WRITE `status = 'removed'`.
 * `lib/reviews/boundary.test.ts` asserts that at the source level, and
 * `reviews_removal_pairing_ck` asserts it at the database: a removal without a named admin profile,
 * an instant and a recorded reason is physically unrepresentable, so even a future bug elsewhere
 * cannot hide a review. Those two layers are what make AC-4 and AC-8 mechanical rather than
 * aspirational.
 *
 * `reinstate` is master §68's required appeal/review mechanism: a removal is reversible, by the same
 * permission, with its own audit entry. `keep` clears a flag without hiding anything, which is the
 * outcome a legitimate negative review that was brigaded should reach (AC-5).
 *
 * EVERY decision writes exactly one `recordAdminAuditEvent` (spec 009 → spec 039's store). If the
 * audit write fails, the transaction fails and the status does not change: an unauditable moderation
 * action is worse than an unmoderated review.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { getAdminRoleNames } from '@/lib/admin-rbac/permissions';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { PageParams } from '@/lib/api/pagination';
import type { AdminReviewDto, ReviewModerationDecision, ReviewStatus } from '@/lib/types/reviews';
import { reviewNotFoundError, reviewStatusConflictError } from './errors';
import { loadReviewRelations, requireReviewRow } from './read';
import { loadReportsForReviews } from './report';
import { REVIEW_COLUMNS, toAdminReviewDto, type ReviewRow } from './rows';

/** The audit event type. Namespaced `reviews.*` so spec 039 can find them all. */
export const REVIEW_MODERATION_EVENT_TYPE = 'reviews.moderation_resolved';

/** What each decision means for the row. The single source of the mapping. */
const DECISION_TO_STATUS: Record<ReviewModerationDecision, ReviewStatus> = {
  keep: 'published',
  remove: 'removed',
  reinstate: 'published',
};

export interface ModerationQueuePage {
  items: AdminReviewDto[];
  total: number;
}

/**
 * R6 — everything awaiting a human: `flagged` reviews plus any review carrying an `open` report.
 *
 * Oldest-first, because the point of the queue is that nothing waits indefinitely, and queue age is
 * the §9 counter that makes a backlog visible.
 */
export async function listModerationQueue(page: PageParams): Promise<ModerationQueuePage> {
  const db = getDb();
  const predicate = sql`(r.status = 'flagged' OR EXISTS (
        SELECT 1 FROM review_reports rp WHERE rp.review_id = r.id AND rp.status = 'open'))`;

  const [countRow] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM reviews r WHERE ${predicate}`,
  );

  const rows = await queryRows<ReviewRow>(
    db,
    sql`SELECT ${REVIEW_COLUMNS} FROM reviews r
         WHERE ${predicate}
         ORDER BY r.created_at ASC, r.id ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  return { items: await toAdminDtos(rows), total: countRow?.total ?? 0 };
}

/** R7 — one admin's decision on one review. */
export async function resolveReviewModeration(params: {
  adminUserId: string;
  reviewId: string;
  decision: ReviewModerationDecision;
  reason: string;
  expectedStatus: ReviewStatus;
  correlationId: string;
}): Promise<AdminReviewDto> {
  const { adminUserId, reviewId, decision, reason, expectedStatus, correlationId } = params;
  const target = DECISION_TO_STATUS[decision];

  const row = await getDb().transaction(async (tx) => {
    const adminProfileId = await requireAdminProfileId(tx, adminUserId);
    const current = await requireReviewRow(reviewId, tx);

    // Optimistic concurrency, the conditional-update shape `applyBookingTransition()` uses: two
    // admins resolving simultaneously cannot silently overwrite each other, and the loser is told
    // what the row actually says so they can decide again.
    if (current.status !== expectedStatus) throw reviewStatusConflictError(current.status);

    const updated = await queryRows<ReviewRow>(
      tx,
      target === 'removed'
        ? sql`UPDATE reviews AS r
                 SET status = 'removed',
                     removal_reason = ${reason},
                     moderated_by_admin_id = ${adminProfileId},
                     moderated_at = clock_timestamp(),
                     updated_at = clock_timestamp(),
                     version = version + 1
               WHERE r.id = ${reviewId} AND r.status = ${expectedStatus}
               RETURNING ${REVIEW_COLUMNS}`
        : // `keep` and `reinstate` both land on `published`. The removal trio is cleared together,
          // because `reviews_removal_pairing_ck` refuses a non-removed row that still carries one.
          sql`UPDATE reviews AS r
                 SET status = 'published',
                     removal_reason = NULL,
                     moderated_by_admin_id = NULL,
                     moderated_at = NULL,
                     updated_at = clock_timestamp(),
                     version = version + 1
               WHERE r.id = ${reviewId} AND r.status = ${expectedStatus}
               RETURNING ${REVIEW_COLUMNS}`,
    );
    // Lost a race after the check: report the current truth rather than a stale success.
    if (updated.length === 0) throw reviewStatusConflictError((await requireReviewRow(reviewId, tx)).status);

    // Resolving the review resolves its open reports, in the same transaction — so there is one
    // decision surface and no second queue that could drift out of step with this one.
    await tx.execute(
      sql`UPDATE review_reports
             SET status = ${target === 'removed' ? 'resolved' : 'dismissed'},
                 resolved_by_admin_id = ${adminProfileId},
                 resolved_at = clock_timestamp(),
                 updated_at = clock_timestamp(),
                 version = version + 1
           WHERE review_id = ${reviewId} AND status = 'open'`,
    );

    // Inside the transaction on purpose: if the audit write fails, the decision is rolled back.
    await recordAdminAuditEvent({
      actorUserId: adminUserId,
      actorRoles: await getAdminRoleNames(adminUserId),
      eventType: REVIEW_MODERATION_EVENT_TYPE,
      resource: 'reviews',
      action: 'moderate',
      targetType: 'review',
      targetId: reviewId,
      reason,
      approvalChain: [],
      correlationId,
    });

    return updated[0]!;
  });

  console.log(
    // §9 observability: the removal counter AC-8 is guarded by. It must always equal the number of
    // `reviews.moderation_resolved` audit events carrying `decision: 'remove'` and never exceed it.
    JSON.stringify({ event: 'review.moderation_resolved', reviewId, decision, status: row.status }),
  );

  const [dto] = await toAdminDtos([row]);
  return dto!;
}

/**
 * The acting admin's `admin_profiles` row. Required, not optional: `reviews_removal_pairing_ck`
 * takes an admin profile id, so an actor without one cannot remove anything — which is the point.
 */
async function requireAdminProfileId(tx: Executor, adminUserId: string): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    tx,
    sql`SELECT id FROM admin_profiles WHERE user_id = ${adminUserId}`,
  );
  if (!row) throw reviewNotFoundError();
  return row.id;
}

async function toAdminDtos(rows: ReviewRow[]): Promise<AdminReviewDto[]> {
  const ids = rows.map((row) => row.id);
  const [relations, reports] = await Promise.all([loadReviewRelations(ids), loadReportsForReviews(ids)]);
  return rows.map((row) =>
    toAdminReviewDto(row, relations.get(row.id) ?? { media: [], response: null }, reports.get(row.id) ?? []),
  );
}
