import { describe, expect, it } from 'vitest';
import { approxDistanceLabel } from './distance';

describe('lib/search/distance (spec 013 §3 privacy-safe approxDistance)', () => {
  const origin = { latitude: 31.5204, longitude: 74.3587 };

  it('buckets a very close point as "Under 1 km"', () => {
    expect(approxDistanceLabel(origin, { latitude: 31.5214, longitude: 74.3587 })).toBe('Under 1 km');
  });

  it('buckets a mid-range point as "1-5 km"', () => {
    expect(approxDistanceLabel(origin, { latitude: 31.55, longitude: 74.3587 })).toBe('1-5 km');
  });

  it('buckets a far point as "10+ km"', () => {
    const karachi = { latitude: 24.8607, longitude: 67.0011 };
    expect(approxDistanceLabel(origin, karachi)).toBe('10+ km');
  });

  it('never returns a raw numeric distance', () => {
    const label = approxDistanceLabel(origin, { latitude: 31.53, longitude: 74.37 });
    expect(label).not.toMatch(/\d+\.\d+/); // no precise decimal figure
  });
});
