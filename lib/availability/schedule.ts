/**
 * Spec 016 §3 — the owner-facing weekly schedule and date overrides (R1–R6), plus the
 * strand-a-booking guard both write paths share (§8 risk #6).
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerAvailabilities, providerAvailabilityOverrides, providerProfiles } from '@/lib/db/schema';
import { validationError } from '@/lib/api/errors';
import { getBusyIntervalLoader, type Tx } from './busy-intervals';
import {
  overrideAlreadyExistsError,
  overrideNotFoundError,
  scheduleVersionConflictError,
  slotOverlapError,
} from './errors';
import { loadOverrides, loadServiceBuffers, loadWeeklyEntries } from './repository';
import {
  resolveWindowsForDate,
  validateOverrideShape,
  validateTimeZone,
  validateWeeklyEntries,
  type OverrideRecord,
} from './resolve';
import { bufferedInterval, widestBufferMinutes } from './slots';
import { addDays, dayOfWeekOf, isValidDateString, utcToZoned, zonedDateTimeToUtc } from './timezone';
import type {
  CreateOverrideRequest,
  DayOfWeek,
  OverrideDto,
  UpdateOverrideRequest,
  WeeklyScheduleDto,
  WeeklyScheduleRequest,
} from '@/lib/types/availability';

/** R1 — the zone a provider gets before they ever save one (spec 016 §3 R1, Pakistan-first). */
export const DEFAULT_SCHEDULING_TIMEZONE = 'Asia/Karachi';

/** How far ahead a schedule change is checked for stranding an existing commitment. */
const STRAND_CHECK_DAYS = 62;

export async function getWeeklySchedule(providerProfileId: string, version: number, timezone: string): Promise<WeeklyScheduleDto> {
  const entries = await loadWeeklyEntries(providerProfileId);
  return { timezone, entries, version };
}

/**
 * §8 risk #6 — a schedule or override change must never silently invalidate an already-confirmed
 * commitment. Every occupied interval in the look-ahead window is re-tested against the schedule
 * the provider is about to save; any that would no longer fit is a `409 SLOT_OVERLAP`.
 *
 * Live once spec 020 registers its loader (./busy-intervals.ts); until then the default loader
 * returns none, because no booking with a scheduled time can exist yet.
 */
async function assertNoStrandedCommitments(
  tx: Tx,
  providerProfileId: string,
  timezone: string,
  weekly: { dayOfWeek: DayOfWeek; startMinute: number; endMinute: number }[],
  overrides: OverrideRecord[],
): Promise<void> {
  const buffers = await loadServiceBuffers(providerProfileId, tx);
  const now = new Date();
  const margin = widestBufferMinutes(buffers) * 60_000;
  const busy = await getBusyIntervalLoader()(tx, providerProfileId, {
    from: new Date(now.getTime() - margin),
    to: new Date(now.getTime() + STRAND_CHECK_DAYS * 86_400_000 + margin),
  });
  if (busy.length === 0) return;

  const overridesByDate = new Map(overrides.map((override) => [override.date, override]));

  for (const interval of busy) {
    // The buffered interval is what must fit: a commitment whose buffer no longer fits is just
    // as stranded as one whose own time does not.
    const widened = bufferedInterval(interval, buffers);
    const local = utcToZoned(widened.startAt, timezone);
    const endLocal = utcToZoned(widened.endAt, timezone);
    const windows = resolveWindowsForDate(dayOfWeekOf(local.date), weekly, overridesByDate.get(local.date));

    const spansMidnight = endLocal.date !== local.date;
    const endMinute = spansMidnight ? 1440 : endLocal.minuteOfDay;
    const fits = windows.some((window) => local.minuteOfDay >= window.startMinute && endMinute <= window.endMinute);

    if (!fits) {
      throw slotOverlapError(
        `This change would leave an existing commitment on ${local.date} outside your availability (reference ${interval.sourceId}). Cancel or move it first.`,
      );
    }
  }
}

