/**
 * Spec 024 §3.5 "Payout state machine" — the ONE way any code changes `payouts.status`.
 *
 * The mechanism is spec 003's, not a new one: `payouts_status_transition_trg` is attached by the
 * baseline and rejects any status change absent from `payouts_status_transitions`, which migration
 * `0020` seeds with exactly the five pairs below. This module is the friendly error and the history
 * writer; the trigger is the independent second line of defence (AC-12).
 *
 * Timing is always the DATABASE clock (`clock_timestamp()`), read after the relevant row lock is held.
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import { PAYOUT_STATUSES, type PayoutStatus } from '@/lib/types/payouts';

export { PAYOUT_STATUSES };

export const PAYOUT_TRANSITIONS: ReadonlyArray<readonly [PayoutStatus, PayoutStatus]> = [
  ['pending', 'eligible'],
  ['eligible', 'processing'],
  ['processing', 'paid'],
  ['processing', 'failed'],
  ['failed', 'eligible'],
] as const;

const ALLOWED = new Set(PAYOUT_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

export function isAllowedPayoutTransition(from: PayoutStatus, to: PayoutStatus): boolean {
  return ALLOWED.has(`${from}->${to}`);
}

export const TERMINAL_PAYOUT_STATUSES: readonly PayoutStatus[] = ['paid'] as const;

export function isTerminalPayoutStatus(status: PayoutStatus): boolean {
  return TERMINAL_PAYOUT_STATUSES.includes(status);
}

export type PayoutActorRole = 'admin' | 'system';

export interface ApplyPayoutTransitionParams {
  payoutId: string;
  from: PayoutStatus;
  to: PayoutStatus;
  actorRole: PayoutActorRole;
  /** null exactly when `actorRole` is `system` (I-19). */
  actorUserId: string | null;
  /** A stable machine note for the history row. Never a rail payload or credential. */
  detail?: string | null;
  /** Extra column assignments applied in the SAME statement as the status change. */
  set?: ReturnType<typeof sql>;
}

/**
 * Applies one transition inside the caller's transaction, conditional on the expected status.
 * Returns whether it applied, so callers can map a lost race onto the right HTTP code.
 */
export async function applyPayoutTransition(tx: Executor, params: ApplyPayoutTransitionParams): Promise<boolean> {
  const { payoutId, from, to, actorRole, actorUserId } = params;
  if (!isAllowedPayoutTransition(from, to)) {
    throw new Error(`Spec 024 does not permit the payout transition ${from} -> ${to}`);
  }
  if ((actorUserId === null) !== (actorRole === 'system')) {
    throw new Error('actorUserId must be null exactly when actorRole is "system"');
  }

  const extra = params.set ?? sql``;
  const updated = await queryRows<{ id: string }>(
    tx,
    sql`UPDATE payouts
           SET status = ${to}, updated_at = clock_timestamp(), version = version + 1 ${extra}
         WHERE id = ${payoutId} AND status = ${from}
         RETURNING id`,
  );
  if (updated.length === 0) return false;

  await tx.execute(sql`
    INSERT INTO payouts_status_history (payout_id, from_status, to_status, actor_user_id, actor_role, detail, occurred_at)
    VALUES (${payoutId}, ${from}, ${to}, ${actorUserId}, ${actorRole}, ${params.detail ?? null}, clock_timestamp())
  `);

  console.log(JSON.stringify({ event: 'payout.transition', payoutId, fromStatus: from, toStatus: to, actorRole }));
  return true;
}
