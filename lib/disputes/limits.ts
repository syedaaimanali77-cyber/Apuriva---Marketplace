/**
 * Spec 031 §3 — the spec's bounded constants. PURE: no I/O, no database.
 *
 * THERE IS NO DISPUTE-OPENING WINDOW CONSTANT HERE, AND THAT IS THE POINT (DECIDED-1). Eligibility
 * is "the booking is `protected` and its payment protection is `held`", which IS spec 021's
 * payment-protection window — already configurable per payment, already bounded 1..720 hours,
 * already anchored to the completion history row. Inventing a second deadline here would create
 * two clocks that could disagree, and a dispute opened after the first one expired could not do
 * what AC-2 promises.
 *
 * The appeal window is the one genuinely new duration, and it follows the repository's established
 * idiom for such a value: an environment variable with a documented default and hard bounds, the
 * way spec 029 handles `DEFAULT_REVIEW_WINDOW_DAYS`, spec 021 `PAYMENT_AUTHORIZATION_WINDOW_MINUTES`
 * and spec 008 `DELETION_GRACE_PERIOD_DAYS`. This is NOT a feature-flag system; spec 041 owns that,
 * and when it ships this migrates to it without a contract change, because callers only ever see
 * `disputeAppealWindowDays()`.
 *
 * No server-only import belongs in this file: the dispute UI imports these constants.
 */
import type { FileContextType } from '@/lib/types/files';

/**
 * §3 "Appeal rules" — how long after a resolution a participant may appeal.
 *
 * 7 is a PRODUCT DECISION recorded in the approved spec. It is long enough that a party who is
 * away for a few days still has a real chance to read the reasoning and respond, and short enough
 * that a provider's money is not held hostage to indecision — the whole dispute stays financially
 * open for its duration, which is exactly what makes AC-4's "the money stays held" true.
 */
export const DEFAULT_DISPUTE_APPEAL_WINDOW_DAYS = 7;
export const MIN_DISPUTE_APPEAL_WINDOW_DAYS = 1;
export const MAX_DISPUTE_APPEAL_WINDOW_DAYS = 30;

export function isValidAppealWindowDays(days: number): boolean {
  return Number.isInteger(days) && days >= MIN_DISPUTE_APPEAL_WINDOW_DAYS && days <= MAX_DISPUTE_APPEAL_WINDOW_DAYS;
}

/**
 * The window in days. Evaluated against `dispute_resolutions.resolved_at` at the moment an appeal
 * is attempted, never snapshotted onto the row: freezing an environment variable in a column would
 * buy nothing, and the stated consequence is that changing this changes the deadline for
 * already-resolved disputes.
 */
export function disputeAppealWindowDays(): number {
  const raw = Number(process.env.DISPUTE_APPEAL_WINDOW_DAYS);
  return isValidAppealWindowDays(raw) ? raw : DEFAULT_DISPUTE_APPEAL_WINDOW_DAYS;
}

/** The instant an appeal stops being possible. `null` in, `null` out — nothing is resolved yet. */
export function appealWindowEndsAt(resolvedAt: Date | string | null, days: number = disputeAppealWindowDays()): Date | null {
  if (resolvedAt === null) return null;
  const start = resolvedAt instanceof Date ? resolvedAt : new Date(resolvedAt);
  if (Number.isNaN(start.getTime())) return null;
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
}

export function hasAppealWindowElapsed(
  resolvedAt: Date | string | null,
  days: number = disputeAppealWindowDays(),
  now: Date = new Date(),
): boolean {
  const endsAt = appealWindowEndsAt(resolvedAt, days);
  return endsAt !== null && now.getTime() >= endsAt.getTime();
}

/**
 * Prose bounds. Reuses spec 025's `MESSAGE_BODY_MAX_LENGTH` value for the message body rather than
 * inventing a second platform prose bound — exactly as spec 029 did for review text and spec 030
 * for a report description.
 */
export const MIN_DISPUTE_REASON_LENGTH = 10;
export const MAX_DISPUTE_REASON_LENGTH = 2000;

/** Admin reason bounds (master §68 requires a reason on every recorded decision). */
export const MIN_DISPUTE_REASONING_LENGTH = 10;
export const MAX_DISPUTE_REASONING_LENGTH = 2000;

/**
 * §3 "Evidence" — the per-dispute cap, counted across BOTH parties.
 *
 * 10, matching spec 030's cap for the same reason: evidence is whatever the party actually has, and
 * narrowing it discards the material the decision is supposed to rest on.
 */
export const MAX_DISPUTE_EVIDENCE = 10;

/**
 * §3 "Dispute messages" — the per-dispute message cap across all authors.
 *
 * Bounds the thread without truncating a real argument: 200 messages is far more than any dispute
 * a human admin can usefully read, so hitting it is a signal the parties are talking past each
 * other rather than a limit a good-faith exchange will meet.
 */
export const MAX_DISPUTE_MESSAGES = 200;

/** The spec 027 context this spec registers. Already in `file_assets_context_type_ck` since 0001. */
export const DISPUTE_EVIDENCE_CONTEXT: FileContextType = 'dispute_evidence';