/**
 * `PUT /providers/me/availability/schedule` — replaces the WHOLE weekly set in one transaction
 * (R2's cross-row non-overlap rule can only be enforced against a complete set), guarded by
 * `expectedVersion` (spec 003 AC-6 optimistic concurrency).
 */
export async function putWeeklySchedule(
  providerProfileId: string,
  body: Partial<WeeklyScheduleRequest>,
): Promise<WeeklyScheduleDto> {
  if (!Array.isArray(body.entries)) {
    throw validationError([{ field: 'entries', message: 'is required and must be an array.' }]);
  }
  if (body.expectedVersion !== undefined && !Number.isInteger(body.expectedVersion)) {
    throw validationError([{ field: 'expectedVersion', message: 'must be an integer when provided.' }]);
  }

  const timezone = body.timezone ?? DEFAULT_SCHEDULING_TIMEZONE;
  validateTimeZone(timezone);
  const entries = body.entries as WeeklyScheduleDto['entries'];
  validateWeeklyEntries(entries);

  return getDb().transaction(async (tx) => {
    // Lock the provider row first: the same serialization point `reserveProviderSlot` uses, so a
    // schedule edit and a reservation can never interleave.
    const [profile] = await tx
      .select({ id: providerProfiles.id, version: providerProfiles.version })
      .from(providerProfiles)
      .where(eq(providerProfiles.id, providerProfileId))
      .for('update');
    if (!profile) throw scheduleVersionConflictError(0);

    if (body.expectedVersion !== undefined && body.expectedVersion !== profile.version) {
      throw scheduleVersionConflictError(profile.version);
    }

    const overrides = await loadOverrides(providerProfileId, undefined, tx);
    await assertNoStrandedCommitments(tx, providerProfileId, timezone, entries, overrides);

    await tx.delete(providerAvailabilities).where(eq(providerAvailabilities.providerProfileId, providerProfileId));
    if (entries.length > 0) {
      await tx.insert(providerAvailabilities).values(
        entries.map((entry) => ({
          providerProfileId,
          dayOfWeek: entry.dayOfWeek,
          startMinute: entry.startMinute,
          endMinute: entry.endMinute,
        })),
      );
    }

    const [updated] = await tx
      .update(providerProfiles)
      .set({ schedulingTimezone: timezone, version: profile.version + 1, updatedAt: new Date() })
      .where(eq(providerProfiles.id, providerProfileId))
      .returning({ version: providerProfiles.version });

    return { timezone, entries, version: updated!.version };
  });
}

function toOverrideDto(row: OverrideRecord): OverrideDto {
  return {
    date: row.date,
    isAvailable: row.isAvailable,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
  };
}

export async function listOverrides(providerProfileId: string, from: string, to: string): Promise<OverrideDto[]> {
  const rows = await loadOverrides(providerProfileId, { from, to });
  return rows.map(toOverrideDto);
}

/** Shared shape validation for both override write paths (R3/R6). */
function normalizeOverrideBody(body: Partial<CreateOverrideRequest>): {
  isAvailable: boolean;
  startMinute: number | null;
  endMinute: number | null;
} {
  if (typeof body.isAvailable !== 'boolean') {
    throw validationError([{ field: 'isAvailable', message: 'is required and must be a boolean.' }]);
  }
  validateOverrideShape({ isAvailable: body.isAvailable, startMinute: body.startMinute, endMinute: body.endMinute });
  return {
    isAvailable: body.isAvailable,
    startMinute: body.isAvailable ? body.startMinute! : null,
    endMinute: body.isAvailable ? body.endMinute! : null,
  };
}

