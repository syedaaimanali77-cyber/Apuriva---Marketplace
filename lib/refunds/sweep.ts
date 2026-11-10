/**
 * Spec 022 §3 "Provider ambiguity and recovery" (AC-7) — the reconcile sweep.
 *
 * This is the module that makes it safe never to auto-fail an ambiguous refund. Everything it does
 * to resolve one is a `getRefundStatus` **READ**; it issues no `provider.refund()` call, ever, so
 * running it repeatedly — including two overlapping invocations — cannot refund twice.
 *
 * Three outcomes per `processing` refund:
 *   - provider says `refunded`  → the refund completes, exactly as the live path would have;
 *   - provider says `failed`    → the refund fails and releases its reservation;
 *   - still `unknown`           → NOTHING changes. After
 *     `REFUND_AMBIGUITY_ESCALATION_MINUTES` the row is logged for manual finance review — never
 *     auto-failed (which would strand the customer's money if the provider did pay) and never
 *     auto-retried (which could pay twice if it did).
 *
 * Uses the repository's existing Vercel Cron mechanism via `app/api/v1/cron/refund-reconcile-sweep`.
 * Idempotent and retry-safe: the next minute's run is the retry, and every row is taken
 * `FOR UPDATE SKIP LOCKED`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resolvePaymentProvider } from '@/lib/payments/provider';
import { recordRefundOutcome } from './execute';

/**
 * AC-7 — how long a refund may sit with an unresolved provider outcome before it is escalated for
 * manual finance review. An environment variable with a documented default, the way spec 008's
 * `DELETION_GRACE_PERIOD_DAYS` and spec 021's authorization window are handled. Not a feature flag.
 */
export const DEFAULT_REFUND_AMBIGUITY_ESCALATION_MINUTES = 60;

export function refundAmbiguityEscalationMinutes(): number {
  const raw = Number(process.env.REFUND_AMBIGUITY_ESCALATION_MINUTES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_REFUND_AMBIGUITY_ESCALATION_MINUTES;
}

export interface RefundSweepResult {
  inspected: number;
  completed: number;
  failed: number;
  stillUnknown: number;
  escalated: number;
}

export async function runRefundReconcileSweep(): Promise<RefundSweepResult> {
  const result: RefundSweepResult = { inspected: 0, completed: 0, failed: 0, stillUnknown: 0, escalated: 0 };
  const escalationMinutes = refundAmbiguityEscalationMinutes();

  const provider = resolvePaymentProvider();

  const candidates = await queryRows<{
    id: string;
    refund_reference: string | null;
    booking_id: string;
    stale: boolean;
  }>(
    getDb(),
    sql`SELECT r.id, r.refund_reference, r.booking_id,
               (r.updated_at < clock_timestamp() - make_interval(mins => ${escalationMinutes})) AS stale
          FROM refunds r
         WHERE r.status = 'processing'
         ORDER BY r.updated_at ASC
         LIMIT 200`,
  );

  for (const candidate of candidates) {
    // Re-check under a lock, skipping any row another sweep already holds.
    const claimed = await getDb().transaction(async (tx) => {
      const [row] = await queryRows<{ id: string; status: string }>(
        tx,
        sql`SELECT id, status FROM refunds WHERE id = ${candidate.id} AND status = 'processing' FOR UPDATE SKIP LOCKED`,
      );
      return Boolean(row);
    });
    if (!claimed) continue;

    result.inspected += 1;

    if (!candidate.refund_reference) {
      // The provider never issued a reference, so there is nothing to look up. This row cannot be
      // resolved automatically and must not be guessed at in either direction.
      result.stillUnknown += 1;
      if (candidate.stale) {
        result.escalated += 1;
        escalate(candidate.id, candidate.booking_id, 'no_refund_reference');
      }
      continue;
    }

    const status = await provider.getRefundStatus(candidate.refund_reference).catch(() => null);

    if (!status || status.outcome === 'unknown') {
      result.stillUnknown += 1;
      if (candidate.stale) {
        result.escalated += 1;
        escalate(candidate.id, candidate.booking_id, 'provider_outcome_still_unknown');
      }
      continue;
    }

    // `recordRefundOutcome` is the SAME routine the live path uses, so a swept refund completes or
    // fails on exactly the same terms — including the payment/booking transitions and the
    // reconciliation and notification emissions.
    await recordRefundOutcome(candidate.id, status, { userId: null, role: 'system' });
    if (status.outcome === 'refunded') result.completed += 1;
    else result.failed += 1;
  }

  return result;
}

/**
 * Escalation is a loud, structured log line and nothing more.
 *
 * Deliberately not a status change: §9 alerts on these, and a human decides. Writing a state here
 * would be exactly the automatic guess AC-7 forbids.
 */
function escalate(refundId: string, bookingId: string, cause: string): void {
  console.error(
    JSON.stringify({
      event: 'refund.escalated',
      refundId,
      bookingId,
      status: 'processing',
      cause,
      action: 'manual finance review required — do not auto-fail or re-issue',
    }),
  );
}
