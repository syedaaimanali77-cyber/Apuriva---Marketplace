/**
 * Spec 030 §3 "Safety report lifecycle" — the transition table. PURE: no I/O, no database.
 *
 * ```
 *    submitted ──claim──▶ under_review ──escalate──▶ escalated
 *        │                     │                        │
 *        └────────resolve──────┴────────resolve─────────┘
 *                              ▼
 *                           resolved   (terminal)
 * ```
 *
 * `resolved` IS TERMINAL and a report is never re-opened (DECIDED-4). A new concern about the same
 * person produces a NEW report, which is cheap, independently auditable and leaves the original
 * finding intact. Mutating a closed safety finding is precisely what an audit trail exists to
 * prevent, and the repository already treats such states as terminal — spec 023's
 * `no_show_reports` reach `resolved`/`withdrawn` and never leave them. Master §68's appeal
 * mechanism applies to admin ACTIONS, which are spec 038's, not to the report record.
 */
import type { SafetyReportStatus } from '@/lib/types/safety';

export const SAFETY_TRANSITIONS: Readonly<Record<SafetyReportStatus, readonly SafetyReportStatus[]>> = {
  submitted: ['under_review', 'escalated', 'resolved'],
  under_review: ['escalated', 'resolved'],
  escalated: ['resolved'],
  resolved: [],
};

export function canTransition(from: SafetyReportStatus, to: SafetyReportStatus): boolean {
  return SAFETY_TRANSITIONS[from].includes(to);
}

/** The statuses from which an admin may still act. Used by the queue filter. */
export const OPEN_SAFETY_STATUSES: readonly SafetyReportStatus[] = ['submitted', 'under_review', 'escalated'];

export function isOpenSafetyStatus(status: SafetyReportStatus): boolean {
  return OPEN_SAFETY_STATUSES.includes(status);
}
