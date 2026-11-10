/**
 * Spec 016 §3 "Service-area resolution" — rules S1–S5 (master spec §41).
 *
 * This module maps `provider_service_areas` rows into spec 012's existing `ServiceArea` shape and
 * calls its `isWithinServiceArea()` primitive. It never reimplements distance maths — spec 012
 * owns the geo layer and this spec owns the storage and the rules, which is exactly the split
 * spec 012 §7 recorded.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { addresses, locations, providerServiceAreas, providerServices, requests, services } from '@/lib/db/schema';
import { validationError } from '@/lib/api/errors';
import { fromMicroDegrees, type GeoPoint } from '@/lib/location/geo';
import { approxAreaLabel } from '@/lib/location/privacy';
import { isWithinServiceArea, type ServiceArea } from '@/lib/location/service-area';
import { invalidServiceAreaError, type FieldError } from './errors';
import type { ServiceAreaDto, ServiceAreaMode, ServiceAreaRequest, ServiceAreasRequest } from '@/lib/types/availability';
import type { StructuredAddress } from '@/lib/types/location';

/** S5 — the radius bounds the DB CHECK also enforces, expressed in the API's kilometres. */
export const MIN_RADIUS_KM = 1;
export const MAX_RADIUS_KM = 500;
export const MAX_CITIES = 50;

const METERS_PER_KM = 1000;

interface ServiceAreaRow {
  serviceId: string | null;
  mode: ServiceAreaMode;
  radiusMeters: number | null;
  centerAddressId: string | null;
  cities: string[] | null;
}

/** S1 — every configured row for a provider, global row included. */
async function loadServiceAreaRows(providerProfileId: string): Promise<ServiceAreaRow[]> {
  const rows = await getDb()
    .select({
      serviceId: providerServiceAreas.serviceId,
      mode: providerServiceAreas.mode,
      radiusMeters: providerServiceAreas.radiusMeters,
      centerAddressId: providerServiceAreas.centerAddressId,
      cities: providerServiceAreas.cities,
    })
    .from(providerServiceAreas)
    .where(eq(providerServiceAreas.providerProfileId, providerProfileId));
  return rows as ServiceAreaRow[];
}

/** Owner-facing read — carries the centre's approximate area label, never its coordinates. */
export async function listServiceAreas(providerProfileId: string): Promise<ServiceAreaDto[]> {
  const rows = await loadServiceAreaRows(providerProfileId);
  const labels = await loadCenterLabels(rows.map((row) => row.centerAddressId).filter((id): id is string => id !== null));

  return rows.map((row) => ({
    serviceId: row.serviceId,
    mode: row.mode,
    radiusKm: row.radiusMeters === null ? null : row.radiusMeters / METERS_PER_KM,
    centerAddressId: row.centerAddressId,
    centerApproxAreaLabel: row.centerAddressId ? (labels.get(row.centerAddressId) ?? null) : null,
    cities: row.cities,
  }));
}

async function loadCenterLabels(addressIds: string[]): Promise<Map<string, string>> {
  if (addressIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: addresses.id, structured: addresses.structured })
    .from(addresses)
    .where(inArray(addresses.id, addressIds));
  return new Map(rows.map((row) => [row.id, approxAreaLabel(row.structured as StructuredAddress)]));
}

/**
 * S5 — validates the whole submitted set, then replaces it in ONE transaction, so a rejected
 * entry leaves the previous configuration completely untouched.
 */
