import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { queryRows } from '@/lib/offers/db';
import { generateExportPayload } from '@/lib/privacy/export';
import { requestPolicyRefund } from './execute';
import {
  allowRefund,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  resetRefundIntegration,
  seedCapturedBooking,
  useRefundIntegration,
} from './refunds-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

/** Spec 022 §4 "Retention and privacy" — integrated with spec 008's EXISTING mechanism. */
describe.skipIf(!dbReachable)('refund privacy (spec 022 §4)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useRefundIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetRefundIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** What the user is entitled to: their own money, its status, and why it was returned. */
  it('exports the caller’s own refund amount, status, completion instant and line reasons', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000, 'Cancelled within the free window');
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const payload = await generateExportPayload(scenario.customer.userId);
    const refund = payload.receipts.refunds.find((row) => row.bookingId === bookingId);

    expect(refund).toBeDefined();
    expect(refund!.status).toBe('completed');
    expect(refund!.totalAmountMinorUnits).toBe(50_000);
    expect(refund!.totalCurrencyCode).toBe('PKR');
    expect(refund!.completedAt).not.toBeNull();
    expect(refund!.lines).toHaveLength(1);
    expect(refund!.lines[0]).toMatchObject({
      lineAmountMinorUnits: 50_000,
      lineCurrencyCode: 'PKR',
      reason: 'Cancelled within the free window',
    });
  });

  /**
   * §4 — the hard boundary. Provider handles, failure detail, idempotency data and the admin
   * approval chain are internal reconciliation and security data, not the user's own personal data.
   */
  it('never exports a provider reference, failure detail, idempotency data or the approval chain', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const payload = await generateExportPayload(scenario.customer.userId);
    const serialized = JSON.stringify(payload.receipts);

    expect(payload.receipts.refunds.length).toBeGreaterThan(0);
    for (const refund of payload.receipts.refunds) {
      expect(Object.keys(refund)).not.toContain('providerReference');
      expect(Object.keys(refund)).not.toContain('refundReference');
      expect(Object.keys(refund)).not.toContain('failureCode');
      expect(Object.keys(refund)).not.toContain('failureReason');
      expect(Object.keys(refund)).not.toContain('idempotencyKey');
      expect(Object.keys(refund)).not.toContain('idempotencyFingerprint');
      expect(Object.keys(refund)).not.toContain('adminActionId');
      expect(Object.keys(refund)).not.toContain('initiatedByUserId');
      expect(Object.keys(refund)).not.toContain('eligibilityDecisionRef');
    }

    // The sandbox reference prefix is a concrete canary for a provider handle leaking anywhere.
    expect(serialized).not.toMatch(/sandbox/);
  });

  /** A provider sees their own bookings' refunds, never the customer's payment detail. */
  it('scopes the export per participant', async () => {
    const { scenario, bookingId } = await seedCapturedBooking();
    await completeBookingFor(scenario, bookingId);
    allowRefund(50_000);
    await requestPolicyRefund(scenario.customer.userId, bookingId, freshKey());

    const providerPayload = await generateExportPayload(scenario.provider.userId);
    expect(providerPayload.receipts.refunds.some((row) => row.bookingId === bookingId)).toBe(true);

    // A stranger's export contains nothing of this booking at all.
    const other = await seedCapturedBooking();
    const strangerPayload = await generateExportPayload(other.scenario.customer.userId);
    expect(strangerPayload.receipts.refunds.some((row) => row.bookingId === bookingId)).toBe(false);
  });

  /**
   * §4 "Retention" — financial records survive account deletion under spec 008's EXISTING rule:
   * every FK is `restrict`, so a refund row cannot be orphaned or swept away.
   */
  it('keeps every refund foreign key ON DELETE RESTRICT', async () => {
    const rows = await queryRows<{ table_name: string; delete_rule: string }>(
      getDb(),
      sql`SELECT tc.table_name, rc.delete_rule
            FROM information_schema.table_constraints tc
            JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_name IN ('refunds','refund_lines','refunds_status_history')`,
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.delete_rule).toBe('RESTRICT');
  });

  /** §4 — no payment-instrument column exists anywhere in this spec's tables. */
  it('stores no payment-instrument data at all', async () => {
    const rows = await queryRows<{ column_name: string }>(
      getDb(),
      sql`SELECT column_name FROM information_schema.columns
           WHERE table_name IN ('refunds','refund_lines','refunds_status_history')`,
    );

    const forbidden = /(card|pan|cvv|cvc|expiry|expiration|iban|account_number|wallet)/i;
    expect(rows.map((row) => row.column_name).filter((name) => forbidden.test(name))).toEqual([]);
  });
});
