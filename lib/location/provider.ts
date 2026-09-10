import { createHash } from 'node:crypto';
import type { StructuredAddress } from '@/lib/types/location';
import type { GeoPoint } from './geo';

/**
 * Maps/geocoding vendor adapter — spec 012 AC-6. No real vendor credentials exist in this
 * environment (§8 risk #1, open), so — mirroring the OAuth/SMS-OTP adapter pattern
 * (lib/auth/oauth-provider.ts, lib/auth/sms-otp-provider.ts) — this ships behind a swappable
 * interface with only a sandbox/mock implementation for now, per master spec §133.7. A real
 * vendor (Google Maps, Mapbox, HERE, or a Pakistan-capable alternative) is a later, separate
 * implementation of this same interface; no business logic outside `lib/location` calls the
 * vendor directly or holds its credentials.
 */
export interface GeocodeResult extends GeoPoint {
  structured: StructuredAddress;
}

export interface LocationProvider {
  geocode(address: string): Promise<GeocodeResult>;
  reverseGeocode(point: GeoPoint): Promise<GeocodeResult>;
}

export class GeocodingFailedError extends Error {}

/**
 * Sandbox implementation: never calls out to a real vendor. Derives a stable, deterministic
 * point/address from the input string/coordinates so the same input always resolves the same
 * way — good enough for tests/dev tooling without needing a real maps API key. An address
 * containing "unresolvable" simulates a vendor lookup failure (AC per §3 `GEOCODING_FAILED`).
 */
class SandboxLocationProvider implements LocationProvider {
  async geocode(address: string): Promise<GeocodeResult> {
    const trimmed = address.trim();
    if (trimmed.length === 0 || /unresolvable/i.test(trimmed)) {
      throw new GeocodingFailedError(`Could not resolve address: "${address}"`);
    }

    const hash = createHash('sha256').update(trimmed.toLowerCase()).digest();
    // Deterministic pseudo-coordinates within valid ranges, derived from the address text.
    const latitude = (hash.readUInt32BE(0) / 0xffffffff) * 180 - 90;
    const longitude = (hash.readUInt32BE(4) / 0xffffffff) * 360 - 180;

    return {
      latitude,
      longitude,
      structured: {
        line1: trimmed,
        area: 'Sandbox Area',
        city: 'Sandbox City',
        country: 'Sandbox Country',
      },
    };
  }

  async reverseGeocode(point: GeoPoint): Promise<GeocodeResult> {
    return {
      latitude: point.latitude,
      longitude: point.longitude,
      structured: {
        line1: `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
        area: 'Sandbox Area',
        city: 'Sandbox City',
        country: 'Sandbox Country',
      },
    };
  }
}

const sandboxProvider = new SandboxLocationProvider();

/** Only the sandbox is wired up for now (§8 risk #1) — swap this factory when a real vendor ships. */
export function getLocationProvider(): LocationProvider {
  return sandboxProvider;
}
