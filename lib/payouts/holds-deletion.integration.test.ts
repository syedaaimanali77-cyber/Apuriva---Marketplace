import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { queryRows } from '@/lib/offers/db';
import { getSandboxPayoutProvider } from '@/lib/payments/provider';
import { sweepDeletions } from '@/lib/privacy/deletion';
import { decryptDestinationToken } from './destination-crypto';
import { closeBatch } from './ledger';
import { revokePendingRemovedMethods } from './payout-methods';
import { registerPayoutHoldGate } from './ports';
import { earningsSummary } from './read';
import {
  accrueBooking,
  addDefaultMethod,
  isDatabaseReachable,
  itemsFor,
  lineFor,
  payoutsFor,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;

afterAll(async () => {
  await getPool().end();
});

/** Spec 024 §3.6 holds and §4.4 account deletion (AC-15). */
describe.skipIf(!dbReachable)('payout holds and account deletion (spec 024)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('an inert hold gate never holds', async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    expect(await closeBatch(payoutId)).toBe('closed');
  });

  it("a held provider's batch never closes, nothing is transferred, and payoutOnHold is exposed without a reason", async () => {
    const settled = await seedSettledBooking();
    await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    registerPayoutHoldGate(async (_tx, providerProfileId) => ({ held: providerProfileId === settled.providerProfileId }));

    expect(await closeBatch(payoutId)).toBe('held');
    expect((await payoutsFor(settled.providerProfileId))[0]!.status).toBe('pending');
    expect(getSandboxPayoutProvider().transfers()).toHaveLength(0);

    const summary = await earningsSummary(settled.providerProfileId, { currency: null, range: { fromInstant: null, toInstant: null } });
    expect(summary.payoutOnHold).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/reason|fraud/i);
  });

  it("deletion removes the user's payout methods in-database with no rail call; the sweep revokes them later", async () => {
    const settled = await seedSettledBooking();
    const methodId = await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    const [row] = await queryRows<{ destination_token_encrypted: string }>(getDb(), sql`SELECT destination_token_encrypted FROM payout_methods WHERE id = ${methodId}`);
    const destination = decryptDestinationToken(row!.destination_token_encrypted);

    await getDb().execute(sql`
      UPDATE users SET lifecycle_status = 'deletion_pending', deletion_requested_at = clock_timestamp(),
             deletion_grace_ends_at = clock_timestamp() - interval '1 minute'
       WHERE id = ${settled.scenario.provider.userId}`);
    await sweepDeletions(new Date());

    const [method] = await queryRows<{ removed_at: Date | null; is_default: boolean; revoked_at: Date | null }>(getDb(), sql`SELECT removed_at, is_default, revoked_at FROM payout_methods WHERE id = ${methodId}`);
    expect(method!.removed_at).not.toBeNull();
    expect(method!.is_default).toBe(false);
    expect(method!.revoked_at).toBeNull();
    expect(getSandboxPayoutProvider().isRevoked(destination)).toBe(false);

    expect(await closeBatch(payoutId)).toBe('account_closed');
    expect(await lineFor(settled.bookingId)).toBeDefined();
    expect(await itemsFor(payoutId)).toHaveLength(1);

    await revokePendingRemovedMethods({ providerProfileIds: [settled.providerProfileId] });
    expect(getSandboxPayoutProvider().isRevoked(destination)).toBe(true);
  });
});
