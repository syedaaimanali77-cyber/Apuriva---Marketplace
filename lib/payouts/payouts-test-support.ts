/**
 * Spec 024 §6 fixtures.
 *
 * Built on spec 022's refund fixtures, which are built on spec 021's payment fixtures and spec 020's
 * real booking scenario (the genuine spec 015→019 path). A "settled" booking here genuinely went
 * through capture, completion, spec 021's protection sweep, an elapsed window and release — nothing
 * about payout eligibility is faked.
 *
 * Determinism: the sandbox rail's outcomes are keyed by the transfer amount's last four digits, and
 * suites that steer outcomes run with `PLATFORM_FEE_BPS=0` so the transfer amount equals the price.
 * Suites drive the ledger through the granular functions (line → eligible → accrue → close →
 * transfer) scoped to THEIR booking, so parallel files sharing the test database never interfere.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { queryRows } from '@/lib/offers/db';
import { backdateProtectionWindow, bookingStatus } from '@/lib/payments/payments-test-support';
import { applyBookingTransition } from '@/lib/bookings';
import { hasProtectionWindowElapsed, nextProtectionState } from '@/lib/payments/protection-window';
import { openProtectionWindow, setProtectionState } from '@/lib/payments/record';
import { getSandboxPayoutProvider, sandboxSetupToken } from '@/lib/payments/provider';
import { PAYOUT_PROVIDER_ENV_VAR } from '@/lib/payments/provider/payout-factory';
import { requestPolicyRefund } from '@/lib/refunds/execute';
import {
  allowRefund,
  completeBookingFor,
  freshKey,
  resetRefundIntegration,
  seedCapturedBooking,
  useRefundIntegration,
  type BookingScenario,
} from '@/lib/refunds/refunds-test-support';
import { grantRole, registerAdmin, type TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { registerPayoutIntegration, resetPayoutIntegrationRegistration } from './index';
import { accrueLine, advanceLineEligibility, closeBatch, createEarningsLineForBooking } from './ledger';
import { createPayoutMethod } from './payout-methods';
import { resetPayoutHoldGate, resetPayoutNotificationSink } from './ports';
import { transferPayout } from './transfer';

export { freshKey, isDatabaseReachable, sessionGet, sessionMutate, type BookingScenario } from '@/lib/refunds/refunds-test-support';
export { allowRefund } from '@/lib/refunds/refunds-test-support';

export const DEFAULT_TEST_FEE_BPS = 1000;

const ENV_KEYS = ['PLATFORM_FEE_BPS', 'PAYOUT_BATCH_CLOSE_INTERVAL_HOURS', 'PAYOUT_MINIMUM_MINOR_UNITS', PAYOUT_PROVIDER_ENV_VAR] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

/** Spec 021/022 seams, this spec's ports, the sandbox rail, and a deterministic fee. */
export function usePayoutIntegration(options?: { feeBps?: number }): void {
  useRefundIntegration();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env[PAYOUT_PROVIDER_ENV_VAR] = 'sandbox';
  process.env.PLATFORM_FEE_BPS = String(options?.feeBps ?? DEFAULT_TEST_FEE_BPS);
  process.env.PAYOUT_BATCH_CLOSE_INTERVAL_HOURS = '0';
  process.env.PAYOUT_MINIMUM_MINOR_UNITS = '0';
  getSandboxPayoutProvider().reset();
  resetPayoutHoldGate();
  resetPayoutNotificationSink();
  resetPayoutIntegrationRegistration();
  registerPayoutIntegration();
}

export function resetPayoutIntegration(): void {
  resetRefundIntegration();
  resetPayoutHoldGate();
  resetPayoutNotificationSink();
  resetPayoutIntegrationRegistration();
  getSandboxPayoutProvider().reset();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

export interface SettledBooking {
  scenario: BookingScenario;
  bookingId: string;
  paymentId: string;
  providerProfileId: string;
  capturedAmountMinorUnits: number;
}

/**
 * Spec 021's protection passes A and B, applied to ONE booking.
 *
 * Deliberately not `runPaymentSweep()`: that sweep is platform-wide, so calling it from these suites
 * would act on every other suite's bookings in the shared test database. These helpers use exactly
 * the primitives the sweep uses — `openProtectionWindow`, `setProtectionState`,
 * `hasProtectionWindowElapsed`, `nextProtectionState` and spec 020's `applyBookingTransition` — anchored
 * to the real `in_progress -> completed` history instant, the same way `forceProtected` does in
 * spec 021's own test support.
 */
async function protectBooking(bookingId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [row] = await queryRows<{ booking_version: number; payment_id: string; payment_version: number; completed_at: Date }>(
      tx,
      sql`SELECT b.version AS booking_version, p.id AS payment_id, p.version AS payment_version,
                 (SELECT occurred_at FROM bookings_status_history h WHERE h.booking_id = b.id AND h.to_status = 'completed'
                   ORDER BY occurred_at ASC LIMIT 1) AS completed_at
            FROM bookings b JOIN payments p ON p.booking_id = b.id
           WHERE b.id = ${bookingId} AND b.status = 'completed' FOR UPDATE OF b, p`,
    );
    if (!row) throw new Error('fixture booking is not completed with a payment');
    if (!(await openProtectionWindow(tx, { paymentId: row.payment_id, startedAt: new Date(row.completed_at), expectedVersion: row.payment_version }))) {
      throw new Error('fixture could not open the protection window');
    }
    await applyBookingTransition(tx, { bookingId, from: 'completed', to: 'protected', actorRole: 'system', actorUserId: null, expectedVersion: row.booking_version });
  });
}

