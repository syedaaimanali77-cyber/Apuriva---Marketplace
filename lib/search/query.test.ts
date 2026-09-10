import { describe, expect, it } from 'vitest';
import { validateSearchParams } from './query';

describe('lib/search/query validateSearchParams (spec 013 §3)', () => {
  it('accepts an empty params object', () => {
    expect(() => validateSearchParams({})).not.toThrow();
  });

  it('accepts a fully valid params object', () => {
    expect(() =>
      validateSearchParams({ q: 'plumber', lat: 31.5, lng: 74.3, radiusKm: 10, budgetMaxMinorUnits: 500000, sort: 'distance' }),
    ).not.toThrow();
  });

  it('rejects lat without lng', () => {
    expect(() => validateSearchParams({ lat: 31.5 })).toThrow();
  });

  it('rejects an out-of-range latitude', () => {
    expect(() => validateSearchParams({ lat: 999, lng: 74.3 })).toThrow();
  });

  it('rejects a non-positive radiusKm', () => {
    expect(() => validateSearchParams({ radiusKm: 0 })).toThrow();
  });

  it('rejects a negative budget', () => {
    expect(() => validateSearchParams({ budgetMaxMinorUnits: -1 })).toThrow();
  });

  it('rejects an unsupported sort value', () => {
    expect(() => validateSearchParams({ sort: 'rating' as never })).toThrow();
  });
});
