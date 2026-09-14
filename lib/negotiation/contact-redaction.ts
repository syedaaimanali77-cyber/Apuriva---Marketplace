/**
 * Spec 019 §3 "Contact redaction" (AC-7). PURE — no I/O, no logging — so every rule is unit-tested.
 *
 * Applied BEFORE storage to message bodies, change-request notes, and offer/revision `providerMessage`
 * and `includedItems`. The unredacted input is never persisted or logged by any caller. Deliberately
 * conservative (master spec §54: do not aggressively block legitimate service information): only email
 * addresses and phone-number-like runs of ≥ 10 digits are replaced, and nothing is ever blocked.
 */

export const CONTACT_PLACEHOLDER = '[contact removed]';

/** A run of this many digits or more is treated as a phone number. */
export const MIN_PHONE_DIGITS = 10;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * A maximal run starting with an optional `+` or `(` and a digit, of Unicode decimal digits (`\p{Nd}`, so
 * Urdu/Arabic-Indic digits count) separated only by at most 2 characters from space, `-`, `.`, `(`, `)`.
 * Commas, `/` and `:` are not separators, so prices ("3,500"), dates ("12/05/2026") and times ("10:30")
 * never join into one run.
 */
const PHONE_CANDIDATE_PATTERN = /[+(]?\p{Nd}(?:[ \-.()]{0,2}\p{Nd})+\)?/gu;
const DIGIT_PATTERN = /\p{Nd}/gu;

export interface RedactionResult {
  text: string;
  redacted: boolean;
  /** How many placeholders were inserted. */
  count: number;
}

export function redactContactInfo(input: string): RedactionResult {
  let count = 0;
  const withoutEmails = input.replace(EMAIL_PATTERN, () => {
    count += 1;
    return CONTACT_PLACEHOLDER;
  });
  const text = withoutEmails.replace(PHONE_CANDIDATE_PATTERN, (run) => {
    const digits = run.match(DIGIT_PATTERN)?.length ?? 0;
    if (digits < MIN_PHONE_DIGITS) return run;
    count += 1;
    return CONTACT_PLACEHOLDER;
  });
  return { text, redacted: count > 0, count };
}

/** Redacts an optional free-text field, keeping `null` as `null`. */
export function redactOptional(input: string | null): { text: string | null; count: number } {
  if (input === null) return { text: null, count: 0 };
  const result = redactContactInfo(input);
  return { text: result.text, count: result.count };
}

/** Redacts each item of a list independently, preserving order. */
export function redactItems(items: string[]): { items: string[]; count: number } {
  let count = 0;
  const redacted = items.map((item) => {
    const result = redactContactInfo(item);
    count += result.count;
    return result.text;
  });
  return { items: redacted, count };
}
