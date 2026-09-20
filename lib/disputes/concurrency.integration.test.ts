/**
 * Spec 031 §6 "Concurrency" — the races §3 "Idempotency and concurrency" enumerates.
 *
 * Each test fires the competing calls with `Promise.allSettled` and asserts EXACTLY ONE winner.
 * The guards being exercised are database objects, not application `if`s: the partial unique index
 * on `disputes`, the unique indexes on `dispute_resolutions` and `dispute_appeals`, and the
 * conditional `UPDATE … WHERE` clauses. That is why these hold under real concurrency rather than
 * only under a lucky interleaving.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import {
  disputeRow,
  freshKey,
  isDatabaseReachable,
  resetDisputeIntegrationForTests,
  seedProtectedBooking,
  trustSafetyAdmin,
  useDisputeIntegration,
  type SettledBooking,
  type TestAdmin,
} from './disputes-test-support';
import { claimDispute, closeDispute, decideAppeal, fileAppeal, openDispute, resolveDispute } from './index';

const reachable = await isDatabaseReachable();

function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled').map((r) => r.value);
}

describe.skipIf(!reachable)('dispute concurrency (spec 031)', () => {
  let seeded: SettledBooking;
  let admin: TestAdmin;

  beforeAll(() => useDisputeIntegration());
  afterAll(() => resetDisputeIntegrationForTests());

  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
    admin = await trustSafetyAdmin();
  }, 60_000);

  it('AC-1: two simultaneous opens on the same booking produce exactly one dispute', async () => {
    const results = await Promise.allSettled([
      openDispute(
        seeded.scenario.customer.userId,
        seeded.bookingId,
        { reason: 'The provider never arrived and did not call.' },
        { key: freshKey(), fingerprint: 'fp' },
      ),
      openDispute(
        seeded.scenario.provider.userId,
        seeded.bookingId,
        { reason: 'The customer refused entry and then complained.' },
        { key: freshKey(), fingerprint: 'fp' },
      ),
    ]);

    expect(fulfilled(results)).toHaveLength(1);

    const rows = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM disputes WHERE booking_id = ${seeded.bookingId}`,
    );
    expect(rows[0]!.total).toBe(1);
  });

  it('the booking and the payment are left consistent after a lost open race', async () => {
    await Promise.allSettled([
      openDispute(seeded.scenario.customer.userId, seeded.bookingId, { reason: 'The provider never arrived at all.' }, { key: freshKey(), fingerprint: 'fp' }),
      openDispute(seeded.scenario.provider.userId, seeded.bookingId, { reason: 'The customer refused entry entirely.' }, { key: freshKey(), fingerprint: 'fp' }),
    ]);

    const [booking] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM bookings WHERE id = ${seeded.bookingId}`);
    const [payment] = await queryRows<{ protection_state: string }>(
      getDb(),
      sql`SELECT protection_state FROM payments WHERE booking_id = ${seeded.bookingId}`,
    );
    // The loser's transaction rolled back entirely — exactly one transition happened.
    expect(booking!.status).toBe('disputed');
    expect(payment!.protection_state).toBe('disputed');

    const history = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM bookings_status_history
           WHERE booking_id = ${seeded.bookingId} AND to_status = 'disputed'`,
    );
    expect(history[0]!.total).toBe(1);
  });

  it('AC-3: two simultaneous resolutions produce exactly one', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    const second = await trustSafetyAdmin();

    const results = await Promise.allSettled([
      resolveDispute(
        dispute.id,
        admin.userId,
        { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
        { key: freshKey(), fingerprint: 'fp' },
        null,
      ),
      resolveDispute(
        dispute.id,
        second.userId,
        { decision: 'favour_provider', reasoning: 'The provider attended at the agreed time.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
        { key: freshKey(), fingerprint: 'fp' },
        null,
      ),
    ]);

    expect(fulfilled(results)).toHaveLength(1);

    const rows = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM dispute_resolutions WHERE dispute_id = ${dispute.id}`,
    );
    expect(rows[0]!.total).toBe(1);
  });

  it('two simultaneous claims produce exactly one owner', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    const second = await trustSafetyAdmin();

    const results = await Promise.allSettled([
      claimDispute(dispute.id, admin.userId, null),
      claimDispute(dispute.id, second.userId, null),
    ]);

    expect(fulfilled(results)).toHaveLength(1);
  });

  it('AC-4: two simultaneous appeals produce exactly one', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    const results = await Promise.allSettled([
      fileAppeal(dispute.id, seeded.scenario.customer.userId, { reason: 'The decision ignored my photographs.' }, { key: freshKey(), fingerprint: 'fp' }),
      fileAppeal(dispute.id, seeded.scenario.provider.userId, { reason: 'The decision ignored my timesheet.' }, { key: freshKey(), fingerprint: 'fp' }),
    ]);

    expect(fulfilled(results)).toHaveLength(1);

    const rows = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM dispute_appeals WHERE dispute_id = ${dispute.id}`,
    );
    expect(rows[0]!.total).toBe(1);
  });

  it('two simultaneous appeal decisions produce exactly one outcome', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );
    await fileAppeal(dispute.id, seeded.scenario.customer.userId, { reason: 'The decision ignored my photographs.' }, { key: freshKey(), fingerprint: 'fp' });

    const one = await trustSafetyAdmin();
    const two = await trustSafetyAdmin();

    const results = await Promise.allSettled([
      decideAppeal(dispute.id, one.userId, { outcome: 'upheld', reasoning: 'The original decision stands on the evidence.' }, null),
      decideAppeal(dispute.id, two.userId, { outcome: 'overturned', reasoning: 'The photographs change the picture entirely.' }, null),
    ]);

    expect(fulfilled(results)).toHaveLength(1);
  });

  it('AC-7: two simultaneous closes transition the booking exactly once', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    const results = await Promise.allSettled([
      closeDispute(dispute.id, { actorUserId: admin.userId }),
      closeDispute(dispute.id, { actorUserId: admin.userId }),
    ]);

    const closed = fulfilled(results).filter((r) => r.closed);
    expect(closed).toHaveLength(1);
    expect((await disputeRow(dispute.id)).status).toBe('closed');

    const history = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM bookings_status_history
           WHERE booking_id = ${seeded.bookingId} AND to_status = 'protected' AND from_status = 'disputed'`,
    );
    expect(history[0]!.total).toBe(1);
  });
});
