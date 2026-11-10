/**
 * Spec 029 §6 — the deterministic flag signals (AC-4, AC-5). Pure; no database.
 *
 * The most important test in this file is `signal evaluation receives no rating`: AC-5 says no rule
 * anywhere may derive a flag from the rating, and the way that is guaranteed is that
 * `evaluateReviewSignals` has no parameter through which a rating could arrive.
 */
import { describe, expect, it } from 'vitest';
import { BURST_SUBMISSION_THRESHOLD, REPEAT_PAIR_THRESHOLD } from './limits';
import { evaluateReviewSignals } from './signals';
import { normalizeReviewText } from './validation';

const NONE = { authorRecentReviews: 0, pairRecentReviews: 0 };

describe('evaluateReviewSignals', () => {
  it('returns no codes for ordinary text', () => {
    expect(evaluateReviewSignals('Turned up on time and did a thorough job. Would book again.', NONE).codes).toEqual([]);
  });

  describe('AC-5: a legitimate negative review is never flagged', () => {
    it.each([
      'Terrible. He was two hours late and left the kitchen filthy. I would never book this again.',
      'One star. The work was sloppy, the quote changed halfway through, and nobody apologised.',
      'Awful experience from start to finish. Deeply disappointed and still waiting for a callback.',
      'Did not do what was agreed. Rude when I asked about it. Avoid.',
    ])('leaves %j unflagged', (text) => {
      expect(evaluateReviewSignals(text, NONE).codes).toEqual([]);
    });

    it('receives no rating at all — there is no parameter through which one could arrive', () => {
      // A compile-time guarantee made observable: the function's arity is (text, history) and the
      // history object carries only counts. If a rating were ever added, this test would need
      // changing, which is the point.
      expect(evaluateReviewSignals.length).toBe(1);
      expect(Object.keys(NONE).sort()).toEqual(['authorRecentReviews', 'pairRecentReviews']);
    });
  });

  describe('profanity', () => {
    it('flags a whole-word match, case- and diacritic-insensitively', () => {
      expect(evaluateReviewSignals('This was SHIT work', NONE).codes).toContain('profanity');
      expect(evaluateReviewSignals('what a cünt', NONE).codes).toContain('profanity');
    });

    it('does not flag an ordinary word that merely contains a listed one', () => {
      // Whole-word matching is what keeps a false positive from queuing a human needlessly.
      expect(evaluateReviewSignals('The assassin classic scunthorpe cocktail', NONE).codes).not.toContain('profanity');
    });

    it('sees through zero-width obfuscation, because the caller normalized first', () => {
      expect(evaluateReviewSignals(normalizeReviewText('this is sh​it'), NONE).codes).toContain('profanity');
    });
  });

  describe('contact_sharing', () => {
    it('flags an email address and a phone number using spec 019 patterns', () => {
      expect(evaluateReviewSignals('Email me at bob@example.com for a better deal', NONE).codes).toContain(
        'contact_sharing',
      );
      expect(evaluateReviewSignals('Call me on 0300 1234567 and skip the platform', NONE).codes).toContain(
        'contact_sharing',
      );
    });

    it('does not flag ordinary numbers', () => {
      expect(evaluateReviewSignals('He arrived at 9 and finished by 11, 2 hours total.', NONE).codes).not.toContain(
        'contact_sharing',
      );
    });
  });

  describe('spam_shape', () => {
    it('flags two or more links', () => {
      expect(evaluateReviewSignals('see https://a.example and https://b.example now', NONE).codes).toContain('spam_shape');
    });

    it('does not flag a single link', () => {
      expect(evaluateReviewSignals('Details are on https://example.com if useful.', NONE).codes).not.toContain(
        'spam_shape',
      );
    });

    it('flags a single token repeated ten times', () => {
      expect(evaluateReviewSignals('buy '.repeat(10), NONE).codes).toContain('spam_shape');
    });

    it('flags a long body that is mostly non-letters', () => {
      expect(evaluateReviewSignals('!!!'.repeat(20), NONE).codes).toContain('spam_shape');
    });

    it('does not apply the ratio rule to a short body', () => {
      expect(evaluateReviewSignals('!!!', NONE).codes).not.toContain('spam_shape');
    });
  });

  describe('manipulation signals', () => {
    it('flags a burst of reviews by one author', () => {
      expect(
        evaluateReviewSignals('fine', { authorRecentReviews: BURST_SUBMISSION_THRESHOLD, pairRecentReviews: 0 }).codes,
      ).toContain('burst_submission');
    });

    it('flags repeated reviews of the same provider by the same author', () => {
      expect(
        evaluateReviewSignals('fine', { authorRecentReviews: 0, pairRecentReviews: REPEAT_PAIR_THRESHOLD }).codes,
      ).toContain('repeat_pair');
    });

    it('still applies to a rating-only review, which is the cheapest manipulation shape', () => {
      expect(
        evaluateReviewSignals(null, { authorRecentReviews: BURST_SUBMISSION_THRESHOLD, pairRecentReviews: 0 }).codes,
      ).toEqual(['burst_submission']);
    });

    it('produces no text signals for a rating-only review', () => {
      expect(evaluateReviewSignals(null, NONE).codes).toEqual([]);
    });
  });
});
