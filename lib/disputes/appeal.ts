/**
 * Spec 031 §3 "Appeal rules" (AC-4, DECIDED-4) — filing an appeal, and deciding one.
 *
 * FOUR RULES, EACH ENFORCED IN TWO PLACES (application + database):
 *
 *   EITHER PARTICIPANT may appeal, not only the opener — a resolution can go against the party who
 *   did not open the dispute, and giving only the opener an appeal would be arbitrary.
 *
 *   EXACTLY ONE APPEAL per dispute. `dispute_appeals_dispute_uq` makes a second one impossible at
 *   the database, whoever files it. One appeal is master §68's "Appeal/review mechanism"; an
 *   unbounded chain is not.
 *
 *   WITHIN THE WINDOW, measured from `dispute_resolutions.resolved_at` against
 *   `DISPUTE_APPEAL_WINDOW_DAYS` (default 7, bounds 1..30). Evaluated at the moment of the attempt,
 *   never snapshotted, so changing the environment variable changes the deadline for
 *   already-resolved disputes — the stated and intended consequence.
 *
 *   A DIFFERENT ADMIN decides it. The caller's user id is compared to
 *   `dispute_resolutions.resolved_by_admin_user_id`; equal is `403 APPEAL_REQUIRES_DIFFERENT_ADMIN`.
 *   This is the rule spec 009's `decideAction()` applies as `SELF_APPROVAL_NOT_ALLOWED`, applied
 *   here to a decision spec 009 does not mediate.
 *
 * THE ORIGINAL RESOLUTION IS NEVER EDITED. `dispute_resolutions` is append-only; the appeal records
 * its own outcome on its own row, and the pair is the history. An overturned decision is still a
 * decision somebody made, and erasing it would destroy the audit trail the appeal exists to create.
 *
 * NOTHING IS RELEASED WHILE AN APPEAL IS PENDING: `appealed` is not `closed`, so
 * `lib/disputes/gate.ts` still answers `open: true` and the payment stays `disputed`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import type { DisputeAppealDto, DisputeStatus } from '@/lib/types/disputes';
import {
  appealAlreadyFiledError,
  appealNotAvailableError,
  appealRequiresDifferentAdminError,
  appealWindowClosedError,
  disputeNotFoundError,
  disputeStatusConflictError,
} from './errors';
import { appealWindowEndsAt, hasAppealWindowElapsed } from './limits';
import { requireDisputeReviewAppealPermission } from './permissions';
import {
  auditDispute,
  DISPUTE_EVENT_TYPES,
  loadAppealRow,
  loadResolutionRow,
  resolveAdminAccess,
  resolveParticipantAccess,
} from './read';
import { toAppealDto } from './rows';
import { closeDispute } from './close';
import type { ParsedAppeal, ParsedAppealDecision } from './validation';

/** AC-4 — a participant files the one appeal this dispute may carry. */
export async function fileAppeal(
  disputeId: string,
  userId: string,
  input: ParsedAppeal,
  idempotency: { key: string; fingerprint: string },
): Promise<{ appeal: DisputeAppealDto; replayed: boolean }> {
  const ownership = await resolveParticipantAccess(disputeId, userId);
  const db = getDb();

  const [replay] = await queryRows<{ dispute_id: string }>(
    db,
    sql`SELECT dispute_id FROM dispute_appeals WHERE appellant_user_id = ${userId} AND idempotency_key = ${idempotency.key}`,
  );
  if (replay) {
    const row = await loadAppealRow(db, replay.dispute_id);
    if (row) return { appeal: toAppealDto(row, userId), replayed: true };
  }

  if (ownership.status !== 'resolved') throw appealNotAvailableError(ownership.status);

  const resolution = await loadResolutionRow(db, disputeId);
  if (!resolution) throw appealNotAvailableError(ownership.status);

  if (hasAppealWindowElapsed(resolution.resolved_at)) {
    throw appealWindowClosedError(appealWindowEndsAt(resolution.resolved_at)!.toISOString());
  }

  try {
    await db.transaction(async (tx) => {
      const [locked] = await queryRows<{ status: DisputeStatus }>(
        tx,
        sql`SELECT status FROM disputes WHERE id = ${disputeId} FOR UPDATE`,
      );
      if (!locked) throw disputeNotFoundError();
      if (locked.status !== 'resolved') throw appealNotAvailableError(locked.status);

      await tx.execute(
        sql`INSERT INTO dispute_appeals
              (dispute_id, appellant_user_id, reason, idempotency_key, idempotency_fingerprint)
            VALUES (${disputeId}, ${userId}, ${input.reason}, ${idempotency.key}, ${idempotency.fingerprint})`,
      );

      const moved = await queryRows<{ id: string }>(
        tx,
        sql`UPDATE disputes SET status = 'appealed', updated_at = clock_timestamp(), version = version + 1
             WHERE id = ${disputeId} AND status = 'resolved'
             RETURNING id`,
      );
      if (moved.length === 0) throw appealNotAvailableError('resolved');
    });
  } catch (err) {
    if (isUniqueViolation(err, 'dispute_appeals_dispute_uq')) throw appealAlreadyFiledError();
    if (isUniqueViolation(err, 'dispute_appeals_appellant_idempotency_uq')) {
      const row = await loadAppealRow(db, disputeId);
      if (row) return { appeal: toAppealDto(row, userId), replayed: true };
    }
    throw err;
  }

  await auditDispute({
    actorUserId: userId,
    eventType: DISPUTE_EVENT_TYPES.appealFiled,
    targetId: disputeId,
    reason: input.reason,
  });

  // Deliberately NO notification: the counterparty sees the appeal in the dispute view, and a push
  // saying "you are being appealed" adds pressure without adding information (§8 "Notifications").

  const row = await loadAppealRow(db, disputeId);
  return { appeal: toAppealDto(row!, userId), replayed: false };
}

