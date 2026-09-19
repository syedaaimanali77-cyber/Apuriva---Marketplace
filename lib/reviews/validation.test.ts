/**
 * Spec 029 §6 — text normalization and body bounds. Pure; no database.
 */
import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { MAX_TEXT_LENGTH, MIN_TEXT_LENGTH } from './limits';
import {
  normalizeReviewText,
  parseCreateReportRequest,
  parseCreateResponseRequest,
  parseCreateReviewRequest,
  parseResolveReviewRequest,
} from './validation';

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    return ((err as ApiRouteError).errors ?? []).map((e) => e.field);
  }
  throw new Error('expected a validation error');
}

describe('normalizeReviewText', () => {
  it('trims and collapses runs of blank lines', () => {
    expect(normalizeReviewText('  hello\n\n\n\nworld  ')).toBe('hello\n\nworld');
  });

  it('normalizes CRLF and lone CR to LF', () => {
    expect(normalizeReviewText('one\r\ntwo\rthree')).toBe('one\ntwo\nthree');
  });

  it('strips control, zero-width and bidi-override characters', () => {
    // These are how a homograph or right-to-left-override trick reaches a public surface.
    expect(normalizeReviewText('cle​an‮text')).toBe('cleantext');
  });

  it('treats a whitespace-only body as no body at all', () => {
    expect(normalizeReviewText('   \n\t  ')).toBeNull();
    expect(normalizeReviewText('')).toBeNull();
  });
});

describe('parseCreateReviewRequest', () => {
  it('accepts a rating-only review — text is optional', () => {
    expect(parseCreateReviewRequest({ rating: 4 })).toEqual({ rating: 4, text: null, mediaFileAssetIds: [] });
  });

  it('accepts a whitespace-only text as null rather than rejecting it', () => {
    expect(parseCreateReviewRequest({ rating: 3, text: '    ' }).text).toBeNull();
  });

  it('rejects a rating outside 1..5, a fractional rating and a missing one', () => {
    expect(fieldsOf(() => parseCreateReviewRequest({ rating: 0 }))).toEqual(['rating']);
    expect(fieldsOf(() => parseCreateReviewRequest({ rating: 6 }))).toEqual(['rating']);
    expect(fieldsOf(() => parseCreateReviewRequest({ rating: 4.5 }))).toEqual(['rating']);
    expect(fieldsOf(() => parseCreateReviewRequest({}))).toEqual(['rating']);
  });

  it('rejects text below the minimum and above the maximum, measured AFTER normalization', () => {
    expect(fieldsOf(() => parseCreateReviewRequest({ rating: 5, text: 'a'.repeat(MIN_TEXT_LENGTH - 1) }))).toEqual(['text']);
    expect(fieldsOf(() => parseCreateReviewRequest({ rating: 5, text: 'a'.repeat(MAX_TEXT_LENGTH + 1) }))).toEqual(['text']);
    // Exactly at the bound, with padding that normalization removes: accepted.
    expect(parseCreateReviewRequest({ rating: 5, text: `  ${'a'.repeat(MIN_TEXT_LENGTH)}  ` }).text).toHaveLength(
      MIN_TEXT_LENGTH,
    );
  });

  it('collapses duplicate media ids so a repeat is not mistaken for exceeding the cap', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(parseCreateReviewRequest({ rating: 5, mediaFileAssetIds: [id, id] }).mediaFileAssetIds).toEqual([id]);
  });

  it('rejects more than five photos and non-uuid ids', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `1111111${i}-1111-4111-8111-111111111111`);
    expect(fieldsOf(() => parseCreateReviewRequest({ rating: 5, mediaFileAssetIds: ids }))).toEqual(['mediaFileAssetIds']);
    expect(fieldsOf(() => parseCreateReviewRequest({ rating: 5, mediaFileAssetIds: ['nope'] }))).toEqual([
      'mediaFileAssetIds',
    ]);
  });
});

describe('parseCreateResponseRequest', () => {
  it('requires text — a reply with no words says nothing', () => {
    expect(fieldsOf(() => parseCreateResponseRequest({}))).toEqual(['text']);
    expect(fieldsOf(() => parseCreateResponseRequest({ text: '   ' }))).toEqual(['text']);
  });

  it('accepts a normalized body inside the bounds', () => {
    expect(parseCreateResponseRequest({ text: '  thanks for the feedback  ' })).toEqual({
      text: 'thanks for the feedback',
    });
  });
});

describe('parseCreateReportRequest', () => {
  it('requires a reason from the closed set', () => {
    expect(fieldsOf(() => parseCreateReportRequest({ reason: 'because' }))).toEqual(['reason']);
  });

  it("requires details when the reason is 'other'", () => {
    expect(fieldsOf(() => parseCreateReportRequest({ reason: 'other' }))).toEqual(['details']);
    expect(parseCreateReportRequest({ reason: 'other', details: 'it names my home address' }).details).toBe(
      'it names my home address',
    );
  });

  it('allows details to be omitted for every other reason', () => {
    expect(parseCreateReportRequest({ reason: 'spam' })).toEqual({ reason: 'spam', details: null });
  });
});

describe('parseResolveReviewRequest', () => {
  it('requires a decision from the closed set, a reason and an expectedStatus', () => {
    expect(fieldsOf(() => parseResolveReviewRequest({}))).toEqual(['decision', 'reason', 'expectedStatus']);
    expect(fieldsOf(() => parseResolveReviewRequest({ decision: 'nuke', reason: 'a'.repeat(20), expectedStatus: 'published' }))).toEqual(
      ['decision'],
    );
  });

  it('rejects a reason shorter than the minimum — master §68 requires a real one', () => {
    expect(
      fieldsOf(() => parseResolveReviewRequest({ decision: 'remove', reason: 'nope', expectedStatus: 'flagged' })),
    ).toEqual(['reason']);
  });

  it('accepts a complete decision', () => {
    expect(
      parseResolveReviewRequest({ decision: 'remove', reason: 'Contains a home address.', expectedStatus: 'flagged' }),
    ).toEqual({ decision: 'remove', reason: 'Contains a home address.', expectedStatus: 'flagged' });
  });
});
