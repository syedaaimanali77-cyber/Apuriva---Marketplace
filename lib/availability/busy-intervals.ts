/**
 * Spec 016 §3 "Interface with spec 020" — the busy-interval port.
 *
 * Spec 016 owns the availability rules and the serialization guarantee; it does **not** own the
 * `bookings` table. Spec 003 AC-4 keeps every baseline table free of feature columns "pending its
 * owning spec", and `bookings` is approved spec 020's. So nothing in `lib/availability/*` ever
 * reads or writes a booking row: an occupied interval arrives through this port instead.
 *
 * Spec 020 registers the real loader (its confirmed bookings, using its own status vocabulary).
 * Until then the default returns an empty list — which is **correct, not a stub**: no code can
 * create a booking with a scheduled time until spec 020 adds those columns. This is the same
 * precedent spec 012 set by shipping `service-area-check` inert and naming the later spec that
 * makes it real.
 */
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from '@/lib/db/schema';

type Schema = typeof schema;

/**
 * The database handle a caller is already inside — a transaction, or a database instance.
 *
 * Deliberately NOT `ReturnType<typeof getDb>`: that carries `$client: Pool`, which would reject a
 * drizzle instance bound to a single `PoolClient`. Spec 020 (and this spec's own concurrency
 * test) must be able to drive `reserveProviderSlot` on one specific connection — that is the
 * whole point of the row lock — so the type has to accept both.
 */
export type Tx =
  | NodePgDatabase<Schema>
  | PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** A provider-occupied interval. Half-open `[startAt, endAt)`, UTC (spec 016 §3 R7). */
export interface BusyInterval {
  startAt: Date;
  endAt: Date;
  /** Which service the interval is for — selects the buffers that widen it (R8). */
  serviceId: string;
  /** Opaque to this spec; echoed into the owner-only `SLOT_OVERLAP` message. */
  sourceId: string;
}

/**
 * Supplied by the caller from whatever it considers "occupied" — spec 020 supplies confirmed
 * bookings. `range` is the window the caller cares about, already widened by the largest buffer
 * so an interval whose buffer reaches into the range is not missed.
 */
export type BusyIntervalLoader = (
  tx: Tx,
  providerProfileId: string,
  range: { from: Date; to: Date },
) => Promise<BusyInterval[]>;

/** The pre-spec-020 default: nothing is occupied, because nothing can be yet. */
const NO_BUSY_INTERVALS: BusyIntervalLoader = async () => [];

let currentLoader: BusyIntervalLoader = NO_BUSY_INTERVALS;

/** Called once by spec 020 at startup to make the port live against real bookings. */
export function registerBusyIntervalLoader(loader: BusyIntervalLoader): void {
  currentLoader = loader;
}

export function getBusyIntervalLoader(): BusyIntervalLoader {
  return currentLoader;
}

/** Restores the default. For tests that register a loader and must not leak it to other suites. */
export function resetBusyIntervalLoader(): void {
  currentLoader = NO_BUSY_INTERVALS;
}
