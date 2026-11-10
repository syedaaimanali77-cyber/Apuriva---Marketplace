/**
 * Spec 031 §6 "Authorization" and "Privacy" — DECIDED-2 and DECIDED-10, end to end.
 *
 * The three properties under test:
 *   - the RBAC split is the one master §69 dictates (T&S decides, Operations watches);
 *   - an admin who is a party to the booking is refused, reads included;
 *   - a non-participant gets `404`, never `403`, so a dispute's existence is not probeable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  disputeAuditCount,
  freshKey,
  isDatabaseReachable,
  operationsAdmin,
  resetDisputeIntegrationForTests,
  seedProtectedBooking,
  trustSafetyAdmin,
  useDisputeIntegration,
  type SettledBooking,
  type TestAdmin,
} from './disputes-test-support';
import { registerAdmin, grantRole } from '@/app/api/v1/admin/admin-rbac-test-support';
import {
  claimDispute,
  decideAppeal,
  getDisputeForAdmin,
  getDisputeForParticipant,
  listDisputeQueue,
  openDispute,
  requireDisputeReadPermission,
  resolveDispute,
} from './index';
import { DISPUTE_EVENT_TYPES } from './read';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('dispute authorization (spec 031 DECIDED-2)', () => {
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

  it('a non-participant gets 404, never 403 — a dispute existence is not probeable', async () => {
    const dispute = await open();
    const stranger = await seedProtectedBooking();

    await expect(getDisputeForParticipant(dispute.id, stranger.scenario.customer.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('both participants can read their own dispute', async () => {
    const dispute = await open();

    await expect(getDisputeForParticipant(dispute.id, seeded.scenario.customer.userId)).resolves.toMatchObject({ id: dispute.id });
    await expect(getDisputeForParticipant(dispute.id, seeded.scenario.provider.userId)).resolves.toMatchObject({ id: dispute.id });
  });

  it('an admin with no dispute permission is refused 403 on the queue', async () => {
    const nobody = await registerAdmin();
    await grantRole(nobody, 'content_admin');

    await expect(requireDisputeReadPermission(nobody.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('Operations may READ a dispute but not resolve it (master §69)', async () => {
    const dispute = await open();
    const ops = await operationsAdmin();

    await expect(getDisputeForAdmin(dispute.id, ops.userId, null, requireDisputeReadPermission)).resolves.toMatchObject({
      id: dispute.id,
    });

    // `disputes/resolve` was deliberately not seeded for operations_admin.
    await expect(claimDispute(dispute.id, ops.userId, null)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      resolveDispute(
        dispute.id,
        ops.userId,
        { decision: 'no_action', reasoning: 'Operations should not be able to do this.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
        { key: freshKey(), fingerprint: 'fp' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('Trust & Safety may both read and resolve', async () => {
    const dispute = await open();

    await expect(getDisputeForAdmin(dispute.id, admin.userId, null, requireDisputeReadPermission)).resolves.toMatchObject({
      id: dispute.id,
    });
    await expect(claimDispute(dispute.id, admin.userId, null)).resolves.toMatchObject({ status: 'under_review' });
  });

  it('refuses an admin who is a PARTY to the booking — reads included', async () => {
    const dispute = await open();

    // Promote the booking's own customer to a full Trust & Safety admin.
    const conflicted = await registerAdmin();
    await grantRole(conflicted, 'trust_safety_admin');
    const { getDb } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    // Point that admin profile at the customer's user id, the cleanest way to express
    // "this admin is a party" without inventing a second booking path.
    await getDb().execute(
      sql`UPDATE admin_profiles SET user_id = ${seeded.scenario.customer.userId} WHERE id = ${conflicted.adminProfileId}`,
    );

    await expect(
      getDisputeForAdmin(dispute.id, seeded.scenario.customer.userId, null, requireDisputeReadPermission),
    ).rejects.toMatchObject({ code: 'DISPUTE_PARTICIPANT_CONFLICT' });

    await expect(claimDispute(dispute.id, seeded.scenario.customer.userId, null)).rejects.toMatchObject({
      code: 'DISPUTE_PARTICIPANT_CONFLICT',
    });
  });

  it('AC-3: an admin detail read is audited, separately from the queue read', async () => {
    const dispute = await open();

    await listDisputeQueue(admin.userId, { limit: 20, offset: 0 }, 'corr-q');
    await getDisputeForAdmin(dispute.id, admin.userId, 'corr-d', requireDisputeReadPermission);

    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.queueRead, 'queue')).toBeGreaterThanOrEqual(1);
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.detailRead, dispute.id)).toBe(1);
  });

  it('AC-4: the appeal reviewer needs review_appeal, not merely resolve', async () => {
    const dispute = await open();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );
    const { fileAppeal } = await import('./index');
    await fileAppeal(dispute.id, seeded.scenario.customer.userId, { reason: 'The decision ignored my photographs.' }, { key: freshKey(), fingerprint: 'fp' });

    const ops = await operationsAdmin();
    await expect(
      decideAppeal(dispute.id, ops.userId, { outcome: 'upheld', reasoning: 'Operations should not be able to do this.' }, null),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe.skipIf(!reachable)('dispute privacy end to end (spec 031 DECIDED-10)', () => {
  let seeded: SettledBooking;
  let admin: TestAdmin;

  beforeAll(() => useDisputeIntegration());
  afterAll(() => resetDisputeIntegrationForTests());

  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
    admin = await trustSafetyAdmin();
  }, 60_000);

  it('the participant DTO contains no user id, admin id, AI summary or approval chain', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    // Read as the PROVIDER — the party who did not open it.
    const dto = await getDisputeForParticipant(dispute.id, seeded.scenario.provider.userId);
    const json = JSON.stringify(dto);

    expect(json).not.toContain(seeded.scenario.customer.userId);
    expect(json).not.toContain(seeded.scenario.provider.userId);
    expect(json).not.toContain(admin.userId);
    expect(dto).not.toHaveProperty('aiSummary');
    expect(dto).not.toHaveProperty('refundAdminActionId');
    expect(dto).not.toHaveProperty('legalHold');
    expect(dto).not.toHaveProperty('escalatedSafetyReportId');

    // But the reasoning DOES reach them — master §2.3.
    expect(dto.resolution?.reasoning).toBe('Neither party substantiated their account.');
    expect(dto.openedBy).toBe('counterparty');
  });

  it('the admin DTO carries exactly what the participant DTO withholds', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    const dto = await getDisputeForAdmin(dispute.id, admin.userId, null, requireDisputeReadPermission);
    expect(dto.openedByUserId).toBe(seeded.scenario.customer.userId);
    expect(dto.customerUserId).toBe(seeded.scenario.customer.userId);
    expect(dto.providerUserId).toBe(seeded.scenario.provider.userId);
    expect(dto).toHaveProperty('aiSummary');
    expect(dto).toHaveProperty('legalHold');
  });
});
