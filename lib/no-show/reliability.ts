/**
 * Spec 023 §3 "Reliability signal" (AC-6) — the fact spec 017 consumes.
 *
 * OWNERSHIP, stated precisely because the draft spec got it wrong: the `reliability` ranking factor
 * belongs to **spec 017** (`lib/matching/weights.ts`, `lib/types/matching.ts`), not spec 016, which
 * owns availability and service areas. This module supplies a COUNT; it computes no score, sets no
 * weight, and imports nothing from `lib/matching/**`. The dependency direction is 017 → 023, so
 * spec 017 activates its factor on its own schedule without this spec changing.
 *
 * Spec 017's current definition of `reliability` (accept/decline rate and response latency from
 * `request_provider_matches`) is untouched. Widening that factor to include verified no-shows is
 * spec 017's change to make; this spec neither performs nor presumes it.
 *
 * WHAT COUNTS: only a RESOLVED report whose outcome is a confirmed no-show. `reported`,
 * `awaiting_response`, `under_review`, `withdrawn`, `no_fault`, `inconclusive` and
 * `escalated_to_dispute` produce nothing at all.
 *
 * EXACTLY ONCE: `no_show_reports_booking_fault_uq` — a partial unique index over `booking_id` where
 * the outcome is a confirmed no-show — makes a second fault-bearing resolution for one booking
 * impossible at the database. Two parties reporting each other therefore cannot double-count, and a
 * duplicate report cannot inflate anyone's number.
 *
 * WHAT THIS NEVER DOES: suspend, ban, restrict, deactivate or de-rank anyone. Master spec §132.11
 * forbids an automatic ban, and `no-auto-ban.test.ts` asserts at source level that no module here
 * writes any user or provider lifecycle status.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { FaultOutcome } from '@/lib/types/no-show';

export type ReliabilitySubjectRole = 'customer' | 'provider';

export interface VerifiedNoShowSignal {
  reportId: string;
  bookingId: string;
  /** The party found at fault — NEVER the reporter. */
  subjectRole: ReliabilitySubjectRole;
  subjectProfileId: string;
  resolvedAt: string;
}

/** The outcome names the party at fault, so the attribution needs no separate decision. */
export function subjectRoleForOutcome(outcome: FaultOutcome): ReliabilitySubjectRole {
  return outcome === 'no_show_confirmed_customer' ? 'customer' : 'provider';
}

/**
 * Spec 017 calls this. A read over resolved reports — the ROWS are the record, so a consumer that
 * was not running when a report resolved loses nothing.
 *
 * `since` lets a consumer weight recent behaviour more heavily without this spec having an opinion
 * about how; deciding that is exactly the ranking question spec 017 owns.
 */
export async function countVerifiedNoShows(
  tx: Executor,
  filter: { subjectRole: ReliabilitySubjectRole; subjectProfileId: string; since?: Date },
): Promise<number> {
  const outcome = filter.subjectRole === 'customer' ? 'no_show_confirmed_customer' : 'no_show_confirmed_provider';
  const profileColumn =
    filter.subjectRole === 'customer' ? sql`b.customer_profile_id` : sql`b.provider_profile_id`;

  const [row] = await queryRows<{ count: string | number }>(
    tx,
    sql`SELECT COUNT(*)::int AS count
          FROM no_show_reports r
          JOIN bookings b ON b.id = r.booking_id
         WHERE r.status = 'resolved'
           AND r.outcome = ${outcome}
           AND ${profileColumn} = ${filter.subjectProfileId}
           AND (${filter.since ?? null}::timestamptz IS NULL OR r.resolved_at >= ${filter.since ?? null})`,
  );
  return Number(row?.count ?? 0);
}

/**
 * A prompt-notification port for spec 017, with an inert default.
 *
 * The DURABLE ROWS remain the source of truth: if this sink is inert, throws, or the process dies,
 * the fact survives and a consumer picks it up on its next read. The port is a latency optimisation,
 * never the record — the same arrangement spec 022 uses for reconciliation.
 */
export type NoShowReliabilitySink = (signal: VerifiedNoShowSignal) => Promise<void>;

const LOG_ONLY: NoShowReliabilitySink = async (signal) => {
  console.log(JSON.stringify({ event: 'no_show.reliability_signal', ...signal }));
};

let currentSink: NoShowReliabilitySink = LOG_ONLY;

export function registerNoShowReliabilitySink(sink: NoShowReliabilitySink): void {
  currentSink = sink;
}

export function getNoShowReliabilitySink(): NoShowReliabilitySink {
  return currentSink;
}

export function resetNoShowReliabilitySink(): void {
  currentSink = LOG_ONLY;
}

/**
 * Emitted after a fault-bearing resolution commits. Never throws: a sink failure must not undo a
 * Trust & Safety decision that is already recorded.
 */
export async function emitReliabilitySignal(input: {
  reportId: string;
  bookingId: string;
  outcome: FaultOutcome;
}): Promise<void> {
  const subjectRole = subjectRoleForOutcome(input.outcome);

  const [row] = await queryRows<{ profile_id: string; resolved_at: Date }>(
    getDb(),
    sql`SELECT ${subjectRole === 'customer' ? sql`b.customer_profile_id` : sql`b.provider_profile_id`} AS profile_id,
               r.resolved_at
          FROM no_show_reports r
          JOIN bookings b ON b.id = r.booking_id
         WHERE r.id = ${input.reportId}`,
  );
  if (!row) return;

  try {
    await currentSink({
      reportId: input.reportId,
      bookingId: input.bookingId,
      subjectRole,
      subjectProfileId: row.profile_id,
      resolvedAt: new Date(row.resolved_at).toISOString(),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'no_show.reliability_sink_failed',
        reportId: input.reportId,
        message: err instanceof Error ? err.message : 'unknown',
      }),
    );
  }
}
