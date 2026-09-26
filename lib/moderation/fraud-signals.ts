/**
 * Spec 038 §3.6 — fraud/abuse signals: REVIEW ITEMS ONLY (AC-3).
 *
 * THIS MODULE CANNOT ENFORCE ANYTHING. It imports neither `./actions` nor `./lifecycle` (asserted at
 * source level by `lib/moderation/boundary.test.ts`), writes no lifecycle column, creates no
 * moderation action and calls no spec 009 function. A signal becomes an enforcement only when a
 * HUMAN admin initiates `POST /api/v1/admin/moderation-actions` naming it — and even then a ban
 * still needs a second admin (AC-2).
 *
 * `recordFraudSignal()` is the single write path. `ai_assisted` is refused unless
 * `AI_FRAUD_SIGNALS_ENABLED=true`; no AI producer ships in spec 038.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { getAdminProfileId } from '@/lib/admin-rbac/permissions';
import type { PageParams } from '@/lib/api/pagination';
import type { FraudSignalDto, FraudSignalSource, FraudSignalStatus } from '@/lib/types/moderation';
import { FRAUD_SIGNALS_READ_ACTION, FRAUD_SIGNALS_TRIAGE_ACTION } from './catalogue';
import { adminForbiddenError, fraudSignalNotFoundError, fraudSignalStatusConflictError } from './errors';
import { auditModeration, MODERATION_EVENT_TYPES } from './audit';
import { isAiFraudSignalsEnabled } from './flags';
import { requireFraudSignalPermission } from './permissions';
import { SELECT_SIGNAL, toFraudSignalDto, type FraudSignalRow } from './rows';
import { isModerationId } from './validation';

/** Thrown for an `ai_assisted` signal while the flag is off. A programming error, never user input. */
export class AiFraudSignalsDisabledError extends Error {
  constructor() {
    super('AI-assisted fraud signals are disabled (AI_FRAUD_SIGNALS_ENABLED is not true).');
    this.name = 'AiFraudSignalsDisabledError';
  }
}

export interface RecordFraudSignalInput {
  targetUserId: string;
  source: FraudSignalSource;
  ruleKey: string;
  observedCount: number;
  threshold: number;
  windowDays: number;
}

/**
 * Records one `pending_review` signal — and nothing else. Returns `false` when an open signal for
 * the same `(rule_key, target)` already exists (the partial unique index is the dedupe authority).
 */
export async function recordFraudSignal(input: RecordFraudSignalInput): Promise<boolean> {
  if (input.source === 'ai_assisted' && !isAiFraudSignalsEnabled()) throw new AiFraudSignalsDisabledError();
  const inserted = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO fraud_signals (target_user_id, source, rule_key, observed_count, threshold, window_days)
        VALUES (${input.targetUserId}, ${input.source}, ${input.ruleKey}, ${input.observedCount}, ${input.threshold}, ${input.windowDays})
        ON CONFLICT (rule_key, target_user_id) WHERE status in ('pending_review','escalated') DO NOTHING
        RETURNING id`,
  );
  if (inserted[0]) {
    console.log(JSON.stringify({ event: 'fraud_signal.recorded', signalId: inserted[0].id, ruleKey: input.ruleKey, source: input.source }));
  }
  return inserted.length > 0;
}

export async function listFraudSignals(
  adminUserId: string,
  filters: { status?: FraudSignalStatus; targetUserId?: string },
  page: PageParams,
): Promise<{ rows: FraudSignalDto[]; total: number }> {
  await requireFraudSignalPermission(adminUserId, FRAUD_SIGNALS_READ_ACTION);
  const where = sql`TRUE
    ${filters.status ? sql`AND s.status = ${filters.status}` : sql``}
    ${filters.targetUserId ? sql`AND s.target_user_id = ${filters.targetUserId}` : sql``}`;
  const rows = await queryRows<FraudSignalRow>(
    getDb(),
    sql`${SELECT_SIGNAL} WHERE ${where}
        ORDER BY CASE s.status WHEN 'escalated' THEN 0 WHEN 'pending_review' THEN 1 ELSE 2 END, s.created_at ASC
        LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: string }>(getDb(), sql`SELECT count(*)::text AS total FROM fraud_signals s WHERE ${where}`);
  return { rows: rows.map(toFraudSignalDto), total: Number(count?.total ?? 0) };
}

