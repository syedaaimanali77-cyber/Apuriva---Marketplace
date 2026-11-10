/**
 * Spec 016 §3 "Request and response types" — provider availability & service areas.
 *
 * This repository has no `packages/types`; every DTO lives under `lib/types/*`, the same as
 * spec 012's `location.ts` and spec 015's `requests.ts`.
 */

/** Minutes from local midnight, 0–1440. 1440 is only ever an end boundary ("to midnight"). */
export type MinuteOfDay = number;

/** 0 = Sunday, matching JS `Date#getDay()`. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type AvailabilityState = 'available' | 'busy' | 'unavailable';

/**
 * Spec 016 §3 "Public vs owner-only information" / AC-5 — the ONLY availability shape a non-owner
 * ever receives (master spec §42). Deliberately carries no weekly rows, override rows, slot
 * boundaries, booking ids, buffers, service areas or the provider's timezone.
 */
export interface AvailabilitySummaryDto {
  state: AvailabilityState;
  /** Always present — AC-5 forbids a bare state with no explanation (master spec §3.5). */
  reason: string;
  /** Local calendar date (YYYY-MM-DD) in the provider's scheduling timezone, or null. */
  nextAvailableDate: string | null;
}

export interface WeeklyScheduleEntry {
  dayOfWeek: DayOfWeek;
  startMinute: MinuteOfDay;
  endMinute: MinuteOfDay;
}

export interface WeeklyScheduleDto {
  /** IANA identifier, e.g. "Asia/Karachi". */
  timezone: string;
  entries: WeeklyScheduleEntry[];
  version: number;
}

export interface WeeklyScheduleRequest {
  timezone: string;
  entries: WeeklyScheduleEntry[];
  /** Optimistic concurrency (spec 003 AC-6); omitted only on the first save. */
  expectedVersion?: number;
}

export interface OverrideDto {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  isAvailable: boolean;
  startMinute: MinuteOfDay | null;
  endMinute: MinuteOfDay | null;
}

export interface CreateOverrideRequest {
  date: string;
  isAvailable: boolean;
  startMinute?: MinuteOfDay | null;
  endMinute?: MinuteOfDay | null;
}

export type UpdateOverrideRequest = Omit<CreateOverrideRequest, 'date'>;

export type SlotBlockedBy = 'booking' | 'override' | 'outside_schedule';

export interface SlotDto {
  /** UTC instant of the slot start. */
  startAt: string;
  endAt: string;
  /** false when a booking (widened by buffers), an override, or the schedule blocks it. */
  available: boolean;
  blockedBy: SlotBlockedBy | null;
}

export type ServiceAreaMode = 'radius' | 'cities' | 'remote';

export interface ServiceAreaDto {
  /** null = the provider's global default, applied to every service with no row of its own. */
  serviceId: string | null;
  mode: ServiceAreaMode;
  radiusKm: number | null;
  centerAddressId: string | null;
  /** Owner-only, and never exact coordinates — spec 012's privacy rule (`lib/location/privacy.ts`). */
  centerApproxAreaLabel: string | null;
  cities: string[] | null;
}

export interface ServiceAreaRequest {
  serviceId?: string | null;
  mode: ServiceAreaMode;
  /** Integer 1–500, required when mode = 'radius'. */
  radiusKm?: number;
  /** Required when mode = 'radius'; must be an address owned by the caller. */
  centerAddressId?: string;
  /** 1–50 entries, required when mode = 'cities'. */
  cities?: string[];
}

/** `PUT /providers/me/service-areas` replaces the whole set in one transaction. */
export interface ServiceAreasRequest {
  areas: ServiceAreaRequest[];
}

export type AvailabilityNotifyStatus = 'pending' | 'sent' | 'cancelled';

export interface AvailabilityNotifyDto {
  id: string;
  status: AvailabilityNotifyStatus;
  createdAt: string;
}
