/**
 * Spec 024 §3.6 Pass D and §3.8 — the transfer, its ambiguity resolution, and automatic retries.
 *
 * Three phases, spec 021's discipline unchanged, because a rail call must never happen inside a
 * transaction:
 *   1. CLAIM  (tx)   — `eligible → processing`, `attempt_count + 1`, commit.
 *   2. CALL   (no tx) — one `transfer()` with key `payout:{id}:{attempt}`.
 *   3. RECORD (tx)   — conditional on the payout still being `processing` at THAT attempt.
 *
 * A timeout can never produce a duplicate payout: the claim commits before the call, only
 * `processing → paid|failed` exist, and resolution is always a READ (by reference, or by the
 * attempt's idempotency key). There is no manual mark-paid or mark-failed path anywhere.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { resolvePayoutProvider } from '@/lib/payments/provider/payout-factory';
import type { PayoutResult } from '@/lib/payments/provider/payout-types';
import type { PayoutFailureCode } from '@/lib/types/payouts';
import {
  AUTOMATICALLY_RETRYABLE_FAILURE_CODES,
  DESTINATION_FAILURE_CODES,
  payoutAmbiguityEscalationMinutes,
  payoutAttemptGraceMinutes,
  payoutMaxAutomaticAttempts,
  payoutRetryBackoffMinutes,
} from './config';
import { decryptDestinationToken } from './destination-crypto';
import { findUsableDefaultMethod } from './ledger';
import { emitPayoutNotification } from './ports';
import { applyPayoutTransition, type PayoutActorRole } from './state-machine';
import { scopeFilter, type PayoutSweepScope } from './sweep-scope';

export function payoutAttemptKey(payoutId: string, attemptCount: number): string {
  return `payout:${payoutId}:${attemptCount}`;
}

export type TransferOutcome = 'paid' | 'failed' | 'unknown' | 'skipped';

/** Phase 1. Returns the attempt claimed, or null when another worker got there first. */
async function claimPayout(payoutId: string): Promise<{
  attempt: number;
  amount: number;
  currency: string;
  destinationToken: string;
} | null> {
  return getDb().transaction(async (tx) => {
    const [payout] = await queryRows<{
      status: string;
      attempt_count: number;
      payout_amount_minor_units: number;
      payout_currency_code: string;
      payout_method_id: string | null;
    }>(
      tx,
      sql`SELECT status, attempt_count, payout_amount_minor_units, payout_currency_code, payout_method_id
            FROM payouts WHERE id = ${payoutId} FOR UPDATE SKIP LOCKED`,
    );
    if (!payout || payout.status !== 'eligible' || !payout.payout_method_id) return null;

    const [method] = await queryRows<{ destination_token_encrypted: string; removed_at: Date | null }>(
      tx,
      sql`SELECT destination_token_encrypted, removed_at FROM payout_methods WHERE id = ${payout.payout_method_id}`,
    );
    // A removed method is never used again (§3.9). Removal of a method snapshotted on an eligible
    // payout is refused, so this is a defensive stop rather than an expected path.
    if (!method || method.removed_at) return null;

    const attempt = payout.attempt_count + 1;
    const applied = await applyPayoutTransition(tx, {
      payoutId,
      from: 'eligible',
      to: 'processing',
      actorRole: 'system',
      actorUserId: null,
      detail: `attempt:${attempt}`,
      set: sql`, attempt_count = ${attempt}, payout_reference = NULL, escalated_at = NULL`,
    });
    if (!applied) return null;

    return {
      attempt,
      amount: payout.payout_amount_minor_units,
      currency: payout.payout_currency_code,
      destinationToken: decryptDestinationToken(method.destination_token_encrypted),
    };
  });
}