/**
 * AC-4 + AC-7 — an admin decides the appeal, which closes the dispute.
 *
 * The decision is FINAL: there is no appeal of an appeal, so this moves the dispute straight to
 * `closed` through `closeDispute()`, which is also where the money is handed back to spec 021.
 * Closure can still refuse (`422 DISPUTE_REFUND_PENDING`) if a proposed refund has not completed —
 * in which case the appeal IS decided and recorded, and the dispute closes later via the sweep.
 * Recording the decision and releasing the money are deliberately separable: a human's verdict
 * should not be lost because a payment provider is slow.
 */
export async function decideAppeal(
  disputeId: string,
  adminUserId: string,
  input: ParsedAppealDecision,
  correlationId: string | null,
): Promise<DisputeAppealDto> {
  const ownership = await resolveAdminAccess(disputeId, adminUserId, requireDisputeReviewAppealPermission);
  const db = getDb();

  if (ownership.status !== 'appealed') throw disputeStatusConflictError(ownership.status);

  const resolution = await loadResolutionRow(db, disputeId);
  if (!resolution) throw disputeNotFoundError();

  // AC-4's different-admin rule. Compared on user id, the same key `resolvePermission` and
  // `recordAdminAuditEvent` use.
  if (resolution.resolved_by_admin_user_id === adminUserId) throw appealRequiresDifferentAdminError();

  const updated = await queryRows<{ dispute_id: string }>(
    db,
    sql`UPDATE dispute_appeals
           SET outcome = ${input.outcome}, reasoning = ${input.reasoning},
               reviewed_by_admin_user_id = ${adminUserId}, decided_at = clock_timestamp(),
               updated_at = clock_timestamp(), version = version + 1
         WHERE dispute_id = ${disputeId} AND outcome IS NULL
         RETURNING dispute_id`,
  );
  if (updated.length === 0) {
    // Another reviewer decided it first. Exactly one winner, the same shape spec 009 uses.
    throw disputeStatusConflictError(ownership.status);
  }

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.appealDecided,
    targetId: disputeId,
    reason: input.reasoning,
    correlationId,
    details: { outcome: input.outcome, originalResolverUserId: resolution.resolved_by_admin_user_id },
  });

  // The appeal decision is final, so close now. A pending refund defers closure to the sweep
  // without losing the decision above.
  await closeDispute(disputeId, { actorUserId: adminUserId, correlationId, tolerateRefundPending: true });

  const row = await loadAppealRow(db, disputeId);
  return toAppealDto(row!, adminUserId);
}

/** An admin opening an appeal for review. Audited separately from the dispute detail read. */
export async function readAppealForAdmin(
  disputeId: string,
  adminUserId: string,
  correlationId: string | null,
): Promise<DisputeAppealDto | null> {
  await resolveAdminAccess(disputeId, adminUserId, requireDisputeReviewAppealPermission);
  const row = await loadAppealRow(getDb(), disputeId);
  if (!row) return null;

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.appealRead,
    targetId: disputeId,
    correlationId,
  });

  return toAppealDto(row, adminUserId);
}
