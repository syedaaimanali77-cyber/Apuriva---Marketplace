/**
 * Spec 029 §3 "Ranking" — the provider rating aggregate, and the ONLY thing spec 017 consumes.
 *
 * This module produces DATA. It contains no ranking logic, no weight, no renormalization and no
 * comparison between providers: spec 017 owns all of that, and neither `lib/matching/ranking.ts`
 * nor `lib/matching/weights.ts` is touched by this spec. The value reaches spec 017 through the
 * `ProviderRatingSource` port (`lib/matching/rating-source.ts`), whose default — `null` for every
 * provider — is spec 017's existing behaviour, so rolling spec 029 back changes nothing there.
 *
 * VISIBLE MEANS `published` + `flagged`. A flagged review counts toward the aggregate until a human
 * resolves it, and that is deliberate: excluding it would be an automatic, invisible ranking
 * penalty applied by a heuristic, which is exactly what master §52 forbids (§8 risk 7).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { ProviderRatingAggregate } from '@/lib/types/reviews';
import { VISIBLE_REVIEW_SQL } from './read';

const EMPTY: ProviderRatingAggregate = { average: 0, count: 0 };

/**
 * One batched query for a whole matching pool — never N queries in a loop.
 *
 * A provider with no visible review is ABSENT from the returned map rather than present with zero:
 * "not yet rated" and "rated zero" are different facts, and spec 017 excludes a `null` factor from
 * both the numerator and the denominator so that nobody is penalised for something nobody can
 * measure. Returning 0 here would silently invert that.
 */
export async function getProviderRatingAggregates(
  providerProfileIds: readonly string[],
  tx?: Executor,
): Promise<Map<string, ProviderRatingAggregate>> {
  const result = new Map<string, ProviderRatingAggregate>();
  const ids = [...new Set(providerProfileIds)].filter((id) => typeof id === 'string' && isUuid(id));
  if (ids.length === 0) return result;

  const rows = await queryRows<{ provider_profile_id: string; average: string | number; count: number }>(
    tx ?? getDb(),
    sql`SELECT r.provider_profile_id,
               avg(r.rating)::numeric AS average,
               count(*)::int AS count
          FROM reviews r
         WHERE r.provider_profile_id IN (${sql.join(
           ids.map((id) => sql`${id}`),
           sql`, `,
         )})
           AND ${VISIBLE_REVIEW_SQL}
         GROUP BY r.provider_profile_id`,
  );

  for (const row of rows) {
    result.set(row.provider_profile_id, {
      // One decimal place, matching exactly what `ui/components/marketplace/Rating` renders. A
      // precision the UI cannot display would be a number nobody could verify.
      average: Math.round(Number(row.average) * 10) / 10,
      count: row.count,
    });
  }
  return result;
}

/** Single-provider convenience for `GET /providers/{id}/reviews`'s `meta`. */
export async function getProviderRatingAggregate(
  providerProfileId: string,
  tx?: Executor,
): Promise<ProviderRatingAggregate> {
  const map = await getProviderRatingAggregates([providerProfileId], tx);
  return map.get(providerProfileId) ?? EMPTY;
}
