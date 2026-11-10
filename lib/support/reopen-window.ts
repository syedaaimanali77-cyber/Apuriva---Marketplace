/**
 * Spec 032 §3 "SLA" / "Ticket lifecycle" — the reopen window.
 *
 * The ONE genuinely independent duration this spec adds, so unlike the SLA table it follows the
 * repository's environment-variable idiom exactly: a documented default with hard bounds, the way
 * spec 031 handles `DISPUTE_APPEAL_WINDOW_DAYS`, spec 029 `REVIEW_WINDOW_DAYS` and spec 008
 * `DELETION_GRACE_PERIOD_DAYS`. This is NOT a feature-flag system; spec 041 owns that.
 *
 * PURE apart from the one `process.env` read. No server-only import: the ticket UI imports these.
 */

/**
 * How long after a resolution the requester may reopen.
 *
 * 3 is a PRODUCT DECISION recorded in the approved spec. It is long enough that someone who was
 * away for a weekend can still say "this did not actually fix it", and short enough that a ticket
 * reaches a terminal state while the context is still fresh for whoever picks it back up.
 */
export const DEFAULT_SUPPORT_REOPEN_WINDOW_DAYS = 3;
export const MIN_SUPPORT_REOPEN_WINDOW_DAYS = 1;
export const MAX_SUPPORT_REOPEN_WINDOW_DAYS = 30;

export function isValidReopenWindowDays(days: number): boolean {
  return (
    Number.isInteger(days) && days >= MIN_SUPPORT_REOPEN_WINDOW_DAYS && days <= MAX_SUPPORT_REOPEN_WINDOW_DAYS
  );
}

/**
 * The window in days.
 *
 * Evaluated against `support_tickets.resolved_at` at the moment a reopen is attempted, never
 * snapshotted onto the row: freezing an environment variable in a column would buy nothing, and the
 * stated consequence is that changing this changes the deadline for already-resolved tickets.
 */
export function supportReopenWindowDays(): number {
  const raw = Number(process.env.SUPPORT_REOPEN_WINDOW_DAYS);
  return isValidReopenWindowDays(raw) ? raw : DEFAULT_SUPPORT_REOPEN_WINDOW_DAYS;
}

/** The instant a reopen stops being possible. `null` in, `null` out — nothing is resolved yet. */
export function reopenWindowEndsAt(
  resolvedAt: Date | string | null,
  days: number = supportReopenWindowDays(),
): Date | null {
  if (resolvedAt === null) return null;
  const start = resolvedAt instanceof Date ? resolvedAt : new Date(resolvedAt);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}

export function hasReopenWindowElapsed(
  resolvedAt: Date | string | null,
  days: number = supportReopenWindowDays(),
  now: Date = new Date(),
): boolean {
  const endsAt = reopenWindowEndsAt(resolvedAt, days);
  return endsAt !== null && now.getTime() >= endsAt.getTime();
}

/**
 * §3 "Ticket lifecycle" — the requester gets ONE reopen.
 *
 * Spec 031's one-appeal rule, for the same reason: an unbounded reopen makes `closed` unreachable,
 * and a ticket that can never end is a ticket nobody can be accountable for. An ADMIN reopen does
 * not consume this, which is why the database allows `reopen_count` up to 2.
 */
export const MAX_REQUESTER_REOPENS = 1;