export async function putServiceAreas(
  providerProfileId: string,
  userId: string,
  body: Partial<ServiceAreasRequest>,
): Promise<ServiceAreaDto[]> {
  if (!Array.isArray(body.areas)) {
    throw validationError([{ field: 'areas', message: 'is required and must be an array.' }]);
  }
  const areas = body.areas as ServiceAreaRequest[];
  const errors: FieldError[] = [];

  // S5 — duplicate serviceId (including two global rows) within one submission.
  const seen = new Set<string>();
  areas.forEach((area, index) => {
    const key = area.serviceId ?? '__global__';
    if (seen.has(key)) {
      errors.push({
        field: `areas[${index}].serviceId`,
        message: 'appears more than once. Each service, and the global default, may have at most one area.',
      });
    }
    seen.add(key);
  });

  areas.forEach((area, index) => validateAreaShape(area, index, errors));
  if (errors.length > 0) throw invalidServiceAreaError(errors);

  // S5 — a `serviceId` the provider does not offer, and a `centerAddressId` they do not own.
  const offered = new Set(
    (
      await getDb()
        .select({ serviceId: providerServices.serviceId })
        .from(providerServices)
        .where(eq(providerServices.providerProfileId, providerProfileId))
    ).map((row) => row.serviceId),
  );
  const ownedAddresses = new Set(
    (await getDb().select({ id: addresses.id, userId: addresses.userId }).from(addresses).where(eq(addresses.userId, userId))).map(
      (row) => row.id,
    ),
  );

  areas.forEach((area, index) => {
    if (area.serviceId && !offered.has(area.serviceId)) {
      errors.push({ field: `areas[${index}].serviceId`, message: 'is not a service you offer.' });
    }
    if (area.mode === 'radius' && area.centerAddressId && !ownedAddresses.has(area.centerAddressId)) {
      errors.push({ field: `areas[${index}].centerAddressId`, message: 'is not one of your saved addresses.' });
    }
  });
  if (errors.length > 0) throw invalidServiceAreaError(errors);

  await getDb().transaction(async (tx) => {
    await tx.delete(providerServiceAreas).where(eq(providerServiceAreas.providerProfileId, providerProfileId));
    if (areas.length > 0) {
      await tx.insert(providerServiceAreas).values(
        areas.map((area) => ({
          providerProfileId,
          serviceId: area.serviceId ?? null,
          mode: area.mode,
          radiusMeters: area.mode === 'radius' ? area.radiusKm! * METERS_PER_KM : null,
          centerAddressId: area.mode === 'radius' ? area.centerAddressId! : null,
          cities: area.mode === 'cities' ? area.cities!.map((city) => city.trim()) : null,
        })),
      );
    }
  });

  return listServiceAreas(providerProfileId);
}

function validateAreaShape(area: ServiceAreaRequest, index: number, errors: FieldError[]): void {
  if (area.mode !== 'radius' && area.mode !== 'cities' && area.mode !== 'remote') {
    errors.push({ field: `areas[${index}].mode`, message: "must be one of 'radius', 'cities' or 'remote'." });
    return;
  }

  if (area.mode === 'radius') {
    if (!Number.isInteger(area.radiusKm) || area.radiusKm! < MIN_RADIUS_KM || area.radiusKm! > MAX_RADIUS_KM) {
      errors.push({ field: `areas[${index}].radiusKm`, message: `must be an integer from ${MIN_RADIUS_KM} to ${MAX_RADIUS_KM}.` });
    }
    if (typeof area.centerAddressId !== 'string' || area.centerAddressId.length === 0) {
      errors.push({ field: `areas[${index}].centerAddressId`, message: "is required when mode is 'radius'." });
    }
    if (area.cities !== undefined) {
      errors.push({ field: `areas[${index}].cities`, message: "must be omitted when mode is 'radius'." });
    }
    return;
  }

  if (area.mode === 'cities') {
    if (!Array.isArray(area.cities) || area.cities.length === 0 || area.cities.length > MAX_CITIES) {
      errors.push({ field: `areas[${index}].cities`, message: `must be an array of 1 to ${MAX_CITIES} city names.` });
    } else if (area.cities.some((city) => typeof city !== 'string' || city.trim().length === 0)) {
      errors.push({ field: `areas[${index}].cities`, message: 'must not contain a blank entry.' });
    }
    if (area.radiusKm !== undefined || area.centerAddressId !== undefined) {
      errors.push({ field: `areas[${index}].radiusKm`, message: "must be omitted when mode is 'cities'." });
    }
    return;
  }

  // 'remote' — S5: carries none of the geographic fields.
  if (area.radiusKm !== undefined || area.centerAddressId !== undefined || area.cities !== undefined) {
    errors.push({
      field: `areas[${index}].mode`,
      message: "'remote' must not carry radiusKm, centerAddressId or cities.",
    });
  }
}

/** S4 — the candidate a provider's area is tested against. */
export interface EligibilityCandidate {
  point?: GeoPoint;
  city?: string;
}

/**
 * S2/S3/S4 — **AC-3 and AC-4**. Uses the service's own row if one exists, else the global row;
 * **no row at all means unrestricted**, preserving the behaviour spec 012's `service-area-check`
 * shipped with. `mode = 'remote'` bypasses every geographic test (AC-4).
 *
 * S4: a candidate with no coordinates is NOT inside a radius area — never silently eligible.
 */
