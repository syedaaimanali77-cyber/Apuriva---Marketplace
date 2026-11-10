import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { recentSearches } from '@/lib/db/schema';
import { validationError } from './errors';
import type { RecordRecentSearchRequest } from '@/lib/types/search';

const RECENT_SEARCHES_KEPT_PER_USER = 20;

/** §3 `POST /api/v1/search/recent` — records a search to the caller's own recent-searches list. */
export async function recordRecentSearch(userId: string, body: Partial<RecordRecentSearchRequest>): Promise<void> {
  if (!body.q && !body.serviceId && !body.categoryId) {
    throw validationError([{ field: 'q', message: 'at least one of q, serviceId, categoryId is required' }]);
  }

  await getDb().insert(recentSearches).values({
    userId,
    q: body.q ?? null,
    serviceId: body.serviceId ?? null,
    categoryId: body.categoryId ?? null,
  });
}

export interface RecentSearchRow {
  q: string | null;
  serviceId: string | null;
  categoryId: string | null;
}

/** Sources `/api/v1/search/autocomplete`'s "recent searches" suggestions (AC-2) — the caller's
 * own rows only, most recent first. */
export async function listRecentSearches(userId: string, limit = RECENT_SEARCHES_KEPT_PER_USER): Promise<RecentSearchRow[]> {
  return getDb()
    .select({ q: recentSearches.q, serviceId: recentSearches.serviceId, categoryId: recentSearches.categoryId })
    .from(recentSearches)
    .where(eq(recentSearches.userId, userId))
    .orderBy(desc(recentSearches.createdAt))
    .limit(limit);
}
