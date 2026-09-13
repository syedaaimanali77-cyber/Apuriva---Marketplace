/**
 * Spec 017 §3 rule E3 — a **read-only** availability check for matching.
 *
 * Composed from spec 016's EXISTING exported pieces; it duplicates none of that logic and adds
 * nothing to `lib/availability/*`.
 *
 * It deliberately does **NOT** call `reserveProviderSlot()`. That primitive takes a
 * `SELECT ... FOR UPDATE` row lock on the provider — correct for spec 020's booking-confirmation
 * transaction, wrong here: taking a lock per candidate provider during a read-only ranking pass
 * would serialize every matching run against every concurrent booking.
 */
import { getBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { getDb } from '@/lib/db';
import { loadOverrides, loadServiceBuffers, loadWeeklyEntries } from '@/lib/availability/repository';
import { resolveWindowsForDate, isWithinAnyWindow } from '@/lib/availability/resolve';
import { findConflictingInterval, widestBufferMinutes } from '@/lib/availability/slots';
import { addDays, dayOfWeekOf, utcToZoned } from '@/lib/availability/timezone';
import { getAvailabilitySummary } from '@/lib/availability/summary';

const MS_PER_MINUTE = 60_000;

/** How spec 017 §3 scores the `availability` factor as well as gating on it. */
export type AvailabilityFit = 'exact' | 'same_day' | 'none';

/**
 * Is the provider available for `startAt` + `durationMinutes`, in their own scheduling timezone?
 *
 * Returns a three-valued fit rather than a boolean so the ranking factor can distinguish "free at
 * exactly that time" (1.0) from "works that day but not that slot" (0.5) — spec 017 §3's
 * `availability` factor definition.
 */
export async function availabilityFitAt(
  providerProfileId: string,
  timezone: string,
  startAt: Date,
  durationMinutes: number,
): Promise<AvailabilityFit> {
  const local = utcToZoned(startAt, timezone);

  const [weekly, overrides, buffers] = await Promise.all([
    loadWeeklyEntries(providerProfileId),
    loadOverrides(providerProfileId, { from: addDays(local.date, -1), to: addDays(local.date, 1) }),
    loadServiceBuffers(providerProfileId),
  ]);

  const override = overrides.find((row) => row.date === local.date);
  const windows = resolveWindowsForDate(dayOfWeekOf(local.date), weekly, override);
  if (windows.length === 0) return 'none';

  const endMinute = local.minuteOfDay + durationMinutes;
  if (!isWithinAnyWindow(windows, local.minuteOfDay, endMinute)) return 'same_day';

  // The slot is inside a declared window — now check it is not already occupied. Busy intervals
  // come through spec 016's port, so this reads no booking column (spec 020 owns those).
  const endAt = new Date(startAt.getTime() + durationMinutes * MS_PER_MINUTE);
  const margin = (widestBufferMinutes(buffers) + durationMinutes) * MS_PER_MINUTE;
  const busy = await getBusyIntervalLoader()(getDb(), providerProfileId, {
    from: new Date(startAt.getTime() - margin),
    to: new Date(endAt.getTime() + margin),
  });

  return findConflictingInterval({ startAt, endAt }, busy, buffers) ? 'same_day' : 'exact';
}

/**
 * E3 when the request states **no** preferred time (`requests.preferred_at` is nullable in spec
 * 015): fall back to spec 016's coarse customer-facing state.
 *
 * A `busy` provider stays ELIGIBLE — master spec §42 keeps them discoverable and the customer has
 * stated no time, so there is nothing to conflict with.
 */
export async function availabilityFitUnscheduled(providerProfileId: string): Promise<AvailabilityFit> {
  const summary = await getAvailabilitySummary(providerProfileId);
  if (summary.state === 'unavailable') return 'none';
  return summary.state === 'available' ? 'exact' : 'same_day';
}

/** The `availability` ranking-factor value for a fit (spec 017 §3). */
export function availabilityFactorValue(fit: AvailabilityFit): number {
  if (fit === 'exact') return 1;
  return fit === 'same_day' ? 0.5 : 0;
}
