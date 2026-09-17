import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { getDb } from '@/lib/db';
import type { UploadUrlRequest } from '@/lib/types/files';
import {
  grantRole,
  registerAdmin,
  resetMessagingIntegration,
  seedConfirmedBooking,
  useMessagingIntegration,
} from '@/lib/messaging/messaging-test-support';
import { issueFileUrl, serveFileContent } from './access';
import { resolveFileStorageAdapter } from './storage';
import { createUploadTarget, finalizeUpload } from './upload';
import { queryRows } from './sql';
import {
  createUser,
  isDatabaseReachable,
  jpegBytes,
  loadAsset,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 027 §3 "Context authorization" — the `message_attachment` policy DELEGATES to spec 025's
 * `resolveConversationAccess`. Spec 025's rules are reused, never re-implemented here, and this
 * suite proves it by exercising them through a real booking seeded the real way.
 */
describe.skipIf(!dbReachable)(
  'message attachment context (spec 027, integration)',
  // Every test here seeds a real booking through spec 015 -> 018 -> 020 -> 021's actual route
  // handlers. That chain alone can approach the global 15s timeout once the full suite has many
  // workers running, so this suite gets a budget matched to what it genuinely does.
  { timeout: 60_000 },
  () => {
  const storage = useTemporaryStorageDir();

  afterAll(() => storage.cleanup());
  beforeEach(() => {
    useMessagingIntegration();
    withShippedPolicies();
  });
  afterEach(() => resetMessagingIntegration());

  async function readyAttachment(userId: string, activeMode: 'customer' | 'provider', bookingId: string): Promise<string> {
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'receipt.jpg',
      contextType: 'message_attachment',
      contextId: bookingId,
    };
    const target = await createUploadTarget({
      session: { userId, activeMode },
      request,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: idempotencyFingerprint(request),
      correlationId: 'test',
    });
    const storageKey = (await loadAsset(target.fileAsset.id))!.storage_key!;
    await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');
    const finalized = await finalizeUpload({ userId }, target.fileAsset.id, 'test');
    expect(finalized.status).toBe('ready');
    return target.fileAsset.id;
  }

  it('both booking participants may read; a stranger is 404', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const fileAssetId = await readyAttachment(scenario.customer.userId, 'customer', bookingId);
    const stranger = await createUser();

    // The uploading customer.
    await expect(
      issueFileUrl({ userId: scenario.customer.userId, activeMode: 'customer' }, fileAssetId, 'test'),
    ).resolves.toMatchObject({ visibility: 'private' });

    // The counterparty provider, in their own mode.
    await expect(
      issueFileUrl({ userId: scenario.provider.userId, activeMode: 'provider' }, fileAssetId, 'test'),
    ).resolves.toMatchObject({ visibility: 'private' });

    await expect(issueFileUrl({ userId: stranger, activeMode: 'customer' }, fileAssetId, 'test')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      status: 404,
    });
  });

  it("wrong active mode on a message attachment is 403 — spec 025's rule, not a rule invented here", async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const fileAssetId = await readyAttachment(scenario.customer.userId, 'customer', bookingId);

    // A genuine participant, but acting in the mode they do not hold on this booking.
    await expect(
      issueFileUrl({ userId: scenario.provider.userId, activeMode: 'customer' }, fileAssetId, 'test'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // And the same at upload time.
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'x.jpg',
      contextType: 'message_attachment',
      contextId: bookingId,
    };
    await expect(
      createUploadTarget({
        session: { userId: scenario.provider.userId, activeMode: 'customer' },
        request,
        idempotencyKey: randomUUID(),
        idempotencyFingerprint: idempotencyFingerprint(request),
        correlationId: 'test',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('a signed link works for the party it was issued to, in either role', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const fileAssetId = await readyAttachment(scenario.customer.userId, 'customer', bookingId);

    for (const party of [
      { userId: scenario.customer.userId, activeMode: 'customer' as const },
      { userId: scenario.provider.userId, activeMode: 'provider' as const },
    ]) {
      const issued = await issueFileUrl(party, fileAssetId, 'test');
      const content = await serveFileContent(fileAssetId, new URL(`http://localhost${issued.url}`));
      expect(content.contentType).toBe('image/jpeg');
    }
  });

  it('a support admin with messaging/read_conversation may read, and the read is AUDITED', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const fileAssetId = await readyAttachment(scenario.customer.userId, 'customer', bookingId);

    const admin = await registerAdmin();
    await grantRole(admin, 'support_admin');

    const issued = await issueFileUrl({ userId: admin.userId, activeMode: 'customer' }, fileAssetId, 'correlation-123');
    expect(issued.visibility).toBe('private');

    // Spec 009's helper wrote the audit entry, correlated to the originating request.
    const events = await queryRows<{ event_type: string; metadata: Record<string, unknown> }>(
      getDb(),
      sql`SELECT event_type, metadata FROM security_events
           WHERE user_id = ${admin.userId} AND event_type = 'files.read_message_attachment'
           ORDER BY created_at DESC LIMIT 1`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({
      resource: 'messaging',
      action: 'read_conversation',
      targetType: 'file_asset',
      targetId: fileAssetId,
      correlationId: 'correlation-123',
    });
  });

  it('an admin WITHOUT the permission is 404, like any other stranger', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const fileAssetId = await readyAttachment(scenario.customer.userId, 'customer', bookingId);

    const admin = await registerAdmin();
    await grantRole(admin, 'finance_admin');

    await expect(
      issueFileUrl({ userId: admin.userId, activeMode: 'customer' }, fileAssetId, 'test'),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });
  });
  },
);
