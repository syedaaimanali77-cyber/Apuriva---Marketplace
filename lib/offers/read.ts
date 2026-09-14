/**
 * Spec 018 §3 — offer reads (AC-3 effective status, AC-4 history) and the `sent -> viewed` mark.
 *
 * Every read selects `clock_timestamp()` in the same statement as the rows it maps, so the effective
 * status (`expired` once `expires_at` has passed, even before the sweep persists it) is always judged
 * against the database clock, never the app server's.
 *
 * Spec 019 §3: every `OfferDto` also carries its revision lineage, joined from `offer_revisions`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { buildPage, type PageParams } from '@/lib/api/pagination';
import type { OfferDto, OfferStatus } from '@/lib/types/offers';
import { queryRows, type Executor } from './db';
import { offerNotFoundError, requestNotFoundError } from './errors';
import { effectiveStatus } from './timer';
import { isUuid } from './validation';

export interface OfferRow {
  id: string;
  request_id: string;
  provider_profile_id: string;
  business_name: string | null;
  status: OfferStatus;
  price_amount_minor_units: number;
  price_currency_code: string;
  included_items: string[];
  provider_message: string | null;
  estimated_duration_minutes: number | null;
  sent_at: Date;
  expires_at: Date;
  viewed_at: Date | null;
  decided_at: Date | null;
  version: number;
  server_now: Date;
  revision_number: number | null;
  previous_offer_id: string | null;
  previous_price_amount_minor_units: number | null;
  superseded_by_offer_id: string | null;
}

const OFFER_COLUMNS = sql`
  o.id, o.request_id, o.provider_profile_id, pp.business_name, o.status,
  o.price_amount_minor_units, o.price_currency_code, o.included_items, o.provider_message,
  o.estimated_duration_minutes, o.sent_at, o.expires_at, o.viewed_at, o.decided_at, o.version,
  rv_in.revision_number, rv_in.offer_id AS previous_offer_id,
  rv_in.previous_price_amount_minor_units, rv_out.new_offer_id AS superseded_by_offer_id,
  clock_timestamp() AS server_now
`;

/** `offers o` with the provider name and both lineage joins every `OFFER_COLUMNS` read needs. */
const OFFER_FROM = sql`
  offers o
  JOIN provider_profiles pp ON pp.id = o.provider_profile_id
  LEFT JOIN offer_revisions rv_in ON rv_in.new_offer_id = o.id
  LEFT JOIN offer_revisions rv_out ON rv_out.offer_id = o.id
`;

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Never serializes idempotency keys or fingerprints (spec 018 §4 "Never exposed"). */
export function toOfferDto(row: OfferRow): OfferDto {
  const now = new Date(row.server_now);
  const expiresAt = new Date(row.expires_at);
  return {
    id: row.id,
    requestId: row.request_id,
    providerProfileId: row.provider_profile_id,
    providerBusinessName: row.business_name,
    status: effectiveStatus(row.status, expiresAt, now),
    priceAmountMinorUnits: row.price_amount_minor_units,
    currencyCode: row.price_currency_code,
    includedItems: row.included_items ?? [],
    providerMessage: row.provider_message,
    estimatedDurationMinutes: row.estimated_duration_minutes,
    sentAt: iso(row.sent_at),
    expiresAt: iso(row.expires_at),
    viewedAt: row.viewed_at ? iso(row.viewed_at) : null,
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    serverNow: iso(row.server_now),
    version: row.version,
    revisionNumber: row.revision_number ?? 0,
    previousOfferId: row.previous_offer_id,
    previousPriceAmountMinorUnits: row.previous_price_amount_minor_units,
    supersededByOfferId: row.superseded_by_offer_id,
  };
}

export async function loadOfferDto(offerId: string, db: Executor = getDb()): Promise<OfferDto> {
  const [row] = await queryRows<OfferRow>(
    db,
    sql`SELECT ${OFFER_COLUMNS} FROM ${OFFER_FROM} WHERE o.id = ${offerId} AND o.status <> 'draft'`,
  );
  if (!row) throw offerNotFoundError();
  return toOfferDto(row);
}

