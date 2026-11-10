/**
 * Spec 019 §6 fixtures. Built on spec 018's `seedOfferScenario`, which runs spec 017's real `runMatching`,
 * so every provider is genuinely distributed (`notified_at` set) and every `request_provider_matches` row
 * (rank, `score_breakdown`) is real — no match rows are faked.
 *
 * Timing follows spec 018: no sleeps and no mocked clock. Windows are shifted relative to the DATABASE
 * clock (`shiftOfferWindow`), and the anti-spam window is exercised by seeding `created_at` relative to
 * `clock_timestamp()`.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { seedOfferScenario, sendOffer, type OfferScenario } from '@/lib/offers/offers-test-support';
import type { ProviderFixture } from '@/lib/matching/matching-test-support';

export {
  authenticatedRequest,
  isDatabaseReachable,
  offerBody,
  offerHistory,
  registerCustomer,
  registerProvider,
  requestStatus,
  seedOfferScenario,
  sendOffer,
  sessionGet,
  sessionMutate,
  shiftOfferWindow,
  storedOffer,
  type OfferScenario,
  type ProviderFixture,
  type TestSession,
} from '@/lib/offers/offers-test-support';

/** Past the 2-minute window by a clear margin, so an offer is unambiguously expired. */
export const EXPIRED_MS_AGO = 121_000;

/**
 * Default revision terms. The price deliberately differs from `seedOffersFromEachProvider`'s seeded
 * prices (300_000 + index × 1_000), so a default revision always changes at least one term (AC-13).
 */
export function reviseBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return { priceAmountMinorUnits: 275_000, currencyCode: 'PKR', includedItems: ['Labour'], ...overrides };
}

/** A scenario whose providers have each sent one live offer — the comparison starting point. */
export async function seedOffersFromEachProvider(providerCount: number): Promise<OfferScenario & { offerIds: string[] }> {
  const scenario = await seedOfferScenario({ providerCount });
  const offerIds: string[] = [];
  for (const provider of scenario.providers) {
    const offer = await sendOffer(provider, scenario.requestId, { priceAmountMinorUnits: 300_000 + offerIds.length * 1_000 });
    offerIds.push(offer.id);
  }
  return { ...scenario, offerIds };
}

export interface StoredOfferFull {
  status: string;
  price_amount_minor_units: number;
  price_currency_code: string;
  included_items: string[];
  provider_message: string | null;
  estimated_duration_minutes: number | null;
  sent_at: Date;
  expires_at: Date;
  version: number;
  window_ok: boolean;
}

/** Raw `sql` reads return timestamps as strings, so they are normalized to `Date` here once. */
export async function fullOfferRow(offerId: string): Promise<StoredOfferFull> {
  const [row] = await queryRows<StoredOfferFull>(
    getDb(),
    sql`SELECT status, price_amount_minor_units, price_currency_code, included_items, provider_message,
               estimated_duration_minutes, sent_at, expires_at, version,
               (expires_at - sent_at = interval '2 minutes') AS window_ok
          FROM offers WHERE id = ${offerId}`,
  );
  return { ...row!, sent_at: new Date(row!.sent_at), expires_at: new Date(row!.expires_at) };
}

export interface StoredRevision {
  id: string;
  offer_id: string;
  new_offer_id: string;
  request_id: string;
  provider_profile_id: string;
  revision_number: number;
  previous_price_amount_minor_units: number;
  previous_price_currency_code: string;
  new_price_amount_minor_units: number;
  new_price_currency_code: string;
  actor_user_id: string;
  change_request_message_id: string | null;
  created_at: Date;
}

export async function revisionRows(requestId: string, providerProfileId?: string): Promise<StoredRevision[]> {
  return queryRows<StoredRevision>(
    getDb(),
    sql`SELECT * FROM offer_revisions
         WHERE request_id = ${requestId}
           ${providerProfileId ? sql`AND provider_profile_id = ${providerProfileId}` : sql``}
         ORDER BY revision_number ASC`,
  );
}

export interface StoredMessage {
  id: string;
  request_id: string;
  provider_profile_id: string;
  offer_id: string | null;
  sender_user_id: string;
  sender_role: string;
  kind: string;
  body: string;
  contact_redacted: boolean;
  proposed_price_amount_minor_units: number | null;
  proposed_price_currency_code: string | null;
  created_at: Date;
}

export async function messageRows(requestId: string, providerProfileId?: string): Promise<StoredMessage[]> {
  return queryRows<StoredMessage>(
    getDb(),
    sql`SELECT * FROM offer_messages
         WHERE request_id = ${requestId}
           ${providerProfileId ? sql`AND provider_profile_id = ${providerProfileId}` : sql``}
         ORDER BY created_at ASC, id ASC`,
  );
}

/**
 * Inserts a thread row whose `created_at` is `msAgo` before the DATABASE clock — the only way to exercise
 * the rolling anti-spam window without sleeping. Bypasses the application deliberately (a test-setup
 * shortcut), so it never redacts or rate-limits.
 */
export async function seedAgedMessage(args: {
  requestId: string;
  providerProfileId: string;
  senderUserId: string;
  senderRole: 'customer' | 'provider';
  msAgo: number;
  body?: string;
}): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO offer_messages
      (request_id, provider_profile_id, sender_user_id, sender_role, kind, body, idempotency_key, idempotency_fingerprint,
       created_at, updated_at)
    VALUES (${args.requestId}, ${args.providerProfileId}, ${args.senderUserId}, ${args.senderRole}, 'message',
            ${args.body ?? 'Seeded message.'}, ${randomUUID()}, 'seeded',
            clock_timestamp() - (${args.msAgo} * interval '1 millisecond'),
            clock_timestamp() - (${args.msAgo} * interval '1 millisecond'))
  `);
}

/** Overwrites spec 017's stored `score_breakdown` for one match row (AC-11 reads the STORED snapshot). */
export async function setStoredScoreBreakdown(
  requestId: string,
  providerProfileId: string,
  breakdown: Record<string, { normalized: number; weight: number; available: boolean }>,
): Promise<void> {
  await getDb().execute(sql`
    UPDATE request_provider_matches SET score_breakdown = ${JSON.stringify(breakdown)}::jsonb
     WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId}
  `);
}

export async function setMatchRank(requestId: string, providerProfileId: string, rank: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE request_provider_matches SET rank = ${rank}
     WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId}
  `);
}

export function factor(normalized: number, available = true) {
  return { normalized, weight: 10, available };
}

/** The provider that owns `offerId` in a scenario. */
export function providerOf(scenario: { providers: ProviderFixture[] }, index: number): ProviderFixture {
  return scenario.providers[index]!;
}
