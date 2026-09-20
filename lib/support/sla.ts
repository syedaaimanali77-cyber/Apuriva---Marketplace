/**
 * Spec 032 §3 "SLA" (AC-8, DECIDED-5) — the deadline clock. PURE: no I/O, no database.
 *
 * This resolves the draft's one open question. Everything here is arithmetic over instants; the
 * database is where the result is stored, and `lib/support/lifecycle.ts` is where it is written.
 *
 * No server-only import belongs in this file: the admin support UI imports these to render a
 * countdown.
 */
import type { SupportPriority, SupportTicketStatus } from '@/lib/types/support';
import { SUPPORT_PRIORITIES } from '@/lib/types/support';

/**
 * §3 "SLA" — the response targets, in WHOLE WALL-CLOCK HOURS from ticket creation.
 *
 * MODULE CONSTANTS, NOT FOUR ENVIRONMENT VARIABLES, and that is the decision rather than an
 * oversight. Four correlated durations configured independently can be made mutually inconsistent
 * — a `low` deadline tighter than a `critical` one — and an admin queue whose ranking silently
 * inverts is worse than one that is not tunable. `assertSlaTableValid()` below makes the
 * consistency a checked invariant rather than a convention.
 *
 * This follows `DEFAULT_PROTECTION_WINDOW_HOURS` / `MIN_` / `MAX_` in
 * `lib/payments/protection-window.ts`, the repository's existing idiom for a bounded duration that
 * is not independently tunable. When spec 041 ships this migrates to it without a contract change,
 * because callers only ever see `slaHoursFor()`.
 */
export const SLA_HOURS_BY_PRIORITY: Record<SupportPriority, number> = {
  critical: 4,
  high: 12,
  medium: 24,
  low: 72,
};

/** The same bounds spec 021 uses for the protection window. */
export const MIN_SLA_HOURS = 1;
export const MAX_SLA_HOURS = 720;

export function slaHoursFor(priority: SupportPriority): number {
  return SLA_HOURS_BY_PRIORITY[priority];
}

/**
 * The invariant that makes the table safe to hard-code: every value is in bounds, and a more urgent
 * priority always gets a STRICTLY tighter deadline. Asserted by `lib/support/sla.test.ts`.
 */
export function assertSlaTableValid(table: Record<SupportPriority, number> = SLA_HOURS_BY_PRIORITY): void {
  for (const priority of SUPPORT_PRIORITIES) {
    const hours = table[priority];
    if (!Number.isInteger(hours) || hours < MIN_SLA_HOURS || hours > MAX_SLA_HOURS) {
      throw new Error(`SLA hours for '${priority}' must be an integer in [${MIN_SLA_HOURS}, ${MAX_SLA_HOURS}]`);
    }
  }
  // `SUPPORT_PRIORITIES` is ordered least→most urgent, so the deadlines must be strictly decreasing
  // as urgency rises: low > medium > high > critical.
  for (let i = 1; i < SUPPORT_PRIORITIES.length; i += 1) {
    const looser = table[SUPPORT_PRIORITIES[i - 1]!];
    const tighter = table[SUPPORT_PRIORITIES[i]!];
    if (!(tighter < looser)) {
      throw new Error(
        `SLA table is not strictly monotonic: '${SUPPORT_PRIORITIES[i]}' (${tighter}h) must be tighter than '${SUPPORT_PRIORITIES[i - 1]}' (${looser}h)`,
      );
    }
  }
}

const MS_PER_HOUR = 60 * 60 * 1000;

/** The deadline a ticket is created with: creation + the priority's hours. UTC throughout. */
export function initialSlaDeadline(createdAt: Date, priority: SupportPriority): Date {
  return new Date(createdAt.getTime() + slaHoursFor(priority) * MS_PER_HOUR);
}

/**
 * The deadline after a PRIORITY CHANGE.
 *
 * Anchored to `createdAt`, NOT to the moment of the change, plus every second already spent waiting
 * on the user. Anchoring to "now" would let an admin buy time by re-prioritising, which is exactly
 * the thing a deadline exists to prevent.
 */
export function recomputeSlaDeadline(createdAt: Date, priority: SupportPriority, pausedSeconds: number): Date {
  return new Date(createdAt.getTime() + slaHoursFor(priority) * MS_PER_HOUR + pausedSeconds * 1000);
}

/**
 * The deadline after LEAVING `awaiting_user`: pushed forward by exactly the elapsed pause.
 *
 * This is what makes AC-8's promise true — a user's own delay can never breach their own ticket.
 */
export function resumeSlaDeadline(deadlineAt: Date, awaitingSince: Date, now: Date): Date {
  const pausedMs = Math.max(0, now.getTime() - awaitingSince.getTime());
  return new Date(deadlineAt.getTime() + pausedMs);
}

/** Whole seconds spent in a single pause, accumulated into `sla_paused_seconds`. */
export function pausedSecondsBetween(awaitingSince: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - awaitingSince.getTime()) / 1000));
}

/**
 * AC-8 — the breach predicate, and the whole of the consequence.
 *
 * A ticket that is `awaiting_user` is NEVER breached, whatever its stored deadline says: the clock
 * is paused and the platform is not the one holding things up. `resolved` and `closed` are past the
 * point a response deadline means anything.
 *
 * NOTHING ELSE HAPPENS WHEN THIS RETURNS TRUE. There is no escalation, no reprioritisation, no
 * notification and no sanction — §7 puts automated SLA consequences out of scope, and this function
 * having exactly one caller (the admin read projection) is how that stays true.
 */
export function isSlaBreached(status: SupportTicketStatus, deadlineAt: Date, now: Date = new Date()): boolean {
  if (status === 'awaiting_user' || status === 'resolved' || status === 'closed') return false;
  return deadlineAt.getTime() < now.getTime();
}
