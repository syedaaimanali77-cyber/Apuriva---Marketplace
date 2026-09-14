import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { queryRows } from '@/lib/offers/db';
import { createBooking } from '@/lib/bookings/create';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { generateExportPayload } from '@/lib/privacy/export';
import { authorizePayment } from './authorize';
import { approvePriceAdjustment, proposePriceAdjustment } from './price-adjustment';
import {
  createBookingBody,
  freshKey,
  resetPaymentIntegration,
  seedBookingScenario,
  storedPayment,
  usePaymentIntegration,
  type BookingScenario,
} from './payments-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 60_000;

afterAll(async () => {
  await getPool().end();
});

async function paidBookingWithAdjustment(scenario: BookingScenario): Promise<string> {
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  await authorizePayment(scenario.customer.userId, booking.id, freshKey());

  const { adjustment } = await proposePriceAdjustment(scenario.provider.userId, booking.id, freshKey(), {
    additionalAmountMinorUnits: 45_000,
    additionalCurrencyCode: 'PKR',
    reason: 'Replacement part',
  });
  await approvePriceAdjustment(scenario.customer.userId, adjustment.id, freshKey());
  return booking.id;
}

/**
 * Spec 021 §4 "Retention and privacy" — the export/deletion boundary, integrated with spec 008's
 * EXISTING mechanism rather than a second one.
 */
describe.skipIf(!dbReachable)('payment privacy (spec 021 §4)', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    usePaymentIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetPaymentIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  /** What the user is entitled to: their own money, status and protection window. */
  it('exports the caller’s own payment amount, currency, status and protection window', async () => {
    const scenario = await seedBookingScenario({ priceAmountMinorUnits: 320_000 });
    const bookingId = await paidBookingWithAdjustment(scenario);

    const payload = await generateExportPayload(scenario.customer.userId);
    const payment = payload.receipts.payments.find((row) => row.bookingId === bookingId);

    expect(payment).toBeDefined();
    expect(payment!.status).toBe('captured');
    expect(payment!.chargeAmountMinorUnits).toBe(320_000);
    expect(payment!.chargeCurrencyCode).toBe('PKR');
    // Not yet protected — the booking has not completed — and the export says so honestly.
    expect(payment!.protectionState).toBeNull();
    expect(payment!.protectionWindowStartedAt).toBeNull();
  });

  it('exports the price adjustments proposed on the caller’s own bookings', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBookingWithAdjustment(scenario);

    const payload = await generateExportPayload(scenario.customer.userId);
    const adjustment = payload.receipts.priceAdjustments.find((row) => row.bookingId === bookingId);

    expect(adjustment).toBeDefined();
    expect(adjustment!.additionalAmountMinorUnits).toBe(45_000);
    expect(adjustment!.additionalCurrencyCode).toBe('PKR');
    expect(adjustment!.reason).toBe('Replacement part');
    expect(adjustment!.status).toBe('charged');
    expect(adjustment!.approvedAt).not.toBeNull();
  });

  /**
   * §4 — the hard boundary. `provider_reference`, `provider_name`, the idempotency columns and
   * attempt-level failure codes are internal reconciliation and anti-abuse data, not the user's own
   * personal data, and they are never selected into an export.
   */
  it('never exports a provider reference, provider name, idempotency data or attempt failure codes', async () => {
    const scenario = await seedBookingScenario();
    await paidBookingWithAdjustment(scenario);

    const payload = await generateExportPayload(scenario.customer.userId);
    const serialized = JSON.stringify(payload.receipts);

    const payments = payload.receipts.payments;
    expect(payments.length).toBeGreaterThan(0);
    for (const payment of payments) {
      expect(Object.keys(payment)).not.toContain('providerReference');
      expect(Object.keys(payment)).not.toContain('providerName');
      expect(Object.keys(payment)).not.toContain('idempotencyKey');
      expect(Object.keys(payment)).not.toContain('idempotencyFingerprint');
    }
    for (const adjustment of payload.receipts.priceAdjustments) {
      expect(Object.keys(adjustment)).not.toContain('idempotencyKey');
      expect(Object.keys(adjustment)).not.toContain('proposedByUserId');
      expect(Object.keys(adjustment)).not.toContain('approvedByUserId');
    }

    // The sandbox reference prefix is a concrete canary for the provider handle leaking anywhere.
    expect(serialized).not.toMatch(/sandbox/);
    expect(serialized).not.toMatch(/card_declined/);
  });

  /** A provider exports their own bookings' payment status, never the customer's payment detail. */
  it('scopes the export per participant', async () => {
    const scenario = await seedBookingScenario();
    const bookingId = await paidBookingWithAdjustment(scenario);

    const providerPayload = await generateExportPayload(scenario.provider.userId);
    const payment = providerPayload.receipts.payments.find((row) => row.bookingId === bookingId);
    expect(payment).toBeDefined();
    expect(Object.keys(payment!)).not.toContain('providerReference');

    // And a stranger's export contains nothing of this booking at all.
    const stranger = await seedBookingScenario();
    const strangerPayload = await generateExportPayload(stranger.customer.userId);
    expect(strangerPayload.receipts.payments.some((row) => row.bookingId === bookingId)).toBe(false);
    expect(strangerPayload.receipts.priceAdjustments.some((row) => row.bookingId === bookingId)).toBe(false);
  });

  /**
   * §4 "Retention" — financial records are retained regardless of account deletion, under spec
   * 008's EXISTING rule: every FK here is `restrict`, so a payment row cannot be orphaned or swept
   * away. No new retention mechanism is introduced by this spec.
   */
  it('keeps every payment foreign key ON DELETE RESTRICT, so financial records cannot be swept', async () => {
    const rows = await queryRows<{ table_name: string; delete_rule: string }>(
      getDb(),
      sql`SELECT tc.table_name, rc.delete_rule
            FROM information_schema.table_constraints tc
            JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
           WHERE tc.constraint_type = 'FOREIGN KEY'
             AND tc.table_name IN ('payments','payment_attempts','payment_authorizations','payments_status_history','price_adjustments')`,
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.delete_rule).toBe('RESTRICT');
  });

  /** §4 — no raw card, CVV, expiry or wallet-credential column exists anywhere in this spec. */
  it('stores no payment-instrument data at all', async () => {
    const rows = await queryRows<{ column_name: string }>(
      getDb(),
      sql`SELECT column_name FROM information_schema.columns
           WHERE table_name IN ('payments','payment_attempts','payment_authorizations','price_adjustments')`,
    );

    const forbidden = /(card|pan|cvv|cvc|expiry|expiration|iban|account_number|wallet|token)/i;
    expect(rows.map((row) => row.column_name).filter((name) => forbidden.test(name))).toEqual([]);
  });

  /** And nothing that looks like a credential ever reaches a stored column value either. */
  it('stores only an opaque provider reference, never a credential', async () => {
    const scenario = await seedBookingScenario();
    const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
    await authorizePayment(scenario.customer.userId, booking.id, freshKey());

    const payment = await storedPayment(booking.id);
    expect(payment!.provider_reference).toMatch(/^sandbox_[0-9a-f-]{36}$/);
  });
});
