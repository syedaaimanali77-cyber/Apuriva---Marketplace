/**
 * Spec 032 §6 "Attachments" (DECIDED-8).
 *
 * Exercises the POLICY spec 027 asks a consuming spec for — who may attach, who may read back —
 * rather than re-testing spec 027's upload, scan and storage machinery, which this spec reuses
 * unchanged and does not own.
 *
 * The first test is the one that keeps the rollback story honest: until
 * `registerSupportAttachmentContext()` runs, the context is unregistered and spec 027 refuses it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { getFileContextPolicy, resetFileContextPolicies } from '@/lib/files/contexts/registry';
import { registerShippedFileContextPolicies } from '@/lib/files/contexts/policies';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
import type { FileAssetRow } from '@/lib/files/assets';
import {
  BASE,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  registerAndLogin,
  seedPermission,
  supportRequest,
  useSupportIntegration,
  type TestAdmin,
  type TestSession,
} from './support-test-support';
import { supportAttachmentPolicy } from './attachment-policy';
import { MAX_SUPPORT_ATTACHMENTS } from './limits';

const dbReachable = await isDatabaseReachable();

async function supportAdmin(): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, 'support_admin');
  for (const [action, tier] of [
    ['read', 'low'],
    ['resolve', 'medium'],
  ] as const) {
    await seedPermission('support_admin', 'support', action, tier);
  }
  return admin;
}

async function makeTicket(user: TestSession): Promise<string> {
  const res = await CREATE(
    supportRequest(`${BASE}/support/tickets`, user, {
      body: {
        subject: 'Screenshot of the problem',
        description: 'I am attaching a screenshot that shows what I am seeing.',
        category: 'technical',
      },
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

/** A minimal stand-in for a finalized spec 027 asset in this context. */
function assetFor(ticketId: string): FileAssetRow {
  return { context_type: 'support_attachment', context_id: ticketId } as unknown as FileAssetRow;
}

describe('the support_attachment context policy', () => {
  it('ships INERT: unregistered until spec 032 registers it, so rollback is clean', () => {
    resetFileContextPolicies();
    registerShippedFileContextPolicies();
    // Spec 027's shipped four only — support is not among them.
    expect(getFileContextPolicy('support_attachment')).toBeNull();

    useSupportIntegration();
    expect(getFileContextPolicy('support_attachment')).not.toBeNull();
  });

  it('is private-only and capped at the same count as request and message attachments', () => {
    expect(supportAttachmentPolicy.publicEligible).toBe(false);
    expect(supportAttachmentPolicy.maxPerContext).toBe(MAX_SUPPORT_ATTACHMENTS);
    expect([...supportAttachmentPolicy.allowedKinds].sort()).toEqual(['document', 'image']);
  });
});

describe.skipIf(!dbReachable)('support attachment authorization (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('lets the requester attach to their own live ticket', async () => {
    const user = await registerAndLogin();
    const ticketId = await makeTicket(user);

    await expect(
      supportAttachmentPolicy.canUpload({ userId: user.userId, activeMode: 'customer', contextId: ticketId }),
    ).resolves.toBe(true);
  });

  it('refuses a stranger, and refuses an unknown or malformed ticket id', async () => {
    const user = await registerAndLogin();
    const stranger = await registerAndLogin();
    const ticketId = await makeTicket(user);

    await expect(
      supportAttachmentPolicy.canUpload({ userId: stranger.userId, activeMode: 'customer', contextId: ticketId }),
    ).resolves.toBe(false);
    await expect(
      supportAttachmentPolicy.canUpload({ userId: user.userId, activeMode: 'customer', contextId: null }),
    ).resolves.toBe(false);
    await expect(
      supportAttachmentPolicy.canUpload({ userId: user.userId, activeMode: 'customer', contextId: 'not-a-uuid' }),
    ).resolves.toBe(false);
  });

  it('refuses an upload once the ticket is no longer live', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Answered and closed off the question.', expectedStatus: 'open' },
      }),
    );

    await expect(
      supportAttachmentPolicy.canUpload({ userId: user.userId, activeMode: 'customer', contextId: ticketId }),
    ).resolves.toBe(false);
  });

  it('lets the requester read back, and an admin holding support/read read too', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const stranger = await registerAndLogin();
    const ticketId = await makeTicket(user);
    const asset = assetFor(ticketId);

    await expect(
      supportAttachmentPolicy.canRead({ userId: user.userId, activeMode: 'customer', asset }),
    ).resolves.toBe(true);
    await expect(
      supportAttachmentPolicy.canRead({ userId: admin.userId, activeMode: 'customer', asset }),
    ).resolves.toBe(true);
    await expect(
      supportAttachmentPolicy.canRead({ userId: stranger.userId, activeMode: 'customer', asset }),
    ).resolves.toBe(false);
  });

  it('a resolved ticket stays READABLE even though it is no longer attachable', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Answered and closed off the question.', expectedStatus: 'open' },
      }),
    );

    // Someone must still be able to look at what they sent.
    await expect(
      supportAttachmentPolicy.canRead({ userId: user.userId, activeMode: 'customer', asset: assetFor(ticketId) }),
    ).resolves.toBe(true);
  });
});
