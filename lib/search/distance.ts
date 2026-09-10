import { distanceMeters, type GeoPoint } from '@/lib/location/geo';

/**
 * Spec 013 §3: `approxDistance` is a coarse, bucketed label, never a precise figure computed
 * straight from exact coordinates — a precise distance repeated across several queries from
 * different points would let a client triangulate a provider's exact location before booking
 * (spec 012 AC-3). Reuses `lib/location/geo.ts`'s `distanceMeters` rather than a new distance
 * calculation.
 */
export function approxDistanceLabel(from: GeoPoint, to: GeoPoint): string {
  const meters = distanceMeters(from, to);
  const km = meters / 1000;
  if (km < 1) return 'Under 1 km';
  if (km < 5) return '1-5 km';
  if (km < 10) return '5-10 km';
  return '10+ km';
}

export function distanceMetersBetween(from: GeoPoint, to: GeoPoint): number {
  return distanceMeters(from, to);
}
