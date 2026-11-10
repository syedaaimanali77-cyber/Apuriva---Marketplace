/**
 * Spec 020 §3 "Slot-conflict alternatives (AC-2)".
 *
 * When the accepted offer's slot is gone at confirmation time, the customer must receive useful,
 * re-submittable alternatives — not a dead end. This module produces them using ONLY spec 016's
 * existing scheduling machinery, driven through the SAME registered `BusyIntervalLoader` the
 * reservation path uses, so alternatives and reservations can never disagree.
 *
 * WHAT IT DOES NOT DO, deliberately (§3):
 *   - it does not re-run spec 017 matching (the request is `provider_selected`, the offer
 *     `accepted`; re-matching would mean unwinding spec 018's single-accept invariant);
 *   - it does not surface the request's other offers (`offers_request_accepted_uq` makes a second
 *     accept impossible, so they are not actionable);
 *   - it is not a slot browser: it never returns a window boundary, buffer, booking id, booking
 *     count or service area, and every instant it returns is the CUSTOMER'S OWN requested
 *     time-of-day on a later date — so it reveals nothing they could not learn by repeating at most
 *     `ALTERNATIVE_LOOKAHEAD_DAYS` booking attempts.
 *
 * It runs AFTER the booking transaction has rolled back, as a read-only computation on the pooled
 * handle, so it never extends or re-takes the provider row lock.
 */
