import type { AddressDto, GeocodeResultDto, StructuredAddress } from '@/lib/types/location';
import type { GeoPoint } from './geo';

/**
 * Exact-location stripping — spec 012 §3/AC-3/AC-4. The single place `latitude`/`longitude` and
 * street-level `structured.line1` are stripped for a caller not authorized for exact location:
 * a pre-booking customer view of a provider, or any provider other than the one assigned to a
 * booking. Stripping only lat/lng is not enough — an unredacted `line1` still discloses exact
 * location without coordinates — so both are gated by the same `authorized` boolean.
 *
 * This module only implements the gate itself; deciding what `authorized` is for a given caller
 * (is this the assigned provider on a confirmed booking? has the customer selected this provider
 * yet?) is the calling spec's job — spec 020 (booking) owns the FK that would answer that
 * question for AC-4 today (see spec 012 §4/§8 risk #2). `lib/location` supplies the primitive,
 * not the cross-entity authorization lookup.
 */

export function approxAreaLabel(structured: Pick<StructuredAddress, 'area' | 'city'>): string {
  return [structured.area, structured.city].filter((part) => part && part.trim().length > 0).join(', ');
}

/** AC-3/AC-4: an unauthorized caller receives only area/city/country + the approx label. */
export function toGeocodeResultDto(point: GeoPoint, structured: StructuredAddress, authorized: boolean): GeocodeResultDto {
  const label = approxAreaLabel(structured);

  if (!authorized) {
    return {
      structured: { area: structured.area, city: structured.city, country: structured.country },
      approxAreaLabel: label,
    };
  }

  return {
    structured,
    latitude: point.latitude,
    longitude: point.longitude,
    approxAreaLabel: label,
  };
}

export function toAddressDto(
  saved: { id: string; label: string; isDefault: boolean },
  point: GeoPoint,
  structured: StructuredAddress,
  authorized: boolean,
): AddressDto {
  return {
    id: saved.id,
    label: saved.label,
    isDefault: saved.isDefault,
    ...toGeocodeResultDto(point, structured, authorized),
  };
}
