import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { getDb } from '@/lib/db';
import type { UploadUrlRequest } from '@/lib/types/files';
import { createUploadTarget } from './upload';
import { queryRows } from './sql';
import {
  createRequestOwnedBy,
  createUser,
  isDatabaseReachable,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';

const dbReachable = await isDatabaseReachable();

/**
 * Spec 027 §3 — `Idempotency-Key` on `upload-url`, reusing spec 015's shared mechanism and its
 * per-entity key columns rather than a second scheme. The key is REQUIRED here specifically because
 * this call creates a row and reserves storage: a retry must not leave an orphan behind.
 */
describe.skipIf(!dbReachable)('file upload idempotency (spec 027, integration)', () => {
  const storage = useTemporaryStorageDir();
  afterAll(() => storage.cleanup());
  beforeEach(() => withShippedPolicies());

  async function scenario() {
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
    return { userId, request, key: randomUUID() };
  }

  const call = (userId: string, request: UploadUrlRequest, key: string, body: unknown = request) =>
    createUploadTarget({
      session: { userId, activeMode: 'customer' },
      request,
      idempotencyKey: key,
      idempotencyFingerprint: idempotencyFingerprint(body),
      correlationId: 'test',
    });

  async function assetCount(userId: string): Promise<number> {
    const [row] = await queryRows<{ n: number }>(
      getDb(),
      sql`SELECT count(*)::int AS n FROM file_assets WHERE uploaded_by_user_id = ${userId}`,
    );
    return row!.n;
  }

  it('the same key and the same body replay the same target, reserving nothing new', async () => {
    const { userId, request, key } = await scenario();

    const first = await call(userId, request, key);
    const second = await call(userId, request, key);

    expect(second.fileAsset.id).toBe(first.fileAsset.id);
    expect(await assetCount(userId)).toBe(1);

    // Property order in the body must not matter — the fingerprint is canonicalized.
    const reordered = { contextType: request.contextType, mimeType: request.mimeType, kind: request.kind, sizeBytes: request.sizeBytes, fileName: request.fileName, contextId: request.contextId };
    const third = await call(userId, request, key, reordered);
    expect(third.fileAsset.id).toBe(first.fileAsset.id);
    expect(await assetCount(userId)).toBe(1);
  });

  it('the same key with a different body is 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const { userId, request, key } = await scenario();
    await call(userId, request, key);

    await expect(call(userId, { ...request, fileName: 'different.jpg' }, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    });
    expect(await assetCount(userId)).toBe(1);
  });

  it('concurrent identical calls create exactly one asset', async () => {
    const { userId, request, key } = await scenario();

    // The unique index is what converges these, not a read-then-write check in application code.
    const results = await Promise.all([
      call(userId, request, key),
      call(userId, request, key),
      call(userId, request, key),
      call(userId, request, key),
    ]);

    const ids = new Set(results.map((r) => r.fileAsset.id));
    expect(ids.size).toBe(1);
    expect(await assetCount(userId)).toBe(1);
  });

  it('the key is scoped per owner — two users may use the same key independently', async () => {
    const a = await scenario();
    const b = await scenario();

    const first = await call(a.userId, a.request, 'shared-key');
    const second = await call(b.userId, b.request, 'shared-key');

    expect(second.fileAsset.id).not.toBe(first.fileAsset.id);
    expect(await assetCount(a.userId)).toBe(1);
    expect(await assetCount(b.userId)).toBe(1);
  });
});
