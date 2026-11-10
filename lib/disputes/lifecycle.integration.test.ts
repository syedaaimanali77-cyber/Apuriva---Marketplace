/**
 * Spec 031 §6 integration — the full lifecycle, AC-1, AC-3 and AC-7.
 *
 * Every state here is reached through the real application path; nothing is hand-inserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BASE,
  backdateResolution,
  bookingStatusOf,
  disputeAuditCount,
  disputeRow,
  freshKey,
  isDatabaseReachable,
  protectionStateOf,
  resetDisputeIntegrationForTests,
  resolutionRow,
  seedProtectedBooking,
  trustSafetyAdmin,
  useDisputeIntegration,
  type SettledBooking,
  type TestAdmin,
} from './disputes-test-support';
import { claimDispute, closeDispute, openDispute, resolveDispute, runDisputeAppealSweep } from './index';
import { DISPUTE_EVENT_TYPES } from './read';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('dispute lifecycle (spec 031)', () => {
  let seeded: SettledBooking;
  let admin: TestAdmin;

  beforeAll(() => {
    useDisputeIntegration();
  });

  afterAll(() => {
    resetDisputeIntegrationForTests();
  });

  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
    admin = await trustSafetyAdmin();
  }, 60_000);

  async function open(reason = 'The provider never arrived and did not call.') {
    const { dispute } = await openDispute(seeded.scenario.customer.userId, seeded.bookingId, { reason }, {
      key: freshKey(),
      fingerprint: 'fp',
    });
    return dispute;
  }

  it('AC-1: opening a dispute creates one open row linked to the booking and the opener', async () => {
    const dispute = await open();

    expect(dispute.status).toBe('open');
    expect(dispute.bookingId).toBe(seeded.bookingId);
    expect(dispute.openedBy).toBe('me');

    const row = await disputeRow(dispute.id);
    expect(row.status).toBe('open');
    expect(row.opened_by_user_id).toBe(seeded.scenario.customer.userId);
    expect(row.closed_at).toBeNull();
  });

  it('AC-1 + AC-2: opening moves the booking to disputed and the protection to disputed, atomically', async () => {
    expect(await bookingStatusOf(seeded.bookingId)).toBe('protected');
    expect(await protectionStateOf(seeded.bookingId)).toBe('held');

    await open();

    expect(await bookingStatusOf(seeded.bookingId)).toBe('disputed');
    expect(await protectionStateOf(seeded.bookingId)).toBe('disputed');
  });

  it('AC-1: the PROVIDER may open a dispute too, not only the customer', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.provider.userId,
      seeded.bookingId,
      { reason: 'The customer refused entry and then claimed a no-show.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    expect(dispute.status).toBe('open');
    expect(dispute.openedBy).toBe('me');
  });

  it('AC-1: a dispute cannot be opened on a booking that is not protected', async () => {
    await open();
    // The booking is now `disputed`, so a fresh attempt is refused on eligibility.
    await expect(
      openDispute(
        seeded.scenario.provider.userId,
        seeded.bookingId,
        { reason: 'A second, unrelated complaint about the same booking.' },
        { key: freshKey(), fingerprint: 'fp' },
      ),
    ).rejects.toMatchObject({ code: 'DISPUTE_ALREADY_OPEN' });
  });

  it('replays an identical open rather than creating a second dispute', async () => {
    const key = freshKey();
    const first = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key, fingerprint: 'fp' },
    );
    const second = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key, fingerprint: 'fp' },
    );

    expect(second.replayed).toBe(true);
    expect(second.dispute.id).toBe(first.dispute.id);
  });

  it('claims a dispute into under_review and records the owning admin', async () => {
    const dispute = await open();
    const claimed = await claimDispute(dispute.id, admin.userId, 'corr-1');

    expect(claimed.status).toBe('under_review');
    expect(claimed.claimedByAdminUserId).toBe(admin.userId);
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.claimed, dispute.id)).toBe(1);
  });

  it('refuses a second claim with 409 and the current status', async () => {
    const dispute = await open();
    await claimDispute(dispute.id, admin.userId, 'corr-1');
    const other = await trustSafetyAdmin();

    await expect(claimDispute(dispute.id, other.userId, 'corr-2')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('AC-3: resolving records the decision, reasoning, resolver and instant, and audits it', async () => {
    const dispute = await open();
    await claimDispute(dispute.id, admin.userId, 'corr-1');

    const resolution = await resolveDispute(
      dispute.id,
      admin.userId,
      {
        decision: 'favour_provider',
        reasoning: 'The evidence shows the provider attended at the agreed time.',
        proposedRefundAmountMinorUnits: null,
        proposedRefundCurrencyCode: null,
      },
      { key: freshKey(), fingerprint: 'fp' },
      'corr-1',
    );

    expect(resolution.decision).toBe('favour_provider');
    expect(resolution.reasoning).toBe('The evidence shows the provider attended at the agreed time.');
    expect(resolution.refundState).toBe('none');

    const row = await resolutionRow(dispute.id);
    expect(row!.resolved_by_admin_user_id).toBe(admin.userId);
    expect(row!.resolved_at).toBeTruthy();
    expect((await disputeRow(dispute.id)).status).toBe('resolved');
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.resolved, dispute.id)).toBe(1);
  });

  it('resolves directly from open — claiming is not a required ceremony', async () => {
    const dispute = await open();
    const resolution = await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );
    expect(resolution.decision).toBe('no_action');
    expect((await disputeRow(dispute.id)).status).toBe('resolved');
  });

  it('AC-4: a resolution alone releases NOTHING — the money stays held through the appeal window', async () => {
    const dispute = await open();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    expect(await bookingStatusOf(seeded.bookingId)).toBe('disputed');
    expect(await protectionStateOf(seeded.bookingId)).toBe('disputed');
  });

  it('AC-7: closing returns the booking to protected and the protection to held', async () => {
    const dispute = await open();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    const outcome = await closeDispute(dispute.id, { actorUserId: admin.userId, correlationId: 'corr-1' });
    expect(outcome.closed).toBe(true);

    expect(await bookingStatusOf(seeded.bookingId)).toBe('protected');
    expect(await protectionStateOf(seeded.bookingId)).toBe('held');

    const row = await disputeRow(dispute.id);
    expect(row.status).toBe('closed');
    expect(row.closed_at).toBeTruthy();
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.closed, dispute.id)).toBe(1);
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.payoutHoldReleased, dispute.id)).toBe(1);
  });

  it('AC-7: closed is terminal — a second close is refused rather than repeated', async () => {
    const dispute = await open();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );
    await closeDispute(dispute.id, { actorUserId: admin.userId });

    const again = await closeDispute(dispute.id, { actorUserId: admin.userId });
    expect(again).toEqual({ closed: false, reason: 'not_closeable' });
  });

  it('refuses to close a dispute that has not been decided', async () => {
    const dispute = await open();
    const outcome = await closeDispute(dispute.id, { actorUserId: admin.userId });
    expect(outcome).toEqual({ closed: false, reason: 'not_closeable' });
    expect(await bookingStatusOf(seeded.bookingId)).toBe('disputed');
  });

  it('the appeal-expiry sweep closes a resolved dispute once its window has elapsed', async () => {
    const dispute = await open();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    // Not yet elapsed: the sweep leaves it alone.
    await runDisputeAppealSweep();
    expect((await disputeRow(dispute.id)).status).toBe('resolved');

    await backdateResolution(dispute.id, 8);
    const result = await runDisputeAppealSweep();

    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect((await disputeRow(dispute.id)).status).toBe('closed');
    expect(await bookingStatusOf(seeded.bookingId)).toBe('protected');
    expect(await protectionStateOf(seeded.bookingId)).toBe('held');
  });
});
