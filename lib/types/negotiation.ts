/**
 * Spec 019 §3 "Request and response types" — offer negotiation & comparison.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`.
 */
import type { VisibleOfferStatus } from './offers';

export type NegotiationSenderRole = 'customer' | 'provider';
export type OfferMessageKind = 'message' | 'change_request';

export interface SendOfferMessageRequest {
  /** Trimmed, 1–1000 characters (measured before redaction). */
  body: string;
}

export interface CreateChangeRequestRequest {
  /** Trimmed, 1–500 characters (measured before redaction). */
  note: string;
  /** Optional positive integer ≤ 2_147_483_647, in the offer's own currency. Never a float. */
  proposedPriceAmountMinorUnits?: number | null;
}

/** Full replacement terms — the same bounds as spec 018's `CreateOfferRequest`, minus `requestId`. */
export interface ReviseOfferRequest {
  priceAmountMinorUnits: number;
  /** Must equal the source offer's currency. */
  currencyCode: string;
  includedItems?: string[];
  providerMessage?: string | null;
  estimatedDurationMinutes?: number | null;
}

export interface MoneyAmount {
  amountMinorUnits: number;
  currencyCode: string;
}

export interface OfferMessageDto {
  id: string;
  requestId: string;
  providerProfileId: string;
  /** Set only for `change_request`: the offer row the change was requested on. */
  offerId: string | null;
  kind: OfferMessageKind;
  senderRole: NegotiationSenderRole;
  /** The stored, already-redacted text. */
  body: string;
  contactRedacted: boolean;
  /** `change_request` only; currency is the offer's. */
  proposedPrice: MoneyAmount | null;
  createdAt: string;
}

export interface MessageThreadSummaryDto {
  providerProfileId: string;
  providerBusinessName: string | null;
  /** The provider's head offer on this request, if any (effective status). */
  headOffer: { offerId: string; status: VisibleOfferStatus } | null;
  messageCount: number;
  lastMessageAt: string | null;
  /** false when AC-8 closes the thread for sending. */
  canSend: boolean;
}

export interface OfferRevisionDto {
  id: string;
  /** The superseded source row. */
  previousOfferId: string;
  /** The new row created by the revision. */
  offerId: string;
  /** 1–5, per (request, provider). */
  revisionNumber: number;
  previousPrice: MoneyAmount;
  newPrice: MoneyAmount;
  actorRole: 'provider';
  /** The change request that prompted it, if the source offer had one. */
  changeRequestMessageId: string | null;
  createdAt: string;
}

export type ComparisonUnavailableReason =
  | 'fewer_than_two_comparable_offers'
  | 'request_not_open_for_offers'
  | 'pricing_model_not_offer_based';

/** Closed set. The UI maps each code to fixed copy (§5); the server never returns prose. */
export type WhyThisProviderReason = 'top_match' | 'available_at_requested_time' | 'nearby';

/** Closed set. `verified` = spec 017 `isVerified` (`provider_profiles.lifecycle_status = 'active'`). */
export type ProviderBadge = 'verified';

export type AvailabilityFit = 'exact' | 'same_day';

export interface ComparedOfferDto {
  offerId: string;
  providerProfileId: string;
  providerBusinessName: string | null;
  status: Extract<VisibleOfferStatus, 'sent' | 'viewed'>;
  priceAmountMinorUnits: number;
  currencyCode: string;
  /** The immediately previous row's price when this offer is a revision; else null. */
  previousPriceAmountMinorUnits: number | null;
  revisionNumber: number;
  includedItems: string[];
  providerMessage: string | null;
  estimatedDurationMinutes: number | null;
  /** From the stored `availability` factor at distribution time: 1 → 'exact', 0.5 → 'same_day', else null. */
  availabilityFit: AvailabilityFit | null;
  /** Spec 017's coarse `approxKm`; null when either point is unknown. Never coordinates. */
  approxDistanceKm: number | null;
  /** Always null until spec 029 ships a ratings source. */
  rating: { average: number; count: number } | null;
  badges: ProviderBadge[];
  isTopMatch: boolean;
  whyThisProvider: WhyThisProviderReason[];
  expiresAt: string;
}

export interface OfferComparisonDto {
  requestId: string;
  available: boolean;
  unavailableReason: ComparisonUnavailableReason | null;
  /** 2–3 entries when available; [] otherwise. Canonical order. */
  offers: ComparedOfferDto[];
  maxOffers: 3;
  serverNow: string;
}
