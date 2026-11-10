import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { getDb } from '@/lib/db';
import type { ActiveMode } from '@/lib/types/users';
import type { FileContextType, UploadUrlRequest } from '@/lib/types/files';
import { MAX_PORTFOLIO_ASSETS, MAX_REQUEST_ATTACHMENTS } from './contexts/policies';
import { createUploadTarget } from './upload';
import { queryRows } from './sql';
import {
  createProviderProfile,
  createRequestOwnedBy,
  createUser,
  isDatabaseReachable,
  useTemporaryStorageDir,
  withShippedPolicies,
} from './files-test-support';

const dbReachable = await isDatabaseReachable();

/** Spec 027 AC-8 — a context is usable only while its policy is registered, and only by its owner. */
describe.skipIf(!dbReachable)('file contexts (spec 027 AC-8, integration)', () => {
  const storage = useTemporaryStorageDir();
  afterAll(() => storage.cleanup());
  beforeEach(() => withShippedPolicies());

  const reserve = (
    userId: string,
    activeMode: ActiveMode,
    overrides: Partial<UploadUrlRequest> & Pick<UploadUrlRequest, 'contextType'>,
  ) => {
    const request: UploadUrlRequest = {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 64,
      fileName: 'photo.jpg',
      contextId: null,
      ...overrides,
    };
    return createUploadTarget({
      session: { userId, activeMode },
      request,
      idempotencyKey: randomUUID(),
      idempotencyFingerprint: idempotencyFingerprint(request),
      correlationId: 'test',
    });
  };

  async function totalAssets(): Promise<number> {
    const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM file_assets`);
    return row!.n;
  }

  it('a reserved context is 422 FILE_CONTEXT_NOT_AVAILABLE and creates no row', async () => {
    const userId = await createUser();
    const before = await totalAssets();

    for (const contextType of ['booking_evidence', 'dispute_evidence', 'verification_document'] as FileContextType[]) {
      await expect(reserve(userId, 'customer', { contextType, contextId: randomUUID() })).rejects.toMatchObject({
        code: 'FILE_CONTEXT_NOT_AVAILABLE',
        status: 422,
      });
    }

    // AC-8's load-bearing half: an unauthorizable asset can never come into existence.
    expect(await totalAssets()).toBe(before);
  });

  it('data_export is unreachable through these routes', async () => {
    const userId = await createUser();
    await expect(reserve(userId, 'customer', { contextType: 'data_export', contextId: null })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('request_attachment: the owning customer may upload, a stranger may not', async () => {
    const owner = await createUser();
    const requestId = await createRequestOwnedBy(owner);
    const stranger = await createUser();

    const target = await reserve(owner, 'customer', { contextType: 'request_attachment', contextId: requestId });
    expect(target.fileAsset.contextType).toBe('request_attachment');
    expect(target.fileAsset.visibility).toBe('private');

    // Indistinguishable from "no such request" — an id cannot be probed for existence.
    await expect(
      reserve(stranger, 'customer', { contextType: 'request_attachment', contextId: requestId }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND', status: 404 });
  });

  it('portfolio: the uploader owns the provider profile, and it is the one public-eligible context', async () => {
    const providerUser = await createUser();
    const providerProfileId = await createProviderProfile(providerUser);
    const stranger = await createUser();

    const target = await reserve(providerUser, 'provider', {
      contextType: 'portfolio',
      contextId: providerProfileId,
      visibility: 'public',
    });
    expect(target.fileAsset.visibility).toBe('public');

    await expect(
      reserve(stranger, 'provider', { contextType: 'portfolio', contextId: providerProfileId }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('a kind the context does not allow is refused', async () => {
    const owner = await createUser();
    const requestId = await createRequestOwnedBy(owner);

    // `request_attachment` takes images and documents, never video.
    await expect(
      reserve(owner, 'customer', {
        contextType: 'request_attachment',
        contextId: requestId,
        kind: 'video',
        mimeType: 'video/mp4',
      }),
    ).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
  });

  it('the per-context count cap is enforced at upload-url', async () => {
    const owner = await createUser();
    const requestId = await createRequestOwnedBy(owner);

    for (let i = 0; i < MAX_REQUEST_ATTACHMENTS; i += 1) {
      await reserve(owner, 'customer', { contextType: 'request_attachment', contextId: requestId });
    }

    await expect(
      reserve(owner, 'customer', { contextType: 'request_attachment', contextId: requestId }),
    ).rejects.toMatchObject({ code: 'FILE_CONTEXT_LIMIT_REACHED', status: 422 });
  });

  it('the caps are the documented product defaults', () => {
    expect(MAX_REQUEST_ATTACHMENTS).toBe(5);
    expect(MAX_PORTFOLIO_ASSETS).toBe(20);
  });

  it('an unknown context VALUE never reaches the database vocabulary check', async () => {
    const userId = await createUser();
    const before = await totalAssets();
    const { parseUploadUrlRequest } = await import('./upload');

    expect(() =>
      parseUploadUrlRequest({
        kind: 'image',
        mimeType: 'image/jpeg',
        sizeBytes: 64,
        fileName: 'x.jpg',
        contextType: 'something_invented',
      }),
    ).toThrow(expect.objectContaining({ code: 'FILE_CONTEXT_NOT_AVAILABLE' }));

    expect(await totalAssets()).toBe(before);
    expect(userId).toBeTruthy();
  });
});
