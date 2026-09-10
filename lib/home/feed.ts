import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { customerProfiles } from '@/lib/db/schema';
import type { SessionRow } from '@/lib/auth/session';
import { searchServices } from '@/lib/search/query';
import { listRecentSearches } from '@/lib/search/recent';
import type { HomeFeedDto } from '@/lib/types/home';
import type { SearchResultDto } from '@/lib/types/search';
import { isHomePersonalizationEnabled } from './feature-flags';

const CURATED_LIMIT = 8;
const RECENT_RELEVANT_LIMIT = 8;
/** How many of the caller's most recent `RecentSearch` rows feed the `recent_relevant` lookup —
 * a small, fixed lookback, not the full history. */
const RECENT_SEARCH_LOOKBACK = 5;

/**
 * Spec 014 §8 risk 1: the only real per-user signal that exists at this spec's ship time is
 * `RecentSearch` (spec 013) — account age has no product backing and is not used. Pure/no I-O so
 * the new-vs-returning decision boundary is directly unit-testable without a database.
 */
export function selectFeedMode(params: {
  personalizationEnabled: boolean;
  hasRecentRelevantItems: boolean;
}): 'curated_popular' | 'recent_relevant' {
  if (!params.personalizationEnabled) return 'curated_popular';
  return params.hasRecentRelevantItems ? 'recent_relevant' : 'curated_popular';
}

/** §4: `CustomerProfile.personalization_enabled`, default true. A user with no `CustomerProfile`
 * row (shouldn't happen — spec 006 provisions one at login completion) defaults to enabled,
 * matching the column's own default rather than special-casing the absence. */
async function getCustomerPersonalizationEnabled(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ personalizationEnabled: customerProfiles.personalizationEnabled })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId));
  return row?.personalizationEnabled ?? true;
}

/** AC-1 fallback and default section — real, currently-existing published-catalog inventory via
 * the same `searchServices` (spec 013) the search page uses, unfiltered and capped. Not a fake
 * "curated" list; there is no popularity-ranking signal yet (spec 040 dependency, §8 risk 3), so
 * this is the honest best-effort implementation available today. */
async function curatedPopular(): Promise<{ type: 'curated_popular'; items: SearchResultDto[] }> {
  const { items } = await searchServices({}, { limit: CURATED_LIMIT, offset: 0 });
  return { type: 'curated_popular', items };
}

/** AC-2 / §8 risk 3: sourced only from `RecentSearch` (spec 013) — never `AnalyticsEvent`, which
 * is column-less until spec 040. Returns `null` when the caller has no recent search history, or
 * when every previously-searched service/category no longer has a matching published result
 * (e.g. it was retired since) — the caller falls back to `curatedPopular` in either case, which
 * is what keeps AC-1's "never an empty/generic screen" true even for a technically-returning user. */
async function recentRelevant(userId: string): Promise<{ type: 'recent_relevant'; items: SearchResultDto[]; reason: string } | null> {
  const recent = await listRecentSearches(userId, RECENT_SEARCH_LOOKBACK);
  const serviceIds = [...new Set(recent.map((r) => r.serviceId).filter((id): id is string => id !== null))];
  const categoryIds = [...new Set(recent.map((r) => r.categoryId).filter((id): id is string => id !== null))];
  if (serviceIds.length === 0 && categoryIds.length === 0) return null;

  const resultBatches = await Promise.all([
    ...serviceIds.map((serviceId) => searchServices({ serviceId }, { limit: RECENT_RELEVANT_LIMIT, offset: 0 })),
    ...categoryIds.map((categoryId) => searchServices({ categoryId }, { limit: RECENT_RELEVANT_LIMIT, offset: 0 })),
  ]);

  const seen = new Set<string>();
  const items: SearchResultDto[] = [];
  outer: for (const { items: batch } of resultBatches) {
    for (const item of batch) {
      const key = `${item.providerId}:${item.serviceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= RECENT_RELEVANT_LIMIT) break outer;
    }
  }

  if (items.length === 0) return null;
  return { type: 'recent_relevant', items, reason: 'Based on your recent searches' };
}

/**
 * Spec 014 §3 `GET /api/v1/home` — customer-mode home feed (§2 scope note: AC-1/2/3/7 apply
 * there only). `activeBooking` is always omitted: `Booking` (spec 020) doesn't exist in code yet
 * (§8 risk 4). `saved_providers` is never included: no spec defines a persistent
 * saved/followed-provider relationship yet (§8 risk 2) — there is nothing to source it from.
 */
export async function getHomeFeed(session: SessionRow | null): Promise<HomeFeedDto> {
  if (!session) {
    return { sections: [await curatedPopular()] };
  }

  const personalizationEnabled = isHomePersonalizationEnabled() && (await getCustomerPersonalizationEnabled(session.userId));
  const recent = personalizationEnabled ? await recentRelevant(session.userId) : null;

  const mode = selectFeedMode({ personalizationEnabled, hasRecentRelevantItems: recent !== null });
  const section = mode === 'recent_relevant' && recent ? recent : await curatedPopular();

  return { sections: [section] };
}
