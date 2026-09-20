/**
 * Spec 031 §6 integration — AC-4, the appeal.
 *
 * The four rules under test are the ones §3 "Appeal rules" states: either participant may appeal,
 * exactly one appeal exists, the window is enforced, and the reviewer must be a different admin
 * from the resolver.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appealRow,
  backdateResolution,
  bookingStatusOf,
  disputeAuditCount,
  disputeRow,
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
import { decideAppeal, fileAppeal, openDispute, resolveDispute, waiveAppeal } from './index';
import { DISPUTE_EVENT_TYPES } from './read';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('dispute appeals (spec 031 AC-4)', () => {
  let seeded: SettledBooking;
  let resolver: TestAdmin;

  beforeAll(() => useDisputeIntegration());
  afterAll(() => resetDisputeIntegrationForTests());

  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
    resolver = await trustSafetyAdmin();
  }, 60_000);

  async function resolvedDispute() {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    await resolveDispute(
      dispute.id,
      resolver.userId,
      {
        decision: 'favour_provider',
        reasoning: 'The evidence shows the provider attended at the agreed time.',
        proposedRefundAmountMinorUnits: null,
        proposedRefundCurrencyCode: null,
      },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );
    return dispute;
  }

  it('lets EITHER participant appeal — not only the dispute opener', async () => {
    const dispute = await resolvedDispute();

    // The customer opened it; the PROVIDER appeals the outcome.
    const { appeal } = await fileAppeal(
      dispute.id,
      seeded.scenario.provider.userId,
      { reason: 'The decision overlooked the photographs I submitted.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    expect(appeal.filedBy).toBe('me');
    expect((await disputeRow(dispute.id)).status).toBe('appealed');
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.appealFiled, dispute.id)).toBe(1);
  });

  it('AC-4: the money stays held while an appeal is pending', async () => {
    const dispute = await resolvedDispute();
    await fileAppeal(
      dispute.id,
      seeded.scenario.customer.userId,
      { reason: 'The decision overlooked the photographs I submitted.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    expect(await bookingStatusOf(seeded.bookingId)).toBe('disputed');
    expect(await protectionStateOf(seeded.bookingId)).toBe('disputed');
  });

  it('AC-4: allows exactly one appeal per dispute, whoever files the second', async () => {
    const dispute = await resolvedDispute();
    await fileAppeal(
      dispute.id,
      seeded.scenario.customer.userId,
      { reason: 'The decision overlooked the photographs I submitted.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    await expect(
      fileAppeal(
        dispute.id,
        seeded.scenario.provider.userId,
        { reason: 'I disagree with the decision as well, for other reasons.' },
        { key: freshKey(), fingerprint: 'fp' },
      ),
    ).rejects.toMatchObject({ code: 'APPEAL_NOT_AVAILABLE' });
  });

  it('refuses an appeal filed after the window has elapsed', async () => {
    const dispute = await resolvedDispute();
    await backdateResolution(dispute.id, 8);

    await expect(
      fileAppeal(
        dispute.id,
        seeded.scenario.customer.userId,
        { reason: 'I only read the decision today and I disagree with it.' },
        { key: freshKey(), fingerprint: 'fp' },
      ),
    ).rejects.toMatchObject({ code: 'APPEAL_WINDOW_CLOSED' });
  });

  it('refuses an appeal on a dispute that has not been resolved', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    await expect(
      fileAppeal(dispute.id, seeded.scenario.customer.userId, { reason: 'Nothing has been decided yet.' }, { key: freshKey(), fingerprint: 'fp' }),
    ).rejects.toMatchObject({ code: 'APPEAL_NOT_AVAILABLE' });
  });

  it('AC-4: refuses the ORIGINAL RESOLVER as the appeal reviewer', async () => {
    const dispute = await resolvedDispute();
    await fileAppeal(
      dispute.id,
      seeded.scenario.customer.userId,
      { reason: 'The decision overlooked the photographs I submitted.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    await expect(
      decideAppeal(
        dispute.id,
        resolver.userId,
        { outcome: 'upheld', reasoning: 'I still consider my original decision correct.' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'APPEAL_REQUIRES_DIFFERENT_ADMIN' });
  });

  it('AC-4 + AC-7: a DIFFERENT admin decides it, which records the outcome and closes the dispute', async () => {
    const dispute = await resolvedDispute();
    await fileAppeal(
      dispute.id,
      seeded.scenario.customer.userId,
      { reason: 'The decision overlooked the photographs I submitted.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    const reviewer = await trustSafetyAdmin();
    const decided = await decideAppeal(
      dispute.id,
      reviewer.userId,
      { outcome: 'overturned', reasoning: 'The photographs do show the property was left unattended.' },
      'corr-9',
    );

    expect(decided.outcome).toBe('overturned');
    expect(decided.reasoning).toBe('The photographs do show the property was left unattended.');

    const row = await appealRow(dispute.id);
    expect(row!.reviewed_by_admin_user_id).toBe(reviewer.userId);
    expect(row!.decided_at).toBeTruthy();

    expect((await disputeRow(dispute.id)).status).toBe('closed');
    expect(await bookingStatusOf(seeded.bookingId)).toBe('protected');
    expect(await protectionStateOf(seeded.bookingId)).toBe('held');
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.appealDecided, dispute.id)).toBe(1);
  });

  it('never edits the original resolution when an appeal overturns it', async () => {
    const dispute = await resolvedDispute();
    const { resolutionRow } = await import('./disputes-test-support');
    const before = await resolutionRow(dispute.id);

    await fileAppeal(
      dispute.id,
      seeded.scenario.customer.userId,
      { reason: 'The decision overlooked the photographs I submitted.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    const reviewer = await trustSafetyAdmin();
    await decideAppeal(
      dispute.id,
      reviewer.userId,
      { outcome: 'overturned', reasoning: 'The photographs do show the property was left unattended.' },
      null,
    );

    const after = await resolutionRow(dispute.id);
    // Append-only: an overturned decision is still a decision somebody made.
    expect(after!.decision).toBe(before!.decision);
    expect(after!.reasoning).toBe(before!.reasoning);
    expect(after!.resolved_by_admin_user_id).toBe(before!.resolved_by_admin_user_id);
  });

  it('refuses a second appeal decision — exactly one reviewer wins', async () => {
    const dispute = await resolvedDispute();
    await fileAppeal(
      dispute.id,
      seeded.scenario.customer.userId,
      { reason: 'The decision overlooked the photographs I submitted.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    const first = await trustSafetyAdmin();
    await decideAppeal(dispute.id, first.userId, { outcome: 'upheld', reasoning: 'The original decision stands.' }, null);

    const second = await trustSafetyAdmin();
    await expect(
      decideAppeal(dispute.id, second.userId, { outcome: 'overturned', reasoning: 'I would have decided differently.' }, null),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lets a participant waive the appeal and close the dispute early', async () => {
    const dispute = await resolvedDispute();

    const outcome = await waiveAppeal(dispute.id, seeded.scenario.customer.userId, null);
    expect(outcome.closed).toBe(true);

    expect((await disputeRow(dispute.id)).status).toBe('closed');
    expect(await bookingStatusOf(seeded.bookingId)).toBe('protected');
    expect(await protectionStateOf(seeded.bookingId)).toBe('held');
  });
});
