/**
 * Spec 019 §3 — offer lineage helpers shared by spec 018's decide paths and spec 019's negotiation paths.
 *
 * The CURRENT (head) offer of a (request, provider) pair is that provider's most recent non-draft row on
 * the request. After a revision the new row is always the most recent (its `sent_at` is a later
 * `clock_timestamp()` read), so this is also the end of any revision chain.
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from './db';

/** The head offer id for the (request, provider) pair `offerId` belongs to; null if `offerId` is unknown. */
export async function currentOfferIdFor(db: Executor, offerId: string): Promise<string | null> {
  const [row] = await queryRows<{ id: string }>(
    db,
    sql`SELECT head.id FROM offers o
          JOIN offers head ON head.request_id = o.request_id
                          AND head.provider_profile_id = o.provider_profile_id
                          AND head.status <> 'draft'
         WHERE o.id = ${offerId}
         ORDER BY head.sent_at DESC, head.id DESC
         LIMIT 1`,
  );
  return row?.id ?? null;
}
