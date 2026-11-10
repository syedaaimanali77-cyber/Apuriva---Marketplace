import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { completeBooking } from './complete';
import { createBookingMilestone, listBookingMilestones } from './milestones';
import { bookingHistory, storedBooking } from './bookings-test-support';
import {
  countMilestones,
  driveToInProgress,
  isDatabaseReachable,
  milestoneRows,
  resetMessagingIntegration,
  resetServiceExecutionIntegration,
  seedConfirmedBooking,
  useMessagingIntegration,
  useServiceExecutionIntegration,
} from './service-execution-test-support';

const dbReachable = await isDatabaseReachable();

type Input = Parameters<typeof createBookingMilestone>[3];

function idem(input: Input, key = randomUUID()) {
  return { key, fingerprint: idempotencyFingerprint(input) };
}

/** Spec 028 §6 — milestones: optional, append-only, idempotent, and never a state change. */
describe.skipIf(!dbReachable)('booking milestones (spec 028, integration)', { timeout: 60_000 }, () => {
  beforeEach(() => {
    useMessagingIntegration();
    useServiceExecutionIntegration();
  });
  afterEach(() => {
    resetMessagingIntegration();
    resetServiceExecutionIntegration();
  });

  async function inProgressBooking() {
    const seeded = await seedConfirmedBooking();
    await driveToInProgress(seeded.scenario, seeded.bookingId);
    return seeded;
  }

  /** AC-3 — the whole point: a milestone posts content and changes nothing about the booking. */
  it('milestone posts write no status history and change no booking status', async () => {
    const { scenario, bookingId } = await inProgressBooking();
    const before = await bookingHistory(bookingId);

    const input: Input = { milestoneType: 'working', note: 'Halfway there' };
    await createBookingMilestone(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      bookingId,
      input,
      idem(input),
    );

    expect((await storedBooking(bookingId)).status).toBe('in_progress');
    expect(await bookingHistory(bookingId)).toHaveLength(before.length);
    expect(await countMilestones(bookingId)).toBe(1);
  });

  /** AC-3 — optional, never forced: completion works with zero milestones and with several. */
  it('is optional, and never required for booking progression', async () => {
    const withNone = await inProgressBooking();
    expect((await completeBooking(withNone.scenario.provider.userId, withNone.bookingId, 'provider')).status).toBe(
      'completed',
    );

    const withSome = await inProgressBooking();
    for (const milestoneType of ['started', 'working', 'almost_done'] as const) {
      const input: Input = { milestoneType, note: null };
      await createBookingMilestone(
        withSome.scenario.provider.userId,
        withSome.scenario.provider.providerProfileId,
        withSome.bookingId,
        input,
        idem(input),
      );
    }
    expect(await countMilestones(withSome.bookingId)).toBe(3);
    expect((await completeBooking(withSome.scenario.provider.userId, withSome.bookingId, 'provider')).status).toBe(
      'completed',
    );
  });

  /** AC-10 — replay, conflict, and the per-booking scope of the key. */
  it('replays on the same key and body, conflicts on a different body', async () => {
    const { scenario, bookingId } = await inProgressBooking();
    const input: Input = { milestoneType: 'working', note: 'Halfway there' };
    const key = randomUUID();

    const first = await createBookingMilestone(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      bookingId,
      input,
      idem(input, key),
    );
    expect(first.replayed).toBe(false);

    const replay = await createBookingMilestone(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      bookingId,
      input,
      idem(input, key),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.milestone.id).toBe(first.milestone.id);
    expect(await countMilestones(bookingId)).toBe(1);

    const different: Input = { milestoneType: 'almost_done', note: 'Nearly done' };
    await expect(
      createBookingMilestone(
        scenario.provider.userId,
        scenario.provider.providerProfileId,
        bookingId,
        different,
        idem(different, key),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', status: 409 });
    expect(await countMilestones(bookingId)).toBe(1);
  });

  /**
   * AC-10 concurrency — two retries racing produce exactly ONE row. The unique index decides it,
   * which a read-then-write could not have promised.
   */
  it('two concurrent retries with the same key write exactly one row', async () => {
    const { scenario, bookingId } = await inProgressBooking();
    const input: Input = { milestoneType: 'started', note: null };
    const key = randomUUID();

    const call = () =>
      createBookingMilestone(
        scenario.provider.userId,
        scenario.provider.providerProfileId,
        bookingId,
        input,
        idem(input, key),
      );

    const results = await Promise.allSettled([call(), call()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await countMilestones(bookingId)).toBe(1);

    const ids = new Set(
      results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.milestone.id] : [])),
    );
    expect(ids.size).toBe(1);
  });

  /** AC-10 — the key is scoped PER BOOKING, so one booking's key never blocks another's. */
  it('the same key may be reused on a different booking', async () => {
    const a = await inProgressBooking();
    const b = await inProgressBooking();
    const input: Input = { milestoneType: 'working', note: null };
    const key = randomUUID();

    await createBookingMilestone(
      a.scenario.provider.userId,
      a.scenario.provider.providerProfileId,
      a.bookingId,
      input,
      idem(input, key),
    );
    const second = await createBookingMilestone(
      b.scenario.provider.userId,
      b.scenario.provider.providerProfileId,
      b.bookingId,
      input,
      idem(input, key),
    );

    expect(second.replayed).toBe(false);
    expect(await countMilestones(a.bookingId)).toBe(1);
    expect(await countMilestones(b.bookingId)).toBe(1);
  });

  /** §3 — only inside the execution window. */
  it('refuses a milestone outside arrived/in_progress', async () => {
    const seeded = await seedConfirmedBooking(); // still `confirmed`
    const input: Input = { milestoneType: 'started', note: null };

    await expect(
      createBookingMilestone(
        seeded.scenario.provider.userId,
        seeded.scenario.provider.providerProfileId,
        seeded.bookingId,
        input,
        idem(input),
      ),
    ).rejects.toMatchObject({ code: 'MILESTONE_NOT_ALLOWED_IN_STATUS', status: 422 });

    await driveToInProgress(seeded.scenario, seeded.bookingId);
    await completeBooking(seeded.scenario.provider.userId, seeded.bookingId, 'provider');

    await expect(
      createBookingMilestone(
        seeded.scenario.provider.userId,
        seeded.scenario.provider.providerProfileId,
        seeded.bookingId,
        input,
        idem(input),
      ),
    ).rejects.toMatchObject({ code: 'MILESTONE_NOT_ALLOWED_IN_STATUS' });
    expect(await countMilestones(seeded.bookingId)).toBe(0);
  });

  /** §3 — the customer may READ but never POST; a stranger gets 404 either way. */
  it('only the provider posts; both participants read; a stranger is 404', async () => {
    const { scenario, bookingId } = await inProgressBooking();
    const stranger = await seedConfirmedBooking();
    const input: Input = { milestoneType: 'working', note: 'Halfway' };

    await createBookingMilestone(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      bookingId,
      input,
      idem(input),
    );

    // The customer cannot post — `404`, indistinguishable from no such booking.
    await expect(
      createBookingMilestone(
        scenario.customer.userId,
        scenario.provider.providerProfileId,
        bookingId,
        input,
        idem(input),
      ),
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_FOUND', status: 404 });

    // But both participants read the same list.
    expect(await listBookingMilestones(scenario.customer.userId, bookingId)).toHaveLength(1);
    expect(await listBookingMilestones(scenario.provider.userId, bookingId)).toHaveLength(1);

    await expect(listBookingMilestones(stranger.scenario.customer.userId, bookingId)).rejects.toMatchObject({
      code: 'BOOKING_NOT_FOUND',
    });
  });

  /** §4 — the DTO never carries a counterparty user id, though the row records the author. */
  it('records the author in the row but never returns a user id', async () => {
    const { scenario, bookingId } = await inProgressBooking();
    const input: Input = { milestoneType: 'almost_done', note: null };
    const { milestone } = await createBookingMilestone(
      scenario.provider.userId,
      scenario.provider.providerProfileId,
      bookingId,
      input,
      idem(input),
    );

    expect(Object.keys(milestone).sort()).toEqual(['bookingId', 'createdAt', 'id', 'milestoneType', 'note']);
    const [row] = await milestoneRows(bookingId);
    expect(row!.created_by_user_id).toBe(scenario.provider.userId);
  });

  /** §3 — append-only at the read surface: oldest first, so the customer reads a narrative. */
  it('returns milestones oldest first', async () => {
    const { scenario, bookingId } = await inProgressBooking();
    for (const milestoneType of ['started', 'working', 'almost_done'] as const) {
      const input: Input = { milestoneType, note: null };
      await createBookingMilestone(
        scenario.provider.userId,
        scenario.provider.providerProfileId,
        bookingId,
        input,
        idem(input),
      );
    }
    const listed = await listBookingMilestones(scenario.customer.userId, bookingId);
    expect(listed.map((m) => m.milestoneType)).toEqual(['started', 'working', 'almost_done']);
  });
});
