/**
 * Spec 023 §3 "No-show workflow" — the response-timeout sweep.
 *
 * SILENCE IS NOT AN ADMISSION. This sweep does exactly one thing: move a report whose response
 * window has elapsed from `awaiting_response` to `under_review`, marking `response_status` as
 * `no_response`. It applies no consequence, transitions no booking, moves no money and sets no
 * outcome — the admin simply sees "no response within the window" as one neutral fact among the
 * evidence, and decides for themselves (master spec §51).
 *
 * Mechanism is the repository's existing one, not a new scheduler: a Vercel Cron route with bearer
 * `CRON_SECRET`, exactly as `/cron/payment-sweep` and `/cron/offer-expiry-sweep` do.
 * `FOR UPDATE SKIP LOCKED` means two overlapping invocations cannot process the same report, and the
 * whole pass is idempotent — the next run is the retry.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { advanceStatus } from './report';

export interface NoShowSweepResult {
  movedToReview: number;
}

/** How many reports one invocation will touch, so a backlog cannot make a single run unbounded. */
const SWEEP_BATCH_SIZE = 50;

export async function runNoShowResponseSweep(): Promise<NoShowSweepResult> {
  let movedToReview = 0;

  const candidates = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM no_show_reports
         WHERE status = 'awaiting_response' AND respond_by_at <= clock_timestamp()
         ORDER BY respond_by_at
         LIMIT ${SWEEP_BATCH_SIZE}`,
  );

  for (const candidate of candidates) {
    await getDb().transaction(async (tx) => {
      const [locked] = await queryRows<{ id: string; elapsed: boolean }>(
        tx,
        sql`SELECT id, respond_by_at <= clock_timestamp() AS elapsed
              FROM no_show_reports
             WHERE id = ${candidate.id} AND status = 'awaiting_response'
             FOR UPDATE SKIP LOCKED`,
      );
      // Someone responded (or withdrew) between the scan and the lock: leave it entirely alone.
      if (!locked || !locked.elapsed) return;

      await tx.execute(
        sql`UPDATE no_show_reports SET response_status = 'no_response', updated_at = clock_timestamp()
             WHERE id = ${candidate.id}`,
      );

      const moved = await advanceStatus(
        tx,
        candidate.id,
        'awaiting_response',
        'under_review',
        { actorRole: 'system', actorUserId: null },
        { detail: 'response_window_elapsed' },
      );
      if (moved) {
        movedToReview += 1;
        console.log(
          JSON.stringify({ event: 'no_show.no_response', reportId: candidate.id, bookingId: moved.booking_id }),
        );
      }
    });
  }

  return { movedToReview };
}
