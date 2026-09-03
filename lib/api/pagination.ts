/**
 * Pagination contract — spec 004 AC-6. Every list endpoint reads its page params through
 * `parsePageParams` and builds its `page` envelope field through `buildPage`, so the shape
 * (`limit`, `offset`, `total`, `nextOffset`) is identical across every domain's list endpoints.
 */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export interface PageParams {
  limit: number;
  offset: number;
}

export function parsePageParams(searchParams: URLSearchParams): PageParams {
  const rawLimit = Number(searchParams.get('limit'));
  const rawOffset = Number(searchParams.get('offset'));

  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.trunc(rawLimit), MAX_PAGE_LIMIT) : DEFAULT_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

  return { limit, offset };
}

export function buildPage(
  total: number,
  limit: number,
  offset: number,
): { limit: number; offset: number; total: number; nextOffset: number | null } {
  const nextOffset = offset + limit < total ? offset + limit : null;
  return { limit, offset, total, nextOffset };
}
