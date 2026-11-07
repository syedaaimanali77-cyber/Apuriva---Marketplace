import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { SANDBOX_DECLINE_AMOUNT_SUFFIX, SANDBOX_REFERENCE_PREFIX, SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX } from '@/lib/payments/provider';
import { capturedWrites, enterDemoEnvironment, isDatabaseReachable, stableNow } from '../demo-test-support';
import { provisionDemoSet, type ProvisionedDemoSet } from '../provision';

const dbReachable = await isDatabaseReachable();

interface PaymentRow {
  status: string;
  provider_name: string;
  provider_reference: string | null;
  charge_amount_minor_units: number;
  protection_state: string | null;
  attempts: { status: string; failure_code: string | null; provider_reference: string | null }[];
}

describe.skipIf(!dbReachable)('spec 045 AC-4 — demo payments come from the sandbox adapter, never a fabricated branch', () => {
  let restore: () => void;
  let set: ProvisionedDemoSet;

  beforeAll(async () => {
    restore = enterDemoEnvironment();
    set = await provisionDemoSet('customer', { now: stableNow() });
  }, 120_000);
  afterAll(() => restore?.());

  async function paymentFor(bookingKey: string): Promise<PaymentRow> {
    const [row] = await queryRows<PaymentRow>(
      getDb(),
      sql`SELECT p.status, p.provider_name, p.provider_reference, p.charge_amount_minor_units, p.protection_state,
                 COALESCE((SELECT json_agg(json_build_object('status', a.status, 'failure_code', a.failure_code,
                                                             'provider_reference', a.provider_reference) ORDER BY a.attempted_at)
                             FROM payment_attempts a WHERE a.payment_id = p.id), '[]') AS attempts
            FROM payments p WHERE p.booking_id = ${set.bookingIds[bookingKey]!}`,
    );
    return row!;
  }

  it('every demo payment row was produced by the sandbox adapter: provider "sandbox", sandbox_ references', async () => {
    const rows = await queryRows<{ provider_name: string; provider_reference: string | null; attempt_refs: string[] }>(
      getDb(),
      sql`SELECT p.provider_name, p.provider_reference,
                 ARRAY(SELECT a.provider_reference FROM payment_attempts a WHERE a.payment_id = p.id) AS attempt_refs
            FROM payments p WHERE p.booking_id IN (${sql.join(Object.values(set.bookingIds).map((id) => sql`${id}`), sql`, `)})`,
    );
    expect(rows.length).toBe(Object.keys(set.bookingIds).length);
    for (const row of rows) {
      expect(row.provider_name).toBe('sandbox');
      for (const ref of [row.provider_reference, ...row.attempt_refs].filter((r): r is string => r !== null)) {
        expect(ref.startsWith(SANDBOX_REFERENCE_PREFIX)).toBe(true);
      }
    }
  });

  it('success: an ordinary amount is authorized and captured by the adapter (two succeeded attempts)', async () => {
    const payment = await paymentFor('confirmed');
    expect(payment.status).toBe('captured');
    expect(payment.attempts.map((a) => a.status)).toEqual(['succeeded', 'succeeded']);
  });

  it(`failure/decline: an amount ending ${SANDBOX_DECLINE_AMOUNT_SUFFIX} is declined by the adapter, then failed by the sweep`, async () => {
    const payment = await paymentFor('failed');
    expect(payment.charge_amount_minor_units % 10_000).toBe(SANDBOX_DECLINE_AMOUNT_SUFFIX);
    expect(payment.status).toBe('failed');
    expect(payment.attempts).toEqual([expect.objectContaining({ status: 'failed', failure_code: 'card_declined' })]);
  });

  it(`requires-action/pending: an amount ending ${SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX} leaves the payment awaiting action and the booking pending`, async () => {
    const payment = await paymentFor('pending');
    expect(payment.charge_amount_minor_units % 10_000).toBe(SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX);
    expect(payment.status).toBe('requires_action');
    expect(payment.attempts.map((a) => a.status)).toEqual(['requires_action']);
  });

  it('cancellation: the cancelled bookings were refunded through the adapter under spec 023’s fee ladder', async () => {
    const partial = await paymentFor('cancelled');
    const full = await paymentFor('refunded');
    expect(partial.status).toBe('partially_refunded');
    expect(full.status).toBe('refunded');

    const refunds = await queryRows<{ booking_id: string; status: string; total_amount_minor_units: number; refund_reference: string | null; fee: number }>(
      getDb(),
      sql`SELECT r.booking_id, r.status, r.total_amount_minor_units, r.refund_reference, bc.fee_amount_minor_units AS fee
            FROM refunds r JOIN booking_cancellations bc ON bc.booking_id = r.booking_id
           WHERE r.booking_id IN (${set.bookingIds.cancelled!}, ${set.bookingIds.refunded!})`,
    );
    expect(refunds).toHaveLength(2);
    for (const refund of refunds) {
      expect(refund.status).toBe('completed');
      expect(refund.refund_reference?.startsWith(SANDBOX_REFERENCE_PREFIX)).toBe(true);
    }
    // 18 hours before → the 25% tier; 72 hours before → no fee.
    expect(refunds.find((r) => r.booking_id === set.bookingIds.cancelled)!.fee).toBe(150_000);
    expect(refunds.find((r) => r.booking_id === set.bookingIds.refunded)!.fee).toBe(0);
  });

  it('protection follows spec 021: held for protected, released for settled, disputed for a dispute', async () => {
    expect((await paymentFor('protected')).protection_state).toBe('held');
    expect((await paymentFor('settled')).protection_state).toBe('released');
    expect((await paymentFor('disputed')).protection_state).toBe('disputed');
  });

  it('a hosted server (NODE_ENV=production) still refuses the sandbox: provisioning fails and writes nothing (DEP-1)', async () => {
    const saved = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = 'production';
    let refusal: unknown;
    try {
      // Every statement this worker issued during the attempt — parallel-safe, unlike a global row count.
      const writes = await capturedWrites(async () => {
        refusal = await provisionDemoSet('customer', { now: stableNow() }).catch((err: unknown) => err);
      });
      expect(writes).toEqual([]);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = saved;
    }
    expect(String(refusal)).toMatch(/sandbox and must never run in production/);
  });
});
