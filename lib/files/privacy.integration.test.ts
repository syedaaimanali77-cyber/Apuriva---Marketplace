import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { generateExportPayload } from '@/lib/privacy/export';
import type { UploadUrlRequest } from '@/lib/types/files';
import { exportFileAssetData } from './privacy';
import { resolveFileStorageAdapter } from './storage';
import { createUploadTarget, finalizeUpload } from './upload';
import {
  createRequestOwnedBy,
  createUser,
  isDatabaseReachable,
  jpegBytes,
  loadAsset,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 027 §4 "Retention and privacy" — metadata only, the caller's own assets only. */
describe.skipIf(!dbReachable)('file privacy export (spec 027, integration)', () => {
  const storage = useTemporaryStorageDir();
  afterAll(() => storage.cleanup());
  beforeEach(() => withShippedPolicies());

  async function readyAttachment(userId?: string): Promise<{ userId: string; fileAssetId: string; storageKey: string }> {
    const owner = userId ?? (await createUser());
    const requestId = await createRequestOwnedBy(owner);
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'holiday-photo.jpg',
      contextType: 'request_attachment',
      contextId: requestId,
    };
    const target = await createUploadTarget({
      session: { userId: owner, activeMode: 'customer' },
      request,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: idempotencyFingerprint(request),
      correlationId: 'test',
    });
    const storageKey = (await loadAsset(target.fileAsset.id))!.storage_key!;
    await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');
    await finalizeUpload({ userId: owner }, target.fileAsset.id, 'test');
    return { userId: owner, fileAssetId: target.fileAsset.id, storageKey };
  }

  it('the export carries file metadata, and no storage key, checksum or scan internals', async () => {
    const { userId, fileAssetId, storageKey } = await readyAttachment();

    const files = await exportFileAssetData(userId);
    const entry = files.find((f) => f.id === fileAssetId)!;
    expect(entry).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      fileName: 'holiday-photo.jpg',
      contextType: 'request_attachment',
      status: 'ready',
    });
    expect(entry.sizeBytes).toBe(jpegBytes(64).length);

    const serialized = JSON.stringify(files);
    for (const forbidden of ['storageKey', 'storage_key', 'checksum', 'scanOutcome', 'scan_', 'idempotency', 'legalHold']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    // Not even by value: the storage key itself must not appear anywhere in the payload.
    expect(serialized).not.toContain(storageKey);
    // Bytes are never exported — they are already reachable through their own authorized URLs.
    expect(serialized).not.toContain(jpegBytes(64).toString('base64'));
  });

  it("never another party's asset", async () => {
    const mine = await readyAttachment();
    const theirs = await readyAttachment();

    const files = await exportFileAssetData(mine.userId);
    expect(files.map((f) => f.id)).toContain(mine.fileAssetId);
    expect(files.map((f) => f.id)).not.toContain(theirs.fileAssetId);
  });

  it("spec 008's full export payload carries the files array", async () => {
    const { userId, fileAssetId } = await readyAttachment();

    const payload = await generateExportPayload(userId);
    expect(Array.isArray(payload.files)).toBe(true);
    expect(payload.files.map((f) => f.id)).toContain(fileAssetId);
    expect(JSON.stringify(payload.files)).not.toContain('storage_key');
  });

  it('a soft-deleted asset drops out of the export', async () => {
    const { userId, fileAssetId } = await readyAttachment();
    const { deleteFileAsset } = await import('./deletion');

    expect((await exportFileAssetData(userId)).map((f) => f.id)).toContain(fileAssetId);
    await deleteFileAsset({ userId }, fileAssetId, 'test');
    expect((await exportFileAssetData(userId)).map((f) => f.id)).not.toContain(fileAssetId);
  });
});
