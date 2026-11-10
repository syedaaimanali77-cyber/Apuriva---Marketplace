/** Spec 013 §3 Request and response types. */
import type { PriceDisplay } from '@/lib/types/service-page';

export type SearchSort = 'relevance' | 'distance' | 'price_asc' | 'price_desc';

export interface SearchIntentDto {
  serviceId?: string;
  serviceNameRaw?: string;
  area?: string;
  date?: string;
  budgetMaxMinorUnits?: number;
  currencyCode?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface SearchResultDto {
  providerId: string;
  serviceId: string;
  displayName: string;
  /** A coarse, bucketed label ("Under 1 km", "1-5 km", "5-10 km", "10+ km") — never a precise
   * figure computed straight from exact coordinates (spec 012 AC-3). Absent when the provider
   * has no resolvable location or no `lat`/`lng` was supplied to the search. */
  approxDistance?: string;
  /** Absent until the provider has at least one rating — spec 029 (reviews & ratings, not yet
   * implemented) owns this aggregate. Never fabricated for a provider with none. */
  rating?: number;
  priceDisplay: PriceDisplay;
  badges: string[];
}

export interface AutocompleteSuggestionDto {
  type: 'recent_search' | 'popular_service' | 'category' | 'service' | 'location';
  label: string;
  /** The raw query text for `recent_search`, or an id (`serviceId`/`categoryId`) for the others —
   * `/api/v1/search` accepts either shape via its existing `q`/`serviceId`/`categoryId` params. */
  value: string;
}

export interface RecordRecentSearchRequest {
  q?: string;
  serviceId?: string;
  categoryId?: string;
}
