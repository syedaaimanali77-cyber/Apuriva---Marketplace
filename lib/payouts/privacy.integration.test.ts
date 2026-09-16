import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { queryRows } from '@/lib/offers/db';
import { generateExportPayload } from '@/lib/privacy/export';
import {
  isDatabaseReachable,
  payBooking,
  refundBooking,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;

afterAll(async () => {
  await getPool().end();
});

/** Spec 024 §4.4 — export boundary and retention (AC-10). */
describe.skipIf(!dbReachable)('payout privacy and retention (spec 024 §4.4)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('the export carries the provider ledger by allowlist and none of the forbidden columns', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    const refundId = await refundBooking(settled, 20_000);

    const payload = await generateExportPayload(settled.scenario.provider.userId);
    const earnings = payload.providerEarnings!;
    expect(earnings.lines).toHaveLength(1);
    expect(Object.keys(earnings.lines[0]!).sort()).toEqual(
      ['bookingId', 'currencyCode', 'eligibleAt', 'feeAmountMinorUnits', 'grossAmountMinorUnits', 'netAmountMinorUnits', 'paidAt', 'platformFeeBps', 'refundedAmountMinorUnits', 'state'].sort(),
    );
    expect(earnings.payouts.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(earnings.payoutMethods[0]!).sort()).toEqual(['createdAt', 'institutionLabel', 'isDefault', 'maskedDetail', 'removedAt', 'type', 'verificationState'].sort());

    const text = JSON.stringify(earnings);
    expect(text).not.toContain('sandbox_payout_');
    expect(text).not.toContain(refundId);
    expect(text).not.toMatch(/destination|payoutReference|providerName|failureReason|idempotency|adminActionId|sourceRefundId/);

    const customerPayload = await generateExportPayload(settled.scenario.customer.userId);
    expect(customerPayload.providerEarnings).toBeNull();
  });

  it('every foreign key on the payout tables is RESTRICT and no payout-credential column exists anywhere', async () => {
    const fks = await queryRows<{ table_name: string; delete_rule: string }>(
      getDb(),
      sql`SELECT tc.table_name, rc.delete_rule FROM information_schema.table_constraints tc
            JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_name IN ('payouts','payout_methods','payouts_status_history','provider_earnings_lines','earnings_adjustments','payout_items')`,
    );
    expect(fks.length).toBeGreaterThan(10);
    expect(fks.every((fk) => fk.delete_rule === 'RESTRICT')).toBe(true);

    const credentialColumns = await queryRows<{ column_name: string }>(
      getDb(),
      sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
            AND column_name ~ '(account_number|iban|wallet_number|pin|cnic|card_number)'`,
    );
    expect(credentialColumns).toEqual([]);
  });
});
