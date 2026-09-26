/**
 * Spec 038 §3.13 — reads: M2 (list), M3 (detail) for admins holding `moderation/read`, and U1 (the
 * moderated user's own actions).
 *
 * Reads reconcile rejected approvals first (§3.2 step 4), so a list never shows a
 * `pending_approval` row whose `AdminAction` a second admin already rejected.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import type { PageParams } from '@/lib/api/pagination';
import { queryRows } from '@/lib/offers/db';
import { MODERATION_ACTION_STATUSES, MODERATION_ACTION_TYPES } from '@/lib/db/schema';
import type {
  ModerationActionDetailDto,
  ModerationActionDto,
  ModerationActionStatus,
  ModerationActionType,
  ModerationAppealStatus,
  MyModerationActionDto,
} from '@/lib/types/moderation';
import { validationError } from '@/lib/api/errors';
import { isUuid } from '@/lib/offers/validation';
import { MODERATION_READ_ACTION } from './catalogue';
import { moderationActionNotFoundError } from './errors';
import { approvalEntriesFor, auditModeration, MODERATION_EVENT_TYPES } from './audit';
import { reconcileRejected } from './actions';
import { holdModerationEvidence, listEvidenceIds } from './evidence';
import { requireModerationPermission } from './permissions';
import {
  loadActionOrThrow,
  SELECT_APPEAL,
  selectActions,
  toModerationActionDto,
  toModerationAppealDto,
  toMyModerationActionDto,
  type AppealRow,
} from './rows';
import { isModerationId } from './validation';

export interface ModerationListFilters {
  targetUserId?: string;
  status?: ModerationActionStatus;
  actionType?: ModerationActionType;
}

/** Query-string filters, shape-checked before they reach a uuid/text column. */
export function parseModerationListFilters(params: URLSearchParams): ModerationListFilters {
  const filters: ModerationListFilters = {};
  const errors: { field: string; message: string }[] = [];
  const targetUserId = params.get('targetUserId');
  if (targetUserId) {
    if (isUuid(targetUserId)) filters.targetUserId = targetUserId;
    else errors.push({ field: 'targetUserId', message: 'must be a UUID' });
  }
  const status = params.get('status');
  if (status) {
    if ((MODERATION_ACTION_STATUSES as readonly string[]).includes(status)) filters.status = status as ModerationActionStatus;
    else errors.push({ field: 'status', message: 'is not a moderation action status' });
  }
  const actionType = params.get('actionType');
  if (actionType) {
    if ((MODERATION_ACTION_TYPES as readonly string[]).includes(actionType)) filters.actionType = actionType as ModerationActionType;
    else errors.push({ field: 'actionType', message: 'is not a moderation action type' });
  }
  if (errors.length > 0) throw validationError(errors);
  return filters;
}

async function reconcileAndAudit(adminUserId: string, where: ReturnType<typeof sql>, correlationId: string | null): Promise<void> {
  const ids = await reconcileRejected(getDb(), where);
  for (const id of ids) {
    await auditModeration({
      actorUserId: adminUserId,
      eventType: MODERATION_EVENT_TYPES.actionRejectedReconciled,
      targetType: 'moderation_action',
      targetId: id,
      after: { status: 'rejected' },
      correlationId,
    });
  }
}

export async function listModerationActions(
  adminUserId: string,
  filters: ModerationListFilters,
  page: PageParams,
  correlationId: string | null,
): Promise<{ rows: ModerationActionDto[]; total: number }> {
  await requireModerationPermission(adminUserId, MODERATION_READ_ACTION);
  const where = sql`TRUE
    ${filters.targetUserId ? sql`AND m.target_user_id = ${filters.targetUserId}` : sql``}
    ${filters.actionType ? sql`AND m.action_type = ${filters.actionType}` : sql``}`;
  await reconcileAndAudit(adminUserId, where, correlationId);

  const fullWhere = sql`${where} ${filters.status ? sql`AND m.status = ${filters.status}` : sql``}`;
  const rows = await selectActions(getDb(), fullWhere, sql`ORDER BY m.created_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`);
  const [count] = await queryRows<{ total: string }>(getDb(), sql`SELECT count(*)::text AS total FROM moderation_actions m WHERE ${fullWhere}`);
  return { rows: rows.map(toModerationActionDto), total: Number(count?.total ?? 0) };
}

export async function getModerationActionDetail(adminUserId: string, actionId: string, correlationId: string | null): Promise<ModerationActionDetailDto> {
  await requireModerationPermission(adminUserId, MODERATION_READ_ACTION);
  if (!isModerationId(actionId)) throw moderationActionNotFoundError();
  await reconcileAndAudit(adminUserId, sql`m.id = ${actionId}`, correlationId);

  const row = await loadActionOrThrow(getDb(), actionId);
  await holdModerationEvidence(row.id);
  const [appeal] = await queryRows<AppealRow>(getDb(), sql`${SELECT_APPEAL} WHERE a.moderation_action_id = ${row.id}`);
  return {
    ...toModerationActionDto(row),
    evidenceFileAssetIds: await listEvidenceIds(row.id),
    approvalChain: await approvalEntriesFor(row.admin_action_id),
    appeal: appeal ? toModerationAppealDto(appeal, 'admin') : null,
  };
}

/** U1 — the caller's own actions. Never `pending_approval` or `rejected` (§3.13). */
export async function listMyModerationActions(userId: string, page: PageParams): Promise<{ rows: MyModerationActionDto[]; total: number }> {
  const where = sql`m.target_user_id = ${userId} AND m.status IN ('active','executed','superseded','reversed')`;
  const rows = await selectActions(getDb(), where, sql`ORDER BY m.activated_at DESC LIMIT ${page.limit} OFFSET ${page.offset}`);
  const appeals = rows.length
    ? await queryRows<{ moderation_action_id: string; status: ModerationAppealStatus; decided_at: Date | null }>(
        getDb(),
        sql`SELECT moderation_action_id, status, decided_at FROM moderation_appeals
             WHERE moderation_action_id IN (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)})`,
      )
    : [];
  const byAction = new Map(appeals.map((a) => [a.moderation_action_id, a]));
  const [count] = await queryRows<{ total: string }>(getDb(), sql`SELECT count(*)::text AS total FROM moderation_actions m WHERE ${where}`);
  return { rows: rows.map((r) => toMyModerationActionDto(r, byAction.get(r.id) ?? null)), total: Number(count?.total ?? 0) };
}