/** Phases 1–3 for one eligible payout. */
export async function transferPayout(payoutId: string): Promise<TransferOutcome> {
  const provider = resolvePayoutProvider();
  const claim = await claimPayout(payoutId);
  if (!claim) return 'skipped';

  console.log(JSON.stringify({ event: 'payout.processing', payoutId, amountMinorUnits: claim.amount, status: 'processing' }));

  let result: PayoutResult;
  try {
    result = await provider.transfer({
      destinationToken: claim.destinationToken,
      idempotencyKey: payoutAttemptKey(payoutId, claim.attempt),
      amountMinorUnits: claim.amount,
      currencyCode: claim.currency,
      reference: payoutId,
    });
  } catch {
    // A transport error is an UNKNOWN outcome — never a failure (AC-7).
    result = { outcome: 'unknown', payoutReference: null };
  }

  return recordTransferOutcome(payoutId, claim.attempt, result, { role: 'system', userId: null });
}

/**
 * Phase 3, shared by the live path and the reconcile sweep so both settle on identical terms.
 * Conditional on the payout still being `processing` at the same attempt, so a stale writer is inert.
 */
export async function recordTransferOutcome(
  payoutId: string,
  attempt: number,
  result: PayoutResult,
  actor: { role: PayoutActorRole; userId: string | null },
): Promise<TransferOutcome> {
  const lineIds = (
    await queryRows<{ earnings_line_id: string }>(
      getDb(),
      sql`SELECT earnings_line_id FROM payout_items WHERE payout_id = ${payoutId} AND kind = 'earnings_line' ORDER BY earnings_line_id`,
    )
  ).map((row) => row.earnings_line_id);

  const recorded = await getDb().transaction(async (tx): Promise<{ outcome: TransferOutcome; providerProfileId?: string; failureCode?: PayoutFailureCode; amount?: number }> => {
    for (const id of lineIds) await tx.execute(sql`SELECT id FROM provider_earnings_lines WHERE id = ${id} FOR UPDATE`);
    const [payout] = await queryRows<{ status: string; attempt_count: number; provider_profile_id: string; payout_reference: string | null; payout_amount_minor_units: number }>(
      tx,
      sql`SELECT status, attempt_count, provider_profile_id, payout_reference, payout_amount_minor_units FROM payouts WHERE id = ${payoutId} FOR UPDATE`,
    );
    if (!payout) return { outcome: 'skipped' };

    if (payout.status !== 'processing' || payout.attempt_count !== attempt) {
      if (result.outcome === 'paid' && payout.status !== 'paid') {
        // The rail says money moved for an attempt this record no longer considers live. Never
        // rewrite state on a guess — surface it loudly for Finance.
        console.error(JSON.stringify({ event: 'payout.outcome_conflict', payoutId, attempt, status: payout.status, action: 'manual finance review required' }));
      }
      return { outcome: 'skipped' };
    }

    if (result.outcome === 'unknown') {
      if (result.payoutReference && !payout.payout_reference) {
        await tx.execute(sql`UPDATE payouts SET payout_reference = ${result.payoutReference}, version = version + 1 WHERE id = ${payoutId}`);
      }
      return { outcome: 'unknown' };
    }

    if (result.outcome === 'paid') {
      const [clock] = await queryRows<{ now: Date }>(tx, sql`SELECT clock_timestamp() AS now`);
      await applyPayoutTransition(tx, {
        payoutId,
        from: 'processing',
        to: 'paid',
        actorRole: actor.role,
        actorUserId: actor.userId,
        set: sql`, paid_at = ${clock!.now}, payout_reference = ${result.payoutReference ?? payout.payout_reference}, failure_code = NULL, failure_reason = NULL`,
      });
      if (lineIds.length > 0) {
        for (const id of lineIds) {
          await tx.execute(sql`
            UPDATE provider_earnings_lines SET state = 'paid', paid_at = ${clock!.now}, updated_at = clock_timestamp(), version = version + 1
             WHERE id = ${id} AND state = 'eligible'
          `);
        }
      }
      return { outcome: 'paid', providerProfileId: payout.provider_profile_id, amount: payout.payout_amount_minor_units };
    }

    const failureCode: PayoutFailureCode = result.failureCode ?? 'unknown_failure';
    await applyPayoutTransition(tx, {
      payoutId,
      from: 'processing',
      to: 'failed',
      actorRole: actor.role,
      actorUserId: actor.userId,
      detail: failureCode,
      set: sql`, failure_code = ${failureCode}, failure_reason = ${result.failureMessage ?? null},
               payout_reference = ${result.payoutReference ?? payout.payout_reference}`,
    });
    return { outcome: 'failed', providerProfileId: payout.provider_profile_id, failureCode, amount: payout.payout_amount_minor_units };
  });

  if (recorded.outcome === 'paid' && recorded.providerProfileId) {
    console.log(JSON.stringify({ event: 'payout.paid', payoutId, providerProfileId: recorded.providerProfileId, amountMinorUnits: recorded.amount, status: 'paid' }));
    await emitPayoutNotification({ kind: 'payout_paid', payoutId, providerProfileId: recorded.providerProfileId });
  } else if (recorded.outcome === 'failed' && recorded.providerProfileId && recorded.failureCode) {
    console.log(JSON.stringify({ event: 'payout.failed', payoutId, providerProfileId: recorded.providerProfileId, amountMinorUnits: recorded.amount, status: 'failed', failureCode: recorded.failureCode }));
    await emitPayoutNotification({ kind: 'payout_failed', payoutId, providerProfileId: recorded.providerProfileId, failureCode: recorded.failureCode, audience: 'provider' });
    await emitPayoutNotification({ kind: 'payout_failed', payoutId, providerProfileId: recorded.providerProfileId, failureCode: recorded.failureCode, audience: 'finance' });
  } else if (recorded.outcome === 'unknown') {
    console.log(JSON.stringify({ event: 'payout.outcome_unknown', payoutId, status: 'processing' }));
  }
  return recorded.outcome;
}

