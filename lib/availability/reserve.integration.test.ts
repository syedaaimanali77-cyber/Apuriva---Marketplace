import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import * as schema from '@/lib/db/schema';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { ApiRouteError } from '@/lib/api/errors';
import { reserveProviderSlot } from './reserve';
import type { BusyInterval, BusyIntervalLoader } from './busy-intervals';

const dbReachable = await isDatabaseReachable();

/** UTC+5 year-round, so every instant below is exact without DST reasoning. */
const TZ = 'Asia/Karachi';

/** Wednesday 2026-09-16 — 09:00–18:00 local is 04:00–13:00Z. */
const WEDNESDAY = 3;

interface Fixture {
  providerProfileId: string;
  serviceId: string;
}

/**
 * A provider with Wed 09:00–18:00 and one service. Written straight at the DB — this suite
 * exercises `reserveProviderSlot`'s locking, not the schedule routes, which have their own tests.
 *
 * NOTE: no booking row is created anywhere in this file. `bookings` has no scheduling columns,
 * because those are approved spec 020's to add (spec 016 §3 "Interface with spec 020"); occupied
 * time is injected through the `BusyIntervalLoader` port instead.
 */
async function seedProvider(options?: { bufferBefore?: number; bufferAfter?: number }): Promise<Fixture> {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);

  const userRows = await db.execute(sql`insert into users default values returning id`);
  const userId = (userRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  const providerRows = await db.execute(
    sql`insert into provider_profiles (user_id, lifecycle_status, scheduling_timezone)
        values (${userId}, 'active', ${TZ}) returning id`,
  );
  const providerProfileId = (providerRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  const categoryRows = await db.execute(
    sql`insert into categories (name, slug, status) values (${`Cat ${suffix}`}, ${`cat-${suffix}`}, 'published') returning id`,
  );
  const categoryId = (categoryRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  const serviceRows = await db.execute(
    sql`insert into services (category_id, name, slug, status)
        values (${categoryId}, ${`Svc ${suffix}`}, ${`svc-${suffix}`}, 'published') returning id`,
  );
  const serviceId = (serviceRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  await db.execute(
    sql`insert into provider_services (provider_profile_id, service_id, duration_minutes, buffer_before_minutes, buffer_after_minutes)
        values (${providerProfileId}, ${serviceId}, 60, ${options?.bufferBefore ?? 0}, ${options?.bufferAfter ?? 0})`,
  );

  await db.execute(
    sql`insert into provider_availabilities (provider_profile_id, day_of_week, start_minute, end_minute)
        values (${providerProfileId}, ${WEDNESDAY}, 540, 1080)`,
  );

  return { providerProfileId, serviceId };
}

function loaderReturning(intervals: BusyInterval[]): BusyIntervalLoader {
  return async () => intervals;
}

async function expectSlotOverlap(fn: () => Promise<unknown>): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiRouteError);
    expect((err as ApiRouteError).code).toBe('SLOT_OVERLAP');
    expect((err as ApiRouteError).status).toBe(409);
    return err as ApiRouteError;
  }
  throw new Error('expected SLOT_OVERLAP to be thrown');
}