async function releaseBooking(bookingId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [row] = await queryRows<{ booking_version: number; payment_id: string; payment_version: number; started_at: Date; hours: number; now: Date }>(
      tx,
      sql`SELECT b.version AS booking_version, p.id AS payment_id, p.version AS payment_version,
                 p.protection_window_started_at AS started_at, p.protection_window_hours AS hours, clock_timestamp() AS now
            FROM bookings b JOIN payments p ON p.booking_id = b.id
           WHERE b.id = ${bookingId} AND b.status = 'protected' AND p.protection_state = 'held' FOR UPDATE OF b, p`,
    );
    if (!row) throw new Error('fixture booking is not protected and held');
    const next = nextProtectionState({ current: 'held', disputeOpen: false, windowElapsed: hasProtectionWindowElapsed(row.started_at, row.hours, new Date(row.now)) });
    if (next !== 'released') throw new Error('fixture protection window has not elapsed');
    await setProtectionState(tx, { paymentId: row.payment_id, from: 'held', to: 'released', expectedVersion: row.payment_version });
    await applyBookingTransition(tx, { bookingId, from: 'protected', to: 'settled', actorRole: 'system', actorUserId: null, expectedVersion: row.booking_version });
  });
}

/** A booking that genuinely reached `settled` with `protection_state = 'released'`. */
export async function seedSettledBooking(options?: { priceAmountMinorUnits?: number }): Promise<SettledBooking> {
  const seeded = await seedCapturedBooking({ priceAmountMinorUnits: options?.priceAmountMinorUnits });
  await completeBookingFor(seeded.scenario, seeded.bookingId);
  await protectBooking(seeded.bookingId);
  await backdateProtectionWindow(seeded.bookingId, 49);
  await releaseBooking(seeded.bookingId);
  const status = await bookingStatus(seeded.bookingId);
  if (status !== 'settled') throw new Error(`fixture booking did not settle (${status})`);
  return { ...seeded, providerProfileId: seeded.scenario.provider.providerProfileId };
}

/** A completed-but-unsettled booking (protection still `held`). */
export async function seedProtectedBooking(): Promise<SettledBooking> {
  const seeded = await seedCapturedBooking();
  await completeBookingFor(seeded.scenario, seeded.bookingId);
  await protectBooking(seeded.bookingId);
  return { ...seeded, providerProfileId: seeded.scenario.provider.providerProfileId };
}

let setupCounter = 1000 + Math.floor(Math.random() * 8000);

/** Setup tokens are single-use at the rail, so each call gets its own unless a mask is specified. */
export async function addDefaultMethod(settled: SettledBooking, lastFour = String((setupCounter += 1) % 9000 + 1000)): Promise<string> {
  const { method } = await createPayoutMethod({
    userId: settled.scenario.provider.userId,
    providerProfileId: settled.providerProfileId,
    idempotencyKey: randomUUID(),
    body: { setupToken: sandboxSetupToken('bank', lastFour, 'PKR') },
    correlationId: randomUUID(),
  });
  return method.id;
}

export async function refundBooking(settled: SettledBooking, amountMinorUnits: number): Promise<string> {
  allowRefund(amountMinorUnits);
  const { refund } = await requestPolicyRefund(settled.scenario.customer.userId, settled.bookingId, freshKey());
  if (refund.status !== 'completed') throw new Error(`fixture refund did not complete (${refund.status})`);
  return refund.id;
}

export async function lineFor(bookingId: string) {
  const [row] = await queryRows<{
    id: string;
    state: string;
    gross_amount_minor_units: number;
    platform_fee_bps: number;
    fee_amount_minor_units: number;
    refunded_amount_minor_units: number;
    fee_reversal_amount_minor_units: number;
    net_amount_minor_units: number;
    eligible_at: Date | null;
    paid_at: Date | null;
  }>(getDb(), sql`SELECT * FROM provider_earnings_lines WHERE booking_id = ${bookingId}`);
  return row;
}

