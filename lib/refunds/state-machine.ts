/**
 * Spec 022 §4 "Refund status machine" — the ONE way any code changes `refunds.status`.
 *
 * The mechanism is spec 003's, not a new one: migration `0018` creates `refunds_status_transitions`
 * and attaches the EXISTING `enforce_status_transition()` function as `refunds_status_transition_trg`,
 * the same function already on `requests`, `offers`, `bookings`, `payments` and `payouts`. This
 * module is the friendly error and the history writer; the trigger is the independent second line
 * of defence.
 *
 * `completed` and `failed` are terminal. `requested → failed` is deliberately absent: nothing can
 * fail before the provider has been asked, and a refund rejected before the provider call is never
 * inserted at all. `failed → processing` is absent because AC-6's retry is a NEW refund row, so
 * every provider attempt keeps its own immutable record and its own reference.
 *
 * Timing is always the DATABASE clock (`clock_timestamp()`), read after the relevant row lock is
 * held — never `now()` (frozen at transaction start) and never a client clock.
 */
import { sql } from 'drizzle-orm';
import { pgError, queryRows, type Executor } from '@/lib/offers/db';
import { REFUND_STATUSES, type RefundActorRole, type RefundStatus } from '@/lib/types/refunds';

export { REFUND_STATUSES };
export type { RefundActorRole, RefundStatus };

/** §4 — the transitions SPEC 022 performs, and only those. In lockstep with what `0018` seeds. */
export const SPEC_022_REFUND_TRANSITIONS: ReadonlyArray<readonly [RefundStatus, RefundStatus]> = [
  ['requested', 'processing'],
  ['processing', 'completed'],
  ['processing', 'failed'],
] as const;

const ALLOWED = new Set(SPEC_022_REFUND_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

export function isAllowedRefundTransition(from: RefundStatus, to: RefundStatus): boolean {
  return ALLOWED.has(`${from}->${to}`);
}

/** Statuses that still hold a reservation against the remaining refundable amount (I-1). */
export const IN_FLIGHT_REFUND_STATUSES: readonly RefundStatus[] = ['requested', 'processing'] as const;
export const TERMINAL_REFUND_STATUSES: readonly RefundStatus[] = ['completed', 'failed'] as const;

export function isInFlightRefundStatus(status: RefundStatus): boolean {
  return IN_FLIGHT_REFUND_STATUSES.includes(status);
}

export function isTerminalRefundStatus(status: RefundStatus): boolean {
  return TERMINAL_REFUND_STATUSES.includes(status);
}

export interface ApplyRefundTransitionParams {
  refundId: string;
  from: RefundStatus;
  to: RefundStatus;
  actorRole: RefundActorRole;
  /** null ONLY for `actorRole: 'system'` — `refunds_status_history_actor_pairing_ck` enforces it. */
  actorUserId: string | null;
  expectedVersion: number;
  /** Free-text context for the history row (e.g. the provider failure code). Never a secret. */
  detail?: string | null;
  /** Column writes applied in the SAME statement as the status change. */
  set?: {
    refundReference?: string | null;
    failureCode?: string | null;
    failureReason?: string | null;
    /** Only ever set alongside `to: 'completed'` — `refunds_completed_pairing_ck` enforces it. */
    completedAt?: 'now' | null;
  };
}

export interface ApplyRefundTransitionResult {
  applied: boolean;
  currentStatus: RefundStatus;
  currentVersion: number;
}

/**
 * Applies one refund status transition inside the caller's transaction.
 *
 * Conditional on BOTH the expected status and the expected `version`, so a concurrent writer is
 * detected rather than silently overwritten — which is what makes the record phase safe after a
 * provider call made outside any transaction. Returns rather than throws, so each caller maps
 * "status mismatch" and "version mismatch" onto the different HTTP codes §3 requires.
 */
export async function applyRefundTransition(
  tx: Executor,
  params: ApplyRefundTransitionParams,
): Promise<ApplyRefundTransitionResult> {
  const { refundId, from, to, actorRole, actorUserId, expectedVersion, set } = params;

  if (!isAllowedRefundTransition(from, to)) {
    // A caller asking for a transition spec 022 does not own is a programming error, not a user
    // error: fail loudly here rather than letting the database trigger report it as a 500.
    throw new Error(`Spec 022 does not own the refund transition ${from} -> ${to}`);
  }
  if ((actorUserId === null) !== (actorRole === 'system')) {
    throw new Error('actorUserId must be null exactly when actorRole is "system"');
  }

  const refundReference = set?.refundReference === undefined ? sql`` : sql`, refund_reference = ${set.refundReference}`;
  const failureCode = set?.failureCode === undefined ? sql`` : sql`, failure_code = ${set.failureCode}`;
  const failureReason = set?.failureReason === undefined ? sql`` : sql`, failure_reason = ${set.failureReason}`;
  const completedAt =
    set?.completedAt === undefined ? sql`` : set.completedAt === 'now' ? sql`, completed_at = clock_timestamp()` : sql`, completed_at = NULL`;

  const updated = await queryRows<{ version: number }>(
    tx,
    sql`UPDATE refunds
           SET status = ${to}, updated_at = clock_timestamp(), version = version + 1
               ${refundReference}${failureCode}${failureReason}${completedAt}
         WHERE id = ${refundId} AND status = ${from} AND version = ${expectedVersion}
         RETURNING version`,
  );

  if (updated.length === 0) {
    const current = await currentRefundState(tx, refundId);
    return { applied: false, currentStatus: current.status, currentVersion: current.version };
  }

  await tx.execute(sql`
    INSERT INTO refunds_status_history (refund_id, from_status, to_status, actor_user_id, actor_role, detail, occurred_at)
    VALUES (${refundId}, ${from}, ${to}, ${actorUserId}, ${actorRole}, ${params.detail ?? null}, clock_timestamp())
  `);

  console.log(JSON.stringify({ event: `refund.${to}`, refundId, fromStatus: from, toStatus: to, actorRole }));

  return { applied: true, currentStatus: to, currentVersion: updated[0]!.version };
}

export async function currentRefundState(tx: Executor, refundId: string): Promise<{ status: RefundStatus; version: number }> {
  const [row] = await queryRows<{ status: RefundStatus; version: number }>(
    tx,
    sql`SELECT status, version FROM refunds WHERE id = ${refundId}`,
  );
  if (!row) throw new Error(`refund ${refundId} disappeared mid-transition`);
  return row;
}

/**
 * Records the creation of a refund in its initial `requested` state. Not a transition — the spec 003
 * trigger only fires on UPDATE — so it is written directly, with `from_status` null.
 */
export async function recordRefundCreated(
  tx: Executor,
  params: { refundId: string; actorUserId: string | null; actorRole: RefundActorRole; detail?: string | null },
): Promise<void> {
  if ((params.actorUserId === null) !== (params.actorRole === 'system')) {
    throw new Error('actorUserId must be null exactly when actorRole is "system"');
  }
  await tx.execute(sql`
    INSERT INTO refunds_status_history (refund_id, from_status, to_status, actor_user_id, actor_role, detail, occurred_at)
    VALUES (${params.refundId}, NULL, 'requested', ${params.actorUserId}, ${params.actorRole}, ${params.detail ?? null}, clock_timestamp())
  `);
}

/** The spec 003 `enforce_status_transition()` trigger raises `SQLSTATE 23514` for an unseeded pair. */
export function isTransitionCheckViolation(err: unknown): boolean {
  return pgError(err)?.code === '23514';
}
