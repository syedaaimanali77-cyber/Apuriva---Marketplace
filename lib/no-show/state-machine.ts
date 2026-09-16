/**
 * Spec 023 §3 "No-show workflow" — the report transition graph, and its history rows.
 *
 * The DATABASE is the authority: `0019` seeds `no_show_reports_status_transitions` and attaches spec
 * 003's EXISTING generic `enforce_status_transition()` trigger, so an unlisted pair is rejected even
 * if application code asks for it. This constant is the friendly error and the documentation, kept
 * in lockstep with those seeded rows — the same two-line-of-defence arrangement specs 020/021/022
 * use for their own machines.
 *
 * `resolved` and `withdrawn` have NO outgoing transition. A resolved report is never reopened here:
 * escalation after resolution is spec 031's, and re-deciding a Trust & Safety outcome in place would
 * destroy the record of what was originally decided.
 */
import { sql } from 'drizzle-orm';
import type { Executor } from '@/lib/offers/db';
import type { NoShowStatus } from '@/lib/types/no-show';

export const NO_SHOW_TRANSITIONS: ReadonlyArray<readonly [NoShowStatus, NoShowStatus]> = [
  ['reported', 'awaiting_response'],
  ['awaiting_response', 'under_review'],
  ['awaiting_response', 'withdrawn'],
  ['under_review', 'resolved'],
] as const;

const ALLOWED = new Set(NO_SHOW_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

export function isAllowedNoShowTransition(from: NoShowStatus, to: NoShowStatus): boolean {
  return ALLOWED.has(`${from}->${to}`);
}

export const TERMINAL_NO_SHOW_STATUSES: readonly NoShowStatus[] = ['resolved', 'withdrawn'];

export function isTerminalNoShowStatus(status: NoShowStatus): boolean {
  return TERMINAL_NO_SHOW_STATUSES.includes(status);
}

export interface NoShowTransitionRecord {
  reportId: string;
  from: NoShowStatus | null;
  to: NoShowStatus;
  actorRole: 'customer' | 'provider' | 'admin' | 'system';
  /** Null exactly for `system` — the response-timeout sweep — per the database pairing check. */
  actorUserId: string | null;
  detail?: string;
}

/**
 * Writes one append-only history row. Attribution can never be rewritten afterwards
 * (`no_show_reports_status_history_append_only_trg`), which is what makes "who moved this report,
 * and when" an audit fact rather than a mutable field.
 */
export async function recordNoShowTransition(tx: Executor, record: NoShowTransitionRecord): Promise<void> {
  if ((record.actorUserId === null) !== (record.actorRole === 'system')) {
    throw new Error('actorUserId must be null exactly when actorRole is "system"');
  }
  await tx.execute(sql`
    INSERT INTO no_show_reports_status_history
      (no_show_report_id, from_status, to_status, actor_user_id, actor_role, detail, occurred_at)
    VALUES (${record.reportId}, ${record.from}, ${record.to}, ${record.actorUserId}, ${record.actorRole},
            ${record.detail ?? null}, clock_timestamp())
  `);
}
