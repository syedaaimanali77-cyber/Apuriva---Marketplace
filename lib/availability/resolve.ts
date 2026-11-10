/**
 * Spec 016 §3 "Schedule resolution" — rules R2, R3, R5, R6. Pure functions over plain values:
 * no database access, no clock, no I/O, so every rule is unit-testable exactly as written.
 *
 * R1 (timezone) lives in ./timezone.ts; R7/R8 (slots and buffers) in ./slots.ts.
 */
import { invalidScheduleRangeError, type FieldError } from './errors';
import { isValidTimeZone } from './timezone';
import type { MinuteOfDay, WeeklyScheduleEntry } from '@/lib/types/availability';

/** R2/R6: a start may not be 1440 (a zero-length window is meaningless); an end may. */
export const MIN_MINUTE = 0;
export const MAX_MINUTE = 1440;

/** A resolved availability window for one local date, in minutes from local midnight. */
export interface ResolvedWindow {
  startMinute: MinuteOfDay;
  endMinute: MinuteOfDay;
}

/** The override row shape resolution needs — a subset of `provider_availability_overrides`. */
export interface OverrideRecord {
  date: string;
  isAvailable: boolean;
  startMinute: MinuteOfDay | null;
  endMinute: MinuteOfDay | null;
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * R2/R5/R6 — validates the WHOLE weekly set at once and throws a single
 * `422 INVALID_SCHEDULE_RANGE` naming every offending entry, rather than failing on the first.
 *
 * R5 (no cross-midnight window) needs no separate check: a window is expressed as two minutes
 * within one local day, and `endMinute <= 1440` means it can never run past local midnight. A
 * client trying to express 22:00–02:00 as `{ start: 1320, end: 120 }` is caught by the
 * `start < end` rule below, which is exactly the R5 rejection.
 */
export function validateWeeklyEntries(entries: WeeklyScheduleEntry[]): void {
  const errors: FieldError[] = [];

  entries.forEach((entry, index) => {
    if (!isWholeNumber(entry.dayOfWeek) || entry.dayOfWeek < 0 || entry.dayOfWeek > 6) {
      errors.push({ field: `entries[${index}].dayOfWeek`, message: 'must be an integer from 0 (Sunday) to 6.' });
    }
    if (!isWholeNumber(entry.startMinute) || entry.startMinute < MIN_MINUTE || entry.startMinute >= MAX_MINUTE) {
      errors.push({ field: `entries[${index}].startMinute`, message: 'must be an integer from 0 to 1439.' });
    }
    if (!isWholeNumber(entry.endMinute) || entry.endMinute <= MIN_MINUTE || entry.endMinute > MAX_MINUTE) {
      errors.push({ field: `entries[${index}].endMinute`, message: 'must be an integer from 1 to 1440.' });
    }
    if (
      isWholeNumber(entry.startMinute) &&
      isWholeNumber(entry.endMinute) &&
      entry.endMinute <= entry.startMinute
    ) {
      errors.push({
        field: `entries[${index}].endMinute`,
        message:
          'must be after startMinute. A window may not run past local midnight — express 22:00–02:00 as two entries, one ending at 1440 and one starting at 0 on the next day.',
      });
    }
  });

  // R2: entries on the same day may not overlap OR touch. Only run once every entry is
  // individually well-formed, so a malformed entry cannot produce a confusing second error.
  if (errors.length === 0) {
    const byDay = new Map<number, { entry: WeeklyScheduleEntry; index: number }[]>();
    entries.forEach((entry, index) => {
      const bucket = byDay.get(entry.dayOfWeek) ?? [];
      bucket.push({ entry, index });
      byDay.set(entry.dayOfWeek, bucket);
    });

    for (const bucket of byDay.values()) {
      const sorted = [...bucket].sort((a, b) => a.entry.startMinute - b.entry.startMinute);
      for (let i = 1; i < sorted.length; i += 1) {
        const previous = sorted[i - 1]!;
        const current = sorted[i]!;
        if (current.entry.startMinute <= previous.entry.endMinute) {
          errors.push({
            field: `entries[${current.index}].startMinute`,
            message: `overlaps or touches entries[${previous.index}] on the same day. Merge touching windows into one entry.`,
          });
        }
      }
    }
  }

  if (errors.length > 0) throw invalidScheduleRangeError(errors);
}

/** R1/R6 — rejects an unknown IANA identifier as a domain-rule failure. */
export function validateTimeZone(timeZone: string, field = 'timezone'): void {
  if (!isValidTimeZone(timeZone)) {
    throw invalidScheduleRangeError([{ field, message: 'must be a valid IANA timezone identifier, e.g. "Asia/Karachi".' }]);
  }
}

/**
 * R3/R6 — validates one override's own shape. `isAvailable: false` is a blocked day and must
 * carry no minutes; `isAvailable: true` must carry both and form a valid non-cross-midnight range.
 */
export function validateOverrideShape(override: {
  isAvailable: boolean;
  startMinute?: MinuteOfDay | null;
  endMinute?: MinuteOfDay | null;
}): void {
  const errors: FieldError[] = [];
  const { isAvailable } = override;
  const startMinute = override.startMinute ?? null;
  const endMinute = override.endMinute ?? null;

  if (!isAvailable) {
    if (startMinute !== null) {
      errors.push({ field: 'startMinute', message: 'must be omitted when isAvailable is false — the whole day is blocked.' });
    }
    if (endMinute !== null) {
      errors.push({ field: 'endMinute', message: 'must be omitted when isAvailable is false — the whole day is blocked.' });
    }
  } else {
    if (!isWholeNumber(startMinute) || startMinute < MIN_MINUTE || startMinute >= MAX_MINUTE) {
      errors.push({ field: 'startMinute', message: 'must be an integer from 0 to 1439 when isAvailable is true.' });
    }
    if (!isWholeNumber(endMinute) || endMinute <= MIN_MINUTE || endMinute > MAX_MINUTE) {
      errors.push({ field: 'endMinute', message: 'must be an integer from 1 to 1440 when isAvailable is true.' });
    }
    if (isWholeNumber(startMinute) && isWholeNumber(endMinute) && endMinute <= startMinute) {
      errors.push({
        field: 'endMinute',
        message: 'must be after startMinute; an override window may not run past local midnight.',
      });
    }
  }

  if (errors.length > 0) throw invalidScheduleRangeError(errors);
}

/**
 * R3 — the resolved windows for one local date. **AC-1**: an override for that date WHOLLY
 * REPLACES the weekly pattern. It is never merged, unioned or intersected with the weekly rows:
 * an unavailable override yields no windows at all regardless of what the weekly pattern says,
 * and an available override yields exactly its own single window.
 *
 * `weekly` may contain entries for any day; only the ones matching this date's weekday are used.
 */
export function resolveWindowsForDate(
  dayOfWeek: number,
  weekly: WeeklyScheduleEntry[],
  override: OverrideRecord | undefined,
): ResolvedWindow[] {
  if (override) {
    if (!override.isAvailable) return [];
    return [{ startMinute: override.startMinute!, endMinute: override.endMinute! }];
  }

  return weekly
    .filter((entry) => entry.dayOfWeek === dayOfWeek)
    .map((entry) => ({ startMinute: entry.startMinute, endMinute: entry.endMinute }))
    .sort((a, b) => a.startMinute - b.startMinute);
}

/**
 * R7 — half-open containment: `[startMinute, endMinute)` must fall entirely inside ONE window.
 * A candidate ending exactly when a window ends is inside it; one spanning two adjacent windows
 * is not (R2 forbids adjacent windows anyway, so this can only mean a genuine gap).
 */
export function isWithinAnyWindow(windows: ResolvedWindow[], startMinute: number, endMinute: number): boolean {
  return windows.some((window) => startMinute >= window.startMinute && endMinute <= window.endMinute);
}
