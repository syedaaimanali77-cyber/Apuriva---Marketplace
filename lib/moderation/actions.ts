/**
 * Spec 038 §3.2 / §3.4 — the moderation action service: initiate (M1), execute (M4), reversal
 * (M5/M6, and the appeal path), and rejection reconciliation.
 *
 * APPROVAL IS SPEC 009's, UNCHANGED. `authorizeAndInitiate()` decides low/medium (`permitted`,
 * applied at once) versus high/critical (`pending_approval`); a DIFFERENT admin approves on spec
 * 009's own route; execution calls `executeApprovedAction()` FIRST and only then performs the
 * domain effect — the two-phase idiom `lib/payouts/admin.ts` ships. `admin_actions` is only the
 * approval record of one step; the moderation record is `moderation_actions`.
 *
 * EFFECTS GO THROUGH THEIR OWNERS: lifecycle values through `./lifecycle` (the only writer), booking
 * cancellation through spec 023's `cancelBooking()` (never `UPDATE bookings`), payout holds through
 * spec 024's port (`./payout-hold` reads the `active` freeze row this module writes).
 *
 * `emergencyBypass` is never passed (§7).
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { authorizeAndInitiate, executeApprovedAction } from '@/lib/admin-rbac/actions';
import { getAdminProfileId, resolvePermission } from '@/lib/admin-rbac/permissions';
import { cancelBooking, isCancellableBookingStatus } from '@/lib/cancellation/cancel';
import { bookingNotCancellableError } from '@/lib/cancellation/errors';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import type { BookingStatus } from '@/lib/types/bookings';
import type { CreateModerationActionRequest, ModerationActionDto } from '@/lib/types/moderation';
import {
  isLifecycleType,
  LIFECYCLE_STANDING_FOR,
  MODERATION_RESOURCE,
  MODERATION_REVERSE_ACTION,
  PERMISSION_ACTION_FOR,
  REQUIRES_APPROVAL,
  REVERSIBLE,
  severityOf,
} from './catalogue';
import {
  adminForbiddenError,
  approvalNotEligibleError,
  approvalRequiredError,
  fraudSignalNotFoundError,
  fraudSignalStatusConflictError,
  idempotencyKeyConflictError,
  moderationActionConflictError,
  moderationActionNotFoundError,
  moderationStatusConflictError,
  moderationTargetNotFoundError,
  targetNotModeratableError,
} from './errors';
import { validationError } from '@/lib/api/errors';
import { approvalChainFor, auditModeration, MODERATION_EVENT_TYPES } from './audit';
import { loadOpenSignalForTarget, markSignalActioned } from './fraud-signals';
import { applyLifecycleAction, reverseLifecycleAction } from './lifecycle';
import { emitModerationNotification } from './notifications';
import { requireActionTypePermission, requireModerationPermission } from './permissions';
import { loadAction, loadActionOrThrow, selectActions, toModerationActionDto, type ModerationRow } from './rows';
import { revokeAllSessionsForModeration } from './sessions';
import { holdModerationEvidence } from './evidence';
import { isModerationId, parseCreateModerationActionRequest } from './validation';

// ---------------------------------------------------------------------------
// Target locking, reconciliation and conflicts
// ---------------------------------------------------------------------------

interface TargetSubject {
  action_type: ModerationRow['action_type'];
  scope: ModerationRow['scope'];
  target_user_id: string;
  provider_profile_id: string | null;
  booking_id: string | null;
}

function lockKey(subject: TargetSubject): string {
  if (subject.scope === 'booking') return `moderation:booking:${subject.booking_id}`;
  if (subject.scope === 'provider_profile') return `moderation:provider_profile:${subject.provider_profile_id}`;
  return `moderation:account:${subject.target_user_id}`;
}

/** §3.4 — every read-decide-write on one scope target is serialized on this lock. */
async function lockTarget(tx: Executor, subject: TargetSubject): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(subject)}))`);
  // A payout freeze also shares the provider-profile key with lifecycle actions on that profile.
}

function sameTargetWhere(subject: TargetSubject): SQL {
  if (subject.scope === 'booking') return sql`m.scope = 'booking' AND m.booking_id = ${subject.booking_id}`;
  if (subject.scope === 'provider_profile') return sql`m.scope = 'provider_profile' AND m.provider_profile_id = ${subject.provider_profile_id}`;
  return sql`m.scope = 'account' AND m.target_user_id = ${subject.target_user_id}`;
}

/**
 * §3.2 step 4 — spec 009 has no rejection callback, so a `pending_approval` row whose `AdminAction`
 * was rejected is set to `rejected` whenever this service next touches it. Returns the reconciled ids
 * so the caller can audit them after its transaction.
 */
export async function reconcileRejected(executor: Executor, where: SQL): Promise<string[]> {
  const rows = await queryRows<{ id: string }>(
    executor,
    sql`UPDATE moderation_actions m
           SET status = 'rejected', updated_at = clock_timestamp(), version = m.version + 1
          FROM admin_actions a
         WHERE a.id = m.admin_action_id AND m.status = 'pending_approval' AND a.status = 'Rejected' AND ${where}
         RETURNING m.id`,
  );
  return rows.map((r) => r.id);
}

async function auditReconciled(actorUserId: string, ids: string[], correlationId: string | null): Promise<void> {
  for (const id of ids) {
    await auditModeration({
      actorUserId,
      eventType: MODERATION_EVENT_TYPES.actionRejectedReconciled,
      targetType: 'moderation_action',
      targetId: id,
      after: { status: 'rejected' },
      correlationId,
    });
  }
}

/** The target's current ACTIVE lifecycle action on the same scope target, if any. */
async function activeLifecycleAction(tx: Executor, subject: TargetSubject): Promise<ModerationRow | undefined> {
  const [row] = await selectActions(
    tx,
    sql`${sameTargetWhere(subject)} AND m.status = 'active' AND m.action_type IN ('restriction','suspension','ban')`,
  );
  return row;
}

/**
 * §3.4 conflicts, under the target lock: one lifecycle action per scope target (a new one must be
 * STRICTLY more severe; no second pending one), one open freeze per profile, one open intervention
 * per booking. `excludeId` is the action being executed, which is itself pending.
 */
async function assertNoConflict(tx: Executor, subject: TargetSubject, excludeId: string | null): Promise<void> {
  const notSelf = excludeId ? sql`AND m.id <> ${excludeId}` : sql``;
  if (isLifecycleType(subject.action_type)) {
    const [pending] = await selectActions(
      tx,
      sql`${sameTargetWhere(subject)} AND m.status = 'pending_approval' AND m.action_type IN ('restriction','suspension','ban') ${notSelf}`,
    );
    if (pending) {
      throw moderationActionConflictError('Another sanction for this target is awaiting approval.', { moderationActionId: pending.id });
    }
    const current = await activeLifecycleAction(tx, subject);
    if (current && severityOf(subject.action_type) <= severityOf(current.action_type)) {
      throw moderationActionConflictError('A sanction of equal or greater severity is already active for this target.', {
        moderationActionId: current.id,
      });
    }
  }
  if (subject.action_type === 'payout_freeze') {
    const [open] = await selectActions(
      tx,
      sql`m.action_type = 'payout_freeze' AND m.provider_profile_id = ${subject.provider_profile_id}
          AND m.status IN ('pending_approval','active') ${notSelf}`,
    );
    if (open) throw moderationActionConflictError('A payout freeze for this provider is already open.', { moderationActionId: open.id });
  }
  if (subject.action_type === 'booking_intervention') {
    const [open] = await selectActions(
      tx,
      sql`m.action_type = 'booking_intervention' AND m.booking_id = ${subject.booking_id}
          AND m.status IN ('pending_approval','executed') ${notSelf}`,
    );
    if (open) throw moderationActionConflictError('An intervention for this booking already exists.', { moderationActionId: open.id });
  }
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

/** 404 for anything that does not exist or does not belong together; 409 for a non-moderatable target. */
async function validateTarget(parsed: CreateModerationActionRequest): Promise<void> {
  const db = getDb();
  const [user] = await queryRows<{ lifecycle_status: string; is_admin: boolean }>(
    db,
    sql`SELECT u.lifecycle_status, EXISTS (SELECT 1 FROM admin_profiles a WHERE a.user_id = u.id) AS is_admin
          FROM users u WHERE u.id = ${parsed.targetUserId}`,
  );
  if (!user) throw moderationTargetNotFoundError('targetUserId');
  if (user.lifecycle_status === 'deleted') throw targetNotModeratableError('account_deleted');
  // A-3: admin access is withdrawn through spec 009 role revocation, never by locking an admin out.
  if (parsed.scope === 'account' && user.is_admin) throw targetNotModeratableError('admin_account');

  if (parsed.scope === 'provider_profile') {
    const [profile] = await queryRows<{ lifecycle_status: string }>(
      db,
      sql`SELECT lifecycle_status FROM provider_profiles WHERE id = ${parsed.providerProfileId} AND user_id = ${parsed.targetUserId}`,
    );
    if (!profile) throw moderationTargetNotFoundError('providerProfileId');
    if (isLifecycleType(parsed.actionType) && profile.lifecycle_status === 'banned') throw targetNotModeratableError('provider_banned');
  }

  if (parsed.scope === 'booking') {
    const [booking] = await queryRows<{ customer_user_id: string; provider_user_id: string }>(
      db,
      sql`SELECT cp.user_id AS customer_user_id, pp.user_id AS provider_user_id
            FROM bookings b
            JOIN customer_profiles cp ON cp.id = b.customer_profile_id
            JOIN provider_profiles pp ON pp.id = b.provider_profile_id
           WHERE b.id = ${parsed.bookingId}`,
    );
    if (!booking || (booking.customer_user_id !== parsed.targetUserId && booking.provider_user_id !== parsed.targetUserId)) {
      throw moderationTargetNotFoundError('bookingId');
    }
  }
}

function assertSignal(result: Awaited<ReturnType<typeof loadOpenSignalForTarget>>): void {
  if (result === 'ok') return;
  if (result === 'missing') throw fraudSignalNotFoundError();
  if (result === 'mismatch') throw validationError([{ field: 'originFraudSignalId', message: 'does not concern targetUserId' }]);
  throw fraudSignalStatusConflictError(result);
}

// ---------------------------------------------------------------------------
// M1 — initiate
// ---------------------------------------------------------------------------

export type InitiateOutcome = 'applied' | 'pending_approval' | 'replayed';

export interface InitiateModerationInput {
  adminUserId: string;
  /** Null only for the spec 030 gate path, whose idempotency is the origin report (§3.16). */
  idempotencyKey: string | null;
  body: unknown;
  correlationId: string | null;
  originSafetyReportId?: string;
}

export async function initiateModerationAction(input: InitiateModerationInput): Promise<{ action: ModerationActionDto; outcome: InitiateOutcome }> {
  const parsed = parseCreateModerationActionRequest(input.body);
  const permissionAction = PERMISSION_ACTION_FOR[parsed.actionType];

  const permission = await resolvePermission(input.adminUserId, MODERATION_RESOURCE, permissionAction);
  if (!permission.allowed || !permission.riskTier) throw adminForbiddenError();
  const adminProfileId = await getAdminProfileId(input.adminUserId);
  if (!adminProfileId) throw adminForbiddenError();

  const fingerprint = idempotencyFingerprint(parsed);
  const replay = async (): Promise<{ action: ModerationActionDto; outcome: InitiateOutcome } | null> => {
    if (!input.idempotencyKey) return null;
    const [existing] = await selectActions(getDb(), sql`m.initiated_by_admin_id = ${adminProfileId} AND m.idempotency_key = ${input.idempotencyKey}`);
    if (!existing) return null;
    if (existing.idempotency_fingerprint !== fingerprint) throw idempotencyKeyConflictError();
    return { action: toModerationActionDto(existing), outcome: 'replayed' };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  await validateTarget(parsed);

  const subject: TargetSubject = {
    action_type: parsed.actionType,
    scope: parsed.scope,
    target_user_id: parsed.targetUserId,
    provider_profile_id: parsed.providerProfileId ?? null,
    booking_id: parsed.bookingId ?? null,
  };

  // Pre-check BEFORE spec 009 creates an AdminAction, so a doomed request leaves no approval behind.
  const reconciledEarly = await getDb().transaction(async (tx) => {
    await lockTarget(tx, subject);
    const ids = await reconcileRejected(tx, sameTargetWhere(subject));
    await assertNoConflict(tx, subject, null);
    if (parsed.originFraudSignalId) assertSignal(await loadOpenSignalForTarget(tx, parsed.originFraudSignalId, parsed.targetUserId));
    return ids;
  });
  await auditReconciled(input.adminUserId, reconciledEarly, input.correlationId);

  const id = randomUUID();
  const initiated = await authorizeAndInitiate({
    userId: input.adminUserId,
    resource: MODERATION_RESOURCE,
    action: permissionAction,
    targetType: 'moderation_action',
    targetId: id,
    reason: parsed.reason,
  });
  // AC-2 fail-closed: a high/critical type that did not land in spec 009's approval queue never proceeds.
  if (REQUIRES_APPROVAL.has(parsed.actionType) && initiated.outcome !== 'pending_approval') throw approvalRequiredError();
  if (initiated.outcome === 'emergency_bypass_executed') throw approvalRequiredError();
  const pending = initiated.outcome === 'pending_approval';
  const adminActionId = initiated.outcome === 'pending_approval' ? initiated.adminActionId : null;

  let lifecycle: Awaited<ReturnType<typeof applyLifecycleAction>> | null = null;
  try {
    await getDb().transaction(async (tx) => {
      await lockTarget(tx, subject);
      await assertNoConflict(tx, subject, null);
      if (parsed.originFraudSignalId) assertSignal(await loadOpenSignalForTarget(tx, parsed.originFraudSignalId, parsed.targetUserId));

      if (!pending) lifecycle = await applyLifecycleAction(tx, subject);
      const previous = lifecycle as Awaited<ReturnType<typeof applyLifecycleAction>> | null;
      await tx.execute(sql`
        INSERT INTO moderation_actions (
          id, action_type, scope, target_user_id, provider_profile_id, booking_id, refund_treatment, risk_tier,
          status, reason, user_message, initiated_by_admin_id, admin_action_id, previous_user_standing,
          previous_provider_lifecycle_status, origin_safety_report_id, origin_fraud_signal_id, activated_at,
          idempotency_key, idempotency_fingerprint
        ) VALUES (
          ${id}, ${parsed.actionType}, ${parsed.scope}, ${parsed.targetUserId}, ${parsed.providerProfileId ?? null},
          ${parsed.bookingId ?? null}, ${parsed.refundTreatment ?? null}, ${permission.riskTier},
          ${pending ? 'pending_approval' : 'active'}, ${parsed.reason}, ${parsed.userMessage ?? null}, ${adminProfileId},
          ${adminActionId}, ${previous?.previousUserStanding ?? null}, ${previous?.previousProviderLifecycleStatus ?? null},
          ${input.originSafetyReportId ?? null}, ${parsed.originFraudSignalId ?? null},
          ${pending ? null : sql`clock_timestamp()`}, ${input.idempotencyKey}, ${input.idempotencyKey ? fingerprint : null}
        )`);
      if (!pending) await supersedeOlder(tx, subject, id);
      if (parsed.originFraudSignalId) await markSignalActioned(tx, parsed.originFraudSignalId, adminProfileId, parsed.reason);
    });
  } catch (err) {
    // A concurrent identical request won: this call's AdminAction targets no row and can never execute.
    if (isUniqueViolation(err, 'moderation_actions_admin_idempotency_uq')) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw err;
  }

  const row = await loadActionOrThrow(getDb(), id);
  const applied = lifecycle as Awaited<ReturnType<typeof applyLifecycleAction>> | null;
  await auditModeration({
    actorUserId: input.adminUserId,
    eventType: pending ? MODERATION_EVENT_TYPES.actionPending : MODERATION_EVENT_TYPES.actionApplied,
    targetType: 'moderation_action',
    targetId: id,
    reason: parsed.reason,
    before: applied?.before,
    after: { status: row.status, actionType: row.action_type, scope: row.scope, targetUserId: row.target_user_id, ...(applied?.after ?? {}) },
    approvalChain: await approvalChainFor(adminActionId),
    correlationId: input.correlationId,
  });
  if (parsed.originFraudSignalId) {
    await auditModeration({
      actorUserId: input.adminUserId,
      eventType: MODERATION_EVENT_TYPES.signalActioned,
      targetType: 'fraud_signal',
      targetId: parsed.originFraudSignalId,
      reason: parsed.reason,
      after: { status: 'actioned', moderationActionId: id },
      correlationId: input.correlationId,
    });
  }
  if (!pending) void emitModerationNotification({ kind: 'moderation_action_applied', moderationActionId: id, recipientUserId: row.target_user_id });
  console.log(JSON.stringify({ event: pending ? 'moderation.action_pending' : 'moderation.action_applied', moderationActionId: id, actionType: row.action_type, riskTier: row.risk_tier }));
  return { action: toModerationActionDto(row), outcome: pending ? 'pending_approval' : 'applied' };
}

/** When a more severe lifecycle action activates, the older one becomes `superseded` (§3.4). */
async function supersedeOlder(tx: Executor, subject: TargetSubject, newId: string): Promise<void> {
  if (!isLifecycleType(subject.action_type)) return;
  await tx.execute(sql`
    UPDATE moderation_actions m
       SET status = 'superseded', superseded_by_moderation_action_id = ${newId},
           updated_at = clock_timestamp(), version = m.version + 1
     WHERE ${sameTargetWhere(subject)} AND m.status = 'active' AND m.id <> ${newId}
       AND m.action_type IN ('restriction','suspension','ban')`);
}

// ---------------------------------------------------------------------------
// M4 — execute an approved action
// ---------------------------------------------------------------------------

async function adminActionStatus(adminActionId: string | null, moderationActionId: string): Promise<string | null> {
  if (!adminActionId) return null;
  const [row] = await queryRows<{ status: string }>(
    getDb(),
    sql`SELECT status FROM admin_actions
         WHERE id = ${adminActionId} AND resource = ${MODERATION_RESOURCE} AND target_id = ${moderationActionId}`,
  );
  return row?.status ?? null;
}

export async function executeModerationAction(input: { adminUserId: string; actionId: string; correlationId: string | null }): Promise<ModerationActionDto> {
  if (!isModerationId(input.actionId)) throw moderationActionNotFoundError();
  let row = await loadActionOrThrow(getDb(), input.actionId);
  await requireActionTypePermission(input.adminUserId, row.action_type);

  const reconciled = await reconcileRejected(getDb(), sql`m.id = ${row.id}`);
  if (reconciled.length > 0) {
    await auditReconciled(input.adminUserId, reconciled, input.correlationId);
    throw approvalNotEligibleError('This action was rejected by the approving admin.');
  }
  if (row.status !== 'pending_approval') throw moderationStatusConflictError(row.status);

  const approval = await adminActionStatus(row.admin_action_id, row.id);
  if (approval === null) throw moderationStatusConflictError(row.status);
  const subject: TargetSubject = row;

  // Checks that must hold BEFORE spec 009's approval is consumed.
  if (approval !== 'Executed') {
    await getDb().transaction(async (tx) => {
      await lockTarget(tx, subject);
      await assertNoConflict(tx, subject, row.id);
    });
    if (row.action_type === 'booking_intervention') {
      const [booking] = await queryRows<{ status: BookingStatus }>(getDb(), sql`SELECT status FROM bookings WHERE id = ${row.booking_id}`);
      if (!booking || !isCancellableBookingStatus(booking.status)) throw bookingNotCancellableError(booking?.status ?? 'unknown');
    }
    // 422 APPROVAL_REQUIRED while Pending; 409 APPROVAL_NOT_ELIGIBLE once Rejected/Executed.
    await executeApprovedAction(row.admin_action_id!, input.adminUserId);
  }
  // else: completes an execution that crashed after spec 009's Approved → Executed (spec 024's rule).

  let lifecycle: Awaited<ReturnType<typeof applyLifecycleAction>> | null = null;
  if (row.action_type === 'booking_intervention') {
    // AC-6: spec 023 performs the transition, the decision record, the refund hand-off and the
    // notifications. The deterministic key makes a crash-recovery retry a spec 023 replay.
    await cancelBooking({
      bookingId: row.booking_id!,
      idempotencyKey: `moderation-${row.id}`,
      actorUserId: input.adminUserId,
      actorRole: 'admin',
      body: { reasonCode: 'moderation_booking_intervention' },
      forceFullRefund: row.refund_treatment === 'full',
    });
    const updated = await queryRows<{ id: string }>(
      getDb(),
      sql`UPDATE moderation_actions SET status = 'executed', activated_at = clock_timestamp(),
                 updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${row.id} AND status = 'pending_approval' RETURNING id`,
    );
    if (updated.length === 0) throw moderationStatusConflictError((await loadActionOrThrow(getDb(), row.id)).status);
  } else {
    await getDb().transaction(async (tx) => {
      await lockTarget(tx, subject);
      await assertNoConflict(tx, subject, row.id);
      lifecycle = await applyLifecycleAction(tx, subject);
      const applied = lifecycle as Awaited<ReturnType<typeof applyLifecycleAction>>;
      const updated = await queryRows<{ id: string }>(
        tx,
        sql`UPDATE moderation_actions
               SET status = 'active', activated_at = clock_timestamp(),
                   previous_user_standing = ${applied.previousUserStanding},
                   previous_provider_lifecycle_status = ${applied.previousProviderLifecycleStatus},
                   updated_at = clock_timestamp(), version = version + 1
             WHERE id = ${row.id} AND status = 'pending_approval' RETURNING id`,
      );
      if (updated.length === 0) throw moderationStatusConflictError('active');
      await supersedeOlder(tx, subject, row.id);
    });
  }

  row = await loadActionOrThrow(getDb(), row.id);
  await holdModerationEvidence(row.id);
  const applied = lifecycle as Awaited<ReturnType<typeof applyLifecycleAction>> | null;
  await auditModeration({
    actorUserId: input.adminUserId,
    eventType: MODERATION_EVENT_TYPES.actionExecuted,
    targetType: 'moderation_action',
    targetId: row.id,
    reason: row.reason,
    before: applied?.before,
    after: { status: row.status, ...(applied?.after ?? {}) },
    approvalChain: await approvalChainFor(row.admin_action_id),
    correlationId: input.correlationId,
  });

  if (row.scope === 'account' && (row.action_type === 'suspension' || row.action_type === 'ban')) {
    const revoked = await revokeAllSessionsForModeration(row.target_user_id, row.action_type === 'ban' ? 'moderation_ban' : 'moderation_suspension');
    await auditModeration({
      actorUserId: input.adminUserId,
      eventType: MODERATION_EVENT_TYPES.sessionsRevoked,
      targetType: 'user',
      targetId: row.target_user_id,
      after: { revokedSessions: revoked, moderationActionId: row.id },
      correlationId: input.correlationId,
    });
  }
  if (row.action_type !== 'booking_intervention') {
    void emitModerationNotification({ kind: 'moderation_action_applied', moderationActionId: row.id, recipientUserId: row.target_user_id });
  }
  console.log(JSON.stringify({ event: 'moderation.action_executed', moderationActionId: row.id, actionType: row.action_type, status: row.status }));
  return toModerationActionDto(row);
}

// ---------------------------------------------------------------------------
// Reversal — M5/M6 and the appeal path
// ---------------------------------------------------------------------------

/**
 * Reverses an ACTIVE action inside the caller's transaction (§3.4). The ONLY path by which a
 * sanctioned account or profile returns to `active`. A reversed action that had superseded an older
 * one returns that older one to `active`, whose standing is exactly what the lifecycle restore set.
 */
export async function reverseModerationActionInTx(
  tx: Executor,
  actionId: string,
  by: { adminProfileId: string; reason: string },
): Promise<{ row: ModerationRow; before: Record<string, string | null>; after: Record<string, string | null> }> {
  const row = await loadActionOrThrow(tx, actionId);
  await lockTarget(tx, row);
  const [locked] = await queryRows<{ status: string }>(tx, sql`SELECT status FROM moderation_actions WHERE id = ${actionId} FOR UPDATE`);
  if (locked?.status !== 'active' || !REVERSIBLE.has(row.action_type)) throw moderationStatusConflictError(locked?.status ?? row.status);

  const change = await reverseLifecycleAction(tx, row);
  await tx.execute(sql`
    UPDATE moderation_actions
       SET status = 'reversed', reversed_at = clock_timestamp(), reversed_by_admin_id = ${by.adminProfileId},
           reversal_reason = ${by.reason}, updated_at = clock_timestamp(), version = version + 1
     WHERE id = ${actionId} AND status = 'active'`);
  if (LIFECYCLE_STANDING_FOR[row.action_type]) {
    await tx.execute(sql`
      UPDATE moderation_actions
         SET status = 'active', superseded_by_moderation_action_id = NULL,
             updated_at = clock_timestamp(), version = version + 1
       WHERE superseded_by_moderation_action_id = ${actionId} AND status = 'superseded'`);
  }
  return { row: await loadActionOrThrow(tx, actionId), before: change.before, after: change.after };
}

/** M5 — requests a reversal; always four-eyes (`moderation/reverse` is `high`, fails closed). */
export async function requestReversal(input: { adminUserId: string; actionId: string; reason: string; correlationId: string | null }): Promise<ModerationActionDto> {
  await requireModerationPermission(input.adminUserId, MODERATION_REVERSE_ACTION);
  if (!isModerationId(input.actionId)) throw moderationActionNotFoundError();
  const row = await loadActionOrThrow(getDb(), input.actionId);
  if (row.status !== 'active' || !REVERSIBLE.has(row.action_type)) throw moderationStatusConflictError(row.status);

  const existing = await adminActionStatus(row.reversal_admin_action_id, row.id);
  if (existing === 'Pending' || existing === 'Approved') throw moderationStatusConflictError('reversal_pending');

  const initiated = await authorizeAndInitiate({
    userId: input.adminUserId,
    resource: MODERATION_RESOURCE,
    action: MODERATION_REVERSE_ACTION,
    targetType: 'moderation_action',
    targetId: row.id,
    reason: input.reason,
  });
  if (initiated.outcome !== 'pending_approval') throw approvalRequiredError();

  const updated = await queryRows<{ id: string }>(
    getDb(),
    sql`UPDATE moderation_actions SET reversal_admin_action_id = ${initiated.adminActionId}, reversal_reason = ${input.reason},
               updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${row.id} AND status = 'active' RETURNING id`,
  );
  if (updated.length === 0) throw moderationStatusConflictError((await loadActionOrThrow(getDb(), row.id)).status);

  await auditModeration({
    actorUserId: input.adminUserId,
    eventType: MODERATION_EVENT_TYPES.reversalRequested,
    targetType: 'moderation_action',
    targetId: row.id,
    reason: input.reason,
    approvalChain: await approvalChainFor(initiated.adminActionId),
    correlationId: input.correlationId,
  });
  return toModerationActionDto(await loadActionOrThrow(getDb(), row.id));
}

/** M6 — executes an approved reversal. */
export async function executeReversal(input: { adminUserId: string; actionId: string; correlationId: string | null }): Promise<ModerationActionDto> {
  await requireModerationPermission(input.adminUserId, MODERATION_REVERSE_ACTION);
  if (!isModerationId(input.actionId)) throw moderationActionNotFoundError();
  const row = await loadActionOrThrow(getDb(), input.actionId);
  if (row.status !== 'active' || !row.reversal_admin_action_id) throw moderationStatusConflictError(row.status);
  const adminProfileId = await getAdminProfileId(input.adminUserId);
  if (!adminProfileId) throw adminForbiddenError();

  const approval = await adminActionStatus(row.reversal_admin_action_id, row.id);
  if (approval !== 'Executed') await executeApprovedAction(row.reversal_admin_action_id, input.adminUserId);

  const result = await getDb().transaction((tx) =>
    reverseModerationActionInTx(tx, row.id, { adminProfileId, reason: row.reversal_reason ?? 'Reversal approved' }),
  );
  await auditModeration({
    actorUserId: input.adminUserId,
    eventType: MODERATION_EVENT_TYPES.actionReversed,
    targetType: 'moderation_action',
    targetId: row.id,
    reason: row.reversal_reason,
    before: { status: 'active', ...result.before },
    after: { status: 'reversed', ...result.after },
    approvalChain: await approvalChainFor(row.reversal_admin_action_id),
    correlationId: input.correlationId,
  });
  console.log(JSON.stringify({ event: 'moderation.action_reversed', moderationActionId: row.id, actionType: row.action_type }));
  return toModerationActionDto(result.row);
}

export { loadAction };
