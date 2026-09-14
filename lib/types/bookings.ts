/**
 * Spec 020 §3 "Request and response types" — booking creation & state machine.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`, the same as
 * spec 016's `availability.ts`, spec 018's `offers.ts` and spec 019's `negotiation.ts`.
 *
 * Every DTO here exposes PROFILE ids, never user ids — the same identifiers specs 015–019 already
 * expose, so a counterparty's `users.id` never reaches a client.
 */
import type { BOOKING_STATUSES } from '@/lib/db/schema';

/** Master spec §125's booking vocabulary. Authored once, in `lib/db/schema.ts`. */
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Who caused a transition. `system` is spec 021's payment-driven `protected`/`settled` only. */
export type BookingActorRole = 'customer' | 'provider' | 'system';

export interface CreateBookingRequest {
  offerId: string;
  /**
   * ISO-8601 instant. Optional: defaults to the request's `preferredAt`. Required (400) when the
   * request has none. Also how a customer retries with one of AC-2's returned alternatives.
   */
  scheduledAt?: string;
}

export interface BookingDto {
  id: string;
  requestId: string;
  offerId: string;
  serviceId: string;
  customerProfileId: string;
  providerProfileId: string;
  status: BookingStatus;
  /** UTC instant, paired with the IANA zone it is local to (spec 003 AC-2). */
  scheduledAt: string;
  /** The provider's `scheduling_timezone` — the zone the slot was validated in (spec 016 R1). */
  scheduledTimezone: string;
  durationMinutes: number;
  priceAmountMinorUnits: number;
  currencyCode: string;
  /** The operational address, revealed to each party under spec 012's rules. */
  addressId: string;
  createdAt: string;
  updatedAt: string;
  /** Optimistic-concurrency token (spec 003 AC-6). */
  version: number;
}

export type BookingListFilter = 'upcoming' | 'active' | 'completed' | 'cancelled' | 'disputed';

export interface BookingSummaryDto {
  id: string;
  status: BookingStatus;
  scheduledAt: string;
  scheduledTimezone: string;
  serviceName: string;
  /** The *counterparty's* display name for the caller's role. Never a user id. */
  counterpartyName: string | null;
  priceAmountMinorUnits: number;
  currencyCode: string;
}

export interface BookingStatusHistoryDto {
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  /** Role only — `actor_user_id` is never exposed to a client (§4 "Retention and privacy"). */
  actorRole: BookingActorRole;
  occurredAt: string;
}

/** One re-submittable alternative start time (AC-2). */
export interface SlotAlternativeDto {
  /** Submit unchanged as `scheduledAt` on a retry. */
  startAt: string;
  scheduledTimezone: string;
  /** YYYY-MM-DD in `scheduledTimezone`. */
  localDate: string;
  /** HH:MM — always the customer's OWN requested time-of-day, never a discovered one. */
  localTimeOfDay: string;
}

/** `details` of `422 SLOT_NO_LONGER_AVAILABLE` (AC-2). */
export interface SlotUnavailableDetails {
  requestedStartAt: string;
  durationMinutes: number;
  scheduledTimezone: string;
  /** 0–3, earliest first. */
  alternatives: SlotAlternativeDto[];
  /** Spec 016's coarse public field; the fallback when `alternatives` is empty. */
  nextAvailableDate: string | null;
}
