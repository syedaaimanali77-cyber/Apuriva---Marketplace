/**
 * `search_services` — spec 013's `searchServices`, the sole authoritative results path (the same
 * function `GET /api/v1/search` calls). Low risk, read-only (master spec §87 "Search").
 * `searchServices` validates the parameters itself (spec 013), so the domain's own error surfaces.
 */
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/pagination';
import { searchServices } from '@/lib/search/query';
import type { SearchResultDto, SearchSort } from '@/lib/types/search';
import type { ToolField } from '../fields';
import { defineTool } from '../tool';

/** Spec 013's `SearchSort`, checked exhaustively against the type at compile time. */
const SORTS = ['relevance', 'distance', 'price_asc', 'price_desc'] as const satisfies readonly SearchSort[];
type MissingSort = Exclude<SearchSort, (typeof SORTS)[number]>;
const sortsAreExhaustive: MissingSort extends never ? true : never = true;
void sortsAreExhaustive;

const FIELDS: readonly ToolField[] = [
  { name: 'q', kind: 'text', required: false },
  { name: 'serviceId', kind: 'uuid', required: false },
  { name: 'categoryId', kind: 'uuid', required: false },
  { name: 'lat', kind: 'number', required: false },
  { name: 'lng', kind: 'number', required: false },
  { name: 'radiusKm', kind: 'number', required: false },
  { name: 'budgetMaxMinorUnits', kind: 'minorUnits', required: false },
  { name: 'date', kind: 'date', required: false },
  { name: 'sort', kind: 'enum', required: false, values: SORTS },
  { name: 'limit', kind: 'integer', required: false, min: 1, max: MAX_PAGE_LIMIT },
  { name: 'offset', kind: 'integer', required: false, min: 0 },
];

interface Input extends Record<string, unknown> {
  q?: string;
  serviceId?: string;
  categoryId?: string;
  lat?: number;
  lng?: number;
  radiusKm?: number;
  budgetMaxMinorUnits?: number;
  date?: string;
  sort?: SearchSort;
  limit?: number;
  offset?: number;
}

export const searchServicesTool = defineTool<Input, { items: SearchResultDto[]; total: number }>({
  name: 'search_services',
  label: 'Search services',
  riskTier: 'low',
  reversible: false,
  modes: ['customer', 'provider'],
  stateChanging: false,
  fields: FIELDS,
  async run(input) {
    const { limit, offset, ...params } = input;
    return searchServices(params, { limit: limit ?? DEFAULT_PAGE_LIMIT, offset: offset ?? 0 });
  },
  summarize: () => null,
});