export interface PayoutReconcileResult {
  inspected: number;
  paid: number;
  failed: number;
  stillUnknown: number;
  escalated: number;
}

/** §3.8 "Ambiguity resolution" — `/api/v1/cron/payout-reconcile-sweep`. Every lookup is a READ. */
export async function runPayoutReconcileSweep(scope?: PayoutSweepScope): Promise<PayoutReconcileResult> {
  const result: PayoutReconcileResult = { inspected: 0, paid: 0, failed: 0, stillUnknown: 0, escalated: 0 };
  const provider = resolvePayoutProvider();
  const escalationMinutes = payoutAmbiguityEscalationMinutes();
  const graceMinutes = payoutAttemptGraceMinutes();

  const candidates = await queryRows<{
    id: string;
    attempt_count: number;
    payout_reference: string | null;
    stale: boolean;
    past_grace: boolean;
    escalated_at: Date | null;
  }>(
    getDb(),
    // Staleness is measured from the claim: while a payout is `processing`, `updated_at` is set only by
    // phase 1 (recording a reference or an escalation deliberately does not touch it).
    sql`SELECT p.id, p.attempt_count, p.payout_reference, p.escalated_at,
               (p.updated_at < clock_timestamp() - make_interval(mins => ${escalationMinutes})) AS stale,
               (p.updated_at <= clock_timestamp() - make_interval(mins => ${graceMinutes})) AS past_grace
          FROM payouts p
         WHERE p.status = 'processing' ${scopeFilter(sql`p.provider_profile_id`, scope)}
         ORDER BY p.updated_at ASC
         LIMIT 200`,
  );

  for (const candidate of candidates) {
    result.inspected += 1;

    let status: PayoutResult | null;
    if (candidate.payout_reference) {
      status = await provider.getPayoutStatus(candidate.payout_reference).catch(() => null);
    } else if (candidate.past_grace) {
      status = await provider
        .getPayoutStatusByIdempotencyKey(payoutAttemptKey(candidate.id, candidate.attempt_count))
        .catch(() => null);
    } else {
      // A live worker may still be inside its rail call: a key lookup now could report
      // `transfer_not_received` for a transfer that is about to happen.
      status = null;
    }

    if (!status || status.outcome === 'unknown') {
      result.stillUnknown += 1;
      if (candidate.stale && !candidate.escalated_at) {
        await getDb().execute(sql`
          UPDATE payouts SET escalated_at = clock_timestamp(), version = version + 1
           WHERE id = ${candidate.id} AND status = 'processing' AND escalated_at IS NULL
        `);
        result.escalated += 1;
        console.error(JSON.stringify({ event: 'payout.escalated', payoutId: candidate.id, status: 'processing', action: 'manual finance review required — do not mark paid, failed or re-issue' }));
        await emitPayoutNotification({ kind: 'payout_escalated', payoutId: candidate.id, audience: 'finance' });
      }
      continue;
    }

    const outcome = await recordTransferOutcome(candidate.id, candidate.attempt_count, status, { role: 'system', userId: null });
    if (outcome === 'paid') result.paid += 1;
    else if (outcome === 'failed') result.failed += 1;
  }

  return result;
}

