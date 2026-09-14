import { describe, expect, it } from 'vitest';
import { MAX_PRICE_MINOR_UNITS } from '@/lib/offers/validation';
import { CHANGE_REQUEST_NOTE_MAX_LENGTH, MESSAGE_BODY_MAX_LENGTH } from './limits';
import { validateChangeRequestBody, validateMessageBody } from './validation';

const validation = expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 });

/** Spec 019 §3 — bounds are measured on the trimmed INPUT, before contact redaction. */
describe('negotiation body validation (spec 019 §3)', () => {
  it('accepts and trims a message body', () => {
    expect(validateMessageBody({ body: '  Is the AC on the second floor?  ' })).toBe('Is the AC on the second floor?');
    expect(validateMessageBody({ body: 'x'.repeat(MESSAGE_BODY_MAX_LENGTH) })).toHaveLength(MESSAGE_BODY_MAX_LENGTH);
  });

  it('rejects an empty, whitespace-only, overlong or non-string message body', () => {
    for (const body of ['', '   ', 'x'.repeat(MESSAGE_BODY_MAX_LENGTH + 1), 42, null, undefined]) {
      expect(() => validateMessageBody({ body })).toThrowError(validation);
    }
    expect(() => validateMessageBody(null)).toThrowError(validation);
    expect(() => validateMessageBody('a string body')).toThrowError(validation);
  });

  it('names the offending field', () => {
    try {
      validateMessageBody({ body: '' });
      throw new Error('expected a validation error');
    } catch (err) {
      expect((err as { errors?: { field: string }[] }).errors).toContainEqual(expect.objectContaining({ field: 'body' }));
    }
  });

  it('accepts a change request with an optional proposed price', () => {
    expect(validateChangeRequestBody({ note: '  Can you do it Sunday?  ' })).toEqual({
      note: 'Can you do it Sunday?',
      proposedPriceAmountMinorUnits: null,
    });
    expect(validateChangeRequestBody({ note: 'Cheaper please', proposedPriceAmountMinorUnits: 250_000 })).toEqual({
      note: 'Cheaper please',
      proposedPriceAmountMinorUnits: 250_000,
    });
    expect(validateChangeRequestBody({ note: 'ok', proposedPriceAmountMinorUnits: null }).proposedPriceAmountMinorUnits).toBeNull();
  });

  it('rejects a bad note or a non-positive/float/oversized proposed price', () => {
    expect(() => validateChangeRequestBody({ note: '' })).toThrowError(validation);
    expect(() => validateChangeRequestBody({ note: 'x'.repeat(CHANGE_REQUEST_NOTE_MAX_LENGTH + 1) })).toThrowError(validation);
    for (const price of [0, -1, 1.5, MAX_PRICE_MINOR_UNITS + 1, '100']) {
      expect(() => validateChangeRequestBody({ note: 'ok', proposedPriceAmountMinorUnits: price })).toThrowError(validation);
    }
  });

  it('ignores unknown fields rather than storing them', () => {
    expect(validateChangeRequestBody({ note: 'ok', status: 'accepted', offerId: 'x' })).toEqual({
      note: 'ok',
      proposedPriceAmountMinorUnits: null,
    });
  });
});
