/**
 * Spec 029 §3 — the named constants of reviews and ratings.
 *
 * Fixed in code except the review window, which is the one server-side configuration value. It is
 * an environment variable with a documented default and hard bounds, exactly the way spec 021's
 * `PAYMENT_AUTHORIZATION_WINDOW_MINUTES` and spec 008's `DELETION_GRACE_PERIOD_DAYS` are handled.
 * This is NOT a feature-flag system — spec 041 owns that, and when it exists this migrates to it
 * without a contract change, because callers only ever see `reviewWindowDays()`.
 *
 * No server-only import belongs in this file: the review UI imports these constants.
 */

/**
 * §3 "Eligibility" — how long after completion a customer may leave a review.
 *
 * 14 is a PRODUCT DECISION recorded in the approved spec, because neither the master specification
 * nor any earlier spec states one. It is long enough that a customer who finishes a job on a Friday
 * still has two weekends, and short enough that the review describes a job the reviewer remembers.
 * It sits deliberately outside spec 021's 48-hour protection window, so reviewing is never a lever
 * on money.
 */
export const DEFAULT_REVIEW_WINDOW_DAYS = 14;
export const MIN_REVIEW_WINDOW_DAYS = 1;
export const MAX_REVIEW_WINDOW_DAYS = 90;

/**
 * The window in days. Evaluated at submit time against the booking's completion instant, never
 * snapshotted per booking: freezing an environment variable in a column would buy nothing, and the
 * stated consequence is that changing this changes eligibility for already-completed bookings.
 */
export function reviewWindowDays(): number {
  const raw = Number(process.env.REVIEW_WINDOW_DAYS);
  return Number.isInteger(raw) && raw >= MIN_REVIEW_WINDOW_DAYS && raw <= MAX_REVIEW_WINDOW_DAYS
    ? raw
    : DEFAULT_REVIEW_WINDOW_DAYS;
}

/** §3 "Rating and text" — the rating scale the design system's `Rating` primitive renders. */
export const MIN_RATING = 1;
export const MAX_RATING = 5;

/**
 * §3 "Rating and text". The maximum reuses `MESSAGE_BODY_MAX_LENGTH` (spec 025) rather than
 * inventing a second platform prose bound; the minimum exists because a one- or two-character body
 * carries no information a reader can act on and is the cheapest bulk-spam vector.
 */
export const MIN_TEXT_LENGTH = 10;
export const MAX_TEXT_LENGTH = 2000;

/** §3 "Moderation" — the mandatory reason on every admin resolution (master §68). */
export const MIN_MODERATION_REASON_LENGTH = 10;
export const MAX_MODERATION_REASON_LENGTH = 2000;

/** §3 "Media" — the per-booking cap, mirrored by `review_media_position_ck`. */
export const MAX_REVIEW_MEDIA = 5;

/** Spec 027's reserved `context_type` for this spec. Named once so no query spells it by hand. */
export const REVIEW_MEDIA_CONTEXT = 'review_media';

/** §3 "Review reporting" — the per-user abuse cap, on top of the `reviews` rate-limit domain. */
export const MAX_REPORTS_PER_WINDOW = 20;
export const REPORT_WINDOW_HOURS = 24;

/**
 * §3 "Deterministic MVP flagging" — the thresholds of the two database-reading signals. Named here
 * so the spec's numbers live in one place rather than inside a query.
 */
export const BURST_SUBMISSION_THRESHOLD = 3;
export const BURST_SUBMISSION_WINDOW_HOURS = 1;
export const REPEAT_PAIR_THRESHOLD = 3;
export const REPEAT_PAIR_WINDOW_DAYS = 30;
