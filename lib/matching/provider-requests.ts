/**
 * Spec 017 §3 — the provider's incoming-request inbox and their accept/decline actions (AC-5),
 * including the claim invariant (§3 "Concurrency").
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  addresses,
  locations,
  providerProfiles,
  requestProviderMatches,
  requests,
  services,
} from '@/lib/db/schema';
import { toBudgetDto } from '@/lib/requests/budget';
import { distanceMeters, fromMicroDegrees } from '@/lib/location/geo';
import { approxAreaLabel } from '@/lib/location/privacy';
import { acceptAllowedForPricingModel, availableActionFor, isActionableStatus } from './actions';
import {
  notDistributedToProviderError,
  actionNotAvailableForPricingModelError,
  matchingNotFoundError,
  requestAlreadyClaimedError,
  requestNotActionableError,
} from './errors';
import { loadProviderCenterPoints } from './repository';
import type { IncomingRequestDto, ProviderResponse, ProviderResponseDto } from '@/lib/types/matching';
import type { StructuredAddress } from '@/lib/types/location';

const METERS_PER_KM = 1000;

/** Rounded to one decimal place: a provider sees roughly how far, never an exact position. */
function approxKm(meters: number): number {
  return Math.round((meters / METERS_PER_KM) * 10) / 10;
}

interface InboxRow {
  requestId: string;
  status: string;
  serviceId: string;
  serviceName: string;
  pricingModel: string;
  description: string;
  urgency: string;
  preferredAt: Date | null;
  notifiedAt: Date | null;
  providerResponse: string;
  structured: unknown;
  latitude: number | null;
  longitude: number | null;
  budgetMinAmountMinorUnits: number | null;
  budgetMinCurrencyCode: string | null;
  budgetMaxAmountMinorUnits: number | null;
  budgetMaxCurrencyCode: string | null;
}

const INBOX_COLUMNS = {
  requestId: requests.id,
  status: requests.status,
  serviceId: requests.serviceId,
  serviceName: services.name,
  pricingModel: services.pricingModel,
  description: requests.description,
  urgency: requests.urgency,
  preferredAt: requests.preferredAt,
  notifiedAt: requestProviderMatches.notifiedAt,
  providerResponse: requestProviderMatches.providerResponse,
  structured: addresses.structured,
  latitude: locations.latitudeMicroDegrees,
  longitude: locations.longitudeMicroDegrees,
  budgetMinAmountMinorUnits: requests.budgetMinAmountMinorUnits,
  budgetMinCurrencyCode: requests.budgetMinCurrencyCode,
  budgetMaxAmountMinorUnits: requests.budgetMaxAmountMinorUnits,
  budgetMaxCurrencyCode: requests.budgetMaxCurrencyCode,
} as const;

/**
 * Spec 017 §3 — the DTO a provider receives. Deliberately privacy-bounded: a coarse
 * `approxDistanceKm` and spec 012's `approxAreaLabel`, never the address id, the `locations` row,
 * or exact coordinates (spec 012 forbids those before booking). It also carries no score, rank or
 * exclusion reason — those are admin-only (AC-6).
 */
function toIncomingRequestDto(row: InboxRow, centerPoint?: { latitude: number; longitude: number }): IncomingRequestDto {
  const structured = row.structured as StructuredAddress;
  const hasPoint = row.latitude !== null && row.longitude !== null;
  const originPoint = hasPoint
    ? { latitude: fromMicroDegrees(row.latitude!), longitude: fromMicroDegrees(row.longitude!) }
    : undefined;

  return {
    requestId: row.requestId,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    availableAction: availableActionFor(row.pricingModel, row.status, row.providerResponse as ProviderResponse),
    approxDistanceKm: originPoint && centerPoint ? approxKm(distanceMeters(originPoint, centerPoint)) : null,
    approxAreaLabel: approxAreaLabel(structured),
    description: row.description,
    urgency: row.urgency as 'normal' | 'urgent',
    budget: toBudgetDto({
      budgetMinAmountMinorUnits: row.budgetMinAmountMinorUnits,
      budgetMinCurrencyCode: row.budgetMinCurrencyCode,
      budgetMaxAmountMinorUnits: row.budgetMaxAmountMinorUnits,
      budgetMaxCurrencyCode: row.budgetMaxCurrencyCode,
    }),
    preferredAt: row.preferredAt ? row.preferredAt.toISOString() : null,
    distributedAt: (row.notifiedAt ?? new Date(0)).toISOString(),
    providerResponse: row.providerResponse as ProviderResponse,
  };
}

/** `GET /providers/me/requests` — only requests this provider was actually distributed into. */
export async function listIncomingRequests(
  providerProfileId: string,
  page: { limit: number; offset: number },
): Promise<{ items: IncomingRequestDto[]; total: number }> {
  const db = getDb();

  const rows = (await db
    .select(INBOX_COLUMNS)
    .from(requestProviderMatches)
    .innerJoin(requests, eq(requests.id, requestProviderMatches.requestId))
    .innerJoin(services, eq(services.id, requests.serviceId))
    .innerJoin(addresses, eq(addresses.id, requests.addressId))
    .innerJoin(locations, eq(locations.id, addresses.locationId))
    .where(
      and(
        eq(requestProviderMatches.providerProfileId, providerProfileId),
        isNotNull(requestProviderMatches.notifiedAt),
      ),
    )
    .orderBy(desc(requestProviderMatches.notifiedAt))
    .limit(page.limit)
    .offset(page.offset)) as InboxRow[];

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(requestProviderMatches)
    .where(
      and(
        eq(requestProviderMatches.providerProfileId, providerProfileId),
        isNotNull(requestProviderMatches.notifiedAt),
      ),
    );

  const serviceIds = [...new Set(rows.map((row) => row.serviceId))];
  const centers = new Map<string, { latitude: number; longitude: number }>();
  for (const serviceId of serviceIds) {
    const points = await loadProviderCenterPoints([providerProfileId], serviceId);
    const point = points.get(providerProfileId);
    if (point) centers.set(serviceId, point);
  }

  return {
    items: rows.map((row) => toIncomingRequestDto(row, centers.get(row.serviceId))),
    total: Number(count),
  };
}

