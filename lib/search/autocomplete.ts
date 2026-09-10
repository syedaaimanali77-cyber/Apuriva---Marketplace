import { and, asc, eq, ilike, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { categories, locations, services } from '@/lib/db/schema';
import type { AutocompleteSuggestionDto } from '@/lib/types/search';
import { listRecentSearches } from './recent';

export const AUTOCOMPLETE_MIN_QUERY_LENGTH = 2;
export const AUTOCOMPLETE_MAX_SUGGESTIONS = 10;

function dedupe(suggestions: AutocompleteSuggestionDto[]): AutocompleteSuggestionDto[] {
  const seen = new Set<string>();
  const result: AutocompleteSuggestionDto[] = [];
  for (const s of suggestions) {
    const key = `${s.type}:${s.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(s);
  }
  return result;
}

/**
 * §3 `GET /api/v1/search/autocomplete` (AC-2). `userId` is only present for a signed-in caller
 * (`getOptionalSession`) — a guest never sees `recent_search` suggestions, only the other four
 * sources, none of which are per-user data.
 */
export async function getAutocompleteSuggestions(q: string, userId: string | null): Promise<AutocompleteSuggestionDto[]> {
  const trimmed = q.trim();
  if (trimmed.length < AUTOCOMPLETE_MIN_QUERY_LENGTH) return [];

  const db = getDb();
  const pattern = `%${trimmed}%`;
  const suggestions: AutocompleteSuggestionDto[] = [];

  if (userId) {
    const recents = await listRecentSearches(userId, 5);
    for (const r of recents) {
      if (r.q && r.q.toLowerCase().includes(trimmed.toLowerCase())) {
        suggestions.push({ type: 'recent_search', label: r.q, value: r.q });
      }
    }
  }

  const categoryRows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.status, 'published'), ilike(categories.name, pattern)))
    .orderBy(asc(categories.sortOrder))
    .limit(5);
  for (const c of categoryRows) suggestions.push({ type: 'category', label: c.name, value: c.id });

  const serviceRows = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .where(and(eq(services.status, 'published'), ilike(services.name, pattern)))
    .orderBy(asc(services.name))
    .limit(5);
  for (const s of serviceRows) suggestions.push({ type: 'service', label: s.name, value: s.id });

  // "Popular" ranks by category prominence (`categories.sortOrder`) — the same proxy the
  // corrected spec §3 documents until spec 040's usage analytics exist to rank by actual use.
  const popularRows = await db
    .select({ id: services.id, name: services.name })
    .from(services)
    .innerJoin(categories, eq(services.categoryId, categories.id))
    .where(and(eq(services.status, 'published'), eq(categories.status, 'published'), ilike(services.name, pattern)))
    .orderBy(asc(categories.sortOrder), asc(services.name))
    .limit(3);
  for (const s of popularRows) suggestions.push({ type: 'popular_service', label: s.name, value: s.id });

  const locationRows = await db
    .select({ city: sql<string>`${locations.geoHierarchy}->>'city'` })
    .from(locations)
    .where(sql`${locations.geoHierarchy}->>'city' ilike ${pattern}`)
    .limit(20); // over-fetch, dedupe city names in JS below (no DISTINCT-on-jsonb-expression here)
  const seenCities = new Set<string>();
  for (const row of locationRows) {
    if (!row.city || seenCities.has(row.city)) continue;
    seenCities.add(row.city);
    suggestions.push({ type: 'location', label: row.city, value: row.city });
    if (seenCities.size >= 5) break;
  }

  return dedupe(suggestions).slice(0, AUTOCOMPLETE_MAX_SUGGESTIONS);
}
