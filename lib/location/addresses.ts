import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { addresses, locations } from '@/lib/db/schema';
import type { AddressDto, CreateAddressRequest, StructuredAddress, UpdateAddressRequest } from '@/lib/types/location';
import { validationError } from '@/lib/api/errors';
import { fromMicroDegrees, isValidLatitude, isValidLongitude, toMicroDegrees } from './geo';
import { getLocationProvider, GeocodingFailedError, type GeocodeResult } from './provider';
import { geocodingFailedError, addressNotFoundError, addressInUseError } from './errors';
import { toAddressDto, toGeocodeResultDto } from './privacy';

type AddressRow = typeof addresses.$inferSelect;
type LocationRow = typeof locations.$inferSelect;

function rowsToDto(address: AddressRow, location: LocationRow, authorized: boolean): AddressDto {
  const structured = address.structured as StructuredAddress;
  const point = {
    latitude: fromMicroDegrees(location.latitudeMicroDegrees ?? 0),
    longitude: fromMicroDegrees(location.longitudeMicroDegrees ?? 0),
  };
  return toAddressDto({ id: address.id, label: address.label, isDefault: address.isDefault }, point, structured, authorized);
}

function validateCoordinates(latitude: number, longitude: number): void {
  const errors: { field: string; message: string }[] = [];
  if (!isValidLatitude(latitude)) errors.push({ field: 'latitude', message: 'must be between -90 and 90' });
  if (!isValidLongitude(longitude)) errors.push({ field: 'longitude', message: 'must be between -180 and 180' });
  if (errors.length > 0) throw validationError(errors);
}

/** §3 `POST /api/v1/location/geocode` — address text -> coordinates + hierarchy. */
export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  try {
    return await getLocationProvider().geocode(address);
  } catch (err) {
    if (err instanceof GeocodingFailedError) throw geocodingFailedError(err.message);
    throw err;
  }
}

/** §3 `POST /api/v1/location/reverse-geocode` — coordinates -> address. */
export async function reverseGeocodePoint(latitude: number, longitude: number): Promise<GeocodeResult> {
  validateCoordinates(latitude, longitude);
  try {
    return await getLocationProvider().reverseGeocode({ latitude, longitude });
  } catch (err) {
    if (err instanceof GeocodingFailedError) throw geocodingFailedError(err.message);
    throw err;
  }
}

/** §3 `GET /api/v1/addresses` — caller's own saved addresses, always exact (owner authorized). */
export async function listAddresses(userId: string): Promise<AddressDto[]> {
  const rows = await getDb()
    .select({ address: addresses, location: locations })
    .from(addresses)
    .innerJoin(locations, eq(addresses.locationId, locations.id))
    .where(eq(addresses.userId, userId));

  return rows.map((r) => rowsToDto(r.address, r.location, true));
}

function validateCreateBody(body: Partial<CreateAddressRequest>): asserts body is CreateAddressRequest {
  const errors: { field: string; message: string }[] = [];
  if (typeof body.label !== 'string' || body.label.trim().length === 0) errors.push({ field: 'label', message: 'is required' });
  if (!body.structured || typeof body.structured.area !== 'string' || body.structured.area.trim().length === 0) {
    errors.push({ field: 'structured.area', message: 'is required' });
  }
  if (!body.structured || typeof body.structured.city !== 'string' || body.structured.city.trim().length === 0) {
    errors.push({ field: 'structured.city', message: 'is required' });
  }
  if (!body.structured || typeof body.structured.country !== 'string' || body.structured.country.trim().length === 0) {
    errors.push({ field: 'structured.country', message: 'is required' });
  }
  if (typeof body.latitude !== 'number' || !isValidLatitude(body.latitude)) {
    errors.push({ field: 'latitude', message: 'must be a number between -90 and 90' });
  }
  if (typeof body.longitude !== 'number' || !isValidLongitude(body.longitude)) {
    errors.push({ field: 'longitude', message: 'must be a number between -180 and 180' });
  }
  if (errors.length > 0) throw validationError(errors);
}

/** §3 `POST /api/v1/addresses`. Setting `isDefault: true` unsets it on the caller's other
 * addresses in the same transaction — application-enforced (no partial-unique-index convention
 * exists in this schema; see schema-lint conventions, no `.where()` on any `uniqueIndex`). */
export async function createAddress(userId: string, body: Partial<CreateAddressRequest>): Promise<AddressDto> {
  validateCreateBody(body);

  return getDb().transaction(async (tx) => {
    const [location] = await tx
      .insert(locations)
      .values({
        latitudeMicroDegrees: toMicroDegrees(body.latitude),
        longitudeMicroDegrees: toMicroDegrees(body.longitude),
        geoHierarchy: { area: body.structured.area, city: body.structured.city, country: body.structured.country },
      })
      .returning();

    if (body.isDefault) {
      await tx.update(addresses).set({ isDefault: false }).where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)));
    }

    const [address] = await tx
      .insert(addresses)
      .values({
        userId,
        locationId: location!.id,
        label: body.label,
        structured: body.structured,
        isDefault: body.isDefault ?? false,
      })
      .returning();

    return rowsToDto(address!, location!, true);
  });
}

/** §3 `PATCH /api/v1/addresses/{id}` — owner only; 404 either way if not found/not owned. */
export async function updateAddress(userId: string, id: string, body: UpdateAddressRequest): Promise<AddressDto> {
  return getDb().transaction(async (tx) => {
    const [current] = await tx
      .select({ address: addresses, location: locations })
      .from(addresses)
      .innerJoin(locations, eq(addresses.locationId, locations.id))
      .where(and(eq(addresses.id, id), eq(addresses.userId, userId)));
    if (!current) throw addressNotFoundError();

    if (body.latitude !== undefined || body.longitude !== undefined) {
      const latitude = body.latitude ?? fromMicroDegrees(current.location.latitudeMicroDegrees ?? 0);
      const longitude = body.longitude ?? fromMicroDegrees(current.location.longitudeMicroDegrees ?? 0);
      validateCoordinates(latitude, longitude);
      await tx
        .update(locations)
        .set({
          latitudeMicroDegrees: toMicroDegrees(latitude),
          longitudeMicroDegrees: toMicroDegrees(longitude),
          updatedAt: new Date(),
        })
        .where(eq(locations.id, current.location.id));
    }

    if (body.isDefault) {
      await tx
        .update(addresses)
        .set({ isDefault: false })
        .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true), ne(addresses.id, id)));
    }

    const [updated] = await tx
      .update(addresses)
      .set({
        label: body.label ?? current.address.label,
        structured: body.structured ?? current.address.structured,
        isDefault: body.isDefault ?? current.address.isDefault,
        version: current.address.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(addresses.id, id))
      .returning();

    const [location] = await tx.select().from(locations).where(eq(locations.id, current.location.id));
    return rowsToDto(updated!, location!, true);
  });
}

/** §3 `DELETE /api/v1/addresses/{id}` — owner only; `409 ADDRESS_IN_USE` if a booking still
 * references it (baseline FK convention is `onDelete: 'restrict'`, never cascade — §4). */
export async function deleteAddress(userId: string, id: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [current] = await tx
      .select({ locationId: addresses.locationId })
      .from(addresses)
      .where(and(eq(addresses.id, id), eq(addresses.userId, userId)));
    if (!current) throw addressNotFoundError();

    try {
      await tx.delete(addresses).where(eq(addresses.id, id));
      await tx.delete(locations).where(eq(locations.id, current.locationId));
    } catch (err) {
      if ((err as { code?: string }).code === '23503') throw addressInUseError();
      throw err;
    }
  });
}