/** `GET /providers/me/requests/{id}` — 403 unless this provider was distributed into it. */
export async function getIncomingRequest(providerProfileId: string, requestId: string): Promise<IncomingRequestDto> {
  const [row] = (await getDb()
    .select(INBOX_COLUMNS)
    .from(requestProviderMatches)
    .innerJoin(requests, eq(requests.id, requestProviderMatches.requestId))
    .innerJoin(services, eq(services.id, requests.serviceId))
    .innerJoin(addresses, eq(addresses.id, requests.addressId))
    .innerJoin(locations, eq(locations.id, addresses.locationId))
    .where(
      and(
        eq(requestProviderMatches.providerProfileId, providerProfileId),
        eq(requestProviderMatches.requestId, requestId),
        isNotNull(requestProviderMatches.notifiedAt),
      ),
    )) as InboxRow[];

  // 403 rather than 404 for a request that exists but was not distributed to this provider — and
  // 403 for a non-existent id too, so ids cannot be probed by comparing statuses.
  if (!row) throw notDistributedToProviderError();
  const centers = await loadProviderCenterPoints([providerProfileId], row.serviceId);
  return toIncomingRequestDto(row, centers.get(providerProfileId));
}

/**
 * AC-5 accept — **the claim invariant** (spec 017 §3 "Concurrency").
 *
 * Layer 1 (application): `SELECT ... FOR UPDATE` on the REQUEST row, taken before any response
 * state is read, inside the same transaction as the write. A second concurrent attempt blocks
 * there until the first commits, then observes its row — so two accepts can never both succeed.
 * Layer 2 (database): the partial unique index `(request_id) where provider_response = 'accepted'`
 * rejects a second accepted row even if a future code path skipped the lock.
 */
export async function acceptRequest(providerProfileId: string, requestId: string): Promise<ProviderResponseDto> {
  return respondToRequest(providerProfileId, requestId, 'accepted');
}

export async function declineRequest(providerProfileId: string, requestId: string): Promise<ProviderResponseDto> {
  return respondToRequest(providerProfileId, requestId, 'declined');
}

async function respondToRequest(
  providerProfileId: string,
  requestId: string,
  response: 'accepted' | 'declined',
): Promise<ProviderResponseDto> {
  return getDb().transaction(async (tx) => {
    // (1) Serialize every claim decision for this request BEFORE reading any response state.
    await tx.execute(sql`select id from requests where id = ${requestId} for update`);

    const [row] = await tx
      .select({
        status: requests.status,
        pricingModel: services.pricingModel,
        providerResponse: requestProviderMatches.providerResponse,
        respondedAt: requestProviderMatches.respondedAt,
        notifiedAt: requestProviderMatches.notifiedAt,
      })
      .from(requestProviderMatches)
      .innerJoin(requests, eq(requests.id, requestProviderMatches.requestId))
      .innerJoin(services, eq(services.id, requests.serviceId))
      .where(
        and(
          eq(requestProviderMatches.requestId, requestId),
          eq(requestProviderMatches.providerProfileId, providerProfileId),
        ),
      );

    if (!row || !row.notifiedAt) throw notDistributedToProviderError();

    // Idempotent: repeating the SAME action returns the existing response rather than erroring.
    if (row.providerResponse === response) {
      return {
        requestId,
        providerResponse: response as ProviderResponse,
        respondedAt: (row.respondedAt ?? new Date()).toISOString(),
      };
    }
    // A DIFFERENT second action is a conflict, not an overwrite.
    if (row.providerResponse !== 'none') {
      throw requestNotActionableError(`You have already ${row.providerResponse} this request.`);
    }

    if (!isActionableStatus(row.status)) {
      throw requestNotActionableError(`This request is no longer open for responses (status: ${row.status}).`);
    }

    if (response === 'accepted') {
      if (!acceptAllowedForPricingModel(row.pricingModel)) {
        throw actionNotAvailableForPricingModelError(row.pricingModel);
      }

      // (2) Under the lock, no other provider can have committed an accept we cannot see.
      const [claimed] = await tx
        .select({ providerProfileId: requestProviderMatches.providerProfileId })
        .from(requestProviderMatches)
        .where(
          and(
            eq(requestProviderMatches.requestId, requestId),
            eq(requestProviderMatches.providerResponse, 'accepted'),
          ),
        );
      if (claimed) throw requestAlreadyClaimedError();
    }

    const respondedAt = new Date();
    await tx
      .update(requestProviderMatches)
      .set({ providerResponse: response, respondedAt, updatedAt: respondedAt })
      .where(
        and(
          eq(requestProviderMatches.requestId, requestId),
          eq(requestProviderMatches.providerProfileId, providerProfileId),
        ),
      );

    return { requestId, providerResponse: response as ProviderResponse, respondedAt: respondedAt.toISOString() };
  });
}

export { providerProfiles };
