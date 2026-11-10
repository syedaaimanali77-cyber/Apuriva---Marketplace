/**
 * Spec 031 §6 "Boundary / financial" — AC-5, the refund handoff to spec 022.
 *
 * WHAT THIS PROVES: a resolution records a PROPOSAL and nothing else; the refund itself is created
 * only by spec 022's override chain; and a dispute cannot close while the money it promised is
 * still in flight or was never sent.
 *
 * It exercises spec 022's REAL admin-override entry points, not a stand-in, so the three-eyed chain
 * (T&S proposes → Finance initiates → a second admin approves) is genuinely traversed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { initiateRefundOverride } from '@/lib/refunds/override';
import {
  disputeRow,
  freshKey,
  isDatabaseReachable,
  resetDisputeIntegrationForTests,
  resolutionRow,
  seedProtectedBooking,
  trustSafetyAdmin,
  useDisputeIntegration,
  type SettledBooking,
  type TestAdmin,
} from './disputes-test-support';
import { registerAdminWithPermission } from '@/app/api/v1/admin/admin-rbac-test-support';
import { closeDispute, linkRefundApproval, openDispute, resolveDispute } from './index';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('dispute → refund handoff (spec 031 AC-5)', () => {
  let seeded: SettledBooking;
  let admin: TestAdmin;

  beforeAll(() => useDisputeIntegration());
  afterAll(() => resetDisputeIntegrationForTests());

  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
    admin = await trustSafetyAdmin();
  }, 60_000);

  async function openAndPropose(amount = 5_000) {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'Only half the work was completed before they left.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    const resolution = await resolveDispute(
      dispute.id,
      admin.userId,
      {
        decision: 'partial_refund_customer',
        reasoning: 'Half the agreed work was completed, so half the fee is returned.',
        proposedRefundAmountMinorUnits: amount,
        proposedRefundCurrencyCode: 'PKR',
      },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );
    return { dispute, resolution };
  }

  it('AC-5: a refund decision records a PROPOSAL — no refunds row is created', async () => {
    const { dispute, resolution } = await openAndPropose();

    expect(resolution.proposedRefundAmountMinorUnits).toBe(5_000);
    expect(resolution.proposedRefundCurrencyCode).toBe('PKR');
    expect(resolution.refundState).toBe('proposed');

    const refunds = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM refunds WHERE booking_id = ${seeded.bookingId}`,
    );
    expect(refunds[0]!.total).toBe(0);

    const row = await resolutionRow(dispute.id);
    expect(row!.refund_admin_action_id).toBeNull();
  });

  it('AC-5: the amount is bounded by spec 022 refundable position, not recomputed here', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'Only half the work was completed before they left.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    await expect(
      resolveDispute(
        dispute.id,
        admin.userId,
        {
          decision: 'refund_customer',
          reasoning: 'The customer should receive far more than was ever captured.',
          proposedRefundAmountMinorUnits: seeded.capturedAmountMinorUnits + 1,
          proposedRefundCurrencyCode: 'PKR',
        },
        { key: freshKey(), fingerprint: 'fp' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'DISPUTE_REFUND_AMOUNT_INVALID' });
  });

  it('rejects a proposal in a currency the payment was not captured in', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'Only half the work was completed before they left.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    await expect(
      resolveDispute(
        dispute.id,
        admin.userId,
        {
          decision: 'partial_refund_customer',
          reasoning: 'Half the agreed work was completed, so half the fee is returned.',
          proposedRefundAmountMinorUnits: 5_000,
          proposedRefundCurrencyCode: 'USD',
        },
        { key: freshKey(), fingerprint: 'fp' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'DISPUTE_REFUND_AMOUNT_INVALID' });
  });

  it('AC-5: a dispute cannot close while a proposed refund was never initiated', async () => {
    const { dispute } = await openAndPropose();

    await expect(closeDispute(dispute.id, { actorUserId: admin.userId })).rejects.toMatchObject({
      code: 'DISPUTE_REFUND_PENDING',
    });
    expect((await disputeRow(dispute.id)).status).toBe('resolved');
  });

  it('AC-5: Finance initiates through spec 022 own override, and link-refund records the chain', async () => {
    const { dispute } = await openAndPropose();

    // Spec 022's REAL entry point, at tier `high`: it returns an approval to await, not a refund.
    const finance = await registerAdminWithPermission('finance_admin', 'refunds', 'override', 'high');
    const initiated = await initiateRefundOverride({
      adminUserId: finance.userId,
      bookingId: seeded.bookingId,
      amountMinorUnits: 5_000,
      currencyCode: 'PKR',
      reason: 'Dispute resolution proposed a partial refund.',
      idempotencyKey: freshKey('refund'),
    });
    expect(initiated.outcome).toBe('pending_approval');

    const linked = await linkRefundApproval(
      dispute.id,
      admin.userId,
      { adminActionId: initiated.override.adminActionId },
      null,
    );

    expect(linked.refundState).toBe('initiated');
    const row = await resolutionRow(dispute.id);
    expect(row!.refund_admin_action_id).toBe(initiated.override.adminActionId);

    // Still no refund row: spec 022 creates one only after a SECOND admin approves.
    const refunds = await queryRows<{ total: number }>(
      getDb(),
      sql`SELECT COUNT(*)::int AS total FROM refunds WHERE booking_id = ${seeded.bookingId}`,
    );
    expect(refunds[0]!.total).toBe(0);
  });

  it('AC-5: closure is still refused while the linked refund has not completed', async () => {
    const { dispute } = await openAndPropose();
    const finance = await registerAdminWithPermission('finance_admin', 'refunds', 'override', 'high');
    const initiated = await initiateRefundOverride({
      adminUserId: finance.userId,
      bookingId: seeded.bookingId,
      amountMinorUnits: 5_000,
      currencyCode: 'PKR',
      reason: 'Dispute resolution proposed a partial refund.',
      idempotencyKey: freshKey('refund'),
    });
    await linkRefundApproval(dispute.id, admin.userId, { adminActionId: initiated.override.adminActionId }, null);

    await expect(closeDispute(dispute.id, { actorUserId: admin.userId })).rejects.toMatchObject({
      code: 'DISPUTE_REFUND_PENDING',
    });
  });

  it('tolerates a pending refund for the sweep and for an appeal decision, without closing', async () => {
    const { dispute } = await openAndPropose();

    const outcome = await closeDispute(dispute.id, { actorUserId: null, tolerateRefundPending: true });
    expect(outcome).toMatchObject({ closed: false, reason: 'refund_pending' });
    expect((await disputeRow(dispute.id)).status).toBe('resolved');
  });

  it('closes normally when the decision proposed no refund at all', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'Only half the work was completed before they left.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'favour_provider', reasoning: 'The work was completed as agreed.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    const outcome = await closeDispute(dispute.id, { actorUserId: admin.userId });
    expect(outcome.closed).toBe(true);
  });

  it('refuses to link a refund chain to a resolution that proposed none', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'Only half the work was completed before they left.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    const finance = await registerAdminWithPermission('finance_admin', 'refunds', 'override', 'high');
    const initiated = await initiateRefundOverride({
      adminUserId: finance.userId,
      bookingId: seeded.bookingId,
      amountMinorUnits: 1_000,
      currencyCode: 'PKR',
      reason: 'An unrelated refund.',
      idempotencyKey: freshKey('refund'),
    });

    await expect(
      linkRefundApproval(dispute.id, admin.userId, { adminActionId: initiated.override.adminActionId }, null),
    ).rejects.toMatchObject({ code: 'DISPUTE_REFUND_AMOUNT_INVALID' });
  });
});