export async function payoutsFor(providerProfileId: string) {
  return queryRows<{
    id: string;
    status: string;
    payout_amount_minor_units: number;
    attempt_count: number;
    failure_code: string | null;
    payout_reference: string | null;
    payout_method_id: string | null;
    escalated_at: Date | null;
  }>(getDb(), sql`SELECT * FROM payouts WHERE provider_profile_id = ${providerProfileId} ORDER BY created_at ASC, id`);
}

export async function itemsFor(payoutId: string) {
  return queryRows<{ id: string; kind: string; earnings_line_id: string | null; source_refund_id: string | null; item_amount_minor_units: number }>(
    getDb(),
    sql`SELECT * FROM payout_items WHERE payout_id = ${payoutId} ORDER BY created_at ASC, id`,
  );
}

export async function historyFor(payoutId: string) {
  return queryRows<{ from_status: string | null; to_status: string; actor_role: string; actor_user_id: string | null; detail: string | null }>(
    getDb(),
    sql`SELECT from_status, to_status, actor_role, actor_user_id, detail FROM payouts_status_history
         WHERE payout_id = ${payoutId} ORDER BY occurred_at ASC, created_at ASC`,
  );
}

export async function reconciliationStateOf(refundId: string): Promise<string> {
  const [row] = await queryRows<{ reconciliation_state: string }>(getDb(), sql`SELECT reconciliation_state FROM refunds WHERE id = ${refundId}`);
  return row!.reconciliation_state;
}

/**
 * Every ledger step takes its row locks `FOR UPDATE SKIP LOCKED`, so under a loaded parallel run a
 * concurrent spec 021 payment sweep holding a booking lock makes a step skip — correct behaviour, and
 * the reason the fixture retries rather than asserts on the first attempt.
 */
async function untilDone<T>(step: () => Promise<T>, done: (value: T) => boolean, attempts = 20): Promise<T> {
  let value = await step();
  for (let i = 1; i < attempts && !done(value); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await step();
  }
  return value;
}

/** Line → eligible → accrued, for one booking. Returns the open batch id. */
export async function accrueBooking(settled: SettledBooking): Promise<string> {
  const outcome = await untilDone(() => createEarningsLineForBooking(settled.bookingId, Number(process.env.PLATFORM_FEE_BPS)), (o) => o !== 'skipped');
  if (outcome === 'skipped') throw new Error('fixture line was skipped');
  const line = await lineFor(settled.bookingId);
  await untilDone(async () => (await advanceLineEligibility(line!.id, settled.bookingId), (await lineFor(settled.bookingId))!.state), (state) => state !== 'pending');
  await untilDone(async () => (await accrueLine(line!.id, settled.bookingId), (await payoutsFor(settled.providerProfileId)).some((p) => p.status === 'pending')), (open) => open);
  const [open] = (await payoutsFor(settled.providerProfileId)).filter((p) => p.status === 'pending');
  if (!open) throw new Error('fixture accrual produced no open batch');
  return open.id;
}

/** Everything through a PAID payout for one booking. Returns the payout id. */
export async function payBooking(settled: SettledBooking): Promise<string> {
  await addDefaultMethod(settled);
  const payoutId = await accrueBooking(settled);
  const closed = await untilDone(() => closeBatch(payoutId), (o) => o !== 'skipped');
  if (closed !== 'closed') throw new Error(`fixture batch did not close (${closed})`);
  const outcome = await transferPayout(payoutId);
  if (outcome !== 'paid') throw new Error(`fixture transfer did not pay (${outcome})`);
  return payoutId;
}

export async function financeAdmin(role: AdminRole = 'finance_admin'): Promise<TestAdmin> {
  resetRateLimitState();
  const admin = await registerAdmin();
  await grantRole(admin, role);
  resetRateLimitState();
  return admin;
}

/** Backdates a processing payout's claim instant so the reconcile sweep treats it as past grace / stale. */
export async function ageProcessing(payoutId: string, minutesAgo: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE payouts SET updated_at = clock_timestamp() - make_interval(mins => ${minutesAgo}) WHERE id = ${payoutId}
  `);
}

/** Backdates a failed payout's failure instant so the automatic-retry backoff has elapsed. */
export async function ageFailure(payoutId: string, minutesAgo: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE payouts SET updated_at = clock_timestamp() - make_interval(mins => ${minutesAgo}) WHERE id = ${payoutId}
  `);
}