import { getDb } from '@/lib/db';
import { getBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import {
  findProviderSchedulingProfile,
  loadOverrides,
  loadServiceBuffers,
  loadWeeklyEntries,
} from '@/lib/availability/repository';
import { isWithinAnyWindow, resolveWindowsForDate } from '@/lib/availability/resolve';
import { findConflictingInterval, widestBufferMinutes } from '@/lib/availability/slots';
import { getAvailabilitySummary } from '@/lib/availability/summary';
import { addDays, dayOfWeekOf, utcToZoned, zonedDateTimeToUtc } from '@/lib/availability/timezone';
import type { SlotAlternativeDto, SlotUnavailableDetails } from '@/lib/types/bookings';

/** AC-2 — how far forward the scan looks, in LOCAL calendar days. */
export const ALTERNATIVE_LOOKAHEAD_DAYS = 14;

/** AC-2 — the hard cap on how many alternatives are ever disclosed in one response. */
export const MAX_ALTERNATIVES = 3;

const MS_PER_MINUTE = 60_000;

export interface AlternativesInput {
  providerProfileId: string;
  serviceId: string;
  /** The instant that failed. */
  requestedStartAt: Date;
  durationMinutes: number;
  /** Injectable for unit tests; production passes the real database clock read at the call site. */
  now?: Date;
}

/** `HH:MM` from a minute-of-day, for display and for round-tripping the customer's own time. */
export function formatLocalTimeOfDay(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * The full `details` payload of `422 SLOT_NO_LONGER_AVAILABLE`. Always returns a complete object —
 * never an empty body — even when nothing qualifies: `alternatives: []` plus spec 016's coarse,
 * already-public `nextAvailableDate`.
 *
 * A provider whose profile has disappeared, or who has no schedule at all, yields an empty list
 * rather than throwing: the customer's booking attempt has already failed, and turning the error
 * response itself into a 500 would be strictly worse for them.
 */
export async function buildSlotUnavailableDetails(input: AlternativesInput): Promise<SlotUnavailableDetails> {
  const { providerProfileId, requestedStartAt, durationMinutes } = input;
  const now = input.now ?? new Date();

  const profile = await findProviderSchedulingProfile(providerProfileId);
  if (!profile) {
    return {
      requestedStartAt: requestedStartAt.toISOString(),
      durationMinutes,
      scheduledTimezone: 'UTC',
      alternatives: [],
      nextAvailableDate: null,
    };
  }

  const requestedLocal = utcToZoned(requestedStartAt, profile.timezone);
  const alternatives = await findAlternatives({ ...input, now, timezone: profile.timezone, requestedLocal });

  return {
    requestedStartAt: requestedStartAt.toISOString(),
    durationMinutes,
    scheduledTimezone: profile.timezone,
    alternatives,
    // Only consulted when nothing qualified — spec 016's public summary is a coarse DATE and is
    // already readable by any non-owner through `GET /providers/{id}/availability`.
    nextAvailableDate: alternatives.length > 0 ? null : await safeNextAvailableDate(providerProfileId, now),
  };
}

async function safeNextAvailableDate(providerProfileId: string, now: Date): Promise<string | null> {
  try {
    return (await getAvailabilitySummary(providerProfileId, now)).nextAvailableDate;
  } catch {
    return null;
  }
}

/**
 * The scan itself. Same provider, same service, same duration, same local time-of-day, one
 * candidate per subsequent local date, earliest first, capped at `MAX_ALTERNATIVES`.
 *
 * The scan starts at the failed date **+ 1 day**: the same time-of-day on the same date IS the
 * instant that just failed, so it can never qualify.
 */
async function findAlternatives(input: {
  providerProfileId: string;
  serviceId: string;
  durationMinutes: number;
  now: Date;
  timezone: string;
  requestedLocal: { date: string; minuteOfDay: number };
}): Promise<SlotAlternativeDto[]> {
  const { providerProfileId, durationMinutes, now, timezone, requestedLocal } = input;

  const weekly = await loadWeeklyEntries(providerProfileId);
  if (weekly.length === 0) return [];

  const firstDate = addDays(requestedLocal.date, 1);
  const lastDate = addDays(requestedLocal.date, ALTERNATIVE_LOOKAHEAD_DAYS);

  const [overrides, buffers] = await Promise.all([
    loadOverrides(providerProfileId, { from: firstDate, to: lastDate }),
    loadServiceBuffers(providerProfileId),
  ]);
  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));

  // One busy load for the whole horizon, widened by the largest configured buffer exactly as
  // `reserveProviderSlot` does, so an interval whose buffer reaches into a candidate is still seen.
  const margin = (widestBufferMinutes(buffers) + durationMinutes) * MS_PER_MINUTE;
  const horizonStart = zonedDateTimeToUtc(firstDate, requestedLocal.minuteOfDay, timezone);
  const horizonEnd = zonedDateTimeToUtc(lastDate, requestedLocal.minuteOfDay + durationMinutes, timezone);
  const busy = await getBusyIntervalLoader()(getDb(), providerProfileId, {
    from: new Date(horizonStart.getTime() - margin),
    to: new Date(horizonEnd.getTime() + margin),
  });

  const endMinute = requestedLocal.minuteOfDay + durationMinutes;
  const found: SlotAlternativeDto[] = [];

  for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) {
    if (found.length >= MAX_ALTERNATIVES) break;

    // A candidate crossing local midnight would need a window on the following date too; spec 016
    // R5 keeps every window inside one local date, so such a candidate can never be available.
    if (endMinute > 1440) continue;

    const windows = resolveWindowsForDate(dayOfWeekOf(date), weekly, overridesByDate.get(date));
    if (!isWithinAnyWindow(windows, requestedLocal.minuteOfDay, endMinute)) continue;

    const startAt = zonedDateTimeToUtc(date, requestedLocal.minuteOfDay, timezone);
    if (startAt.getTime() < now.getTime()) continue; // never offer a time already past.

    const candidate = { startAt, endAt: new Date(startAt.getTime() + durationMinutes * MS_PER_MINUTE) };
    if (findConflictingInterval(candidate, busy, buffers)) continue;

    found.push({
      startAt: startAt.toISOString(),
      scheduledTimezone: timezone,
      localDate: date,
      localTimeOfDay: formatLocalTimeOfDay(requestedLocal.minuteOfDay),
    });
  }

  return found;
}
