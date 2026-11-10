/**
 * Fixed-point degree <-> micro-degree conversion and great-circle distance — spec 012 §4.
 * Coordinates are stored as `*_micro_degrees integer` (degrees x 1,000,000), never
 * numeric/float/double (schema-lint AC-1 bans float types schema-wide), so every DB boundary
 * converts through these two functions rather than storing a raw float.
 */
const MICRO_DEGREES_PER_DEGREE = 1_000_000;
const EARTH_RADIUS_METERS = 6_371_000;

export function toMicroDegrees(degrees: number): number {
  return Math.round(degrees * MICRO_DEGREES_PER_DEGREE);
}

export function fromMicroDegrees(microDegrees: number): number {
  return microDegrees / MICRO_DEGREES_PER_DEGREE;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Haversine great-circle distance between two points, in meters. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
