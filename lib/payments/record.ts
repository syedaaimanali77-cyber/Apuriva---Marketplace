/**
 * Spec 021 §3 — the ONLY module that records a provider outcome.
 *
 * Every write that moves a payment to `authorized` or `captured` happens here, and every one of
 * them takes a `ProviderResult` argument. That is the structural half of AC-1/AC-8: there is no
 * code path anywhere in the application that can reach a successful payment status without a
 * provider adapter having returned one, and `no-fabricated-success.test.ts` asserts at source level
 * that no other file writes those statuses.
 *
 * Every function here runs INSIDE the caller's transaction (phase 3 of §3 "Transaction and lock
 * ordering"). The provider call itself already happened, outside any transaction.
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { PaymentAttemptStatus, PaymentProtectionState, PaymentStatus } from '@/lib/types/payments';
import type { ProviderResult } from './provider';
import { applyPaymentTransition, type ApplyPaymentTransitionResult } from './state-machine';

/**
 * The audit trail behind every provider round trip — success and failure alike.
 *
 * `payment_attempts` is append-only at the database (`payment_attempts_append_only_trg`), so the
 * record of "we asked the provider and this is what it said" can never be rewritten. A failed
 * attempt is written for exactly the same reason a successful one is: AC-6 requires a failure to
 * leave evidence, not just an HTTP status.
 */
export async function recordAttempt(
  tx: Executor,
  params: {
    paymentId: string;
    status: PaymentAttemptStatus;
    providerReference?: string | null;
    failureCode?: string | null;
    failureReason?: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO payment_attempts (payment_id, status, provider_reference, failure_code, failure_reason, attempted_at)
    VALUES (${params.paymentId}, ${params.status}, ${params.providerReference ?? null},
            ${params.failureCode ?? null}, ${params.failureReason ?? null}, clock_timestamp())
  `);
}

/**
 * Records a provider authorization: the `payment_authorizations` row plus the status transition.
 *
 * Takes the `ProviderResult` rather than a boolean so the reference stored is always the
 * provider's own — never generated here, never defaulted.
 */
export async function recordAuthorization(
  tx: Executor,
  params: {
    paymentId: string;
    from: PaymentStatus;
    expectedVersion: number;
    actorUserId: string | null;
    actorRole: 'customer' | 'provider' | 'system' | 'admin';
    amountMinorUnits: number;
    currencyCode: string;
    result: ProviderResult;
  },
): Promise<ApplyPaymentTransitionResult> {
  const { result } = params;
  if (result.outcome !== 'authorized' && result.outcome !== 'captured') {
    throw new Error(`recordAuthorization requires an authorized/captured provider result, got "${result.outcome}"`);
  }

  const captured = result.outcome === 'captured';

  await tx.execute(sql`
    INSERT INTO payment_authorizations (
      payment_id, authorized_amount_minor_units, authorized_currency_code, authorized_at,
      captured_amount_minor_units, captured_currency_code, captured_at, provider_reference
    ) VALUES (
      ${params.paymentId}, ${params.amountMinorUnits}, ${params.currencyCode}, clock_timestamp(),
      ${captured ? params.amountMinorUnits : null}, ${captured ? params.currencyCode : null},
      ${captured ? sql`clock_timestamp()` : sql`NULL`}, ${result.providerReference}
    )
  `);

  await recordAttempt(tx, {
    paymentId: params.paymentId,
    status: 'succeeded',
    providerReference: result.providerReference,
  });

  return applyPaymentTransition(tx, {
    paymentId: params.paymentId,
    from: params.from,
    to: captured ? 'captured' : 'authorized',
    actorRole: params.actorRole,
    actorUserId: params.actorUserId,
    expectedVersion: params.expectedVersion,
    set: { providerReference: result.providerReference },
  });
}

/** Records a provider capture against an existing authorization row. */
export async function recordCapture(
  tx: Executor,
  params: {
    paymentId: string;
    expectedVersion: number;
    actorUserId: string | null;
    actorRole: 'customer' | 'provider' | 'system' | 'admin';
    amountMinorUnits: number;
    currencyCode: string;
    result: ProviderResult;
  },
): Promise<ApplyPaymentTransitionResult> {
  if (params.result.outcome !== 'captured') {
    throw new Error(`recordCapture requires a captured provider result, got "${params.result.outcome}"`);
  }

  await tx.execute(sql`
    UPDATE payment_authorizations
       SET captured_amount_minor_units = ${params.amountMinorUnits},
           captured_currency_code = ${params.currencyCode},
           captured_at = clock_timestamp(),
           updated_at = clock_timestamp(),
           version = version + 1
     WHERE payment_id = ${params.paymentId} AND captured_at IS NULL
  `);

  await recordAttempt(tx, {
    paymentId: params.paymentId,
    status: 'succeeded',
    providerReference: params.result.providerReference,
  });

  return applyPaymentTransition(tx, {
    paymentId: params.paymentId,
    from: 'authorized',
    to: 'captured',
    actorRole: params.actorRole,
    actorUserId: params.actorUserId,
    expectedVersion: params.expectedVersion,
    set: { providerReference: params.result.providerReference },
  });
}

/**
 * AC-5a — opens the protection window.
 *
 * `startedAt` is ALWAYS the booking's `in_progress -> completed` history instant, passed in by the
 * sweep. It is never `clock_timestamp()` here: the whole point of AC-5a is that the sweep's own
 * clock must not move the deadline. Conditional on `protection_state IS NULL` and on `version`, so
 * two overlapping sweeps cannot open the same window twice.
 */
export async function openProtectionWindow(
  tx: Executor,
  params: { paymentId: string; startedAt: Date; expectedVersion: number },
): Promise<boolean> {
  const updated = await queryRows<{ id: string }>(
    tx,
    sql`UPDATE payments
           SET protection_state = 'held',
               protection_window_started_at = ${params.startedAt.toISOString()}::timestamptz,
               updated_at = clock_timestamp(),
               version = version + 1
         WHERE id = ${params.paymentId}
           AND status = 'captured'
           AND protection_state IS NULL
           AND version = ${params.expectedVersion}
         RETURNING id`,
  );
  return updated.length > 0;
}

/**
 * AC-5b / AC-5c — moves `held` on to `released` or `disputed`.
 *
 * `payments.status` does not change (the money was already captured), so this is a plain update
 * rather than a status transition; it is still guarded on the previous protection state and on
 * `version`, so a concurrent sweep loses rather than double-releasing.
 */
export async function setProtectionState(
  tx: Executor,
  params: { paymentId: string; from: PaymentProtectionState; to: PaymentProtectionState; expectedVersion: number },
): Promise<boolean> {
  const updated = await queryRows<{ id: string }>(
    tx,
    sql`UPDATE payments
           SET protection_state = ${params.to}, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${params.paymentId} AND protection_state = ${params.from} AND version = ${params.expectedVersion}
         RETURNING id`,
  );
  if (updated.length > 0) {
    console.log(
      JSON.stringify({
        event: params.to === 'released' ? 'payment.protection_released' : 'payment.protection_disputed',
        paymentId: params.paymentId,
        protectionState: params.to,
      }),
    );
  }
  return updated.length > 0;
}
