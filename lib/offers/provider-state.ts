/**
 * Spec 018 §3 "Provider inbox integration (spec 017)" — the caller's own offer state per request.
 *
 * Only ever filtered by the caller's own `provider_profile_id`: a provider never learns anything about
 * another provider's offers on the same request.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { offers } from '@/lib/db/schema';
import type { CurrentOfferSummary, OfferStatus } from '@/lib/types/offers';
import { effectiveStatus } from './timer';

export interface ProviderOfferState {
  currentOffer: CurrentOfferSummary | null;
  hasLiveOffer: boolean;
  hasDeclinedOffer: boolean;
}

export const NO_OFFER_STATE: ProviderOfferState = { currentOffer: null, hasLiveOffer: false, hasDeclinedOffer: false };

export async function loadProviderOfferStates(
  providerProfileId: string,
  requestIds: string[],
): Promise<Map<string, ProviderOfferState>> {
  const states = new Map<string, ProviderOfferState>();
  if (requestIds.length === 0) return states;

  const rows = await getDb()
    .select({
      id: offers.id,
      requestId: offers.requestId,
      status: offers.status,
      expiresAt: offers.expiresAt,
      sentAt: offers.sentAt,
      serverNow: sql<Date>`clock_timestamp()`,
    })
    .from(offers)
    .where(and(eq(offers.providerProfileId, providerProfileId), inArray(offers.requestId, requestIds), ne(offers.status, 'draft')))
    .orderBy(desc(offers.sentAt), desc(offers.id));

  for (const row of rows) {
    const now = new Date(row.serverNow);
    const status = effectiveStatus(row.status as OfferStatus, row.expiresAt, now);
    const state = states.get(row.requestId) ?? { ...NO_OFFER_STATE };
    if (!state.currentOffer && row.expiresAt) {
      state.currentOffer = {
        offerId: row.id,
        status,
        expiresAt: row.expiresAt.toISOString(),
        serverNow: now.toISOString(),
      };
    }
    if (status === 'sent' || status === 'viewed') state.hasLiveOffer = true;
    if (status === 'declined') state.hasDeclinedOffer = true;
    states.set(row.requestId, state);
  }
  return states;
}
