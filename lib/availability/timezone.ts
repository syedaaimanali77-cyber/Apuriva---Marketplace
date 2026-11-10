/**
 * Spec 016 §3 R1 — local-wall-clock ⇄ UTC conversion in the provider's single IANA
 * `provider_profiles.scheduling_timezone`.
 *
 * Built on `Intl.DateTimeFormat`, which ships with Node's full-ICU build, rather than a date
 * library: the repository has no date dependency and this spec needs exactly two operations.
 * Because every conversion goes through the zone's own rules, DST is handled by construction —
 * spec 016 §3 R1's "follows that zone's DST rules" is not a separate code path.
 */

const MINUTES_PER_DAY = 1440;

export const MINUTES_PER_HOUR = 60;

/** R6: an unknown IANA identifier is a domain-rule failure, not a crash. */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD`, and a real calendar date (rejects 2026-02-30). */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  return {
    year: map.year!,
    month: map.month!,
    day: map.day!,
    // `hour12: false` renders midnight as 24 in some ICU versions.
    hour: map.hour! === 24 ? 0 : map.hour!,
    minute: map.minute!,
    second: map.second!,
  };
}

/** Milliseconds that `timeZone` is ahead of UTC at `instant` (negative west of Greenwich). */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * A local wall-clock date + minute-of-day in `timeZone`, as a UTC instant.
 *
 * The offset depends on the instant we are solving for, so this estimates once and refines once —
 * the standard two-pass approach. A wall-clock time that a DST spring-forward skips resolves to
 * the instant the clock jumps to, which is the only sensible interpretation and never throws.
 */
export function zonedDateTimeToUtc(dateString: string, minuteOfDay: number, timeZone: string): Date {
  const [year, month, day] = dateString.split('-').map(Number) as [number, number, number];
  const dayOffset = Math.floor(minuteOfDay / MINUTES_PER_DAY);
  const withinDay = minuteOfDay - dayOffset * MINUTES_PER_DAY;
  const wallClockAsUtc = Date.UTC(
    year,
    month - 1,
    day + dayOffset,
    Math.floor(withinDay / MINUTES_PER_HOUR),
    withinDay % MINUTES_PER_HOUR,
  );

  const firstGuess = new Date(wallClockAsUtc - zoneOffsetMs(new Date(wallClockAsUtc), timeZone));
  const refinedOffset = zoneOffsetMs(firstGuess, timeZone);
  return new Date(wallClockAsUtc - refinedOffset);
}

export interface ZonedDate {
  /** `YYYY-MM-DD` in the target zone. */
  date: string;
  /** 0 = Sunday, matching `WeeklyScheduleEntry.dayOfWeek`. */
  dayOfWeek: number;
  /** Minutes since local midnight. */
  minuteOfDay: number;
}

/** The local calendar date, weekday and minute-of-day a UTC instant falls on in `timeZone`. */
export function utcToZoned(instant: Date, timeZone: string): ZonedDate {
  const p = partsInZone(instant, timeZone);
  return {
    date: toDateString(p.year, p.month, p.day),
    dayOfWeek: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
    minuteOfDay: p.hour * MINUTES_PER_HOUR + p.minute,
  };
}

function toDateString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Calendar-day arithmetic on a `YYYY-MM-DD` string, independent of any timezone. */
export function addDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return toDateString(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** `dayOfWeek` (0 = Sunday) of a `YYYY-MM-DD` local calendar date. */
export function dayOfWeekOf(dateString: string): number {
  const [year, month, day] = dateString.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Whole days from `from` to `to` (negative when `to` precedes `from`). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Every local calendar date from `from` to `to`, inclusive. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let cursor = from; daysBetween(cursor, to) >= 0; cursor = addDays(cursor, 1)) out.push(cursor);
  return out;
}
