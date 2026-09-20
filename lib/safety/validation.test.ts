/**
 * Spec 030 §6 "Unit" — parsing, normalization and bounds. PURE: no database.
 *
 * The assertion that carries the most weight is the last block: a create request has no `priority`
 * field at all, so a reporter cannot set their own triage level and no rule can derive one
 * (DECIDED-1).
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeSafetyText,
  parseCreateBlockRequest,
  parseCreateSafetyReportRequest,
  parseSetPriorityRequest,
  parseTransitionRequest,
} from './validation';
import { MAX_DESCRIPTION_LENGTH, MIN_DESCRIPTION_LENGTH } from './limits';

const TARGET = '11111111-1111-1111-1111-111111111111';
const BOOKING = '22222222-2222-2222-2222-222222222222';
const GOOD_DESCRIPTION = 'They shouted at me and refused to leave the property.';

describe('spec 030 normalization', () => {
  it('collapses CRLF and trims', () => {
    expect(normalizeSafetyText('  line one\r\nline two  ')).toBe('line one\nline two');
  });

  it('strips zero-width and bidi-override characters, so a stored record cannot carry a trick', () => {
    expect(normalizeSafetyText('a​b‮c')).toBe('abc');
  });

  it('collapses three or more newlines to two', () => {
    expect(normalizeSafetyText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('returns null for blank or whitespace-only input', () => {
    expect(normalizeSafetyText('   \n  ')).toBeNull();
    expect(normalizeSafetyText('')).toBeNull();
  });

  it('applies NFC so two encodings of the same text normalize identically', () => {
    expect(normalizeSafetyText('é')).toBe(normalizeSafetyText('é'));
  });
});

describe('parseCreateBlockRequest', () => {
  it('accepts a uuid target', () => {
    expect(parseCreateBlockRequest({ targetUserId: TARGET })).toEqual({ targetUserId: TARGET });
  });

  it('rejects a missing or malformed target', () => {
    expect(() => parseCreateBlockRequest({})).toThrowError();
    expect(() => parseCreateBlockRequest({ targetUserId: 'nope' })).toThrowError();
  });
});

describe('parseCreateSafetyReportRequest', () => {
  it('accepts a complete body and normalizes the description', () => {
    const parsed = parseCreateSafetyReportRequest({
      targetUserId: TARGET,
      category: 'harassment',
      description: `  ${GOOD_DESCRIPTION}  `,
      bookingId: BOOKING,
    });
    expect(parsed).toEqual({
      targetUserId: TARGET,
      category: 'harassment',
      description: GOOD_DESCRIPTION,
      bookingId: BOOKING,
    });
  });

  it('treats bookingId as optional', () => {
    const parsed = parseCreateSafetyReportRequest({
      targetUserId: TARGET,
      category: 'other',
      description: GOOD_DESCRIPTION,
    });
    expect(parsed.bookingId).toBeNull();
  });

  it('rejects an unknown category', () => {
    expect(() =>
      parseCreateSafetyReportRequest({ targetUserId: TARGET, category: 'nonsense', description: GOOD_DESCRIPTION }),
    ).toThrowError();
  });

  it('enforces the description bounds AFTER normalization', () => {
    expect(() =>
      parseCreateSafetyReportRequest({ targetUserId: TARGET, category: 'other', description: 'short' }),
    ).toThrowError();

    expect(() =>
      parseCreateSafetyReportRequest({
        targetUserId: TARGET,
        category: 'other',
        description: 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1),
      }),
    ).toThrowError();

    // Exactly at the minimum, once whitespace is stripped.
    const atMinimum = parseCreateSafetyReportRequest({
      targetUserId: TARGET,
      category: 'other',
      description: `   ${'a'.repeat(MIN_DESCRIPTION_LENGTH)}   `,
    });
    expect(atMinimum.description).toHaveLength(MIN_DESCRIPTION_LENGTH);
  });

  describe('DECIDED-1: a reporter cannot influence triage', () => {
    it('ignores a priority supplied in the body — the parsed result has no such field', () => {
      const parsed = parseCreateSafetyReportRequest({
        targetUserId: TARGET,
        category: 'threat',
        description: GOOD_DESCRIPTION,
        priority: 'critical',
      } as Record<string, unknown>);

      expect(parsed).not.toHaveProperty('priority');
      expect(Object.keys(parsed).sort()).toEqual(['bookingId', 'category', 'description', 'targetUserId']);
    });
  });
});

describe('parseTransitionRequest', () => {
  it('requires expectedStatus always', () => {
    expect(() => parseTransitionRequest({ reason: 'A sufficiently long reason here.' }, true)).toThrowError();
  });

  it('requires a bounded reason when the caller says one is required', () => {
    expect(() => parseTransitionRequest({ expectedStatus: 'submitted' }, true)).toThrowError();
    expect(() => parseTransitionRequest({ expectedStatus: 'submitted', reason: 'too short' }, true)).toThrowError();
  });

  it('allows an absent reason when one is not required, as for a claim', () => {
    expect(parseTransitionRequest({ expectedStatus: 'submitted' }, false)).toEqual({
      reason: null,
      expectedStatus: 'submitted',
      requestRestriction: false,
    });
  });

  it('defaults requestRestriction to false, so a restriction is never requested by omission', () => {
    const parsed = parseTransitionRequest({ expectedStatus: 'submitted', reason: 'A sufficiently long reason.' }, true);
    expect(parsed.requestRestriction).toBe(false);
  });

  it('carries an explicit requestRestriction through', () => {
    const parsed = parseTransitionRequest(
      { expectedStatus: 'submitted', reason: 'A sufficiently long reason.', requestRestriction: true },
      true,
    );
    expect(parsed.requestRestriction).toBe(true);
  });

  it('rejects a non-boolean requestRestriction rather than coercing it', () => {
    expect(() =>
      parseTransitionRequest(
        { expectedStatus: 'submitted', reason: 'A sufficiently long reason.', requestRestriction: 'yes' },
        true,
      ),
    ).toThrowError();
  });
});

describe('parseSetPriorityRequest', () => {
  it('accepts a valid priority and expectedStatus', () => {
    expect(parseSetPriorityRequest({ priority: 'critical', expectedStatus: 'submitted' })).toEqual({
      priority: 'critical',
      expectedStatus: 'submitted',
    });
  });

  it('rejects a priority outside the closed set', () => {
    expect(() => parseSetPriorityRequest({ priority: 'urgent', expectedStatus: 'submitted' })).toThrowError();
  });
});
