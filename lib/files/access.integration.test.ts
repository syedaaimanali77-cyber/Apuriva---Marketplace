import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { getDb } from '@/lib/db';
import type { UploadUrlRequest } from '@/lib/types/files';
import { issueFileUrl, serveFileContent } from './access';
import { resolveFileStorageAdapter } from './storage';
import { buildContentUrl } from './storage/signing';
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

/**
 * Spec 027 AC-3 and AC-6 — the rule a leaked or stale link cannot get around: a signature says who
 * a link was issued to, never that they may read it. Authorization is re-resolved on every fetch.
 */
describe.skipIf(!dbReachable)('file access control (spec 027 AC-3, AC-6, integration)', () => {
  const storage = useTemporaryStorageDir();
  const originalTtl = process.env.FILE_SIGNED_URL_TTL_SECONDS;

  afterAll(() => storage.cleanup());
  beforeEach(() => withShippedPolicies());
  afterEach(() => {
    if (originalTtl === undefined) delete process.env.FILE_SIGNED_URL_TTL_SECONDS;
    else process.env.FILE_SIGNED_URL_TTL_SECONDS = originalTtl;
  });

  /** A ready, private `request_attachment` owned by a fresh customer. */
  async function readyAttachment(): Promise<{ userId: string; requestId: string; fileAssetId: string }> {
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
    const finalized = await finalizeUpload({ userId }, target.fileAsset.id, 'test');
    expect(finalized.status).toBe('ready');
    return { userId, requestId, fileAssetId: target.fileAsset.id };
  }

  const contentUrl = (path: string) => new URL(`http://localhost${path}`);

  it('a private asset is reachable only through a signed url that expires', async () => {
    process.env.FILE_SIGNED_URL_TTL_SECONDS = '300';
    const { userId, fileAssetId } = await readyAttachment();

    const issued = await issueFileUrl({ userId, activeMode: 'customer' }, fileAssetId, 'test');
    expect(issued.visibility).toBe('private');
    // AC-3: no permanently public path to a private object exists.
    expect(issued.expiresAt).not.toBeNull();
    expect(new Date(issued.expiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(issued.expiresAt!).getTime()).toBeLessThanOrEqual(Date.now() + 301_000);
    expect(issued.url).toContain('sig=');

    const content = await serveFileContent(fileAssetId, contentUrl(issued.url));
    expect(content.bytes).toEqual(jpegBytes(64));
    expect(content.contentType).toBe('image/jpeg');
  });

  it('a leaked signed url fails for another user', async () => {
    const { userId, fileAssetId } = await readyAttachment();
    const stranger = await createUser();

    const issued = await issueFileUrl({ userId, activeMode: 'customer' }, fileAssetId, 'test');
    const leaked = contentUrl(issued.url);
    // The whole attack: a third party pastes the link, swapping in their own id.
    leaked.searchParams.set('uid', stranger);

    await expect(serveFileContent(fileAssetId, leaked)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });

    // And a link forged wholesale for the stranger is refused too — the HMAC covers the user id.
    const forged = contentUrl(buildContentUrl(fileAssetId, stranger, 300).path);
    forged.searchParams.set('sig', 'deadbeef');
    await expect(serveFileContent(fileAssetId, forged)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('an expired signature is refused', async () => {
    const { userId, fileAssetId } = await readyAttachment();

    // Issued with a TTL already in the past — the signature itself is valid, only stale.
    const expired = contentUrl(buildContentUrl(fileAssetId, userId, -1).path);
    await expect(serveFileContent(fileAssetId, expired)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });

    // An extended expiry does not help: `exp` is inside the signed tuple.
    const tampered = contentUrl(buildContentUrl(fileAssetId, userId, -1).path);
    tampered.searchParams.set('exp', String(Date.now() + 600_000));
    await expect(serveFileContent(fileAssetId, tampered)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('access revoked after issue fails at the next fetch', async () => {
    const { userId, requestId, fileAssetId } = await readyAttachment();

    const issued = await issueFileUrl({ userId, activeMode: 'customer' }, fileAssetId, 'test');
    // It works right now.
    await expect(serveFileContent(fileAssetId, contentUrl(issued.url))).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });

    // The access that justified it goes away: the request is reassigned to another customer.
    const otherUser = await createUser();
    const otherRequest = await createRequestOwnedBy(otherUser);
    const [otherProfile] = (
      await getDb().execute(sql`SELECT customer_profile_id FROM requests WHERE id = ${otherRequest}`)
    ).rows as { customer_profile_id: string }[];
    await getDb().execute(
      sql`UPDATE requests SET customer_profile_id = ${otherProfile!.customer_profile_id} WHERE id = ${requestId}`,
    );

    // The SAME unexpired link now fails — authorization is re-resolved, not remembered.
    await expect(serveFileContent(fileAssetId, contentUrl(issued.url))).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it("another user's id is 404, never 403", async () => {
    const { fileAssetId } = await readyAttachment();
    const stranger = await createUser();

    const err = await issueFileUrl({ userId: stranger, activeMode: 'customer' }, fileAssetId, 'test').catch((e) => e);
    expect(err.code).toBe('FILE_NOT_FOUND');
    expect(err.status).toBe(404);

    // An id that does not exist at all answers identically, so existence is not probeable.
    const missing = await issueFileUrl({ userId: stranger, activeMode: 'customer' }, randomUUID(), 'test').catch((e) => e);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe(err.code);

    // A malformed id too.
    const malformed = await issueFileUrl({ userId: stranger, activeMode: 'customer' }, 'not-a-uuid', 'test').catch((e) => e);
    expect(malformed.status).toBe(404);
  });

  it('a non-ready asset yields no url and no bytes, even to its owner', async () => {
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

    await expect(issueFileUrl({ userId, activeMode: 'customer' }, target.fileAsset.id, 'test')).rejects.toMatchObject({
      code: 'FILE_NOT_READY',
      status: 409,
    });

    // Even a correctly signed link cannot pull bytes for a pending asset.
    const signed = contentUrl(buildContentUrl(target.fileAsset.id, userId, 300).path);
    await expect(serveFileContent(target.fileAsset.id, signed)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('an unsigned or partially signed content request is refused outright', async () => {
    const { userId, fileAssetId } = await readyAttachment();

    for (const query of ['', `?uid=${userId}`, `?uid=${userId}&exp=${Date.now() + 60_000}`]) {
      await expect(
        serveFileContent(fileAssetId, contentUrl(`/api/v1/files/${fileAssetId}/content${query}`)),
      ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    }
  });
});
