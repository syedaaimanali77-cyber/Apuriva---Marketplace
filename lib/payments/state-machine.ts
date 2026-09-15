/**
 * Spec 021 §4 "Payment status machine" — the ONE way any code changes `payments.status`.
 *
 * The mechanism is spec 003's, not a new one: `payments_status_transition_trg` already rejects any
 * status change absent from `payments_status_transitions`, and migration `0017` seeds exactly the
 * transitions below. This module is the friendly error and the history writer; the trigger is the
 * independent second line of defence.
 *
 * Deliberately absent, seeded by their owner: `captured -> refunded` and
 * `captured -> partially_refunded` (spec 022). `captured` has no outgoing transition here.
 *
 * Timing is always the DATABASE clock (`clock_timestamp()`), read in a statement issued AFTER the
 * relevant row lock is held — never `now()` (frozen at transaction start) and never a client clock.
 * That is the rule spec 018 established for offer expiry and spec 020 carried into bookings.
 */
import { sql } from 'drizzle-orm';
import { pgError, queryRows, type Executor } from '@/lib/offers/db';
import { PAYMENT_STATUSES, type PaymentStatus } from '@/lib/types/payments';

export { PAYMENT_STATUSES };
export type { PaymentStatus };

/** Who caused a payment transition. `system` is the sweep; `null` actor pairs with it. */
export type PaymentActorRole = 'customer' | 'provider' | 'system' | 'admin';

/**
 * §4 — the transitions SPEC 021 performs, and only those. Kept in lockstep with the rows `0017`
 * seeds into `payments_status_transitions`.
 */
export const SPEC_021_PAYMENT_TRANSITIONS: ReadonlyArray<readonly [PaymentStatus, PaymentStatus]> = [
  ['created', 'requires_action'],
  ['created', 'authorized'],
  ['created', 'captured'],
  ['created', 'failed'],
  ['requires_action', 'authorized'],
  ['requires_action', 'captured'],
  ['requires_action', 'failed'],
  ['authorized', 'captured'],
  ['authorized', 'failed'],
] as const;

const ALLOWED = new Set(SPEC_021_PAYMENT_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

export function isAllowedPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED.has(`${from}->${to}`);
}

/**
 * The extension registry the header above always described in prose: "`captured -> refunded` and
 * `captured -> partially_refunded` (spec 022)". `applyPaymentTransition()` is the one primitive that
 * writes `payments.status`, so a later spec performing a transition IT owns has to be able to pass
 * this guard — otherwise the guard, which exists to catch a spec 021 programming error, would
 * instead block the collaboration §4 explicitly designed for.
 *
 * This is NOT a change to spec 021's transition graph. `SPEC_021_PAYMENT_TRANSITIONS` is untouched
 * and `isAllowedPaymentTransition()` still answers only "does spec 021 own this pair?", so spec
 * 021's own tests — which assert the refund pairs are NOT spec 021's — keep passing unchanged. The
 * database `payments_status_transitions` table remains the real authority either way: a pair
 * registered here but never seeded is still rejected by the spec 003 trigger.
 *
 * Mirrors `registerBookingTransitions` in `lib/bookings/state-machine.ts` exactly.
 */
const REGISTERED_EXTENSIONS = new Map<string, string>();

export function registerPaymentTransitions(
  owner: string,
  pairs: ReadonlyArray<readonly [PaymentStatus, PaymentStatus]>,
): void {
  for (const [from, to] of pairs) {
    if (isAllowedPaymentTransition(from, to)) {
      throw new Error(`${from} -> ${to} is owned by spec 021; it cannot be registered by ${owner}`);
    }
    REGISTERED_EXTENSIONS.set(`${from}->${to}`, owner);
  }
}

/** Test-only: clears extension registrations so suites cannot leak into each other. */
export function resetRegisteredPaymentTransitions(): void {
  REGISTERED_EXTENSIONS.clear();
}

/** True when a later spec has registered `(from, to)` as one it owns and performs. */
export function isRegisteredPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return REGISTERED_EXTENSIONS.has(`${from}->${to}`);
}

/** Statuses from which no further movement is possible in this spec. */
export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = ['captured', 'failed'] as const;

export function isTerminalPaymentStatus(status: PaymentStatus): boolean {
  return TERMINAL_PAYMENT_STATUSES.includes(status);
}

