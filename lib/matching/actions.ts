/**
 * Spec 017 §3 "Provider actions and pricing model" (AC-5).
 *
 * Master spec §26 and the repository's `PRICING_MODELS` define FIVE models — `fixed`, `package`,
 * `hourly`, `quote`, `custom` — not the two AC-5 names, so all five are mapped explicitly here.
 */
import type { AvailableAction, ProviderResponse } from '@/lib/types/matching';

/** Request statuses during which a distributed provider may still act (spec 015 vocabulary). */
export const ACTIONABLE_REQUEST_STATUSES = ['matching', 'offers_open'] as const;

/**
 * AC-5 — the action a provider is offered for a service's pricing model.
 *
 * - `fixed`   → accept: the price is already determined ("fixed/instant" in AC-5).
 * - `package` → accept: a pre-priced bundle; nothing is left to quote.
 * - `hourly`  → accept: the rate is pre-set; the total follows from actual hours at completion.
 * - `quote`   → send_offer: AC-5's "quote-based".
 * - `custom`  → send_offer: bespoke work cannot be accepted at a pre-set price.
 *
 * `send_offer` is a STATE ONLY. Offer creation is spec 018's (`POST /api/v1/offers`); this spec
 * ships no send-offer endpoint, and `POST .../accept` rejects these models rather than silently
 * creating an offer.
 */
export function actionForPricingModel(pricingModel: string): AvailableAction {
  switch (pricingModel) {
    case 'fixed':
    case 'package':
    case 'hourly':
      return 'accept';
    case 'quote':
    case 'custom':
      return 'send_offer';
    default:
      // An unknown model must never imply a binding "Accept". Declining stays available.
      return 'decline_only';
  }
}

export function acceptAllowedForPricingModel(pricingModel: string): boolean {
  return actionForPricingModel(pricingModel) === 'accept';
}

/**
 * AC-5 — what this provider may do right now. Decline is always available while the request is
 * actionable and the provider has not already responded; once they have, or once the request has
 * moved on, only `decline_only` is reported (the UI renders every action disabled).
 */
export function availableActionFor(
  pricingModel: string,
  requestStatus: string,
  providerResponse: ProviderResponse,
): AvailableAction {
  const actionable = (ACTIONABLE_REQUEST_STATUSES as readonly string[]).includes(requestStatus);
  if (!actionable || providerResponse !== 'none') return 'decline_only';
  return actionForPricingModel(pricingModel);
}

export function isActionableStatus(requestStatus: string): boolean {
  return (ACTIONABLE_REQUEST_STATUSES as readonly string[]).includes(requestStatus);
}