describe.skipIf(!dbReachable)('reserveProviderSlot (spec 016 AC-2/AC-7, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('permits a slot inside the schedule when nothing is occupied', async () => {
    const { providerProfileId, serviceId } = await seedProvider();
    await expect(
      getDb().transaction(async (tx) =>
        reserveProviderSlot(
          tx,
          { providerProfileId, serviceId, startAt: new Date('2026-09-16T05:00:00Z'), durationMinutes: 60 },
          loaderReturning([]),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a slot outside the resolved schedule', async () => {
    const { providerProfileId, serviceId } = await seedProvider();
    const err = await expectSlotOverlap(() =>
      getDb().transaction(async (tx) =>
        reserveProviderSlot(
          // 02:00Z = 07:00 local, before the 09:00 window opens.
          tx,
          { providerProfileId, serviceId, startAt: new Date('2026-09-16T02:00:00Z'), durationMinutes: 60 },
          loaderReturning([]),
        ),
      ),
    );
    expect(err.message).toContain('outside their schedule');
  });

  it('AC-1: an unavailable override blocks a slot the weekly pattern would allow', async () => {
    const { providerProfileId, serviceId } = await seedProvider();
    await getDb().execute(
      sql`insert into provider_availability_overrides (provider_profile_id, date, is_available)
          values (${providerProfileId}, '2026-09-16', false)`,
    );

    await expectSlotOverlap(() =>
      getDb().transaction(async (tx) =>
        reserveProviderSlot(
          tx,
          { providerProfileId, serviceId, startAt: new Date('2026-09-16T05:00:00Z'), durationMinutes: 60 },
          loaderReturning([]),
        ),
      ),
    );
  });

  it('rejects a slot overlapping an occupied interval', async () => {
    const { providerProfileId, serviceId } = await seedProvider();
    const occupied: BusyInterval = {
      startAt: new Date('2026-09-16T05:00:00Z'),
      endAt: new Date('2026-09-16T06:00:00Z'),
      serviceId,
      sourceId: 'commitment-1',
    };

    const err = await expectSlotOverlap(() =>
      getDb().transaction(async (tx) =>
        reserveProviderSlot(
          tx,
          { providerProfileId, serviceId, startAt: new Date('2026-09-16T05:30:00Z'), durationMinutes: 60 },
          loaderReturning([occupied]),
        ),
      ),
    );
    expect(err.message).toContain('commitment-1');
  });

  it('AC-7: rejects a reservation that only overlaps a busy interval\'s buffer', async () => {
    const { providerProfileId, serviceId } = await seedProvider({ bufferAfter: 30 });
    const occupied: BusyInterval = {
      startAt: new Date('2026-09-16T05:00:00Z'),
      endAt: new Date('2026-09-16T06:00:00Z'),
      serviceId,
      sourceId: 'commitment-buffered',
    };

    // 06:00Z starts exactly when the commitment ends — free but for the 30-minute after-buffer.
    await expectSlotOverlap(() =>
      getDb().transaction(async (tx) =>
        reserveProviderSlot(
          tx,
          { providerProfileId, serviceId, startAt: new Date('2026-09-16T06:00:00Z'), durationMinutes: 60 },
          loaderReturning([occupied]),
        ),
      ),
    );

    // 06:30Z is past the buffer and succeeds, proving the rejection above was the buffer alone.
    await expect(
      getDb().transaction(async (tx) =>
        reserveProviderSlot(
          tx,
          { providerProfileId, serviceId, startAt: new Date('2026-09-16T06:30:00Z'), durationMinutes: 60 },
          loaderReturning([occupied]),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('AC-2: two concurrent transactions reserving the same overlapping slot — exactly one proceeds, the other gets 409 SLOT_OVERLAP', async () => {
    const { providerProfileId, serviceId } = await seedProvider();
    const startAt = new Date('2026-09-16T05:00:00Z');

    // A shared, in-memory stand-in for "what is already committed". Each transaction reads it
    // through the port INSIDE its own transaction, and the winner appends to it before
    // committing — exactly the sequence spec 020's booking INSERT will follow.
    const committed: BusyInterval[] = [];
    const loader: BusyIntervalLoader = async () => [...committed];

    const pool = getPool();
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    // Each side drives `reserveProviderSlot` on its OWN connection — the whole point of the test
    // is that the two compete for the same row lock, which only happens across real connections.
    const dbA = drizzle(clientA, { schema });
    const dbB = drizzle(clientB, { schema });

    const results: string[] = [];
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      // A checks and "writes" first, still uncommitted — it now holds the provider row lock.
      await reserveProviderSlot(dbA, { providerProfileId, serviceId, startAt, durationMinutes: 60 }, loader);
      committed.push({ startAt, endAt: new Date(startAt.getTime() + 3_600_000), serviceId, sourceId: 'winner' });
      results.push('a-reserved');

      // B attempts the same slot. Its FOR UPDATE blocks on A's lock rather than reading stale
      // state, so it cannot decide anything until A commits.
      const bAttempt = reserveProviderSlot(dbB, { providerProfileId, serviceId, startAt, durationMinutes: 60 }, loader);
      let bSettledEarly = false;
      void bAttempt.then(
        () => {
          bSettledEarly = true;
        },
        () => {
          bSettledEarly = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(bSettledEarly).toBe(false);

      await clientA.query('COMMIT');

      // Unblocked, B now observes A's commitment and refuses — never a second success.
      await expectSlotOverlap(() => bAttempt);
      results.push('b-rejected');
      await clientB.query('ROLLBACK');
    } finally {
      clientA.release();
      clientB.release();
    }

    expect(results).toEqual(['a-reserved', 'b-rejected']);
  });

  it('AC-2: the provider lock is taken before the overlap read, inside the caller\'s transaction', async () => {
    const { providerProfileId, serviceId } = await seedProvider();

    // The loader records whether the provider row was already locked when it ran. A second
    // connection that cannot get the lock (NOWAIT) proves it was held BEFORE the overlap read.
    let lockHeldDuringLoad: boolean | undefined;
    const probingLoader: BusyIntervalLoader = async () => {
      const probe = await getPool().connect();
      try {
        await probe.query('BEGIN');
        await probe.query('SELECT id FROM provider_profiles WHERE id = $1 FOR UPDATE NOWAIT', [providerProfileId]);
        lockHeldDuringLoad = false; // acquired it => the caller was NOT holding it
        await probe.query('ROLLBACK');
      } catch {
        lockHeldDuringLoad = true; // refused => the caller's transaction holds it
        await probe.query('ROLLBACK').catch(() => undefined);
      } finally {
        probe.release();
      }
      return [];
    };

    await getDb().transaction(async (tx) =>
      reserveProviderSlot(
        tx,
        { providerProfileId, serviceId, startAt: new Date('2026-09-16T05:00:00Z'), durationMinutes: 60 },
        probingLoader,
      ),
    );

    expect(lockHeldDuringLoad).toBe(true);
  });

  it('rejects an unknown provider with 404 rather than silently permitting the slot', async () => {
    const { serviceId } = await seedProvider();
    await expect(
      getDb().transaction(async (tx) =>
        reserveProviderSlot(
          tx,
          { providerProfileId: randomUUID(), serviceId, startAt: new Date('2026-09-16T05:00:00Z'), durationMinutes: 60 },
          loaderReturning([]),
        ),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