export interface ApplyPaymentTransitionParams {
  paymentId: string;
  from: PaymentStatus;
  to: PaymentStatus;
  actorRole: PaymentActorRole;
  /** null ONLY for `actorRole: 'system'` — `payments_status_history_actor_pairing_ck` enforces it. */
  actorUserId: string | null;
  expectedVersion: number;
  /** Optional column writes applied in the SAME statement as the status change. */
  set?: {
    providerReference?: string | null;
    protectionState?: 'held' | 'released' | 'disputed' | null;
  };
}

export interface ApplyPaymentTransitionResult {
  applied: boolean;
  currentStatus: PaymentStatus;
  currentVersion: number;
}

/**
 * Applies one payment status transition inside the caller's transaction.
 *
 * The update is conditional on BOTH the expected status and the expected `version`, so a concurrent
 * writer is detected rather than silently overwritten — this is what makes the record phase of
 * §3 "Transaction and lock ordering" safe after the provider call was made outside a transaction.
 * Returns rather than throws, so each caller can map "status mismatch" and "version mismatch" onto
 * the different HTTP codes §3 requires.
 */
export async function applyPaymentTransition(
  tx: Executor,
  params: ApplyPaymentTransitionParams,
): Promise<ApplyPaymentTransitionResult> {
  const { paymentId, from, to, actorRole, actorUserId, expectedVersion, set } = params;

  if (!isAllowedPaymentTransition(from, to) && !isRegisteredPaymentTransition(from, to)) {
    // A caller asking for a transition NOBODY owns is a programming error, not a user error: fail
    // loudly here rather than letting the database trigger report it as a 500.
    throw new Error(`No spec owns the payment transition ${from} -> ${to}`);
  }
  if ((actorUserId === null) !== (actorRole === 'system')) {
    throw new Error('actorUserId must be null exactly when actorRole is "system"');
  }

  const providerReferenceAssignment =
    set?.providerReference === undefined ? sql`` : sql`, provider_reference = ${set.providerReference}`;
  const protectionAssignment =
    set?.protectionState === undefined ? sql`` : sql`, protection_state = ${set.protectionState}`;

  const updated = await queryRows<{ version: number }>(
    tx,
    sql`UPDATE payments
           SET status = ${to}, updated_at = clock_timestamp(), version = version + 1
               ${providerReferenceAssignment}${protectionAssignment}
         WHERE id = ${paymentId} AND status = ${from} AND version = ${expectedVersion}
         RETURNING version`,
  );

  if (updated.length === 0) {
    const current = await currentPaymentState(tx, paymentId);
    return { applied: false, currentStatus: current.status, currentVersion: current.version };
  }

  await tx.execute(sql`
    INSERT INTO payments_status_history (payment_id, from_status, to_status, actor_user_id, actor_role, occurred_at)
    VALUES (${paymentId}, ${from}, ${to}, ${actorUserId}, ${actorRole}, clock_timestamp())
  `);

  console.log(JSON.stringify({ event: 'payment.transition', paymentId, fromStatus: from, toStatus: to, actorRole }));

  return { applied: true, currentStatus: to, currentVersion: updated[0]!.version };
}

export async function currentPaymentState(
  tx: Executor,
  paymentId: string,
): Promise<{ status: PaymentStatus; version: number }> {
  const [row] = await queryRows<{ status: PaymentStatus; version: number }>(
    tx,
    sql`SELECT status, version FROM payments WHERE id = ${paymentId}`,
  );
  if (!row) throw new Error(`payment ${paymentId} disappeared mid-transition`);
  return row;
}

/**
 * Records the creation of a payment in its initial `created` state. Not a transition — the spec 003
 * trigger only fires on UPDATE — so it is written directly, with `from_status` null.
 */
export async function recordPaymentCreated(
  tx: Executor,
  params: { paymentId: string; actorUserId: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO payments_status_history (payment_id, from_status, to_status, actor_user_id, actor_role, occurred_at)
    VALUES (${params.paymentId}, NULL, 'created', ${params.actorUserId}, 'customer', clock_timestamp())
  `);
}

/** The spec 003 `enforce_status_transition()` trigger raises `SQLSTATE 23514` for an unseeded pair. */
export function isTransitionCheckViolation(err: unknown): boolean {
  return pgError(err)?.code === '23514';
}
