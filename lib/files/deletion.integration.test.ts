import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { getDb } from '@/lib/db';
import { REDACTED_DESCRIPTION } from '@/lib/privacy/deletion';
import type { UploadUrlRequest } from '@/lib/types/files';
import { issueFileUrl } from './access';
import { deleteFileAsset, redactFileAssetsForDeletedUser } from './deletion';
import { resolveFileStorageAdapter } from './storage';
import { runFileMaintenanceSweep } from './sweep';
import { createUploadTarget, finalizeUpload } from './upload';
import { queryRows } from './sql';
import {
  backdateDeletion,
  createRequestOwnedBy,
  createUser,
  isDatabaseReachable,
  jpegBytes,
  loadAsset,
  setLegalHold,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 027 AC-9 — deletion is a SOFT delete: the record survives, only the bytes eventually go. */
describe.skipIf(!dbReachable)('file deletion and retention (spec 027 AC-9, integration)', () => {
  const storage = useTemporaryStorageDir();
  afterAll(() => storage.cleanup());
  beforeEach(() => withShippedPolicies());

  async function readyAttachment(): Promise<{
    userId: string;
    requestId: string;
    fileAssetId: string;
    storageKey: string;
  }> {
    const userId = await createUser();
    const requestId = await createRequestOwnedBy(userId);
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'photo.jpg',
      contextType: 'request_attachment',
      contextId: requestId,
    };
    const target = await createUploadTarget({
      session: { userId, activeMode: 'customer' },
      request,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: idempotencyFingerprint(request),
      correlationId: 'test',
    });
    const storageKey = (await loadAsset(target.fileAsset.id))!.storage_key!;
    await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');
    await finalizeUpload({ userId }, target.fileAsset.id, 'test');
    return { userId, requestId, fileAssetId: target.fileAsset.id, storageKey };
  }

  /** Spec 015's linkage row — untouched by this spec, and it must survive a delete. */
  async function linkToRequest(requestId: string, fileAssetId: string): Promise<void> {
    await getDb().execute(
      sql`INSERT INTO request_attachments (request_id, file_asset_id) VALUES (${requestId}, ${fileAssetId})`,
    );
  }

  it('soft delete hides the asset and keeps its linkage', async () => {
    const { userId, requestId, fileAssetId } = await readyAttachment();
    await linkToRequest(requestId, fileAssetId);

    await deleteFileAsset({ userId }, fileAssetId, 'test');

    // It reads as 404 to everyone — including the owner who just deleted it.
    await expect(issueFileUrl({ userId, activeMode: 'customer' }, fileAssetId, 'test')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      status: 404,
    });

    // The row survives (every FK onto it is RESTRICT) and so does spec 015's linkage.
    const row = (await loadAsset(fileAssetId))!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.status).toBe('ready');
    const links = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM request_attachments WHERE file_asset_id = ${fileAssetId}`,
    );
    expect(links[0]!.n).toBe(1);
  });

  it('only the owner may delete; anyone else is 404, never 403', async () => {
    const { fileAssetId } = await readyAttachment();
    const stranger = await createUser();

    await expect(deleteFileAsset({ userId: stranger }, fileAssetId, 'test')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      status: 404,
    });
    expect((await loadAsset(fileAssetId))!.deleted_at).toBeNull();
  });

  it('bytes are purged after the grace period, and not before it', async () => {
    const { userId, fileAssetId, storageKey } = await readyAttachment();
    await deleteFileAsset({ userId }, fileAssetId, 'test');

    // Inside the grace period: the bytes are deliberately still there.
    await runFileMaintenanceSweep();
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(true);
    expect((await loadAsset(fileAssetId))!.storage_deleted_at).toBeNull();

    await backdateDeletion(fileAssetId, 30);
    const result = await runFileMaintenanceSweep();
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(false);
    expect((await loadAsset(fileAssetId))!.storage_deleted_at).not.toBeNull();
  });

  it('a legal-hold asset is retained — its bytes are never purged', async () => {
    const { userId, fileAssetId, storageKey } = await readyAttachment();
    await setLegalHold(fileAssetId, true);
    await deleteFileAsset({ userId }, fileAssetId, 'test');
    await backdateDeletion(fileAssetId, 365);

    await runFileMaintenanceSweep();

    // Evidence survives the grace period entirely.
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(true);
    expect((await loadAsset(fileAssetId))!.storage_deleted_at).toBeNull();
  });

  it('account deletion redacts the filename and queues purge, retaining legal-hold assets', async () => {
    const { userId, fileAssetId, storageKey } = await readyAttachment();
    const held = await readyAttachment();
    // The held asset belongs to the SAME user, so both go through one redaction pass.
    await getDb().execute(sql`UPDATE file_assets SET uploaded_by_user_id = ${userId} WHERE id = ${held.fileAssetId}`);
    await setLegalHold(held.fileAssetId, true);

    await redactFileAssetsForDeletedUser(getDb(), userId, REDACTED_DESCRIPTION);

    const ordinary = (await loadAsset(fileAssetId))!;
    expect(ordinary.file_name).toBe(REDACTED_DESCRIPTION);
    expect(ordinary.deleted_at).not.toBeNull();

    const evidence = (await loadAsset(held.fileAssetId))!;
    // Retained as evidence — but with the owner already anonymized and the name redacted too.
    expect(evidence.file_name).toBe(REDACTED_DESCRIPTION);
    expect(evidence.deleted_at).toBeNull();
    expect(evidence.legal_hold).toBe(true);

    await backdateDeletion(fileAssetId, 30);
    await runFileMaintenanceSweep();
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(false);
    expect((await resolveFileStorageAdapter().head(held.storageKey)).exists).toBe(true);
  });

  it('a second delete is 404 — the asset genuinely is not there any more', async () => {
    const { userId, fileAssetId } = await readyAttachment();
    await deleteFileAsset({ userId }, fileAssetId, 'test');
    await expect(deleteFileAsset({ userId }, fileAssetId, 'test')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('no row is ever hard-deleted by any of this', async () => {
    const { userId, fileAssetId } = await readyAttachment();
    await deleteFileAsset({ userId }, fileAssetId, 'test');
    await backdateDeletion(fileAssetId, 90);
    await runFileMaintenanceSweep();

    const rows = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM file_assets WHERE id = ${fileAssetId}`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});
