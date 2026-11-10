/**
 * Spec 016 §3 "Double-booking prevention" (AC-2) — the serialization primitive.
 *
 * PRIMARY ENFORCEMENT MECHANISM: an application-level check inside the CALLER's writing
 * transaction, serialized by `SELECT ... FOR UPDATE` on the provider row. Chosen over a Postgres
 * `EXCLUDE USING gist` constraint because that needs the `btree_gist` extension (no migration in
 * `drizzle/` has ever issued `CREATE EXTENSION`) and would have to be partial on
 * `bookings.status = 'confirmed'`, hard-coding a status vocabulary that is approved spec 020's to
 * define. Row locking plus a transactional check is the repository's established concurrency
 * idiom (`lib/db/concurrency.integration.test.ts`, spec 003 AC-6).
 *
 * This module is BOOKING-AGNOSTIC: it never reads or writes `bookings` and contains no booking
 * SQL. Occupied time arrives through the `BusyIntervalLoader` port, which spec 020 supplies from
 * the columns it owns (§3 "Interface with spec 020").
 */
import { sql } from 'drizzle-orm';
import { providerNotFoundError, slotOverlapError } from './errors';
import { getBusyIntervalLoader, type BusyInterval, type BusyIntervalLoader, type Tx } from './busy-intervals';
import {
  findProviderSchedulingProfile,
  loadOverrides,
  loadServiceBuffers,
  loadWeeklyEntries,
} from './repository';
import { isWithinAnyWindow, resolveWindowsForDate } from './resolve';
import { findConflictingInterval, widestBufferMinutes } from './slots';
import { addDays, utcToZoned } from './timezone';

const MS_PER_MINUTE = 60_000;

export type { BusyInterval, BusyIntervalLoader, Tx };

export interface ReserveProviderSlotParams {
  providerProfileId: string;
  serviceId: string;
  /** UTC instant the service starts. */
  startAt: Date;
  durationMinutes: number;
}

/**
 * Runs inside the CALLER's transaction. Takes the provider row lock, resolves the schedule
 * (R1–R3, R7), applies buffers (R8), and throws `409 SLOT_OVERLAP` when the candidate interval
 * overlaps a busy interval or falls outside a resolved window. Returns normally — writing
 * nothing — when the slot is free; the caller then performs its own INSERT inside the same
 * transaction, while still holding the lock.
 *
 * The lock is taken BEFORE the overlap read, which is precisely what makes this race-free: a
 * second transaction blocks on it until the first commits, then observes the first's row.
 *
 * `loadBusyIntervals` defaults to the registered loader, so spec 016's own write paths and spec
 * 020's booking-confirmation transaction share one implementation.
 */
export async function reserveProviderSlot(
  tx: Tx,
  params: ReserveProviderSlotParams,
  loadBusyIntervals: BusyIntervalLoader = getBusyIntervalLoader(),
): Promise<void> {
  // `serviceId` identifies the candidate but deliberately contributes no buffer of its own: R8
  // widens the ALREADY-OCCUPIED interval, not the one being requested. Widening both would
  // double-count the gap between two adjacent bookings.
  const { providerProfileId, startAt, durationMinutes } = params;

  // (1) Serialize every scheduling decision for this provider. `FOR UPDATE` on an existing row
  // is held until the caller's transaction ends — so the whole check-then-insert is atomic.
  const locked = await tx.execute(
    sql`select id from provider_profiles where id = ${providerProfileId} for update`,
  );
  if (lockedRowCount(locked) === 0) throw providerNotFoundError();

  const profile = await findProviderSchedulingProfile(providerProfileId, tx);
  if (!profile) throw providerNotFoundError();

  const endAt = new Date(startAt.getTime() + durationMinutes * MS_PER_MINUTE);
  const candidate = { startAt, endAt };

  // (2a) The candidate must fall inside a resolved window for its own local date (R3/R7).
  const localStart = utcToZoned(startAt, profile.timezone);
  const [weekly, overrides, buffers] = await Promise.all([
    loadWeeklyEntries(providerProfileId, tx),
    loadOverrides(providerProfileId, { from: addDays(localStart.date, -1), to: addDays(localStart.date, 1) }, tx),
    loadServiceBuffers(providerProfileId, tx),
  ]);

  const override = overrides.find((row) => row.date === localStart.date);
  const windows = resolveWindowsForDate(localStart.dayOfWeek, weekly, override);
  const endMinute = localStart.minuteOfDay + durationMinutes;
  if (!isWithinAnyWindow(windows, localStart.minuteOfDay, endMinute)) {
    throw slotOverlapError(
      `The provider is not available on ${localStart.date} for the requested time. The slot falls outside their schedule.`,
    );
  }

  // (2b) No buffer-widened occupied interval may overlap the candidate (R7/R8). The load range is
  // widened by the largest configured buffer so an interval whose buffer reaches into the
  // candidate — but whose own time does not — is still seen.
  const margin = (widestBufferMinutes(buffers) + durationMinutes) * MS_PER_MINUTE;
  const busy = await loadBusyIntervals(tx, providerProfileId, {
    from: new Date(startAt.getTime() - margin),
    to: new Date(endAt.getTime() + margin),
  });

  const conflict = findConflictingInterval(candidate, busy, buffers);
  if (conflict) {
    const conflictLocal = utcToZoned(conflict.startAt, profile.timezone);
    throw slotOverlapError(
      `That time conflicts with an existing commitment on ${conflictLocal.date} (reference ${conflict.sourceId}).`,
    );
  }
}

/** `db.execute` returns a driver result whose row container differs between drizzle versions. */
function lockedRowCount(result: unknown): number {
  const rows = (result as { rows?: unknown[] }).rows;
  if (Array.isArray(rows)) return rows.length;
  return Array.isArray(result) ? result.length : 0;
}
