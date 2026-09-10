import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { addresses, categories, locations, providerProfiles, providerServices, servicePackages, services, users } from '@/lib/db/schema';
import { fromMicroDegrees, type GeoPoint } from '@/lib/location/geo';
import type { PriceDisplay, PriceDisplayType } from '@/lib/types/service-page';
import type { SearchResultDto, SearchSort } from '@/lib/types/search';
import { approxDistanceLabel, distanceMetersBetween } from './distance';
import { validationError } from './errors';

export interface SearchParams {
  q?: string;
  serviceId?: string;
  categoryId?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  budgetMaxMinorUnits?: number;
  /** Accepted for forward compatibility but currently a documented no-op — `ProviderAvailability`
   * (spec 016) is still a bare baseline table with no day/time columns to filter against. */
  date?: string;
  sort?: SearchSort;
}

const SORT_VALUES: SearchSort[] = ['relevance', 'distance', 'price_asc', 'price_desc'];

/**
 * Candidate-set cap for the in-memory sort/paginate path (`distance`/`price_asc`/`price_desc`,
 * and `relevance` when a location or price ordering can't be pushed into SQL directly). A
 * pragmatic limit for this implementation phase, not a spec requirement — revisit with SQL-level
 * distance/price ordering if result volume ever approaches it. `relevance` without this concern
 * still paginates at the SQL level.
 */
const CANDIDATE_CAP = 500;

interface CandidateRow {
  providerId: string;
  serviceId: string;
  categoryId: string;
  businessName: string | null;
  pricingModel: 'fixed' | 'package' | 'hourly' | 'quote' | 'custom';
  point: GeoPoint | null;
  relevanceRank: number;
}

export function validateSearchParams(params: SearchParams): void {
  const errors: { field: string; message: string }[] = [];
  if (params.lat !== undefined && (params.lng === undefined || !Number.isFinite(params.lat) || params.lat < -90 || params.lat > 90)) {
    errors.push({ field: 'lat', message: 'must be a valid latitude, paired with lng' });
  }
  if (params.lng !== undefined && (params.lat === undefined || !Number.isFinite(params.lng) || params.lng < -180 || params.lng > 180)) {
    errors.push({ field: 'lng', message: 'must be a valid longitude, paired with lat' });
  }
  if (params.radiusKm !== undefined && (!Number.isFinite(params.radiusKm) || params.radiusKm <= 0)) {
    errors.push({ field: 'radiusKm', message: 'must be a positive number' });
  }
  if (params.budgetMaxMinorUnits !== undefined && (!Number.isFinite(params.budgetMaxMinorUnits) || params.budgetMaxMinorUnits < 0)) {
    errors.push({ field: 'budgetMaxMinorUnits', message: 'must be a non-negative integer' });
  }
  if (params.sort !== undefined && !SORT_VALUES.includes(params.sort)) {
    errors.push({ field: 'sort', message: `must be one of ${SORT_VALUES.join(', ')}` });
  }
  if (errors.length > 0) throw validationError(errors);
}

/** §3: cheapest matching package wins; a provider's own package (if any) is preferred over the
 * service-level default package (`providerProfileId is null`). `pricingModel: 'quote'` always
 * displays as a quote, regardless of any package rows, per spec 011's pricing model semantics. */
function resolvePriceDisplay(
  pricingModel: CandidateRow['pricingModel'],
  ownPackages: { amountMinorUnits: number; currencyCode: string }[],
  defaultPackages: { amountMinorUnits: number; currencyCode: string }[],
): PriceDisplay {
  if (pricingModel === 'quote') return { type: 'quote' };

  const packages = ownPackages.length > 0 ? ownPackages : defaultPackages;
  if (packages.length === 0) return { type: pricingModel === 'hourly' ? 'hourly' : 'quote' };

  const cheapest = packages.reduce((a, b) => (a.amountMinorUnits <= b.amountMinorUnits ? a : b));
  const type: PriceDisplayType = pricingModel === 'hourly' ? 'hourly' : packages.length > 1 ? 'starting' : 'exact';
  return { type, amountMinorUnits: cheapest.amountMinorUnits, currencyCode: cheapest.currencyCode };
}

/**
 * §3 `GET /api/v1/search` — the sole authoritative source of search results (AC-1/AC-6). Never
 * calls `lib/ai`; only reads `services`/`providerServices`/`providerProfiles`/`locations`
 * (specs 010-012). Visibility: published services from active provider profiles only.
 */