/** R4 — `POST` creates; a date that already has a row is `409 CONFLICT`, not a silent overwrite. */
export async function createOverride(
  providerProfileId: string,
  timezone: string,
  body: Partial<CreateOverrideRequest>,
): Promise<OverrideDto> {
  if (!isValidDateString(body.date)) {
    throw validationError([{ field: 'date', message: 'is required and must be a real calendar date in YYYY-MM-DD form.' }]);
  }
  const normalized = normalizeOverrideBody(body);
  const date = body.date;

  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select({ date: providerAvailabilityOverrides.date })
      .from(providerAvailabilityOverrides)
      .where(and(eq(providerAvailabilityOverrides.providerProfileId, providerProfileId), eq(providerAvailabilityOverrides.date, date)));
    if (existing) throw overrideAlreadyExistsError(date);

    await assertOverrideKeepsCommitments(tx, providerProfileId, timezone, { date, ...normalized });

    const [inserted] = await tx
      .insert(providerAvailabilityOverrides)
      .values({ providerProfileId, date, ...normalized })
      .returning({
        date: providerAvailabilityOverrides.date,
        isAvailable: providerAvailabilityOverrides.isAvailable,
        startMinute: providerAvailabilityOverrides.startMinute,
        endMinute: providerAvailabilityOverrides.endMinute,
      });
    return toOverrideDto(inserted!);
  });
}

export async function updateOverride(
  providerProfileId: string,
  timezone: string,
  date: string,
  body: Partial<UpdateOverrideRequest>,
): Promise<OverrideDto> {
  if (!isValidDateString(date)) {
    throw validationError([{ field: 'date', message: 'must be a real calendar date in YYYY-MM-DD form.' }]);
  }
  const normalized = normalizeOverrideBody(body);

  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select({ date: providerAvailabilityOverrides.date })
      .from(providerAvailabilityOverrides)
      .where(and(eq(providerAvailabilityOverrides.providerProfileId, providerProfileId), eq(providerAvailabilityOverrides.date, date)));
    if (!existing) throw overrideNotFoundError();

    await assertOverrideKeepsCommitments(tx, providerProfileId, timezone, { date, ...normalized });

    const [updated] = await tx
      .update(providerAvailabilityOverrides)
      .set({ ...normalized, updatedAt: new Date() })
      .where(and(eq(providerAvailabilityOverrides.providerProfileId, providerProfileId), eq(providerAvailabilityOverrides.date, date)))
      .returning({
        date: providerAvailabilityOverrides.date,
        isAvailable: providerAvailabilityOverrides.isAvailable,
        startMinute: providerAvailabilityOverrides.startMinute,
        endMinute: providerAvailabilityOverrides.endMinute,
      });
    return toOverrideDto(updated!);
  });
}

/** R4 — deleting an override restores the weekly pattern for that date. */
export async function deleteOverride(providerProfileId: string, date: string): Promise<void> {
  if (!isValidDateString(date)) {
    throw validationError([{ field: 'date', message: 'must be a real calendar date in YYYY-MM-DD form.' }]);
  }
  const deleted = await getDb()
    .delete(providerAvailabilityOverrides)
    .where(and(eq(providerAvailabilityOverrides.providerProfileId, providerProfileId), eq(providerAvailabilityOverrides.date, date)))
    .returning({ date: providerAvailabilityOverrides.date });
  if (deleted.length === 0) throw overrideNotFoundError();
}

/** The strand guard for a single override write — the same rule, scoped to one date. */
async function assertOverrideKeepsCommitments(
  tx: Tx,
  providerProfileId: string,
  timezone: string,
  override: OverrideRecord,
): Promise<void> {
  const weekly = await loadWeeklyEntries(providerProfileId, tx);
  const others = (await loadOverrides(providerProfileId, { from: addDays(override.date, -1), to: addDays(override.date, 1) }, tx)).filter(
    (row) => row.date !== override.date,
  );
  await assertNoStrandedCommitments(tx, providerProfileId, timezone, weekly, [...others, override]);
}

/** Exposed for the slots route: the UTC instant a local date + minute maps to (R1/R7). */
export { zonedDateTimeToUtc };
