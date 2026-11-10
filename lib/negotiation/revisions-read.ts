/**
 * Spec 019 §3 `GET /api/v1/offers/{id}/revisions` — the whole revision chain containing `{id}`, ordered
 * `revisionNumber ASC`. Visible to the request's customer and the offer's provider only (404 otherwise).
 * Never serializes `actor_user_id`.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { OfferRevisionDto } from '@/lib/types/negotiation';
import { offerNotFoundError } from './errors';

interface RevisionRow {
  id: string;
  offer_id: string;
  new_offer_id: string;
  revision_number: number;
  previous_price_amount_minor_units: number;
  previous_price_currency_code: string;
  new_price_amount_minor_units: number;
  new_price_currency_code: string;
  change_request_message_id: string | null;
  created_at: Date;
}

function toRevisionDto(row: RevisionRow): OfferRevisionDto {
  return {
    id: row.id,
    previousOfferId: row.offer_id,
    offerId: row.new_offer_id,
    revisionNumber: row.revision_number,
    previousPrice: { amountMinorUnits: row.previous_price_amount_minor_units, currencyCode: row.previous_price_currency_code },
    newPrice: { amountMinorUnits: row.new_price_amount_minor_units, currencyCode: row.new_price_currency_code },
    actorRole: 'provider',
    changeRequestMessageId: row.change_request_message_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Walks back to the chain's root, then forward through every revision (UNION stops at any cycle). */
async function loadChain(offerId: string): Promise<OfferRevisionDto[]> {
  const rows = await queryRows<RevisionRow>(
    getDb(),
    sql`WITH RECURSIVE back(id) AS (
          SELECT ${offerId}::uuid
          UNION
          SELECT r.offer_id FROM offer_revisions r JOIN back b ON r.new_offer_id = b.id
        ),
        root AS (
          SELECT b.id FROM back b WHERE NOT EXISTS (SELECT 1 FROM offer_revisions r WHERE r.new_offer_id = b.id)
        ),
        fwd(id) AS (
          SELECT id FROM root
          UNION
          SELECT r.new_offer_id FROM offer_revisions r JOIN fwd f ON r.offer_id = f.id
        )
        SELECT r.id, r.offer_id, r.new_offer_id, r.revision_number, r.previous_price_amount_minor_units,
               r.previous_price_currency_code, r.new_price_amount_minor_units, r.new_price_currency_code,
               r.change_request_message_id, r.created_at
          FROM offer_revisions r
         WHERE r.offer_id IN (SELECT id FROM fwd)
         ORDER BY r.revision_number ASC`,
  );
  return rows.map(toRevisionDto);
}

export async function listRevisionChainForCustomer(customerUserId: string, offerId: string): Promise<OfferRevisionDto[]> {
  if (!isUuid(offerId)) throw offerNotFoundError();
  const [owned] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT o.id FROM offers o
          JOIN requests r ON r.id = o.request_id
          JOIN customer_profiles cp ON cp.id = r.customer_profile_id
         WHERE o.id = ${offerId} AND cp.user_id = ${customerUserId} AND o.status <> 'draft'`,
  );
  if (!owned) throw offerNotFoundError();
  return loadChain(offerId);
}

export async function listRevisionChainForProvider(providerProfileId: string, offerId: string): Promise<OfferRevisionDto[]> {
  if (!isUuid(offerId)) throw offerNotFoundError();
  const [owned] = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT id FROM offers WHERE id = ${offerId} AND provider_profile_id = ${providerProfileId} AND status <> 'draft'`,
  );
  if (!owned) throw offerNotFoundError();
  return loadChain(offerId);
}
