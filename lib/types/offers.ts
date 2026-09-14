/**
 * Spec 018 §3 "Request and response types" — offer system & 2-minute timer.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`.
 */
import type { OFFER_STATUSES } from '@/lib/db/schema';

/** Master spec §125 offer vocabulary. `revised` is RESERVED for spec 019 and never written here. */
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** `draft` never leaves the creating transaction, so it is never returned by any endpoint. */
export type VisibleOfferStatus = Exclude<OfferStatus, 'draft'>;

export interface CreateOfferRequest {
  requestId: string;
  /** Positive integer, ≤ 2_147_483_647. Master spec §132.5 — never a float. */
  priceAmountMinorUnits: number;
  /** `^[A-Z]{3}$`; must equal the request budget's currency when the request has a budget. */
  currencyCode: string;
  /** 0–20 items, each trimmed 1–200 chars. Defaults to `[]`. */
  includedItems?: string[];
  /** ≤ 1000 chars; trimmed; empty string stored as null. */
  providerMessage?: string | null;
  /** Integer 1–1440. */
  estimatedDurationMinutes?: number | null;
}

export interface OfferDto {
  id: string;
  requestId: string;
  providerProfileId: string;
  /** `provider_profiles.business_name`; null when unset or after deletion anonymization. */
  providerBusinessName: string | null;
  /** EFFECTIVE status: a stored `sent`/`viewed` row whose `expires_at` has passed is reported as
   *  `expired`, even before the cron job persists it (AC-3). */
  status: VisibleOfferStatus;
  priceAmountMinorUnits: number;
  currencyCode: string;
  includedItems: string[];
  providerMessage: string | null;
  estimatedDurationMinutes: number | null;
  sentAt: string;
  /** Authoritative, database-computed: exactly `sentAt + 2 minutes`. */
  expiresAt: string;
  viewedAt: string | null;
  /** Set for accepted / declined / withdrawn; null for live and expired offers. */
  decidedAt: string | null;
  /** The database clock at read time — lets a client offset its cosmetic countdown for local clock
   *  drift. Never used by the server for any decision. */
  serverNow: string;
  version: number;
}

/** Spec 018 §3 "Provider inbox integration" — the caller's own most recent offer on a request. */
export interface CurrentOfferSummary {
  offerId: string;
  status: VisibleOfferStatus;
  expiresAt: string;
  serverNow: string;
}