export async function searchServices(params: SearchParams, page: { limit: number; offset: number }): Promise<{ items: SearchResultDto[]; total: number }> {
  validateSearchParams(params);
  const sort = params.sort ?? 'relevance';
  const db = getDb();

  const conditions = [eq(services.status, 'published'), eq(providerProfiles.lifecycleStatus, 'active')];
  if (params.serviceId) conditions.push(eq(services.id, params.serviceId));
  if (params.categoryId) conditions.push(eq(services.categoryId, params.categoryId));

  const trimmedQuery = params.q?.trim();
  const relevanceExpr = trimmedQuery
    ? sql<number>`ts_rank(to_tsvector('english', ${services.name}), plainto_tsquery('english', ${trimmedQuery})) + ts_rank(to_tsvector('english', coalesce(${providerProfiles.businessName}, '')), plainto_tsquery('english', ${trimmedQuery}))`
    : sql<number>`0`;
  if (trimmedQuery) {
    conditions.push(
      sql`(to_tsvector('english', ${services.name}) @@ plainto_tsquery('english', ${trimmedQuery})
        or to_tsvector('english', coalesce(${providerProfiles.businessName}, '')) @@ plainto_tsquery('english', ${trimmedQuery}))`,
    );
  }

  const rows = await db
    .select({
      providerId: providerProfiles.id,
      serviceId: services.id,
      categoryId: services.categoryId,
      businessName: providerProfiles.businessName,
      pricingModel: services.pricingModel,
      latitudeMicroDegrees: locations.latitudeMicroDegrees,
      longitudeMicroDegrees: locations.longitudeMicroDegrees,
      relevanceRank: relevanceExpr,
    })
    .from(providerServices)
    .innerJoin(services, eq(providerServices.serviceId, services.id))
    .innerJoin(providerProfiles, eq(providerServices.providerProfileId, providerProfiles.id))
    .leftJoin(users, eq(providerProfiles.userId, users.id))
    .leftJoin(addresses, and(eq(addresses.userId, users.id), eq(addresses.isDefault, true)))
    .leftJoin(locations, eq(addresses.locationId, locations.id))
    .where(and(...conditions))
    .limit(CANDIDATE_CAP);

  const candidates: CandidateRow[] = rows.map((r) => ({
    providerId: r.providerId,
    serviceId: r.serviceId,
    categoryId: r.categoryId,
    businessName: r.businessName,
    pricingModel: r.pricingModel,
    point:
      r.latitudeMicroDegrees !== null && r.longitudeMicroDegrees !== null
        ? { latitude: fromMicroDegrees(r.latitudeMicroDegrees), longitude: fromMicroDegrees(r.longitudeMicroDegrees) }
        : null,
    relevanceRank: Number(r.relevanceRank ?? 0),
  }));

  // Radius filter: a candidate with no resolvable location can't be verified as in-range, so it's
  // excluded only when a radius was actually requested — otherwise it's kept, just without a
  // displayable distance.
  const queryPoint: GeoPoint | null = params.lat !== undefined && params.lng !== undefined ? { latitude: params.lat, longitude: params.lng } : null;
  const withinRadius = candidates.filter((c) => {
    if (!queryPoint || params.radiusKm === undefined) return true;
    if (!c.point) return false;
    return distanceMetersBetween(queryPoint, c.point) <= params.radiusKm * 1000;
  });

  // Price resolution (two-query pattern: fetch every matching package for the candidate service
  // ids once, then resolve per-candidate in memory, rather than a row-duplicating join).
  const serviceIds = [...new Set(withinRadius.map((c) => c.serviceId))];
  const packageRows =
    serviceIds.length > 0
      ? await db
          .select({
            serviceId: servicePackages.serviceId,
            providerProfileId: servicePackages.providerProfileId,
            amountMinorUnits: servicePackages.amountMinorUnits,
            currencyCode: servicePackages.currencyCode,
          })
          .from(servicePackages)
          .where(inArray(servicePackages.serviceId, serviceIds))
      : [];

  const withPrice = withinRadius.map((c) => {
    const ownPackages = packageRows.filter((p) => p.serviceId === c.serviceId && p.providerProfileId === c.providerId);
    const defaultPackages = packageRows.filter((p) => p.serviceId === c.serviceId && p.providerProfileId === null);
    const priceDisplay = resolvePriceDisplay(c.pricingModel, ownPackages, defaultPackages);
    return { ...c, priceDisplay };
  });

  // Budget filter: excluded only when a resolved price is known to exceed the budget — an
  // unknown ('quote') price can't be said to violate a budget it can't be compared against.
  const withinBudget =
    params.budgetMaxMinorUnits === undefined
      ? withPrice
      : withPrice.filter((c) => c.priceDisplay.amountMinorUnits === undefined || c.priceDisplay.amountMinorUnits <= params.budgetMaxMinorUnits!);

  const withDistance = withinBudget.map((c) => ({
    ...c,
    distanceMeters: queryPoint && c.point ? distanceMetersBetween(queryPoint, c.point) : null,
  }));

  // AC-6: deterministic ordering, ties always broken by id ascending.
  const sorted = [...withDistance].sort((a, b) => {
    let primary = 0;
    if (sort === 'relevance') primary = b.relevanceRank - a.relevanceRank;
    else if (sort === 'distance') primary = (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
    else if (sort === 'price_asc') primary = (a.priceDisplay.amountMinorUnits ?? Infinity) - (b.priceDisplay.amountMinorUnits ?? Infinity);
    else if (sort === 'price_desc') primary = (b.priceDisplay.amountMinorUnits ?? -Infinity) - (a.priceDisplay.amountMinorUnits ?? -Infinity);
    if (primary !== 0) return primary;
    return a.providerId === b.providerId ? a.serviceId.localeCompare(b.serviceId) : a.providerId.localeCompare(b.providerId);
  });

  const total = sorted.length;
  const page_ = sorted.slice(page.offset, page.offset + page.limit);

  const items: SearchResultDto[] = page_.map((c) => ({
    providerId: c.providerId,
    serviceId: c.serviceId,
    displayName: c.businessName ?? 'Provider',
    approxDistance: queryPoint && c.point ? approxDistanceLabel(queryPoint, c.point) : undefined,
    priceDisplay: c.priceDisplay,
    // No badges yet — nothing distinguishing exists in the schema today (rating is spec 029's,
    // "new"/exploration exposure is spec 017's); an empty array is honest, not a placeholder.
    badges: [],
  }));

  return { items, total };
}
