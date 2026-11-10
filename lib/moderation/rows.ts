/**
 * Spec 038 — the raw-row shapes this domain reads, and their DTO mappings. Raw `sql` (the
 * `lib/offers/db` idiom) because every mutation here needs row locks and conditional updates.
 */
import { sql, type SQL } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import type {
  AccountStanding,
  FraudSignalDto,
  ModerationActionDto,
  ModerationActionStatus,
  ModerationActionType,
  ModerationAppealDto,
  ModerationAppealStatus,
  ModerationScope,
  MyModerationActionDto,
  RefundTreatment,
} from '@/lib/types/moderation';
import type { RiskTier } from '@/lib/types/admin-rbac';
import { APPEALABLE } from './catalogue';
import { moderationActionNotFoundError } from './errors';

export interface ModerationRow {
  id: string;
  action_type: ModerationActionType;
  scope: ModerationScope;
  target_user_id: string;
  provider_profile_id: string | null;
  booking_id: string | null;
  refund_treatment: RefundTreatment | null;
  risk_tier: RiskTier;
  status: ModerationActionStatus;
  reason: string;
  user_message: string | null;
  initiated_by_admin_id: string;
  initiated_by_user_id: string;
  admin_action_id: string | null;
  reversal_admin_action_id: string | null;
  previous_user_standing: AccountStanding | null;
  previous_provider_lifecycle_status: string | null;
  superseded_by_moderation_action_id: string | null;
  origin_safety_report_id: string | null;
  origin_fraud_signal_id: string | null;
  activated_at: Date | null;
  reversed_at: Date | null;
  reversed_by_admin_id: string | null;
  reversal_reason: string | null;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  created_at: Date;
}

const SELECT_ACTION = sql`SELECT m.*, ip.user_id AS initiated_by_user_id
                            FROM moderation_actions m
                            JOIN admin_profiles ip ON ip.id = m.initiated_by_admin_id`;

export async function selectActions(executor: Executor, where: SQL, suffix: SQL = sql``): Promise<ModerationRow[]> {
  return queryRows<ModerationRow>(executor, sql`${SELECT_ACTION} WHERE ${where} ${suffix}`);
}

export async function loadAction(executor: Executor, id: string): Promise<ModerationRow | undefined> {
  const [row] = await selectActions(executor, sql`m.id = ${id}`);
  return row;
}

export async function loadActionOrThrow(executor: Executor, id: string): Promise<ModerationRow> {
  const row = await loadAction(executor, id);
  if (!row) throw moderationActionNotFoundError();
  return row;
}

function iso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function toModerationActionDto(row: ModerationRow): ModerationActionDto {
  return {
    id: row.id,
    actionType: row.action_type,
    scope: row.scope,
    targetUserId: row.target_user_id,
    providerProfileId: row.provider_profile_id,
    bookingId: row.booking_id,
    refundTreatment: row.refund_treatment,
    riskTier: row.risk_tier,
    status: row.status,
    reason: row.reason,
    userMessage: row.user_message,
    adminActionId: row.admin_action_id,
    reversalAdminActionId: row.reversal_admin_action_id,
    previousUserStanding: row.previous_user_standing,
    previousProviderLifecycleStatus: row.previous_provider_lifecycle_status,
    originSafetyReportId: row.origin_safety_report_id,
    originFraudSignalId: row.origin_fraud_signal_id,
    initiatedByAdminUserId: row.initiated_by_user_id,
    createdAt: new Date(row.created_at).toISOString(),
    activatedAt: iso(row.activated_at),
    reversedAt: iso(row.reversed_at),
  };
}

/** The target's own view (§3.14): no reason, evidence, admin identity or origin. */
export function toMyModerationActionDto(
  row: ModerationRow,
  appeal: { status: ModerationAppealStatus; decided_at: Date | null } | null,
): MyModerationActionDto {
  return {
    id: row.id,
    actionType: row.action_type,
    scope: row.scope,
    status: row.status as MyModerationActionDto['status'],
    userMessage: row.user_message,
    activatedAt: new Date(row.activated_at!).toISOString(),
    appealable: APPEALABLE.has(row.action_type) && row.status === 'active' && appeal === null,
    appeal: appeal ? { status: appeal.status, decidedAt: iso(appeal.decided_at) } : null,
  };
}

export interface AppealRow {
  id: string;
  moderation_action_id: string;
  appellant_user_id: string;
  statement: string;
  status: ModerationAppealStatus;
  decided_by_admin_id: string | null;
  decided_by_user_id: string | null;
  decision_reason: string | null;
  decided_at: Date | null;
  idempotency_key: string;
  idempotency_fingerprint: string;
  created_at: Date;
}

export const SELECT_APPEAL = sql`SELECT a.*, dp.user_id AS decided_by_user_id
                                   FROM moderation_appeals a
                                   LEFT JOIN admin_profiles dp ON dp.id = a.decided_by_admin_id`;

export function toModerationAppealDto(row: AppealRow, audience: 'admin' | 'appellant'): ModerationAppealDto {
  return {
    id: row.id,
    moderationActionId: row.moderation_action_id,
    status: row.status,
    statement: row.statement,
    decisionReason: audience === 'admin' ? row.decision_reason : null,
    decidedByAdminUserId: audience === 'admin' ? row.decided_by_user_id : null,
    createdAt: new Date(row.created_at).toISOString(),
    decidedAt: iso(row.decided_at),
  };
}

export interface FraudSignalRow {
  id: string;
  target_user_id: string;
  source: FraudSignalDto['source'];
  rule_key: string;
  observed_count: number;
  threshold: number;
  window_days: number;
  status: FraudSignalDto['status'];
  created_at: Date;
  triaged_by_user_id: string | null;
  triage_reason: string | null;
  moderation_action_id: string | null;
}

export const SELECT_SIGNAL = sql`SELECT s.id, s.target_user_id, s.source, s.rule_key, s.observed_count, s.threshold,
                                        s.window_days, s.status, s.created_at, s.triage_reason,
                                        tp.user_id AS triaged_by_user_id,
                                        (SELECT m.id FROM moderation_actions m WHERE m.origin_fraud_signal_id = s.id
                                          ORDER BY m.created_at DESC LIMIT 1) AS moderation_action_id
                                   FROM fraud_signals s
                                   LEFT JOIN admin_profiles tp ON tp.id = s.triaged_by_admin_id`;

export function toFraudSignalDto(row: FraudSignalRow): FraudSignalDto {
  return {
    id: row.id,
    targetUserId: row.target_user_id,
    source: row.source,
    ruleKey: row.rule_key,
    observedCount: row.observed_count,
    threshold: row.threshold,
    windowDays: row.window_days,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    triagedByAdminUserId: row.triaged_by_user_id,
    triageReason: row.triage_reason,
    moderationActionId: row.moderation_action_id,
  };
}
