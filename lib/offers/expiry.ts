/**
 * Spec 018 §3 "Background expiry" (AC-3) — persisting `expired` without any client.
 *
 * Correctness never depends on this job: accept/decline/withdraw re-check `expires_at` against the
 * database clock after locking, and every read reports the effective status. The sweep only makes the
 * stored state converge — within 120 s of `expires_at` under the `* * * * *` Vercel Cron schedule
 * (spec 001 §8's decided mechanism; one minute is its finest granularity).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from './db';

export const EXPIRY_SWEEP_BATCH_SIZE = 500;
/** A run stops starting new batches after this long, so one minute's run never overlaps the next. */
export const EXPIRY_SWEEP_MAX_DURATION_MS = 45_000;

/**
 * One batch. `FOR UPDATE SKIP LOCKED` means the sweep never blocks on, or overwrites, an offer an
 * accept/decline/withdraw currently holds; the `UPDATE` re-states the predicate, and the spec-003
 * trigger forbids `expired -> expired`, so no row can be expired twice. One history row per offer,
 * carrying its true `from_status`, actor `null` (system).
 */
async function expireBatch(db: Executor, batchSize: number): Promise<number> {
  const rows = await queryRows<{ offer_id: string }>(
    db,
    sql`
      WITH due AS (
        SELECT id, status FROM offers
         WHERE status IN ('sent', 'viewed') AND expires_at <= clock_timestamp()
         ORDER BY expires_at
         LIMIT ${batchSize}
         FOR UPDATE SKIP LOCKED
      ), expired AS (
        UPDATE offers o
           SET status = 'expired', updated_at = clock_timestamp(), version = o.version + 1
          FROM due
         WHERE o.id = due.id AND o.status IN ('sent', 'viewed') AND o.expires_at <= clock_timestamp()
        RETURNING o.id, due.status AS from_status
      )
      INSERT INTO offers_status_history (offer_id, from_status, to_status, actor_user_id)
      SELECT id, from_status, 'expired', NULL FROM expired
      RETURNING offer_id
    `,
  );
  return rows.length;
}

export interface OfferExpirySweepResult {
  expired: number;
  batches: number;
  durationMs: number;
}

export async function runOfferExpirySweep(options?: {
  batchSize?: number;
  maxDurationMs?: number;
}): Promise<OfferExpirySweepResult> {
  const batchSize = options?.batchSize ?? EXPIRY_SWEEP_BATCH_SIZE;
  const maxDurationMs = options?.maxDurationMs ?? EXPIRY_SWEEP_MAX_DURATION_MS;
  const startedAt = Date.now();
  let expired = 0;
  let batches = 0;

  try {
    for (;;) {
      const count = await expireBatch(getDb(), batchSize);
      expired += count;
      batches += 1;
      if (count < batchSize || Date.now() - startedAt >= maxDurationMs) break;
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'offers.expiry_sweep_failed', expired, batches, error: String(err) }));
    throw err;
  }

  const result = { expired, batches, durationMs: Date.now() - startedAt };
  console.log(JSON.stringify({ event: 'offers.expiry_sweep', ...result }));
  return result;
}

/**
 * Spec 018 §3 creation rule 10: inside the creating transaction (which already holds the request
 * lock), persist `expired` on this provider's stale, not-yet-swept offers for this request, so a stale
 * row can never block AC-5's fresh offer.
 */
export async function expireStaleOffersFor(tx: Executor, requestId: string, providerProfileId: string): Promise<void> {
  await tx.execute(sql`
    WITH stale AS (
      UPDATE offers o
         SET status = 'expired', updated_at = clock_timestamp(), version = o.version + 1
        FROM (SELECT id, status FROM offers
               WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId}
                 AND status IN ('sent', 'viewed') AND expires_at <= clock_timestamp()
               FOR UPDATE) due
       WHERE o.id = due.id AND o.status IN ('sent', 'viewed') AND o.expires_at <= clock_timestamp()
      RETURNING o.id, due.status AS from_status
    )
    INSERT INTO offers_status_history (offer_id, from_status, to_status, actor_user_id)
    SELECT id, from_status, 'expired', NULL FROM stale
  `);
}