export async function isProviderEligibleForLocation(
  providerProfileId: string,
  serviceId: string | null,
  candidate: EligibilityCandidate,
): Promise<boolean> {
  const rows = await loadServiceAreaRows(providerProfileId);
  if (rows.length === 0) return true; // S2: unrestricted.

  const row = (serviceId ? rows.find((r) => r.serviceId === serviceId) : undefined) ?? rows.find((r) => r.serviceId === null);
  if (!row) return true; // No service-specific row and no global default — still unrestricted.

  if (row.mode === 'remote') return true; // AC-4.

  const area = await toServiceArea(row);
  if (!area) return true; // A row whose centre address vanished cannot exclude anyone.

  // S4: a candidate with no coordinates can never satisfy a radius area. A cities area ignores
  // the point entirely, so a placeholder origin is passed and only `city` decides.
  if (area.kind === 'radius' && !candidate.point) return false;

  return isWithinServiceArea({ point: candidate.point ?? { latitude: 0, longitude: 0 }, city: candidate.city }, area);
}

/** S3 — a stored row as spec 012's `ServiceArea`, resolving the centre through addresses→locations. */
async function toServiceArea(row: ServiceAreaRow): Promise<ServiceArea | null> {
  if (row.mode === 'cities') {
    return { kind: 'cities', cities: row.cities ?? [] };
  }
  if (row.mode !== 'radius' || !row.centerAddressId || row.radiusMeters === null) return null;

  const [center] = await getDb()
    .select({
      latitude: locations.latitudeMicroDegrees,
      longitude: locations.longitudeMicroDegrees,
    })
    .from(addresses)
    .innerJoin(locations, eq(locations.id, addresses.locationId))
    .where(eq(addresses.id, row.centerAddressId));

  if (!center || center.latitude === null || center.longitude === null) return null;

  return {
    kind: 'radius',
    center: { latitude: fromMicroDegrees(center.latitude), longitude: fromMicroDegrees(center.longitude) },
    radiusMeters: row.radiusMeters,
  };
}

/**
 * S4 — the candidate for a request: its address's coordinates and city. Used by spec 017's
 * matching eligibility; exported here because the request→address→location resolution is part of
 * what "the candidate point" means in this spec's rules.
 */
export async function candidateForRequest(requestId: string): Promise<EligibilityCandidate | null> {
  const [row] = await getDb()
    .select({
      latitude: locations.latitudeMicroDegrees,
      longitude: locations.longitudeMicroDegrees,
      structured: addresses.structured,
    })
    .from(requests)
    .innerJoin(addresses, eq(addresses.id, requests.addressId))
    .innerJoin(locations, eq(locations.id, addresses.locationId))
    .where(eq(requests.id, requestId));

  if (!row) return null;
  const structured = row.structured as StructuredAddress;
  return {
    point:
      row.latitude === null || row.longitude === null
        ? undefined
        : { latitude: fromMicroDegrees(row.latitude), longitude: fromMicroDegrees(row.longitude) },
    city: structured?.city,
  };
}

/** The service a provider offers, for the `serviceId` validation on the slots route. */
export async function providerOffersService(providerProfileId: string, serviceId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: providerServices.id })
    .from(providerServices)
    .where(and(eq(providerServices.providerProfileId, providerProfileId), eq(providerServices.serviceId, serviceId)));
  return Boolean(row);
}

/** Whether a service id exists at all — distinguishes `404` from "you do not offer it". */
export async function serviceExists(serviceId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: services.id }).from(services).where(eq(services.id, serviceId));
  return Boolean(row);
}

/** Kept for callers that need the global row explicitly (spec 017 will). */
export async function findGlobalServiceArea(providerProfileId: string): Promise<ServiceAreaRow | undefined> {
  const [row] = await getDb()
    .select({
      serviceId: providerServiceAreas.serviceId,
      mode: providerServiceAreas.mode,
      radiusMeters: providerServiceAreas.radiusMeters,
      centerAddressId: providerServiceAreas.centerAddressId,
      cities: providerServiceAreas.cities,
    })
    .from(providerServiceAreas)
    .where(and(eq(providerServiceAreas.providerProfileId, providerProfileId), isNull(providerServiceAreas.serviceId)));
  return row as ServiceAreaRow | undefined;
}
