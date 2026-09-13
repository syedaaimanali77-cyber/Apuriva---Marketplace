/**
 * Spec 017 — the shared database reads for matching.
 *
 * Nothing here reads a `bookings` or `offers` feature column: those tables are still spec 003
 * baselines owned by specs 018/020, which is precisely why six of the nine ranking factors have no
 * data source yet (spec 017 §3).
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { addresses, locations, providerServiceAreas, requestProviderMatches } from '@/lib/db/schema';
import { fromMicroDegrees, type GeoPoint } from '@/lib/location/geo';

/**
 * The centre point a provider's `radius` service area is anchored on, per provider.
 *
 * Used only for the `location` ranking factor. A provider whose area is `cities` or `remote` — or
 * who has configured none — has no centre, so `location` is reported unavailable for them and the
 * score is renormalized over the remaining factors rather than scoring them 0.
 */
export async function loadProviderCenterPoints(
  providerProfileIds: string[],
  serviceId: string,
): Promise<Map<string, GeoPoint>> {
  if (providerProfileIds.length === 0) return new Map();

  const rows = await getDb()
    .select({
      providerProfileId: providerServiceAreas.providerProfileId,
      areaServiceId: providerServiceAreas.serviceId,
      mode: providerServiceAreas.mode,
      latitude: locations.latitudeMicroDegrees,
      longitude: locations.longitudeMicroDegrees,
    })
    .from(providerServiceAreas)
    .innerJoin(addresses, eq(addresses.id, providerServiceAreas.centerAddressId))
    .innerJoin(locations, eq(locations.id, addresses.locationId))
    .where(inArray(providerServiceAreas.providerProfileId, providerProfileIds));

  // Spec 016 S2 precedence: a service-specific row wins over the provider's global row.
  const byProvider = new Map<string, GeoPoint>();
  for (const row of rows) {
    if (row.mode !== 'radius' || row.latitude === null || row.longitude === null) continue;
    const isServiceSpecific = row.areaServiceId === serviceId;
    if (!isServiceSpecific && row.areaServiceId !== null) continue;
    if (isServiceSpecific || !byProvider.has(row.providerProfileId)) {
      byProvider.set(row.providerProfileId, {
        latitude: fromMicroDegrees(row.latitude),
        longitude: fromMicroDegrees(row.longitude),
      });
    }
  }
  return byProvider;
}

/**
 * Spec 017 AC-3 — providers who have recorded at least one TERMINAL response
 * (`accepted`/`declined`/`offer_sent`). A provider absent from this set is "new".
 *
 * Computed from this spec's own table, so it needs no new schema and cannot be gamed by creating a
 * profile and idling. It is also self-extinguishing: a provider leaves the "new" population the
 * moment they record their first terminal response, which is what prevents exploration exposure
 * from becoming a permanent advantage.
 */
export async function loadTerminalResponderIds(providerProfileIds: string[]): Promise<Set<string>> {
  if (providerProfileIds.length === 0) return new Set();

  const rows = await getDb()
    .selectDistinct({ providerProfileId: requestProviderMatches.providerProfileId })
    .from(requestProviderMatches)
    .where(
      and(
        inArray(requestProviderMatches.providerProfileId, providerProfileIds),
        ne(requestProviderMatches.providerResponse, 'none'),
      ),
    );

  return new Set(rows.map((row) => row.providerProfileId));
}
