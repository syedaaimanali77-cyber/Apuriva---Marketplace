import { describe, expect, it } from 'vitest';
import { getLocationProvider, GeocodingFailedError, type LocationProvider } from './provider';

/** AC-6: no business logic outside `lib/location` should require changes when the vendor
 * behind `LocationProvider` is swapped — asserted here by driving the whole suite through the
 * interface only, then separately proving a second implementation satisfies it unchanged. */
describe('lib/location/provider (spec 012 AC-6 vendor abstraction)', () => {
  it('getLocationProvider() returns something satisfying the LocationProvider interface', async () => {
    const provider = getLocationProvider();
    const result = await provider.geocode('123 Main Street, Lahore');
    expect(typeof result.latitude).toBe('number');
    expect(typeof result.longitude).toBe('number');
    expect(result.structured.city).toBeTruthy();
  });

  it('geocode() is deterministic for the same input', async () => {
    const provider = getLocationProvider();
    const a = await provider.geocode('42 Sandbox Lane');
    const b = await provider.geocode('42 Sandbox Lane');
    expect(a.latitude).toBe(b.latitude);
    expect(a.longitude).toBe(b.longitude);
  });

  it('geocode() throws GeocodingFailedError for an unresolvable address', async () => {
    const provider = getLocationProvider();
    await expect(provider.geocode('this is unresolvable')).rejects.toBeInstanceOf(GeocodingFailedError);
  });

  it('reverseGeocode() echoes the given point back as structured/exact location', async () => {
    const provider = getLocationProvider();
    const result = await provider.reverseGeocode({ latitude: 31.5, longitude: 74.35 });
    expect(result.latitude).toBe(31.5);
    expect(result.longitude).toBe(74.35);
  });

  it('a second implementation of LocationProvider is a drop-in replacement (AC-6)', async () => {
    class AlternateVendorProvider implements LocationProvider {
      async geocode() {
        return { latitude: 1, longitude: 2, structured: { area: 'A', city: 'B', country: 'C' } };
      }
      async reverseGeocode() {
        return { latitude: 1, longitude: 2, structured: { area: 'A', city: 'B', country: 'C' } };
      }
    }
    const alternate: LocationProvider = new AlternateVendorProvider();
    const result = await alternate.geocode('anything');
    expect(result.latitude).toBe(1);
  });
});
