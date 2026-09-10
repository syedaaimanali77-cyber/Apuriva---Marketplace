import { describe, expect, it } from 'vitest';
import { isWithinServiceArea } from './service-area';

describe('lib/location/service-area (spec 012 AC-5)', () => {
  const lahoreCenter = { latitude: 31.5204, longitude: 74.3587 };

  it('a request inside the declared radius is within the service area', () => {
    const nearby = { latitude: 31.53, longitude: 74.36 };
    const area = { kind: 'radius' as const, center: lahoreCenter, radiusMeters: 20_000 };
    expect(isWithinServiceArea({ point: nearby }, area)).toBe(true);
  });

  it('AC-5: a request originating outside the declared radius is excluded', () => {
    const karachi = { latitude: 24.8607, longitude: 67.0011 };
    const area = { kind: 'radius' as const, center: lahoreCenter, radiusMeters: 20_000 };
    expect(isWithinServiceArea({ point: karachi }, area)).toBe(false);
  });

  it('a request whose city matches a declared city list is within the service area', () => {
    const area = { kind: 'cities' as const, cities: ['Lahore', 'Islamabad'] };
    expect(isWithinServiceArea({ point: lahoreCenter, city: 'lahore' }, area)).toBe(true);
  });

  it('AC-5: a request whose city is not in the declared city list is excluded', () => {
    const area = { kind: 'cities' as const, cities: ['Lahore', 'Islamabad'] };
    expect(isWithinServiceArea({ point: lahoreCenter, city: 'Karachi' }, area)).toBe(false);
  });

  it('a city-based area excludes a candidate with no city information', () => {
    const area = { kind: 'cities' as const, cities: ['Lahore'] };
    expect(isWithinServiceArea({ point: lahoreCenter }, area)).toBe(false);
  });
});
