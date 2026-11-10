/**
 * Spec 016 §3 R7 (slot boundaries) and R8 (buffers). Pure functions over plain values — no
 * database access — so every boundary case is unit-testable exactly as the rules are written.
 */
import { resolveWindowsForDate, isWithinAnyWindow, type OverrideRecord } from './resolve';
import { dayOfWeekOf, eachDate, zonedDateTimeToUtc } from './timezone';
import type { BusyInterval } from './busy-intervals';
import type { SlotBlockedBy, SlotDto, WeeklyScheduleEntry } from '@/lib/types/availability';

/** R7 — a fixed 30-minute grid aligned to LOCAL midnight, never to a UTC boundary. */
export const SLOT_GRID_MINUTES = 30;

/** Per-service buffers (spec 016 §4 `provider_services`), keyed by `service_id`. */
export interface ServiceBuffers {
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

export type BufferLookup = Map<string, ServiceBuffers>;

const MS_PER_MINUTE = 60_000;

/**
 * R8 — widen an already-occupied interval by ITS service's buffers:
 * `[startAt − bufferBefore, endAt + bufferAfter)`. Buffers never widen a schedule window, so a
 * buffer can never make a provider available outside their declared hours.
 *
 * A service with no `provider_services` row contributes no buffer (0/0) rather than throwing:
 * an interval for a service the provider no longer offers still blocks the time it occupies.
 */
export function bufferedInterval(busy: BusyInterval, buffers: BufferLookup): { startAt: Date; endAt: Date } {
  const buffer = buffers.get(busy.serviceId) ?? { bufferBeforeMinutes: 0, bufferAfterMinutes: 0 };
  return {
    startAt: new Date(busy.startAt.getTime() - buffer.bufferBeforeMinutes * MS_PER_MINUTE),
    endAt: new Date(busy.endAt.getTime() + buffer.bufferAfterMinutes * MS_PER_MINUTE),
  };
}

/** R7 — half-open overlap: touching intervals do **not** overlap. */
export function intervalsOverlap(a: { startAt: Date; endAt: Date }, b: { startAt: Date; endAt: Date }): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

/**
 * R7/R8 — the first busy interval (buffer-widened) that the candidate collides with, or
 * `undefined` when the candidate is free. Returning the interval rather than a boolean is what
 * lets `SLOT_OVERLAP` name the conflicting window to the owning provider.
 */
export function findConflictingInterval(
  candidate: { startAt: Date; endAt: Date },
  busy: BusyInterval[],
  buffers: BufferLookup,
): BusyInterval | undefined {
  return busy.find((interval) => intervalsOverlap(candidate, bufferedInterval(interval, buffers)));
}

export interface GenerateSlotsInput {
  /** Local calendar dates, inclusive, in `timezone`. */
  from: string;
  to: string;
  timezone: string;
  weekly: WeeklyScheduleEntry[];
  overrides: OverrideRecord[];
  /** The service being scheduled — its duration and its buffers. */
  serviceId: string;
  durationMinutes: number;
  busy: BusyInterval[];
  buffers: BufferLookup;
}

/**
 * R7 — every 30-minute grid position across the requested local dates, each marked available or
 * blocked with the reason. A candidate is available only when the whole
 * `[start, start + durationMinutes)` interval falls inside ONE resolved window for that date and
 * collides with no buffer-widened busy interval.
 *
 * `blockedBy` distinguishes the three causes the DTO declares: `override` when an override
 * removed the day's availability, `outside_schedule` when the weekly pattern does not cover it,
 * and `booking` when an occupied interval does.
 */
export function generateSlots(input: GenerateSlotsInput): SlotDto[] {
  const overridesByDate = new Map(input.overrides.map((override) => [override.date, override]));
  const slots: SlotDto[] = [];

  for (const date of eachDate(input.from, input.to)) {
    const override = overridesByDate.get(date);
    const windows = resolveWindowsForDate(dayOfWeekOf(date), input.weekly, override);
    // The grid always spans the whole local day, so a caller can see *why* a time is unavailable
    // rather than only seeing the times that happen to be offered.
    const dayBlockedBy: SlotBlockedBy = override ? 'override' : 'outside_schedule';

    for (let startMinute = 0; startMinute < 1440; startMinute += SLOT_GRID_MINUTES) {
      const endMinute = startMinute + input.durationMinutes;
      const startAt = zonedDateTimeToUtc(date, startMinute, input.timezone);
      const endAt = zonedDateTimeToUtc(date, endMinute, input.timezone);

      if (!isWithinAnyWindow(windows, startMinute, endMinute)) {
        slots.push({ startAt: startAt.toISOString(), endAt: endAt.toISOString(), available: false, blockedBy: dayBlockedBy });
        continue;
      }

      const conflict = findConflictingInterval({ startAt, endAt }, input.busy, input.buffers);
      slots.push({
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        available: !conflict,
        blockedBy: conflict ? 'booking' : null,
      });
    }
  }

  return slots;
}

/** The widest buffer configured for any service — how far a load range must reach (R8). */
export function widestBufferMinutes(buffers: BufferLookup): number {
  let widest = 0;
  for (const buffer of buffers.values()) {
    widest = Math.max(widest, buffer.bufferBeforeMinutes, buffer.bufferAfterMinutes);
  }
  return widest;
}
