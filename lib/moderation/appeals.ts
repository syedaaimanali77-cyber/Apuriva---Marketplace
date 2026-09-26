/**
 * Spec 038 §3.12 (AC-5) — filing an appeal and deciding one, on spec 031's pattern:
 *
 *   ONLY THE TARGET files (anyone else gets `404`, indistinguishable from a missing action), and only
 *   while the action is `active` and of an appealable type. No time window is invented: the appeal is
 *   open for as long as the action is.
 *
 *   EXACTLY ONE APPEAL per action — `moderation_appeals_moderation_action_id_uq` enforces it.
 *
 *   A DIFFERENT ADMIN decides: never the initiator and never spec 009's approver
 *   (`403 APPEAL_REQUIRES_DIFFERENT_ADMIN`).
 *
 *   `upheld` REVERSES through the §3.4 reversal service, in the same transaction as the decision —
 *   the only path back to `active` besides M5/M6. `denied` records the decision only. A reversal that
 *   finds the lifecycle changed rolls the whole decision back, leaving the appeal `pending`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { PageParams } from '@/lib/api/pagination';
import { getAdminProfileId } from '@/lib/admin-rbac/permissions';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import type { ModerationAppealDto, ModerationAppealStatus } from '@/lib/types/moderation';
import { APPEALABLE, MODERATION_REVIEW_APPEAL_ACTION } from './catalogue';
import {
  adminForbiddenError,
  appealAlreadyFiledError,
  appealNotAvailableError,
  appealRequiresDifferentAdminError,
  appealStatusConflictError,
  idempotencyKeyConflictError,
  moderationActionNotFoundError,
  moderationAppealNotFoundError,
} from './errors';
import { auditModeration, MODERATION_EVENT_TYPES } from './audit';
import { reverseModerationActionInTx } from './actions';
import { holdModerationEvidence } from './evidence';
import { emitModerationNotification } from './notifications';
import { requireModerationPermission } from './permissions';
import { loadAction, SELECT_APPEAL, toModerationAppealDto, type AppealRow } from './rows';
import { isModerationId } from './validation';

async function loadAppealRow(where: ReturnType<typeof sql>): Promise<AppealRow | undefined> {
  const [row] = await queryRows<AppealRow>(getDb(), sql`${SELECT_APPEAL} WHERE ${where}`);
  return row;
}

/** U2 — the target files the one appeal an action may carry. */
export async function fileModerationAppeal(input: {
  userId: string;
  actionId: string;
  statement: string;
  idempotencyKey: string;
  fingerprint: string;
  correlationId: string | null;
}): Promise<{ appeal: ModerationAppealDto; replayed: boolean }> {
  if (!isModerationId(input.actionId)) throw moderationActionNotFoundError();

  const replay = await loadAppealRow(sql`a.appellant_user_id = ${input.userId} AND a.idempotency_key = ${input.idempotencyKey}`);
  if (replay) {
    if (replay.idempotency_fingerprint !== input.fingerprint || replay.moderation_action_id !== input.actionId) {
      throw idempotencyKeyConflictError();
    }
    return { appeal: toModerationAppealDto(replay, 'appellant'), replayed: true };
  }

  const action = await loadAction(getDb(), input.actionId);
  if (!action || action.target_user_id !== input.userId) throw moderationActionNotFoundError();
  if (!APPEALABLE.has(action.action_type) || action.status !== 'active') throw appealNotAvailableError();
  if (await loadAppealRow(sql`a.moderation_action_id = ${action.id}`)) throw appealAlreadyFiledError();

  let id: string;
  try {
    const [inserted] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO moderation_appeals (moderation_action_id, appellant_user_id, statement, idempotency_key, idempotency_fingerprint)
          VALUES (${action.id}, ${input.userId}, ${input.statement}, ${input.idempotencyKey}, ${input.fingerprint})
          RETURNING id`,
    );
    id = inserted!.id;
  } catch (err) {
    if (isUniqueViolation(err, 'moderation_appeals_moderation_action_id_uq')) throw appealAlreadyFiledError();
    if (isUniqueViolation(err, 'moderation_appeals_appellant_idempotency_uq')) throw idempotencyKeyConflictError();
    throw err;
  }

  await auditModeration({
    actorUserId: input.userId,
    asNonAdmin: true,
    eventType: MODERATION_EVENT_TYPES.appealFiled,
    targetType: 'moderation_action',
    targetId: action.id,
    after: { appealId: id, status: 'pending' },
    correlationId: input.correlationId,
  });
  return { appeal: toModerationAppealDto((await loadAppealRow(sql`a.id = ${id}`))!, 'appellant'), replayed: false };
}

export async function listModerationAppeals(
  adminUserId: string,
  status: ModerationAppealStatus | undefined,
  page: PageParams,
): Promise<{ rows: ModerationAppealDto[]; total: number }> {
  await requireModerationPermission(adminUserId, MODERATION_REVIEW_APPEAL_ACTION);
  const where = status ? sql`a.status = ${status}` : sql`TRUE`;
  const rows = await queryRows<AppealRow>(
    getDb(),
    sql`${SELECT_APPEAL} WHERE ${where} ORDER BY a.created_at ASC LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: string }>(getDb(), sql`SELECT count(*)::text AS total FROM moderation_appeals a WHERE ${where}`);
  return { rows: rows.map((r) => toModerationAppealDto(r, 'admin')), total: Number(count?.total ?? 0) };
}

