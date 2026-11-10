import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import type { UploadUrlRequest } from '@/lib/types/files';
import { createUploadTarget, finalizeUpload } from './upload';
import { resolveFileStorageAdapter } from './storage';
import {
  createRequestOwnedBy,
  createUser,
  isDatabaseReachable,
  jpegBytes,
  loadAsset,
  pdfBytes,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 027 AC-1, AC-5, AC-7 — upload-url -> PUT -> finalize, and everything it refuses. */
describe.skipIf(!dbReachable)('file upload lifecycle (spec 027, integration)', () => {
  const storage = useTemporaryStorageDir();
  afterAll(() => storage.cleanup());
  beforeEach(() => withShippedPolicies());

  async function reserve(
    overrides: Partial<UploadUrlRequest> = {},
  ): Promise<{ userId: string; requestId: string; fileAssetId: string; storageKey: string }> {
    const userId = await createUser();
    const requestId = await createRequestOwnedBy(userId);
    const body: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'photo.jpg',
      contextType: 'request_attachment',
      contextId: requestId,
      ...overrides,
    };
    const target = await createUploadTarget({
      session: { userId, activeMode: 'customer' },
      request: body,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: idempotencyFingerprint(body),
      correlationId: 'test',
    });
    const row = (await loadAsset(target.fileAsset.id))!;
    return { userId, requestId, fileAssetId: target.fileAsset.id, storageKey: row.storage_key! };
  }

  it('reserves a pending row whose every sensitive column is server-derived', async () => {
    const userId = await createUser();
    const requestId = await createRequestOwnedBy(userId);
    const body: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: '../../etc/passwd',
      contextType: 'request_attachment',
      contextId: requestId,
      // AC-2/AC-7: asking for `public` on a private-only context does NOT make it public.
      visibility: 'public',
    };
    const target = await createUploadTarget({
      session: { userId, activeMode: 'customer' },
      request: body,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: idempotencyFingerprint(body),
      correlationId: 'test',
    });

    expect(target.fileAsset.status).toBe('pending');
    expect(target.fileAsset.visibility).toBe('private');
    expect(target.upload.method).toBe('PUT');
    expect(new Date(target.upload.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const row = (await loadAsset(target.fileAsset.id))!;
    expect(row.uploaded_by_user_id).toBe(userId);
    // The storage key is derived, never supplied — and never built from the file name.
    expect(row.storage_key).toBe(`${userId}/${target.fileAsset.id}`);
    expect(row.file_name).not.toContain('/');
    expect(row.ready_at).toBeNull();
    expect(row.scan_outcome).toBeNull();

    // The DTO never carries routing or diagnostic data.
    expect(Object.keys(target.fileAsset)).not.toContain('storageKey');
    expect(JSON.stringify(target.fileAsset)).not.toContain(row.storage_key!);
  });

  it('upload-url -> PUT -> finalize -> scanning -> ready', async () => {
    const { fileAssetId, storageKey } = await reserve();
    const bytes = jpegBytes(64);
    await resolveFileStorageAdapter().write(storageKey, bytes, 'image/jpeg');

    const finalized = await finalizeUpload({ userId: (await loadAsset(fileAssetId))!.uploaded_by_user_id! }, fileAssetId, 'test');
    expect(finalized.status).toBe('ready');
    expect(finalized.readyAt).not.toBeNull();
    // The ACTUAL size replaces the declared one.
    expect(finalized.sizeBytes).toBe(bytes.length);

    const row = (await loadAsset(fileAssetId))!;
    expect(row.scan_outcome).toBe('clean');
    expect(row.scan_next_attempt_at).toBeNull();
  });

  it('FILE_NOT_UPLOADED when the adapter reports no object at the key', async () => {
    const { userId, fileAssetId } = await reserve();
    await expect(finalizeUpload({ userId }, fileAssetId, 'test')).rejects.toMatchObject({
      code: 'FILE_NOT_UPLOADED',
      status: 422,
    });
    expect((await loadAsset(fileAssetId))!.status).toBe('pending');
  });

  it('an actual size over the limit rejects and purges', async () => {
    const previous = process.env.FILE_MAX_IMAGE_BYTES;
    process.env.FILE_MAX_IMAGE_BYTES = '1024';
    try {
      const { userId, fileAssetId, storageKey } = await reserve({ sizeBytes: 64 });
      // The client declared 64 bytes and then sent 4 KB — the declaration was never trusted.
      await resolveFileStorageAdapter().write(storageKey, jpegBytes(4096), 'image/jpeg');

      const result = await finalizeUpload({ userId }, fileAssetId, 'test');
      expect(result.status).toBe('rejected');
      expect(result.rejectionReason).toBe('too_large');

      // Purged, not merely ignored.
      expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(false);
      expect((await loadAsset(fileAssetId))!.storage_deleted_at).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.FILE_MAX_IMAGE_BYTES;
      else process.env.FILE_MAX_IMAGE_BYTES = previous;
    }
  });

  it('a .jpg whose bytes are not a JPEG is rejected and its bytes purged', async () => {
    const { userId, fileAssetId, storageKey } = await reserve();
    // Declared image/jpeg, actually a PDF. This is what stops a .jpg-labelled executable.
    await resolveFileStorageAdapter().write(storageKey, pdfBytes(64), 'image/jpeg');

    const result = await finalizeUpload({ userId }, fileAssetId, 'test');
    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('type_mismatch');
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(false);
  });

  it('finalize is idempotent — a second call returns the same terminal row unchanged', async () => {
    const { userId, fileAssetId, storageKey } = await reserve();
    await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');

    const first = await finalizeUpload({ userId }, fileAssetId, 'test');
    const second = await finalizeUpload({ userId }, fileAssetId, 'test');
    expect(second).toEqual(first);
    expect(second.version).toBe(first.version);
  });

  it('only the uploader may finalize; anyone else is 404, never 403', async () => {
    const { fileAssetId, storageKey } = await reserve();
    await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');
    const stranger = await createUser();

    await expect(finalizeUpload({ userId: stranger }, fileAssetId, 'test')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      status: 404,
    });
    expect((await loadAsset(fileAssetId))!.status).toBe('pending');
  });

  it('a declared type or size that could never be accepted creates NO row', async () => {
    const userId = await createUser();
    const requestId = await createRequestOwnedBy(userId);

    for (const [request, code] of [
      [{ kind: 'document', mimeType: 'application/x-msdownload', sizeBytes: 10 }, 'FILE_TYPE_NOT_ALLOWED'],
      [{ kind: 'image', mimeType: 'image/jpeg', sizeBytes: 999_999_999 }, 'FILE_TOO_LARGE'],
    ] as const) {
      await expect(
        createUploadTarget({
          session: { userId, activeMode: 'customer' },
          request: { ...request, fileName: 'x', contextType: 'request_attachment', contextId: requestId },
          idempotencyKey: randomUUID(),
          idempotencyFingerprint: 'fp',
          correlationId: 'test',
        }),
      ).rejects.toMatchObject({ code });
    }

    const { queryRows } = await import('./sql');
    const { getDb } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const rows = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM file_assets WHERE uploaded_by_user_id = ${userId}`,
    );
    expect(rows[0]!.n).toBe(0);
  });
});
