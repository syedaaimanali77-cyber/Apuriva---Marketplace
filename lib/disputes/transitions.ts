/**
 * Spec 031 §3 "Dispute lifecycle" (DECIDED-3) — the transition table. PURE: no I/O, no database.
 *
 * ```
 *    open ──claim──▶ under_review ──resolve──▶ resolved ──appeal──▶ appealed
 *      │                  │                       │                    │
 *      └───resolve────────┘                       │ close              │ decide_appeal
 *                                                 ▼                    ▼
 *                                              closed  ◀───────────  closed   (terminal)
 * ```
 *
 * `closed` IS TERMINAL and a dispute is never reopened. That is not merely a policy: because
 * eligibility requires `protected` + `held` (DECIDED-1) and closure hands the payment back to spec
 * 021's sweep, which then releases it, no booking can ever be eligible a second time. A genuinely
 * new problem after closure is a safety report (spec 030) or a moderation report (spec 038), each
 * independently auditable and each leaving the original finding intact. The repository already
 * treats closed findings this way: spec 030's `resolved` and spec 023's `resolved`/`withdrawn` are
 * terminal for the same reason.
 *
 * `closed` IS ALSO THE SINGLE FINANCIALLY-FINAL STATE. `isDisputeFinanciallyOpen` is what
 * `lib/disputes/gate.ts` answers spec 021 with, so a resolution alone releases nothing — the money
 * stays held through the entire appeal window. That is what makes AC-4's "the money stays held"
 * true without a second mechanism guarding it.
 */
import type { DisputeStatus } from '@/lib/types/disputes';

export const DISPUTE_TRANSITIONS: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = {
  open: ['under_review', 'resolved'],
  under_review: ['resolved'],
  resolved: ['appealed', 'closed'],
  appealed: ['closed'],
  closed: [],
};

export function canTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  return DISPUTE_TRANSITIONS[from].includes(to);
}

/** The statuses an admin may still resolve from. */
export const RESOLVABLE_STATUSES: readonly DisputeStatus[] = ['open', 'under_review'];

export function isResolvable(status: DisputeStatus): boolean {
  return RESOLVABLE_STATUSES.includes(status);
}

/**
 * The statuses in which a participant may still post a message or attach evidence.
 *
 * `resolved` is deliberately absent and `appealed` deliberately present: a decided case is frozen,
 * but an appeal is precisely the stage that exists to admit new material.
 */
export const CONTRIBUTABLE_STATUSES: readonly DisputeStatus[] = ['open', 'under_review', 'appealed'];

export function isContributable(status: DisputeStatus): boolean {
  return CONTRIBUTABLE_STATUSES.includes(status);
}

/**
 * The statuses in which money stays held — everything except `closed`.
 *
 * This single predicate is the whole of AC-2's and AC-4's financial behaviour. `lib/disputes/gate.ts`
 * returns `{ open: isDisputeFinanciallyOpen(status) }` and spec 021 does the rest.
 */
export const FINANCIALLY_OPEN_STATUSES: readonly DisputeStatus[] = ['open', 'under_review', 'resolved', 'appealed'];

export function isDisputeFinanciallyOpen(status: DisputeStatus): boolean {
  return status !== 'closed';
}

/** The statuses from which closure is possible. A dispute is never closed before it is decided. */
export const CLOSEABLE_STATUSES: readonly DisputeStatus[] = ['resolved', 'appealed'];

export function isCloseable(status: DisputeStatus): boolean {
  return CLOSEABLE_STATUSES.includes(status);
}
