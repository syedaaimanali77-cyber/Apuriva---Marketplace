/** Spec 014 §3 Request and response types. */
import type { SearchResultDto } from '@/lib/types/search'; // reuse, not redefine — the existing
// canonical provider+service listing shape (spec 013). There is no separate "ServiceSummary"
// type anywhere in the codebase; `curated_popular`/`recent_relevant` items are `SearchResultDto`,
// unchanged, rendered with the same `ResultCard` component the search page already uses.

/** New in this spec — no provider-only summary DTO exists elsewhere to reuse (spec 013's
 * `SearchResultDto` is always a provider+service pair). Deliberately minimal: baseline
 * `ProviderProfile` fields plus the same absent-until-reviewed `rating` convention
 * `SearchResultDto` already uses (spec 029 owns the aggregate; never fabricate a rating for an
 * unrated provider). */
export interface ProviderSummaryDto {
  providerId: string;
  businessName: string;
  rating?: number;
}

export interface HomeFeedDto {
  /** Omitted (not present, not a falsy/empty value) until spec 020 (`Booking`) exists in code —
   * see spec 014 §8 risk 4. Clients must treat "key absent" and "no active booking" identically. */
  activeBooking?: { bookingId: string; status: string; summary: string };
  sections: Array<
    | { type: 'curated_popular'; items: SearchResultDto[] }
    | { type: 'recent_relevant'; items: SearchResultDto[]; reason?: string }
    | { type: 'saved_providers'; items: ProviderSummaryDto[] }
  >;
}

export interface PersonalizationSettingsDto {
  personalizationEnabled: boolean;
}

export interface UpdatePersonalizationSettingsRequest {
  personalizationEnabled: boolean;
}
