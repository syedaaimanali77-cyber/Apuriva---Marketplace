/**
 * Spec 032 §3 "Ticket lifecycle" — the reopen-window sweep.
 *
 * WHAT IT DOES IS DELIBERATELY SMALL: close `resolved` tickets whose reopen window has elapsed. It
 * sets no outcome, changes no priority, reassigns nobody and notifies nobody — an un-reopened
 * resolution simply becomes final, which is the only thing that has to happen for `closed` to be
 * reachable at all.
 *
 * THIS IS NOT AN SLA SWEEP, AND THERE ISN'T ONE. §7 puts automated SLA consequences out of scope:
 * a breached ticket is flagged in the admin queue and nothing else happens to it, ever. This sweep
 * exists for the REOPEN deadline, which is a lifecycle boundary rather than a performance target —
 * the same job spec 031's `runDisputeAppealSweep` does for its appeal window, and modelled on it.
 *
 * IDEMPOTENT AND RETRY-SAFE BY CONSTRUCTION: it selects only `resolved` rows past their deadline,
 * and each row's own `UPDATE` re-checks that same predicate, so re-running — including after a
 * crash mid-sweep — can only ever affect a row once.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { supportReopenWindowDays } from './reopen-window';

export async function runSupportReopenSweep(): Promise<{ closed: number }> {
  const db = getDb();
  const days = supportReopenWindowDays();

  // One statement: the deadline is evaluated against the database clock, and the same predicate
  // guards the write, so two concurrent sweep runs cannot both close the same ticket.
  const closed = await queryRows<{ id: string }>(
    db,
    sql`UPDATE support_tickets
           SET status = 'closed',
               closed_at = clock_timestamp(),
               updated_at = clock_timestamp(),
               version = version + 1
         WHERE status = 'resolved'
           AND resolved_at IS NOT NULL
           AND resolved_at + make_interval(days => ${days}) <= clock_timestamp()
        RETURNING id`,
  );

  return { closed: closed.length };
}
