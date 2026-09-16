import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { expectDatabaseRejection } from '@/lib/bookings/bookings-test-support';
import { queryRows } from '@/lib/offers/db';
import { accrueLine, advanceLineEligibility, closeBatch, createEarningsLineForBooking } from './ledger';
import { transferPayout } from './transfer';
import {
  addDefaultMethod,
  historyFor,
  isDatabaseReachable,
  itemsFor,
  lineFor,
  payBooking,
  payoutsFor,
  resetPayoutIntegration,
  seedProtectedBooking,
  seedSettledBooking,
  usePayoutIntegration,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 90_000;

afterAll(async () => {
  await getPool().end();
});

/** Spec 024 §3.5/§3.6 — the lifecycle end to end (AC-1, AC-12, AC-14). */
describe.skipIf(!dbReachable)('payout lifecycle (spec 024)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('a settled booking produces exactly one eligible line', async () => {
    const settled = await seedSettledBooking();
    expect(await createEarningsLineForBooking(settled.bookingId, 1000)).toBe('created');
    expect(await createEarningsLineForBooking(settled.bookingId, 1000)).toBe('exists');

    const line = await lineFor(settled.bookingId);
    expect(line!.state).toBe('pending');
    expect(line!.gross_amount_minor_units).toBe(settled.capturedAmountMinorUnits);
    expect(line!.fee_amount_minor_units).toBe(Math.trunc((settled.capturedAmountMinorUnits * 1000 + 5000) / 10_000));
    expect(line!.net_amount_minor_units).toBe(settled.capturedAmountMinorUnits - line!.fee_amount_minor_units);

    expect(await advanceLineEligibility(line!.id, settled.bookingId)).toBe(true);
    expect((await lineFor(settled.bookingId))!.state).toBe('eligible');
    const [{ count }] = (await queryRows<{ count: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS count FROM provider_earnings_lines WHERE booking_id = ${settled.bookingId}`,
    )) as [{ count: number }];
    expect(count).toBe(1);
  });

  it('a held (unsettled) booking produces no line at all', async () => {
    const protectedBooking = await seedProtectedBooking();
    expect(await createEarningsLineForBooking(protectedBooking.bookingId, 1000)).toBe('skipped');
    expect(await lineFor(protectedBooking.bookingId)).toBeUndefined();
  });

  it('runs pending → eligible → processing → paid with one append-only history row per transition', async () => {
    const settled = await seedSettledBooking();
    const payoutId = await payBooking(settled);

    const [payout] = await payoutsFor(settled.providerProfileId);
    expect(payout!.id).toBe(payoutId);
    expect(payout!.status).toBe('paid');
    expect(payout!.attempt_count).toBe(1);
    expect(payout!.payout_reference).toMatch(/^sandbox_payout_/);

    const history = await historyFor(payoutId);
    expect(history.map((h) => `${h.from_status}->${h.to_status}`)).toEqual(['pending->eligible', 'eligible->processing', 'processing->paid']);
    expect(history.every((h) => h.actor_role === 'system' && h.actor_user_id === null)).toBe(true);

    const line = await lineFor(settled.bookingId);
    expect(line!.state).toBe('paid');
    expect(line!.paid_at).not.toBeNull();

    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE payouts_status_history SET detail = 'x' WHERE payout_id = ${payoutId}`),
      /append-only/,
    );
  });

  it('the database trigger rejects an unseeded transition', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const line = await (async () => {
      await createEarningsLineForBooking(settled.bookingId, 1000);
      const l = await lineFor(settled.bookingId);
      await advanceLineEligibility(l!.id, settled.bookingId);
      await accrueLine(l!.id, settled.bookingId);
      return l!;
    })();
    expect(line).toBeDefined();
    const [open] = await payoutsFor(settled.providerProfileId);
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE payouts SET status = 'paid', paid_at = clock_timestamp(), closed_at = clock_timestamp() WHERE id = ${open!.id}`),
      /Invalid payouts status transition/,
    );
  });

  it('a payout cannot close with a non-positive total, and a closed batch freezes its items', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    await createEarningsLineForBooking(settled.bookingId, 1000);
    const line = await lineFor(settled.bookingId);
    await advanceLineEligibility(line!.id, settled.bookingId);
    await accrueLine(line!.id, settled.bookingId);
    const [open] = await payoutsFor(settled.providerProfileId);

    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE payouts SET payout_amount_minor_units = 0, status = 'eligible', closed_at = clock_timestamp(), payout_method_id = (SELECT id FROM payout_methods WHERE provider_profile_id = ${settled.providerProfileId} LIMIT 1) WHERE id = ${open!.id}`),
      /payouts_amount_positive_when_closed_ck/,
    );

    expect(await closeBatch(open!.id)).toBe('closed');
    const [item] = await itemsFor(open!.id);
    await expectDatabaseRejection(() => getDb().execute(sql`DELETE FROM payout_items WHERE id = ${item!.id}`), /frozen/);
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE payout_items SET item_amount_minor_units = 1 WHERE id = ${item!.id}`),
      /never updated/,
    );
    expect(await transferPayout(open!.id)).toBe('paid');
  });

  it('the immutable core of an earnings line rejects an update, and net can only fall', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1000);
    const line = await lineFor(settled.bookingId);

    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE provider_earnings_lines SET platform_fee_bps = 0 WHERE id = ${line!.id}`),
      /immutable core/,
    );
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE provider_earnings_lines SET gross_amount_minor_units = gross_amount_minor_units + 1, net_amount_minor_units = net_amount_minor_units + 1 WHERE id = ${line!.id}`),
      /immutable core/,
    );
    await expectDatabaseRejection(() => getDb().execute(sql`DELETE FROM provider_earnings_lines WHERE id = ${line!.id}`), /never deleted/);
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE provider_earnings_lines SET state = 'paid', paid_at = clock_timestamp(), eligible_at = clock_timestamp() WHERE id = ${line!.id}`),
      /Invalid earnings line state change/,
    );
  });
});