/**
 * `sent -> viewed` (spec 018 §3): conditional, only for live offers, only on the owning customer's
 * read. `SKIP LOCKED` so a read never waits on — or fails because of — an accept/decline holding an
 * offer row; a skipped row simply stays `sent` until a later read. Never touches `expires_at`.
 * Spec 019 adds the `offerIds` scope for the comparison read.
 */
export async function markViewed(
  customerUserId: string,
  scope: { requestId: string } | { offerId: string } | { offerIds: string[] },
): Promise<void> {
  if ('offerIds' in scope && scope.offerIds.length === 0) return;
  const filter =
    'requestId' in scope
      ? sql`request_id = ${scope.requestId}`
      : 'offerId' in scope
        ? sql`id = ${scope.offerId}`
        : sql`id IN (${sql.join(
            scope.offerIds.map((id) => sql`${id}`),
            sql`, `,
          )})`;
  await getDb().execute(sql`
    WITH viewed AS (
      UPDATE offers o
         SET status = 'viewed', viewed_at = clock_timestamp(), updated_at = clock_timestamp(), version = o.version + 1
       WHERE o.id IN (
         SELECT id FROM offers
          WHERE ${filter} AND status = 'sent' AND clock_timestamp() < expires_at
          FOR UPDATE SKIP LOCKED
       )
         AND o.status = 'sent' AND clock_timestamp() < o.expires_at
      RETURNING o.id
    )
    INSERT INTO offers_status_history (offer_id, from_status, to_status, actor_user_id)
    SELECT id, 'sent', 'viewed', ${customerUserId} FROM viewed
  `);
}

/** Ownership: the request exists and belongs to the caller's customer profile; otherwise 404. */
export async function assertCustomerOwnsRequest(userId: string, requestId: string): Promise<void> {
  if (!isUuid(requestId)) throw requestNotFoundError();
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT r.id FROM requests r JOIN customer_profiles cp ON cp.id = r.customer_profile_id
        WHERE r.id = ${requestId} AND cp.user_id = ${userId}`,
  );
  if (!row) throw requestNotFoundError();
}

/** `GET /api/v1/requests/{id}/offers` — every offer on the caller's own request, terminal ones included (AC-4). */
export async function listOffersForCustomer(
  userId: string,
  requestId: string,
  page: PageParams,
): Promise<{ data: OfferDto[]; page: ReturnType<typeof buildPage> }> {
  await assertCustomerOwnsRequest(userId, requestId);
  await markViewed(userId, { requestId });

  const db = getDb();
  const [{ total } = { total: 0 }] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM offers WHERE request_id = ${requestId} AND status <> 'draft'`,
  );
  const rows = await queryRows<OfferRow>(
    db,
    sql`SELECT ${OFFER_COLUMNS} FROM ${OFFER_FROM}
        WHERE o.request_id = ${requestId} AND o.status <> 'draft'
        ORDER BY o.sent_at DESC, o.id DESC
        LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  return { data: rows.map(toOfferDto), page: buildPage(Number(total), page.limit, page.offset) };
}

/** `GET /api/v1/offers/{id}` in customer mode — the request's owner only; anyone else gets 404. */
export async function getOfferForCustomer(userId: string, offerId: string): Promise<OfferDto> {
  if (!isUuid(offerId)) throw offerNotFoundError();
  const [owned] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT o.id FROM offers o
          JOIN requests r ON r.id = o.request_id
          JOIN customer_profiles cp ON cp.id = r.customer_profile_id
        WHERE o.id = ${offerId} AND cp.user_id = ${userId} AND o.status <> 'draft'`,
  );
  if (!owned) throw offerNotFoundError();
  await markViewed(userId, { offerId });
  return loadOfferDto(offerId);
}

/** `GET /api/v1/offers/{id}` in provider mode — the offer's own provider only; never marks it viewed. */
export async function getOfferForProvider(providerProfileId: string, offerId: string): Promise<OfferDto> {
  if (!isUuid(offerId)) throw offerNotFoundError();
  const [owned] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM offers WHERE id = ${offerId} AND provider_profile_id = ${providerProfileId} AND status <> 'draft'`,
  );
  if (!owned) throw offerNotFoundError();
  return loadOfferDto(offerId);
}
