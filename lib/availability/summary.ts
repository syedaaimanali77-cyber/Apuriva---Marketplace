/**
 * Spec 016 §3 R9 / AC-5 — the simplified customer-facing availability state (master spec §42).
 *
 * This is the ONLY availability data a non-owner ever sees. It deliberately derives a state and a
 * fixed reason phrase and nothing else: no weekly rows, no override rows, no slot boundaries, no
 * occupied-interval ids, no buffers, no service areas, and not even the provider's timezone —
 * §3 "Public vs owner-only information".
 */
import { getBusyIntervalLoader } from './busy-intervals';
import { getDb } from '@/lib/db';
import { findProviderSchedulingProfile, loadOverrides, loadServiceBuffers, loadWeeklyEntries } from './repository';
import { resolveWindowsForDate } from './resolve';
import { findConflictingInterval, SLOT_GRID_MINUTES } from './slots';
import { addDays, dayOfWeekOf, utcToZoned, zonedDateTimeToUtc } from './timezone';
import { providerNotFoundError } from './errors';
import type { AvailabilitySummaryDto } from '@/lib/types/availability';

/** R9's fixed phrases. Each states a cause without leaking a schedule detail. */
export const AVAILABILITY_REASONS = {
  notAcceptingWork: 'Not accepting work right now',
  noSchedule: 'No working hours set yet',
  dayBlocked: 'Not working today',
  outsideHours: 'Outside working hours',
  fullyBooked: 'Fully booked today',
  available: 'Available now',
} as const;

/** How far ahead `nextAvailableDate` looks before giving up and returning null. */
const LOOKAHEAD_DAYS = 30;

/** A default duration for the "is any slot left today" probe — R9 is a coarse state, not a booking. */
const PROBE_DURATION_MINUTES = SLOT_GRID_MINUTES;

/**
 * R9 — resolved at request time against the provider's GLOBAL schedule (never per service).
 *
 * `unavailable`: no weekly entries at all, today overridden unavailable, or the profile's
 * lifecycle status is not `active`. `busy`: inside a declared window right now, but every
 * remaining slot today is taken. `available`: otherwise.
 */
export async function getAvailabilitySummary(providerProfileId: string, now = new Date()): Promise<AvailabilitySummaryDto> {
  const profile = await findProviderSchedulingProfile(providerProfileId);
  if (!profile) throw providerNotFoundError();

  // A provider who is not `active` stays DISCOVERABLE (AC-5) — the profile still resolves; only
  // the state says they cannot be booked.
  if (profile.lifecycleStatus !== 'active') {
    return { state: 'unavailable', reason: AVAILABILITY_REASONS.notAcceptingWork, nextAvailableDate: null };
  }

  const weekly = await loadWeeklyEntries(providerProfileId);
  if (weekly.length === 0) {
    return { state: 'unavailable', reason: AVAILABILITY_REASONS.noSchedule, nextAvailableDate: null };
  }

  const today = utcToZoned(now, profile.timezone);
  const horizon = addDays(today.date, LOOKAHEAD_DAYS);
  const overrides = await loadOverrides(providerProfileId, { from: today.date, to: horizon });
  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));
  const buffers = await loadServiceBuffers(providerProfileId);

  const db = getDb();
  const busy = await getBusyIntervalLoader()(db, providerProfileId, {
    from: now,
    to: zonedDateTimeToUtc(horizon, 1440, profile.timezone),
  });

  const todayOverride = overridesByDate.get(today.date);
  const todayWindows = resolveWindowsForDate(today.dayOfWeek, weekly, todayOverride);
  const nextAvailableDate = findNextAvailableDate({
    fromDate: today.date,
    horizon,
    timezone: profile.timezone,
    weekly,
    overridesByDate,
    busy,
    buffers,
    now,
  });

  if (todayOverride && !todayOverride.isAvailable) {
    return { state: 'unavailable', reason: AVAILABILITY_REASONS.dayBlocked, nextAvailableDate };
  }

  const insideWindowNow = todayWindows.some(
    (window) => today.minuteOfDay >= window.startMinute && today.minuteOfDay < window.endMinute,
  );

  const hasFreeSlotToday = nextAvailableDate === today.date;
  if (hasFreeSlotToday) {
    return { state: 'available', reason: AVAILABILITY_REASONS.available, nextAvailableDate };
  }

  // Inside declared hours but nothing left today = busy; outside them = unavailable. Both keep
  // the provider discoverable; only the reason differs (AC-5).
  return insideWindowNow
    ? { state: 'busy', reason: AVAILABILITY_REASONS.fullyBooked, nextAvailableDate }
    : { state: 'unavailable', reason: AVAILABILITY_REASONS.outsideHours, nextAvailableDate };
}

function findNextAvailableDate(input: {
  fromDate: string;
  horizon: string;
  timezone: string;
  weekly: Awaited<ReturnType<typeof loadWeeklyEntries>>;
  overridesByDate: Map<string, { date: string; isAvailable: boolean; startMinute: number | null; endMinute: number | null }>;
  busy: Awaited<ReturnType<ReturnType<typeof getBusyIntervalLoader>>>;
  buffers: Awaited<ReturnType<typeof loadServiceBuffers>>;
  now: Date;
}): string | null {
  for (let date = input.fromDate; date <= input.horizon; date = addDays(date, 1)) {
    const windows = resolveWindowsForDate(dayOfWeekOf(date), input.weekly, input.overridesByDate.get(date));

    for (const window of windows) {
      for (let minute = window.startMinute; minute + PROBE_DURATION_MINUTES <= window.endMinute; minute += SLOT_GRID_MINUTES) {
        const startAt = zonedDateTimeToUtc(date, minute, input.timezone);
        if (startAt.getTime() < input.now.getTime()) continue; // a slot already past is not "next".
        const endAt = zonedDateTimeToUtc(date, minute + PROBE_DURATION_MINUTES, input.timezone);
        if (!findConflictingInterval({ startAt, endAt }, input.busy, input.buffers)) return date;
      }
    }
  }
  return null;
}
