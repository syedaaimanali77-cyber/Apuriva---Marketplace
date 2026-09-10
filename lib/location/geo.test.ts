import { describe, expect, it } from 'vitest';
import { distanceMeters, fromMicroDegrees, isValidLatitude, isValidLongitude, toMicroDegrees } from './geo';

describe('lib/location/geo (spec 012 §4 fixed-point coordinates)', () => {
  it('round-trips degrees through micro-degrees at six decimal places of precision', () => {
    expect(toMicroDegrees(24.860735)).toBe(24_860_735);
    expect(fromMicroDegrees(24_860_735)).toBeCloseTo(24.860735, 6);
    expect(fromMicroDegrees(toMicroDegrees(-33.865143))).toBeCloseTo(-33.865143, 6);
  });

  it('computes zero distance between identical points', () => {
    const point = { latitude: 31.5204, longitude: 74.3587 };
    expect(distanceMeters(point, point)).toBe(0);
  });

  it('computes a plausible great-circle distance between two known cities', () => {
    // Lahore to Karachi is roughly 1000-1050km as the crow flies.
    const lahore = { latitude: 31.5204, longitude: 74.3587 };
    const karachi = { latitude: 24.8607, longitude: 67.0011 };
    const meters = distanceMeters(lahore, karachi);
    expect(meters).toBeGreaterThan(1_000_000);
    expect(meters).toBeLessThan(1_060_000);
  });

  it('validates latitude/longitude ranges', () => {
    expect(isValidLatitude(90)).toBe(true);
    expect(isValidLatitude(-90)).toBe(true);
    expect(isValidLatitude(90.1)).toBe(false);
    expect(isValidLatitude(Number.NaN)).toBe(false);
    expect(isValidLongitude(180)).toBe(true);
    expect(isValidLongitude(-180)).toBe(true);
    expect(isValidLongitude(180.1)).toBe(false);
  });
});