/**
 * §3.8 — `failed → eligible`, re-snapshotting the provider's current usable default method.
 * Shared by the sweep's automatic retry and an approved Finance retry.
 */
export async function reopenFailedPayout(
  tx: Executor,
  payoutId: string,
  actor: { role: PayoutActorRole; userId: string | null; detail: string },
): Promise<'reopened' | 'no_payout_method' | 'not_failed'> {
  const [payout] = await queryRows<{ status: string; provider_profile_id: string; payout_currency_code: string }>(
    tx,
    sql`SELECT status, provider_profile_id, payout_currency_code FROM payouts WHERE id = ${payoutId} FOR UPDATE`,
  );
  if (!payout || payout.status !== 'failed') return 'not_failed';

  const method = await findUsableDefaultMethod(tx, payout.provider_profile_id, payout.payout_currency_code);
  if (!method) return 'no_payout_method';

  const applied = await applyPayoutTransition(tx, {
    payoutId,
    from: 'failed',
    to: 'eligible',
    actorRole: actor.role,
    actorUserId: actor.userId,
    detail: actor.detail,
    set: sql`, payout_method_id = ${method.id}`,
  });
  if (applied) console.log(JSON.stringify({ event: 'payout.retried', payoutId, status: 'eligible', actorRole: actor.role }));
  return applied ? 'reopened' : 'not_failed';
}

/** §3.8 — the two closed automatic-retry cases, bounded by `PAYOUT_MAX_AUTOMATIC_ATTEMPTS`. */
export async function retryFailedPayoutsAutomatically(scope?: PayoutSweepScope): Promise<number> {
  const candidates = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT p.id FROM payouts p
         WHERE p.status = 'failed' ${scopeFilter(sql`p.provider_profile_id`, scope)} AND p.attempt_count < ${payoutMaxAutomaticAttempts()}
           AND (
             (p.failure_code IN (${sql.join(AUTOMATICALLY_RETRYABLE_FAILURE_CODES.map((c) => sql`${c}`), sql`, `)})
               AND p.updated_at <= clock_timestamp() - make_interval(mins => ${payoutRetryBackoffMinutes()}))
             OR
             (p.failure_code IN (${sql.join(DESTINATION_FAILURE_CODES.map((c) => sql`${c}`), sql`, `)})
               AND EXISTS (SELECT 1 FROM payout_methods m
                            WHERE m.provider_profile_id = p.provider_profile_id AND m.payout_currency_code = p.payout_currency_code
                              AND m.is_default AND m.removed_at IS NULL AND m.verification_state = 'verified'
                              AND m.id IS DISTINCT FROM p.payout_method_id
                              AND m.updated_at > p.updated_at))
           )
         ORDER BY p.updated_at ASC
         LIMIT 200`,
  );

  let reopened = 0;
  for (const candidate of candidates) {
    const outcome = await getDb().transaction((tx) =>
      reopenFailedPayout(tx, candidate.id, { role: 'system', userId: null, detail: 'automatic_retry' }),
    );
    if (outcome === 'reopened') reopened += 1;
  }
  return reopened;
}
