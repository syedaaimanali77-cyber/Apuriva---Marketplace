/**
 * Spec 031 §6 "Boundary / financial" — AC-2, the payout hold.
 *
 * THIS IS THE CROSS-SPEC TEST THAT MATTERS MOST. It does not assert that `lib/disputes` blocks a
 * payout — it asserts that SPEC 024's OWN `evaluateEligibility()` refuses, unmodified, because the
 * protection state spec 021 owns says `disputed`. If that chain ever breaks, a payout could be
 * created for money under argument, and this is what would catch it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { evaluateEligibility, loadEligibilityFacts } from '@/lib/payouts/eligibility';
import { getDisputeGate } from '@/lib/payments/protection-window';
import {
  bookingStatusOf,
  freshKey,
  isDatabaseReachable,
  protectionStateOf,
  resetDisputeIntegrationForTests,
  seedProtectedBooking,
  trustSafetyAdmin,
  useDisputeIntegration,
  type SettledBooking,
  type TestAdmin,
} from './disputes-test-support';
import { closeDispute, openDispute, resolveDispute } from './index';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('a dispute holds the payout (spec 031 AC-2)', () => {
  let seeded: SettledBooking;
  let admin: TestAdmin;

  beforeAll(() => useDisputeIntegration());
  afterAll(() => resetDisputeIntegrationForTests());

  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
    admin = await trustSafetyAdmin();
  }, 60_000);

  async function open() {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    return dispute;
  }

  async function eligibility() {
    const facts = await loadEligibilityFacts(getDb(), seeded.bookingId);
    return evaluateEligibility(facts!);
  }

  it('the registered DisputeGate reports the dispute to spec 021', async () => {
    const dispute = await open();
    const gate = getDisputeGate();

    expect(await gate(getDb(), seeded.bookingId)).toEqual({ open: true });
    expect(dispute.status).toBe('open');
  });

  it("AC-2: spec 024's own evaluateEligibility answers protection_not_released while a dispute is live", async () => {
    await open();

    expect(await protectionStateOf(seeded.bookingId)).toBe('disputed');
    expect(await eligibility()).toEqual({ eligible: false, reason: 'protection_not_released' });
  });

  it('AC-2: the hold survives a RESOLUTION — money stays held through the appeal window', async () => {
    const dispute = await open();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    const gate = getDisputeGate();
    expect(await gate(getDb(), seeded.bookingId)).toEqual({ open: true });
    expect(await eligibility()).toEqual({ eligible: false, reason: 'protection_not_released' });
  });

  it('AC-7: closing releases the gate and hands the booking back to spec 021', async () => {
    const dispute = await open();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );
    await closeDispute(dispute.id, { actorUserId: admin.userId });

    const gate = getDisputeGate();
    expect(await gate(getDb(), seeded.bookingId)).toEqual({ open: false });
    expect(await protectionStateOf(seeded.bookingId)).toBe('held');
    expect(await bookingStatusOf(seeded.bookingId)).toBe('protected');

    // Still not payable — but now for spec 021's ORDINARY reason (the window has not elapsed),
    // not because of a dispute. The hold is gone; the normal lifecycle resumed.
    expect(await eligibility()).toEqual({ eligible: false, reason: 'protection_not_released' });
  });

  it('writes no payouts row and no payouts column — the hold is a gate, not ownership', async () => {
    await open();
    const { queryRows } = await import('@/lib/offers/db');
    const { sql } = await import('drizzle-orm');

    const payouts = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM payouts p
            JOIN payout_items i ON i.payout_id = p.id
            JOIN provider_earnings_lines l ON l.id = i.earnings_line_id
           WHERE l.booking_id = ${seeded.bookingId}`,
    );
    expect(payouts[0]!.total).toBe(0);
  });

  it('leaves every other booking untouched — the gate is scoped to its own booking', async () => {
    const other = await seedProtectedBooking();
    await open();

    const gate = getDisputeGate();
    expect(await gate(getDb(), other.bookingId)).toEqual({ open: false });
    expect(await protectionStateOf(other.bookingId)).toBe('held');
    expect(await bookingStatusOf(other.bookingId)).toBe('protected');
  });
});
