import { and, count, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import {
  customerProfiles,
  offers,
  requestFieldValues,
  requests,
  serviceFields,
  services,
} from '@/lib/db/schema';
import { buildPage, type PageParams } from '@/lib/api/pagination';
import {
  ACTIVE_REQUEST_STATUSES,
  customerFacingStep,
  type RequestDto,
  type RequestListFilter,
  type RequestStatus,
  type RequestSummaryDto,
} from '@/lib/types/requests';
import { toBudgetDto } from './budget';
import { requestNotFoundError } from './errors';

/**
 * Spec 015 §3 reads. AC-5: nothing here exposes an internal matching mechanic — no
 * `request_provider_matches` row, pool size, ranking or exclusion reason is ever selected, and the
 * customer-facing step always comes from the single mapping in `lib/types/requests.ts`.
 */

/** The row shape every read path shares, always joined to its service for the display name. */
async function loadRow(requestId: string) {
  const [row] = await getDb()
    .select({
      request: requests,
      serviceName: services.name,
      customerUserId: customerProfiles.userId,
    })
    .from(requests)
    .innerJoin(services, eq(services.id, requests.serviceId))
    .innerJoin(customerProfiles, eq(customerProfiles.id, requests.customerProfileId))
    .where(eq(requests.id, requestId));
  return row ?? null;
}

export async function toRequestDto(requestId: string): Promise<RequestDto> {
  const row = await loadRow(requestId);
  if (!row) throw requestNotFoundError();

  const valueRows = await getDb()
    .select({ key: serviceFields.key, value: requestFieldValues.value })
    .from(requestFieldValues)
    .innerJoin(serviceFields, eq(serviceFields.id, requestFieldValues.serviceFieldId))
    .where(eq(requestFieldValues.requestId, requestId));

  const fieldValues: Record<string, string | number | boolean> = {};
  for (const { key, value } of valueRows) fieldValues[key] = value as string | number | boolean;

  const { request } = row;
  return {
    id: request.id,
    status: request.status as RequestStatus,
    serviceId: request.serviceId,
    serviceName: row.serviceName,
    description: request.description,
    fieldValues,
    budget: toBudgetDto(request),
    preferredAt: request.preferredAt ? request.preferredAt.toISOString() : null,
    preferredTimezone: request.preferredTimezone,
    addressId: request.addressId,
    urgency: request.urgency,
    offerCount: await countOffers(requestId),
    customerFacingStep: customerFacingStep(request.status as RequestStatus),
    version: request.version,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

/**
 * Counted from the real `offers` table rather than hardcoded: no offer can exist until spec 018,
 * so this is `0` throughout this spec, and it stays correct once offers do exist instead of
 * silently lying.
 */
async function countOffers(requestId: string): Promise<number> {
  const [row] = await getDb().select({ value: count() }).from(offers).where(eq(offers.requestId, requestId));
  return row?.value ?? 0;
}

/**
 * §3 `GET /api/v1/requests/{id}` — owner only. A request that doesn't exist and one that isn't the
 * caller's are indistinguishable (`404 REQUEST_NOT_FOUND`), so request ids aren't probeable.
 */
export async function getRequestForOwner(userId: string, requestId: string): Promise<RequestDto> {
  const row = await loadRow(requestId);
  if (!row || row.customerUserId !== userId) throw requestNotFoundError();
  return toRequestDto(requestId);
}

/** The owning row, without building the full DTO — for the cancel paths' ownership/state checks. */
export async function getOwnedRequestRow(
  userId: string,
  requestId: string,
): Promise<{ id: string; status: RequestStatus; version: number }> {
  const row = await loadRow(requestId);
  if (!row || row.customerUserId !== userId) throw requestNotFoundError();
  return { id: row.request.id, status: row.request.status as RequestStatus, version: row.request.version };
}

/** §3 `GET /api/v1/requests` — the caller's own requests only, newest first. */
export async function listRequests(
  userId: string,
  filter: RequestListFilter,
  page: PageParams,
): Promise<{ data: RequestSummaryDto[]; page: ReturnType<typeof buildPage> }> {
  const db = getDb();

  const [customerProfile] = await db
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId));
  if (!customerProfile) return { data: [], page: buildPage(0, page.limit, page.offset) };

  const scope = and(
    eq(requests.customerProfileId, customerProfile.id),
    filter === 'active'
      ? inArray(requests.status, ACTIVE_REQUEST_STATUSES)
      : notInArray(requests.status, ACTIVE_REQUEST_STATUSES),
  );

  const [totalRow] = await db.select({ value: count() }).from(requests).where(scope);

  const rows = await db
    .select({
      id: requests.id,
      status: requests.status,
      serviceId: requests.serviceId,
      serviceName: services.name,
      createdAt: requests.createdAt,
    })
    .from(requests)
    .innerJoin(services, eq(services.id, requests.serviceId))
    .where(scope)
    .orderBy(desc(requests.createdAt))
    .limit(page.limit)
    .offset(page.offset);

  const data = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      status: row.status as RequestStatus,
      customerFacingStep: customerFacingStep(row.status as RequestStatus),
      serviceId: row.serviceId,
      serviceName: row.serviceName,
      offerCount: await countOffers(row.id),
      createdAt: row.createdAt.toISOString(),
    })),
  );

  return { data, page: buildPage(totalRow?.value ?? 0, page.limit, page.offset) };
}