const TRIAGE_FROM: Record<'dismissed' | 'escalated', readonly FraudSignalStatus[]> = {
  dismissed: ['pending_review', 'escalated'],
  escalated: ['pending_review'],
};

/** F2/F3 — conditional on `expectedStatus`, so two admins cannot silently overwrite each other. */
export async function triageFraudSignal(input: {
  adminUserId: string;
  signalId: string;
  to: 'dismissed' | 'escalated';
  expectedStatus: FraudSignalStatus;
  reason: string;
  correlationId: string | null;
}): Promise<FraudSignalDto> {
  await requireFraudSignalPermission(input.adminUserId, FRAUD_SIGNALS_TRIAGE_ACTION);
  if (!isModerationId(input.signalId)) throw fraudSignalNotFoundError();
  const adminProfileId = await getAdminProfileId(input.adminUserId);
  if (!adminProfileId) throw adminForbiddenError();

  const [current] = await queryRows<{ status: FraudSignalStatus }>(getDb(), sql`SELECT status FROM fraud_signals WHERE id = ${input.signalId}`);
  if (!current) throw fraudSignalNotFoundError();
  if (current.status !== input.expectedStatus || !TRIAGE_FROM[input.to].includes(current.status)) {
    throw fraudSignalStatusConflictError(current.status);
  }

  const updated = await queryRows<{ id: string }>(
    getDb(),
    sql`UPDATE fraud_signals
           SET status = ${input.to}, triaged_by_admin_id = ${adminProfileId}, triage_reason = ${input.reason},
               triaged_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${input.signalId} AND status = ${input.expectedStatus}
         RETURNING id`,
  );
  if (updated.length === 0) {
    const [now] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM fraud_signals WHERE id = ${input.signalId}`);
    throw fraudSignalStatusConflictError(now?.status ?? 'unknown');
  }

  await auditModeration({
    actorUserId: input.adminUserId,
    eventType: input.to === 'dismissed' ? MODERATION_EVENT_TYPES.signalDismissed : MODERATION_EVENT_TYPES.signalEscalated,
    targetType: 'fraud_signal',
    targetId: input.signalId,
    reason: input.reason,
    before: { status: current.status },
    after: { status: input.to },
    correlationId: input.correlationId,
  });
  return loadFraudSignalDto(input.signalId);
}

export async function loadFraudSignalDto(signalId: string): Promise<FraudSignalDto> {
  const [row] = await queryRows<FraudSignalRow>(getDb(), sql`${SELECT_SIGNAL} WHERE s.id = ${signalId}`);
  if (!row) throw fraudSignalNotFoundError();
  return toFraudSignalDto(row);
}

/** For the action service: the signal an admin names must exist, concern the target and be open. */
export async function loadOpenSignalForTarget(executor: Executor, signalId: string, targetUserId: string): Promise<'ok' | 'missing' | 'mismatch' | FraudSignalStatus> {
  const [row] = await queryRows<{ status: FraudSignalStatus; target_user_id: string }>(
    executor,
    sql`SELECT status, target_user_id FROM fraud_signals WHERE id = ${signalId} FOR UPDATE`,
  );
  if (!row) return 'missing';
  if (row.target_user_id !== targetUserId) return 'mismatch';
  if (row.status !== 'pending_review' && row.status !== 'escalated') return row.status;
  return 'ok';
}

/**
 * Marks a signal `actioned` — called only by the action service, inside its transaction, when a
 * HUMAN admin initiated an action naming this signal.
 */
export async function markSignalActioned(tx: Executor, signalId: string, adminProfileId: string, reason: string): Promise<void> {
  await tx.execute(sql`
    UPDATE fraud_signals
       SET status = 'actioned', triaged_by_admin_id = ${adminProfileId}, triage_reason = ${reason.slice(0, 500)},
           triaged_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
     WHERE id = ${signalId} AND status IN ('pending_review','escalated')`);
}
