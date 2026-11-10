import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { isUuid, validateCreateOfferBody } from './validation';
import { formatMinorUnits, parseMajorAmountToMinorUnits } from './price-input';

const REQUEST_ID = '6f1f5d2e-5d3a-4b7c-9a52-1c2b3d4e5f60';
const VALID = { requestId: REQUEST_ID, priceAmountMinorUnits: 320_000, currencyCode: 'PKR' };

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiRouteError);
    expect((err as ApiRouteError).code).toBe('VALIDATION_ERROR');
    return ((err as ApiRouteError).errors ?? []).map((e) => e.field);
  }
  throw new Error('expected VALIDATION_ERROR');
}

describe('lib/offers/validation (spec 018 §3 creation rule 2)', () => {
  it('accepts a minimal valid body and normalizes optional fields', () => {
    expect(validateCreateOfferBody(VALID)).toEqual({
      ...VALID,
      includedItems: [],
      providerMessage: null,
      estimatedDurationMinutes: null,
    });
  });

  it('AC-7: ignores client-supplied sentAt/expiresAt/status — they are never extracted', () => {
    const result = validateCreateOfferBody({
      ...VALID,
      sentAt: '2000-01-01T00:00:00Z',
      expiresAt: '2999-01-01T00:00:00Z',
      status: 'accepted',
      windowMinutes: 60,
    });
    expect(Object.keys(result).sort()).toEqual(
      ['currencyCode', 'estimatedDurationMinutes', 'includedItems', 'priceAmountMinorUnits', 'providerMessage', 'requestId'].sort(),
    );
  });

  it('price must be a positive integer ≤ 2_147_483_647 (never a float)', () => {
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, priceAmountMinorUnits: 0 }))).toContain('priceAmountMinorUnits');
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, priceAmountMinorUnits: 10.5 }))).toContain('priceAmountMinorUnits');
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, priceAmountMinorUnits: 2_147_483_648 }))).toContain('priceAmountMinorUnits');
    expect(validateCreateOfferBody({ ...VALID, priceAmountMinorUnits: 2_147_483_647 }).priceAmountMinorUnits).toBe(2_147_483_647);
  });

  it('currency must be three uppercase letters', () => {
    for (const bad of ['pkr', 'PK', 'PKRR', '', 12]) {
      expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, currencyCode: bad }))).toContain('currencyCode');
    }
  });

  it('requestId must be a uuid', () => {
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, requestId: 'nope' }))).toContain('requestId');
    expect(isUuid(REQUEST_ID)).toBe(true);
  });

  it('includedItems: at most 20, each trimmed 1–200 characters', () => {
    expect(validateCreateOfferBody({ ...VALID, includedItems: ['  Parts  ', 'Labour'] }).includedItems).toEqual(['Parts', 'Labour']);
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, includedItems: Array(21).fill('x') }))).toContain('includedItems');
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, includedItems: ['   '] }))).toContain('includedItems[0]');
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, includedItems: ['x'.repeat(201)] }))).toContain('includedItems[0]');
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, includedItems: 'Parts' }))).toContain('includedItems');
  });

  it('providerMessage: ≤ 1000 chars, trimmed, empty stored as null', () => {
    expect(validateCreateOfferBody({ ...VALID, providerMessage: '   ' }).providerMessage).toBeNull();
    expect(validateCreateOfferBody({ ...VALID, providerMessage: ' Hi ' }).providerMessage).toBe('Hi');
    expect(validateCreateOfferBody({ ...VALID, providerMessage: 'x'.repeat(1000) }).providerMessage).toHaveLength(1000);
    expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, providerMessage: 'x'.repeat(1001) }))).toContain('providerMessage');
  });

  it('estimatedDurationMinutes: integer 1–1440', () => {
    expect(validateCreateOfferBody({ ...VALID, estimatedDurationMinutes: 1440 }).estimatedDurationMinutes).toBe(1440);
    for (const bad of [0, 1441, 1.5, '60']) {
      expect(fieldsOf(() => validateCreateOfferBody({ ...VALID, estimatedDurationMinutes: bad }))).toContain('estimatedDurationMinutes');
    }
  });

  it('reports every invalid field at once', () => {
    expect(fieldsOf(() => validateCreateOfferBody({})).sort()).toEqual(['currencyCode', 'priceAmountMinorUnits', 'requestId']);
  });
});

describe('lib/offers/price-input (spec 018 §5, integer arithmetic only)', () => {
  it('parses whole and two-decimal amounts into minor units', () => {
    expect(parseMajorAmountToMinorUnits('3200')).toBe(320_000);
    expect(parseMajorAmountToMinorUnits('3200.5')).toBe(320_050);
    expect(parseMajorAmountToMinorUnits(' 0.01 ')).toBe(1);
  });

  it('rejects zero, negatives, three decimals and non-numbers', () => {
    for (const bad of ['0', '-5', '1.234', 'abc', '', '1e3']) expect(parseMajorAmountToMinorUnits(bad)).toBeNull();
  });

  it('formats minor units back for display', () => {
    expect(formatMinorUnits(320_050)).toBe('3200.50');
  });
});
