import { distanceMeters, type GeoPoint } from './geo';

/**
 * Service-area evaluation primitive — spec 012 §7 "Out of scope": this spec provides the
 * geo/distance primitive a declared provider service area is checked against; it does not own
 * *storing* a provider's declared area. `provider_service_areas` (spec 003 baseline,
 * `lib/db/schema.ts`) still has no radius/cities columns — those are spec 016's
 * (provider-availability-service-areas) to add. Once spec 016 adds them, its code maps its own
 * row shape into one of the `ServiceArea` variants below and calls `isWithinServiceArea` — this
 * module never reads `provider_service_areas` itself.
 */
export type ServiceArea = { kind: 'radius'; center: GeoPoint; radiusMeters: number } | { kind: 'cities'; cities: string[] };

export interface ServiceAreaCandidate {
  point: GeoPoint;
  city?: string;
}

export function isWithinServiceArea(candidate: ServiceAreaCandidate, area: ServiceArea): boolean {
  if (area.kind === 'radius') {
    return distanceMeters(candidate.point, area.center) <= area.radiusMeters;
  }
  if (!candidate.city) return false;
  const normalized = candidate.city.trim().toLowerCase();
  return area.cities.some((city) => city.trim().toLowerCase() === normalized);
}
