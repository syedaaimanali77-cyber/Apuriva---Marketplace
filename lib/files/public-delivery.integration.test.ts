import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import type { UploadUrlRequest } from '@/lib/types/files';
import { issueFileUrl } from './access';
import { DEFAULT_DELIVERY_TRANSFORM, resolveImageOptimizer } from './optimization';
import { resolveFileStorageAdapter } from './storage';
import { createUploadTarget, finalizeUpload } from './upload';
import {
  createProviderProfile,
  createRequestOwnedBy,
  createUser,
  isDatabaseReachable,
  jpegBytes,
  loadAsset,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';

const dbReachable = await isDatabaseReachable();
const CDN_BASE = 'https://cdn.example.test/media';

/** Spec 027 AC-2 — public delivery, and the transform an honest optimizer boundary can still carry. */
describe.skipIf(!dbReachable)('public file delivery (spec 027 AC-2, integration)', () => {
  const storage = useTemporaryStorageDir();
  const originalCdn = process.env.FILE_PUBLIC_CDN_BASE_URL;

  afterAll(() => storage.cleanup());
  beforeEach(() => {
    withShippedPolicies();
    process.env.FILE_PUBLIC_CDN_BASE_URL = CDN_BASE;
  });
  afterEach(() => {
    if (originalCdn === undefined) delete process.env.FILE_PUBLIC_CDN_BASE_URL;
    else process.env.FILE_PUBLIC_CDN_BASE_URL = originalCdn;
  });

  async function portfolioAsset(options: { finalize: boolean }): Promise<{ userId: string; fileAssetId: string }> {
    const userId = await createUser();
    const providerProfileId = await createProviderProfile(userId);
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'work.jpg',
      contextType: 'portfolio',
      contextId: providerProfileId,
      visibility: 'public',
    };
    const target = await createUploadTarget({
      session: { userId, activeMode: 'provider' },
      request,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: idempotencyFingerprint(request),
      correlationId: 'test',
    });
    if (options.finalize) {
      const storageKey = (await loadAsset(target.fileAsset.id))!.storage_key!;
      await resolveFileStorageAdapter().write(storageKey, jpegBytes(64), 'image/jpeg');
      await finalizeUpload({ userId }, target.fileAsset.id, 'test');
    }
    return { userId, fileAssetId: target.fileAsset.id };
  }

  it('a ready portfolio image returns a CDN url with the delivery transform', async () => {
    const { userId, fileAssetId } = await portfolioAsset({ finalize: true });

    const issued = await issueFileUrl({ userId, activeMode: 'provider' }, fileAssetId, 'test');
    expect(issued.visibility).toBe('public');
    expect(issued.url.startsWith(CDN_BASE)).toBe(true);
    // A CDN URL has no expiry — that is what makes it a CDN URL rather than a signed one.
    expect(issued.expiresAt).toBeNull();
    // AC-2: the width cap and quality the ImageOptimizer port defines ride on the URL.
    expect(issued.url).toContain(`w=${DEFAULT_DELIVERY_TRANSFORM.width}`);
    expect(issued.url).toContain(`q=${DEFAULT_DELIVERY_TRANSFORM.quality}`);
    // It is never a signed URL, so it carries no signature material at all.
    expect(issued.url).not.toContain('sig=');
  });

  it('a public asset is readable by anyone once ready — that is what public means', async () => {
    const { fileAssetId } = await portfolioAsset({ finalize: true });
    const stranger = await createUser();

    const issued = await issueFileUrl({ userId: stranger, activeMode: 'customer' }, fileAssetId, 'test');
    expect(issued.visibility).toBe('public');
    expect(issued.url.startsWith(CDN_BASE)).toBe(true);
  });

  it('a non-ready public asset returns no url', async () => {
    const { userId, fileAssetId } = await portfolioAsset({ finalize: false });

    await expect(issueFileUrl({ userId, activeMode: 'provider' }, fileAssetId, 'test')).rejects.toMatchObject({
      code: 'FILE_NOT_READY',
      status: 409,
    });
  });

  it('a private asset never gets a public url, whatever the CDN is set to', async () => {
    const userId = await createUser();
    const requestId = await createRequestOwnedBy(userId);
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'photo.jpg',
      contextType: 'request_attachment',
      contextId: requestId,
      // Asked for public on a private-only context.
      visibility: 'public',
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

    const issued = await issueFileUrl({ userId, activeMode: 'customer' }, target.fileAsset.id, 'test');
    expect(issued.visibility).toBe('private');
    expect(issued.url.startsWith(CDN_BASE)).toBe(false);
    expect(issued.expiresAt).not.toBeNull();
  });

  it('with no CDN configured, a public asset is served the private way rather than claiming a CDN', async () => {
    const { userId, fileAssetId } = await portfolioAsset({ finalize: true });
    delete process.env.FILE_PUBLIC_CDN_BASE_URL;

    const issued = await issueFileUrl({ userId, activeMode: 'provider' }, fileAssetId, 'test');
    expect(issued.url).toContain('sig=');
    expect(issued.expiresAt).not.toBeNull();
  });

  it('the optimizer DECLINES to resize and says so, rather than claiming a resize that never happened', async () => {
    const optimizer = resolveImageOptimizer();
    expect(await optimizer.optimize({ storageKey: 'k', mimeType: 'image/jpeg', sizeBytes: 100 })).toEqual({
      optimized: false,
      reason: 'no_optimizer',
    });

    // The delivery transform is where AC-2's resizing/compression is honestly expressed.
    expect(optimizer.deliveryTransform({ mimeType: 'image/jpeg' })).toEqual(DEFAULT_DELIVERY_TRANSFORM);
    // A PDF or video has no width/quality transform to carry.
    expect(optimizer.deliveryTransform({ mimeType: 'application/pdf' })).toEqual({});
  });
});
