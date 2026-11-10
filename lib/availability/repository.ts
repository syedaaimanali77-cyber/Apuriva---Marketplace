/**
 * Spec 016 — the database reads every availability path shares, kept in one place so both the
 * owner-facing routes and `reserveProviderSlot()` resolve a schedule from exactly the same rows.
 *
 * Nothing here touches `bookings`: occupied time arrives through the `BusyIntervalLoader` port
 * (./busy-intervals.ts), because booking schema is approved spec 020's (spec 016 §3, §4, §7).
 */
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerAvailabilities, providerAvailabilityOverrides, providerProfiles, providerServices } from '@/lib/db/schema';
import type { Tx } from './busy-intervals';
import type { OverrideRecord } from './resolve';
import type { BufferLookup } from './slots';
import type { DayOfWeek, WeeklyScheduleEntry } from '@/lib/types/availability';

function dbOr(tx?: Tx): Tx {
  return tx ?? getDb();
}

export interface ProviderSchedulingProfile {
  id: string;
  timezone: string;
  lifecycleStatus: string;
  version: number;
}

export async function findProviderSchedulingProfile(
  providerProfileId: string,
  tx?: Tx,
): Promise<ProviderSchedulingProfile | undefined> {
  const [row] = await dbOr(tx)
    .select({
      id: providerProfiles.id,
      timezone: providerProfiles.schedulingTimezone,
      lifecycleStatus: providerProfiles.lifecycleStatus,
      version: providerProfiles.version,
    })
    .from(providerProfiles)
    .where(eq(providerProfiles.id, providerProfileId));
  return row;
}

/** The provider profile owned by `userId`, or undefined — the `/providers/me/**` ownership check. */
export async function findProviderProfileForUser(userId: string): Promise<ProviderSchedulingProfile | undefined> {
  const [row] = await getDb()
    .select({
      id: providerProfiles.id,
      timezone: providerProfiles.schedulingTimezone,
      lifecycleStatus: providerProfiles.lifecycleStatus,
      version: providerProfiles.version,
    })
    .from(providerProfiles)
    .where(eq(providerProfiles.userId, userId));
  return row;
}

export async function loadWeeklyEntries(providerProfileId: string, tx?: Tx): Promise<WeeklyScheduleEntry[]> {
  const rows = await dbOr(tx)
    .select({
      dayOfWeek: providerAvailabilities.dayOfWeek,
      startMinute: providerAvailabilities.startMinute,
      endMinute: providerAvailabilities.endMinute,
    })
    .from(providerAvailabilities)
    .where(eq(providerAvailabilities.providerProfileId, providerProfileId))
    .orderBy(asc(providerAvailabilities.dayOfWeek), asc(providerAvailabilities.startMinute));

  return rows.map((row) => ({
    dayOfWeek: row.dayOfWeek as DayOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
  }));
}

/** Overrides for an inclusive local-date range; omit the range to load every override. */
export async function loadOverrides(
  providerProfileId: string,
  range?: { from: string; to: string },
  tx?: Tx,
): Promise<OverrideRecord[]> {
  const where = range
    ? and(
        eq(providerAvailabilityOverrides.providerProfileId, providerProfileId),
        gte(providerAvailabilityOverrides.date, range.from),
        lte(providerAvailabilityOverrides.date, range.to),
      )
    : eq(providerAvailabilityOverrides.providerProfileId, providerProfileId);

  const rows = await dbOr(tx)
    .select({
      date: providerAvailabilityOverrides.date,
      isAvailable: providerAvailabilityOverrides.isAvailable,
      startMinute: providerAvailabilityOverrides.startMinute,
      endMinute: providerAvailabilityOverrides.endMinute,
    })
    .from(providerAvailabilityOverrides)
    .where(where)
    .orderBy(asc(providerAvailabilityOverrides.date));

  return rows;
}

/** R8 — every service this provider offers, with its duration and buffers, keyed by `service_id`. */
export async function loadServiceBuffers(providerProfileId: string, tx?: Tx): Promise<BufferLookup> {
  const rows = await dbOr(tx)
    .select({
      serviceId: providerServices.serviceId,
      bufferBeforeMinutes: providerServices.bufferBeforeMinutes,
      bufferAfterMinutes: providerServices.bufferAfterMinutes,
    })
    .from(providerServices)
    .where(eq(providerServices.providerProfileId, providerProfileId));

  return new Map(
    rows.map((row) => [
      row.serviceId,
      { bufferBeforeMinutes: row.bufferBeforeMinutes, bufferAfterMinutes: row.bufferAfterMinutes },
    ]),
  );
}

export interface ProviderServiceRecord {
  serviceId: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

export async function findProviderService(
  providerProfileId: string,
  serviceId: string,
  tx?: Tx,
): Promise<ProviderServiceRecord | undefined> {
  const [row] = await dbOr(tx)
    .select({
      serviceId: providerServices.serviceId,
      durationMinutes: providerServices.durationMinutes,
      bufferBeforeMinutes: providerServices.bufferBeforeMinutes,
      bufferAfterMinutes: providerServices.bufferAfterMinutes,
    })
    .from(providerServices)
    .where(and(eq(providerServices.providerProfileId, providerProfileId), eq(providerServices.serviceId, serviceId)));
  return row;
}
