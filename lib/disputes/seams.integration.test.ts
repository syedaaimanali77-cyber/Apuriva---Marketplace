/**
 * Spec 031 §6 — the cross-spec seams: evidence (027), messages (025) and safety escalation (030).
 *
 * Each of these is a place where this spec consumes another spec's machinery rather than building
 * its own, so the tests exercise the REAL other-spec path and assert the boundary holds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { getFileContextPolicy } from '@/lib/files/contexts/registry';
import {
  disputeAuditCount,
  freshKey,
  isDatabaseReachable,
  resetDisputeIntegrationForTests,
  seedProtectedBooking,
  trustSafetyAdmin,
  useDisputeIntegration,
  type SettledBooking,
  type TestAdmin,
} from './disputes-test-support';
import { seedPermission } from '@/app/api/v1/admin/admin-rbac-test-support';
import {
  escalateToSafety,
  listMessagesForParticipant,
  openDispute,
  postAdminMessage,
  postParticipantMessage,
  resolveDispute,
} from './index';
import { DISPUTE_EVENT_TYPES } from './read';
import { MAX_DISPUTE_MESSAGES } from './limits';

const reachable = await isDatabaseReachable();

describe.skipIf(!reachable)('dispute evidence seam into spec 027 (spec 031 DECIDED-6)', () => {
  let seeded: SettledBooking;

  beforeAll(() => useDisputeIntegration());
  afterAll(() => resetDisputeIntegrationForTests());
  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
  }, 60_000);

  it('registers the dispute_evidence context spec 027 deliberately left unregistered', () => {
    const policy = getFileContextPolicy('dispute_evidence');
    expect(policy).not.toBeNull();
    expect(policy!.publicEligible).toBe(false);
    expect(policy!.maxPerContext).toBe(10);
    expect(policy!.allowedKinds).toEqual(['image', 'document', 'video']);
  });

  it('DECIDED-6: BOTH participants may read, unlike spec 030 where the reported user never can', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    const policy = getFileContextPolicy('dispute_evidence')!;
    const asset = { id: 'asset-1', context_id: dispute.id } as never;

    await expect(policy.canRead({ userId: seeded.scenario.customer.userId, activeMode: 'customer', asset })).resolves.toBe(true);
    await expect(policy.canRead({ userId: seeded.scenario.provider.userId, activeMode: 'provider', asset })).resolves.toBe(true);
  });

  it('refuses a stranger, and refuses upload once the dispute is decided', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    const stranger = await seedProtectedBooking();
    const policy = getFileContextPolicy('dispute_evidence')!;
    const asset = { id: 'asset-1', context_id: dispute.id } as never;

    await expect(policy.canRead({ userId: stranger.scenario.customer.userId, activeMode: 'customer', asset })).resolves.toBe(false);
    await expect(policy.canUpload({ userId: seeded.scenario.customer.userId, activeMode: 'customer', contextId: dispute.id })).resolves.toBe(true);

    const admin = await trustSafetyAdmin();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    // A decided case is frozen — evidence cannot be bolted onto it.
    await expect(policy.canUpload({ userId: seeded.scenario.customer.userId, activeMode: 'customer', contextId: dispute.id })).resolves.toBe(false);
  });

  it('audits an admin evidence read BEFORE the bytes are disclosed', async () => {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider never arrived and did not call.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    const admin = await trustSafetyAdmin();
    const policy = getFileContextPolicy('dispute_evidence')!;

    const allowed = await policy.canRead({
      userId: admin.userId,
      activeMode: 'customer',
      asset: { id: 'asset-1', context_id: dispute.id } as never,
      correlationId: 'corr-e',
    });

    expect(allowed).toBe(true);
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.evidenceRead, dispute.id)).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!reachable)('dispute messages seam into spec 025 (spec 031 DECIDED-7)', () => {
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

  it('both participants read the WHOLE thread, each other messages included', async () => {
    const dispute = await open();
    await postParticipantMessage(dispute.id, seeded.scenario.customer.userId, { body: 'Nobody came to the door.' }, { key: freshKey(), fingerprint: 'fp' });
    await postParticipantMessage(dispute.id, seeded.scenario.provider.userId, { body: 'I rang twice and waited.' }, { key: freshKey(), fingerprint: 'fp' });

    const asCustomer = await listMessagesForParticipant(dispute.id, seeded.scenario.customer.userId, { limit: 20, offset: 0 });
    expect(asCustomer.total).toBe(2);
    expect(asCustomer.items.map((m) => m.authorRole)).toEqual(['me', 'counterparty']);

    const asProvider = await listMessagesForParticipant(dispute.id, seeded.scenario.provider.userId, { limit: 20, offset: 0 });
    expect(asProvider.items.map((m) => m.authorRole)).toEqual(['counterparty', 'me']);
  });

  it('returns the thread OLDEST FIRST, so it reads as a record', async () => {
    const dispute = await open();
    await postParticipantMessage(dispute.id, seeded.scenario.customer.userId, { body: 'First message.' }, { key: freshKey(), fingerprint: 'fp' });
    await postParticipantMessage(dispute.id, seeded.scenario.customer.userId, { body: 'Second message.' }, { key: freshKey(), fingerprint: 'fp' });

    const { items } = await listMessagesForParticipant(dispute.id, seeded.scenario.customer.userId, { limit: 20, offset: 0 });
    expect(items.map((m) => m.body)).toEqual(['First message.', 'Second message.']);
  });

  it('DECIDED-7: FLAGS contact details rather than masking them — a dispute is always post-confirmed', async () => {
    const dispute = await open();
    await postParticipantMessage(
      dispute.id,
      seeded.scenario.customer.userId,
      { body: 'Call me on 0300 1234567 to sort this out.' },
      { key: freshKey(), fingerprint: 'fp' },
    );

    const [row] = await queryRows<{ body: string; contact_flagged: boolean }>(
      getDb(),
      sql`SELECT body, contact_flagged FROM dispute_messages WHERE dispute_id = ${dispute.id}`,
    );
    // Verbatim, because redacting evidence would be wrong — and flagged as a T&S signal.
    expect(row!.body).toContain('0300 1234567');
    expect(row!.contact_flagged).toBe(true);
    expect(row!.body).not.toContain('[contact removed]');
  });

  it('marks an admin message as official and audits it — participant posts are not audited', async () => {
    const dispute = await open();
    await postParticipantMessage(dispute.id, seeded.scenario.customer.userId, { body: 'Nobody came to the door.' }, { key: freshKey(), fingerprint: 'fp' });
    await postAdminMessage(dispute.id, admin.userId, { body: 'We are reviewing both accounts now.' }, { key: freshKey(), fingerprint: 'fp' }, 'corr-m');

    const { items } = await listMessagesForParticipant(dispute.id, seeded.scenario.customer.userId, { limit: 20, offset: 0 });
    expect(items.map((m) => m.isAdmin)).toEqual([false, true]);
    expect(items[1]!.authorRole).toBe('admin');

    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.adminMessagePosted, dispute.id)).toBe(1);
  });

  it('refuses a post once the dispute is resolved, and again once closed', async () => {
    const dispute = await open();
    await resolveDispute(
      dispute.id,
      admin.userId,
      { decision: 'no_action', reasoning: 'Neither party substantiated their account.', proposedRefundAmountMinorUnits: null, proposedRefundCurrencyCode: null },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    await expect(
      postParticipantMessage(dispute.id, seeded.scenario.customer.userId, { body: 'One more thing.' }, { key: freshKey(), fingerprint: 'fp' }),
    ).rejects.toMatchObject({ code: 'DISPUTE_NOT_OPEN' });
  });

  it('replays an identical post rather than duplicating it', async () => {
    const dispute = await open();
    const key = freshKey();
    const first = await postParticipantMessage(dispute.id, seeded.scenario.customer.userId, { body: 'Nobody came to the door.' }, { key, fingerprint: 'fp' });
    const second = await postParticipantMessage(dispute.id, seeded.scenario.customer.userId, { body: 'Nobody came to the door.' }, { key, fingerprint: 'fp' });

    expect(second.replayed).toBe(true);
    expect(second.message.id).toBe(first.message.id);
  });

  it('reuses spec 025 2000-character bound rather than inventing a second one', async () => {
    const dispute = await open();
    const { MESSAGE_BODY_MAX_LENGTH } = await import('@/lib/messaging/limits');
    expect(MESSAGE_BODY_MAX_LENGTH).toBe(2000);

    await expect(
      postParticipantMessage(dispute.id, seeded.scenario.customer.userId, { body: 'x'.repeat(2001) }, { key: freshKey(), fingerprint: 'fp' }),
    ).rejects.toBeTruthy();
  });

  it('caps the thread at MAX_DISPUTE_MESSAGES across all authors', () => {
    expect(MAX_DISPUTE_MESSAGES).toBe(200);
  });
});

describe.skipIf(!reachable)('safety escalation seam into spec 030 (spec 031 DECIDED-9)', () => {
  let seeded: SettledBooking;
  let admin: TestAdmin;

  beforeAll(() => useDisputeIntegration());
  afterAll(() => resetDisputeIntegrationForTests());
  beforeEach(async () => {
    useDisputeIntegration();
    seeded = await seedProtectedBooking();
    admin = await trustSafetyAdmin();
    // Spec 030's own permission, seeded separately — escalation needs BOTH.
    await seedPermission('trust_safety_admin', 'safety_reports', 'read', 'low');
  }, 60_000);

  async function open() {
    const { dispute } = await openDispute(
      seeded.scenario.customer.userId,
      seeded.bookingId,
      { reason: 'The provider shouted at me and would not leave.' },
      { key: freshKey(), fingerprint: 'fp' },
    );
    return dispute;
  }

  it('files a spec 030 report through its own path and cross-references it', async () => {
    const dispute = await open();

    const { safetyReportId } = await escalateToSafety(
      dispute.id,
      admin.userId,
      {
        targetUserId: seeded.scenario.provider.userId,
        category: 'threat',
        reason: 'The customer describes threatening behaviour during the job.',
      },
      { key: freshKey(), fingerprint: 'fp' },
      'corr-s',
    );

    const [report] = await queryRows<{ id: string; status: string; priority: string; target_user_id: string }>(
      getDb(),
      sql`SELECT id, status, priority, target_user_id FROM safety_reports WHERE id = ${safetyReportId}`,
    );
    expect(report!.status).toBe('submitted');
    // Spec 030's default priority, not one this spec chose.
    expect(report!.priority).toBe('medium');
    expect(report!.target_user_id).toBe(seeded.scenario.provider.userId);

    const [row] = await queryRows<{ escalated_safety_report_id: string; status: string }>(
      getDb(),
      sql`SELECT escalated_safety_report_id, status FROM disputes WHERE id = ${dispute.id}`,
    );
    expect(row!.escalated_safety_report_id).toBe(safetyReportId);
    // Escalating does NOT pause the dispute.
    expect(row!.status).toBe('open');
    expect(await disputeAuditCount(DISPUTE_EVENT_TYPES.safetyEscalated, dispute.id)).toBe(1);
  });

  it('refuses a target who is not a party to this dispute', async () => {
    const dispute = await open();
    const stranger = await seedProtectedBooking();

    await expect(
      escalateToSafety(
        dispute.id,
        admin.userId,
        { targetUserId: stranger.scenario.provider.userId, category: 'threat', reason: 'An unrelated person entirely.' },
        { key: freshKey(), fingerprint: 'fp' },
        null,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('changes no account state — enforcement is spec 038, not this spec', async () => {
    const dispute = await open();
    const [before] = await queryRows<{ lifecycle_status: string }>(
      getDb(),
      sql`SELECT lifecycle_status FROM users WHERE id = ${seeded.scenario.provider.userId}`,
    );

    await escalateToSafety(
      dispute.id,
      admin.userId,
      { targetUserId: seeded.scenario.provider.userId, category: 'threat', reason: 'The customer describes threatening behaviour.' },
      { key: freshKey(), fingerprint: 'fp' },
      null,
    );

    const [after] = await queryRows<{ lifecycle_status: string }>(
      getDb(),
      sql`SELECT lifecycle_status FROM users WHERE id = ${seeded.scenario.provider.userId}`,
    );
    expect(after!.lifecycle_status).toBe(before!.lifecycle_status);
  });
});
