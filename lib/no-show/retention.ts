/**
 * Spec 023 §4 "Retention and privacy" (AC-10) — evidence minimisation.
 *
 * WHAT IS DELETED, and why only this: a resolved report's `evidence` bundle, its coarse
 * `location_signal` and both parties' free-text statements are the only parts of the record that
 * describe people rather than decisions. Once the report has been resolved for
 * `NO_SHOW_EVIDENCE_RETENTION_DAYS`, they have served their purpose and are nulled.
 *
 * WHAT IS RETAINED, deliberately: the report's identity, booking, status, outcome, resolving admin
 * and timestamps. Those are the audit record of a financial consequence and of a Trust & Safety
 * decision — spec 008 requires financial and audit records be retained regardless — and they are
 * also the basis of the AC-6 verified-no-show fact, which must not silently disappear from a
 * reliability count because a retention window elapsed.
 *
 * The evidence-immutability trigger permits exactly this write and no other: it rejects any UPDATE
 * that CHANGES evidence or a statement, but allows one that NULLS it. Minimisation can only ever
 * remove, never rewrite — so this sweep cannot be turned into a way to alter the record.
 *
 * No new scheduler: this runs from the existing `/cron/account-deletion-sweep` route, which spec
 * 008 already owns and already runs hourly.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';

export const NO_SHOW_EVIDENCE_RETENTION_DAYS = Number(process.env.NO_SHOW_EVIDENCE_RETENTION_DAYS ?? 180);

export interface NoShowRetentionResult {
  minimized: number;
}

/**
 * Nulls the evidence of every report resolved longer ago than the retention window.
 *
 * Idempotent: a report whose evidence is already `{}` and whose statements are already null is not
 * matched again, so repeated runs converge and the next run is always a safe retry.
 */
export async function sweepNoShowEvidence(): Promise<NoShowRetentionResult> {
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`UPDATE no_show_reports
           SET evidence = '{}'::jsonb,
               location_signal = 'unavailable',
               reporter_statement = NULL,
               response_statement = NULL,
               updated_at = clock_timestamp()
         WHERE status = 'resolved'
           AND resolved_at IS NOT NULL
           AND resolved_at < clock_timestamp() - make_interval(days => ${NO_SHOW_EVIDENCE_RETENTION_DAYS})
           AND (
                 evidence <> '{}'::jsonb
              OR location_signal <> 'unavailable'
              OR reporter_statement IS NOT NULL
              OR response_statement IS NOT NULL
               )
         RETURNING id`,
  );

  if (rows.length > 0) {
    console.log(JSON.stringify({ event: 'no_show.evidence_minimized', count: rows.length }));
  }
  return { minimized: rows.length };
}