/** A2 — decided by an admin who neither initiated nor approved the appealed action. */
export async function decideModerationAppeal(input: {
  adminUserId: string;
  appealId: string;
  decision: 'upheld' | 'denied';
  reason: string;
  correlationId: string | null;
}): Promise<ModerationAppealDto> {
  await requireModerationPermission(input.adminUserId, MODERATION_REVIEW_APPEAL_ACTION);
  if (!isModerationId(input.appealId)) throw moderationAppealNotFoundError();
  const deciderProfileId = await getAdminProfileId(input.adminUserId);
  if (!deciderProfileId) throw adminForbiddenError();

  const appeal = await loadAppealRow(sql`a.id = ${input.appealId}`);
  if (!appeal) throw moderationAppealNotFoundError();
  if (appeal.status !== 'pending') throw appealStatusConflictError(appeal.status);

  const action = await loadAction(getDb(), appeal.moderation_action_id);
  if (!action) throw moderationActionNotFoundError();
  const approvers = action.admin_action_id
    ? await queryRows<{ approver_admin_id: string }>(
        getDb(),
        sql`SELECT approver_admin_id FROM admin_action_approvals WHERE admin_action_id = ${action.admin_action_id}`,
      )
    : [];
  if (action.initiated_by_admin_id === deciderProfileId || approvers.some((a) => a.approver_admin_id === deciderProfileId)) {
    throw appealRequiresDifferentAdminError();
  }

  let reversal: { before: Record<string, string | null>; after: Record<string, string | null> } | null = null;
  await getDb().transaction(async (tx) => {
    const updated = await queryRows<{ id: string }>(
      tx,
      sql`UPDATE moderation_appeals
             SET status = ${input.decision}, decided_by_admin_id = ${deciderProfileId}, decision_reason = ${input.reason},
                 decided_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${appeal.id} AND status = 'pending' RETURNING id`,
    );
    if (updated.length === 0) throw appealStatusConflictError('decided');
    if (input.decision === 'upheld') {
      const result = await reverseModerationActionInTx(tx, action.id, { adminProfileId: deciderProfileId, reason: input.reason });
      reversal = { before: result.before, after: result.after };
    }
  });

  await holdModerationEvidence(action.id);
  await auditModeration({
    actorUserId: input.adminUserId,
    eventType: MODERATION_EVENT_TYPES.appealDecided,
    targetType: 'moderation_appeal',
    targetId: appeal.id,
    reason: input.reason,
    after: { decision: input.decision, moderationActionId: action.id },
    correlationId: input.correlationId,
  });
  const reversed = reversal as { before: Record<string, string | null>; after: Record<string, string | null> } | null;
  if (reversed) {
    await auditModeration({
      actorUserId: input.adminUserId,
      eventType: MODERATION_EVENT_TYPES.actionReversed,
      targetType: 'moderation_action',
      targetId: action.id,
      reason: input.reason,
      before: { status: 'active', ...reversed.before },
      after: { status: 'reversed', via: 'appeal', appealId: appeal.id, ...reversed.after },
      correlationId: input.correlationId,
    });
  }
  void emitModerationNotification({ kind: 'moderation_appeal_decided', appealId: appeal.id, recipientUserId: appeal.appellant_user_id });
  return toModerationAppealDto((await loadAppealRow(sql`a.id = ${appeal.id}`))!, 'admin');
}
