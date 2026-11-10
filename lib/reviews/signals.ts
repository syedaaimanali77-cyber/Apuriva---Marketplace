/**
 * Spec 029 §3 "Deterministic MVP flagging" (AC-4, AC-5) — the rule-based signal evaluation.
 *
 * THE MOST IMPORTANT PROPERTY OF THIS MODULE IS WHAT IT CANNOT DO.
 *
 *   - It is PURE: no I/O, no logging, no database, no clock, no network. The two signals that need
 *     history (`burst_submission`, `repeat_pair`) are computed by `create.ts` inside the creating
 *     transaction and passed IN as plain counts, so even those do not turn this into an I/O module.
 *   - It takes **text only**. There is no `rating` parameter and no way to add one without changing
 *     this signature, which is how AC-5 — "no rule anywhere derives a flag from the rating" — is
 *     enforced by the type system rather than by discipline.
 *   - It returns a LIST OF CODES. It cannot set a status, cannot hide anything and cannot remove
 *     anything. The only thing a caller may do with a non-empty result is mark the review `flagged`,
 *     which is publicly visible and differs from `published` only in that a human is asked to look.
 *
 * This is the whole of MVP flagging. It is not a placeholder for an AI call: `docs/workflow.md`
 * records rule-based-first as the agreed sequencing for this spec, and an AI-assisted signal, if
 * one is ever added, may only widen this result — never change a review's visibility on its own.
 */
import type { ReviewSignalCode } from '@/lib/types/reviews';
import { redactContactInfo } from '@/lib/negotiation/contact-redaction';
import { PROFANITY_WORDS } from './profanity-list';
import { BURST_SUBMISSION_THRESHOLD, REPEAT_PAIR_THRESHOLD } from './limits';

export interface ReviewSignalResult {
  /** Empty means `published`. Non-empty means `flagged` — visible, and queued for a human. */
  codes: ReviewSignalCode[];
}

/** Counts the caller computed from history. Never the rating, and never anything about sentiment. */
export interface ReviewHistoryCounts {
  /** How many reviews this author created in the preceding `BURST_SUBMISSION_WINDOW_HOURS`. */
  authorRecentReviews: number;
  /** How many reviews this (author, provider) pair produced in the preceding `REPEAT_PAIR_WINDOW_DAYS`. */
  pairRecentReviews: number;
}

const NO_HISTORY: ReviewHistoryCounts = { authorRecentReviews: 0, pairRecentReviews: 0 };

/** At least two of these means the body is a link dump rather than an account of a job. */
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;
const TOKEN_PATTERN = /[\p{L}\p{N}']+/gu;
const ALPHABETIC_PATTERN = /\p{L}/u;

const SPAM_URL_THRESHOLD = 2;
const SPAM_REPEAT_THRESHOLD = 10;
const SPAM_NON_ALPHABETIC_RATIO = 0.7;
const SPAM_RATIO_MIN_LENGTH = 40;

/** Case- and diacritic-insensitive comparison form. NFD strips accents to combining marks. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const FOLDED_PROFANITY = new Set(PROFANITY_WORDS.map(fold));

/**
 * The one entry point. `text` is the ALREADY-NORMALIZED body (`normalizeReviewText`), so control,
 * zero-width and bidi characters are gone before any rule looks at it — which is what stops the
 * simplest obfuscation from walking past the wordlist.
 *
 * A `null` body (a rating-only review, which this spec allows) has nothing to evaluate and produces
 * no text signals; the history signals still apply, because a burst of empty 1-star ratings is
 * exactly the manipulation pattern master §52 names.
 */
export function evaluateReviewSignals(text: string | null, history: ReviewHistoryCounts = NO_HISTORY): ReviewSignalResult {
  const codes: ReviewSignalCode[] = [];

  if (text !== null) {
    if (hasProfanity(text)) codes.push('profanity');
    // Spec 019's pattern set, reused unchanged — one pattern set for the whole platform, exactly
    // as spec 025 reuses it. Contact details in a public review are both a privacy leak and the
    // standard off-platform solicitation.
    if (redactContactInfo(text).count > 0) codes.push('contact_sharing');
    if (hasSpamShape(text)) codes.push('spam_shape');
  }

  if (history.authorRecentReviews >= BURST_SUBMISSION_THRESHOLD) codes.push('burst_submission');
  if (history.pairRecentReviews >= REPEAT_PAIR_THRESHOLD) codes.push('repeat_pair');

  return { codes };
}

function hasProfanity(text: string): boolean {
  for (const token of fold(text).match(TOKEN_PATTERN) ?? []) {
    if (FOLDED_PROFANITY.has(token)) return true;
  }
  return false;
}

/**
 * Structural properties only — length, repetition, character classes and link count. Nothing here
 * inspects meaning or tone, so a furious, articulate one-star review passes cleanly (AC-5).
 */
function hasSpamShape(text: string): boolean {
  if ((text.match(URL_PATTERN) ?? []).length >= SPAM_URL_THRESHOLD) return true;

  const tokens = fold(text).match(TOKEN_PATTERN) ?? [];
  if (tokens.length > 0) {
    const counts = new Map<string, number>();
    for (const token of tokens) {
      const next = (counts.get(token) ?? 0) + 1;
      if (next >= SPAM_REPEAT_THRESHOLD) return true;
      counts.set(token, next);
    }
  }

  if (text.length >= SPAM_RATIO_MIN_LENGTH) {
    let alphabetic = 0;
    for (const character of text) if (ALPHABETIC_PATTERN.test(character)) alphabetic += 1;
    if (1 - alphabetic / text.length >= SPAM_NON_ALPHABETIC_RATIO) return true;
  }

  return false;
}
