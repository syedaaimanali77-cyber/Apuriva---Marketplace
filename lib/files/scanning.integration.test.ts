import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import type { UploadUrlRequest } from '@/lib/types/files';
import { resolveFileStorageAdapter } from './storage';
import { TEST_UNKNOWN_MARKER, TEST_UNSAFE_MARKER, EICAR_TEST_STRING } from './scanning';
import { runFileMaintenanceSweep } from './sweep';
import { createUploadTarget, finalizeUpload } from './upload';
import {
  createRequestOwnedBy,
  createUser,
  isDatabaseReachable,
  jpegBytes,
  jpegWithMarker,
  loadAsset,
  makeScanDue,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 027 AC-4 — the scan verdict is the ONLY thing that makes a file readable. */
describe.skipIf(!dbReachable)('file scanning (spec 027 AC-4, integration)', () => {
  const storage = useTemporaryStorageDir();
  const originalMaxAttempts = process.env.FILE_SCAN_MAX_ATTEMPTS;

  afterAll(() => storage.cleanup());
  beforeEach(() => withShippedPolicies());
  afterEach(() => {
    if (originalMaxAttempts === undefined) delete process.env.FILE_SCAN_MAX_ATTEMPTS;
    else process.env.FILE_SCAN_MAX_ATTEMPTS = originalMaxAttempts;
    vi.restoreAllMocks();
  });

  /** Reserves, uploads the given bytes and finalizes — returning the asset id and storage key. */
  async function upload(bytes: Buffer): Promise<{ userId: string; fileAssetId: string; storageKey: string }> {
    const userId = await createUser();
    const requestId = await createRequestOwnedBy(userId);
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: bytes.length,
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
    await resolveFileStorageAdapter().write(storageKey, bytes, 'image/jpeg');
    await finalizeUpload({ userId }, target.fileAsset.id, 'test');
    return { userId, fileAssetId: target.fileAsset.id, storageKey };
  }

  it('clean becomes ready, and only then', async () => {
    const { fileAssetId } = await upload(jpegBytes(64));
    const row = (await loadAsset(fileAssetId))!;
    expect(row.status).toBe('ready');
    expect(row.scan_outcome).toBe('clean');
    expect(row.ready_at).not.toBeNull();
  });

  it('rejected is terminal and purges bytes', async () => {
    const { fileAssetId, storageKey } = await upload(jpegWithMarker(TEST_UNSAFE_MARKER));

    const row = (await loadAsset(fileAssetId))!;
    expect(row.status).toBe('rejected');
    expect(row.scan_outcome).toBe('rejected');
    expect(row.rejection_reason).toBe('test_marker');
    expect(row.ready_at).toBeNull();
    // Purged immediately, not after a grace period.
    expect((await resolveFileStorageAdapter().head(storageKey)).exists).toBe(false);
    expect(row.storage_deleted_at).not.toBeNull();

    // Terminal: the sweep leaves it alone, and it is never re-admitted.
    await runFileMaintenanceSweep();
    expect((await loadAsset(fileAssetId))!.status).toBe('rejected');
  });

  it('the standard EICAR test string is rejected', async () => {
    const { fileAssetId } = await upload(jpegWithMarker(EICAR_TEST_STRING));
    const row = (await loadAsset(fileAssetId))!;
    expect(row.status).toBe('rejected');
    expect(row.rejection_reason).toBe('eicar');
  });

  it('unknown never becomes ready, across every retry and past the ceiling', async () => {
    process.env.FILE_SCAN_MAX_ATTEMPTS = '3';
    const { fileAssetId } = await upload(jpegWithMarker(TEST_UNKNOWN_MARKER));

    // The inline finalize attempt already counted once and left it non-ready.
    let row = (await loadAsset(fileAssetId))!;
    expect(row.status).toBe('scanning');
    expect(row.scan_outcome).toBe('unknown');
    expect(row.scan_attempts).toBe(1);
    expect(row.scan_next_attempt_at).not.toBeNull();

    // Each sweep pass retries and STILL refuses to guess.
    for (const expectedAttempts of [2, 3]) {
      await makeScanDue(fileAssetId);
      await runFileMaintenanceSweep();
      row = (await loadAsset(fileAssetId))!;
      expect(row.scan_attempts).toBe(expectedAttempts);
      expect(row.status).toBe('scanning');
      expect(row.ready_at).toBeNull();
    }

    // At the ceiling it stops being auto-claimed — but is STILL not a terminal state.
    expect(row.scan_next_attempt_at).toBeNull();
    expect(row.status).toBe('scanning');
    await runFileMaintenanceSweep();
    expect((await loadAsset(fileAssetId))!.scan_attempts).toBe(3);
  });

  it('logs file.scan_unresolved at the ceiling so an operator is told', async () => {
    process.env.FILE_SCAN_MAX_ATTEMPTS = '1';
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });

    const { fileAssetId } = await upload(jpegWithMarker(TEST_UNKNOWN_MARKER));
    vi.restoreAllMocks();

    expect(logged.some((line) => line.includes('file.scan_unresolved'))).toBe(true);
    const row = (await loadAsset(fileAssetId))!;
    expect(row.status).toBe('scanning');
    expect(row.scan_next_attempt_at).toBeNull();
  });

  it('a scanner that throws is treated as unknown, never as clean', async () => {
    process.env.FILE_SCAN_MAX_ATTEMPTS = '5';
    const scanning = await import('./scanning');
    vi.spyOn(scanning, 'resolveFileScanner').mockImplementation(() => {
      throw new Error('scanner unreachable');
    });

    const { fileAssetId } = await upload(jpegBytes(64));
    const row = (await loadAsset(fileAssetId))!;
    expect(row.status).not.toBe('ready');
    expect(row.status).toBe('scanning');
    expect(row.scan_outcome).toBe('unknown');
  });
});
