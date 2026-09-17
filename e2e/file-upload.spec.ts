import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as UPLOAD_URL } from '@/app/api/v1/files/upload-url/route';
import { POST as FINALIZE } from '@/app/api/v1/files/[id]/finalize/route';
import { GET as GET_FILE } from '@/app/api/v1/files/[id]/route';
import { GET as GET_CONTENT, PUT as PUT_CONTENT } from '@/app/api/v1/files/[id]/content/route';
import { IDEMPOTENCY_KEY_HEADER } from '@/lib/api/idempotency';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, registerAndLogin } from '@/app/api/v1/search/search-test-support';
import {
  createRequestOwnedBy,
  isDatabaseReachable,
  jpegBytes,
  useTemporaryStorageDir,
  withShippedPolicies,
} from '@/lib/files/files-test-support';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/files';

type Session = Awaited<ReturnType<typeof registerAndLogin>>;

/**
 * Spec 027 §6 "E2E" — the whole journey through the real route handlers, real sessions and the real
 * isolated database: a customer attaches a photo to their request and sees it; a stranger cannot
 * reach it with the id OR with a copied link.
 *
 * Vitest, not Playwright — there is no Playwright in this repository, and `e2e/*.spec.ts` is the
 * pattern `vitest.config.ts` already configures and five existing specs already use.
 */
describe.skipIf(!dbReachable)('file upload end to end (spec 027)', () => {
  const storage = useTemporaryStorageDir();
  afterAll(() => storage.cleanup());
  beforeEach(() => {
    resetRateLimitState();
    withShippedPolicies();
  });

  const post = (url: string, s: Session, body?: unknown) =>
    authenticatedRequest(url, s.sessionId, s.csrfToken, { method: 'POST', body });
  const get = (url: string, s: Session) => authenticatedRequest(url, s.sessionId, s.csrfToken, { method: 'GET' });

  it('a customer uploads a request attachment and sees it previewed', async () => {
    const customer = await registerAndLogin();
    const requestId = await createRequestOwnedBy(customer.userId);

    // 1. Declare the file. Nothing is stored yet, and nothing is readable.
    const reserve = post(`${BASE}/upload-url`, customer, {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: jpegBytes(64).length,
      fileName: 'kitchen.jpg',
      contextType: 'request_attachment',
      contextId: requestId,
    });
    reserve.headers.set(IDEMPOTENCY_KEY_HEADER, randomUUID());
    const reserveRes = await UPLOAD_URL(reserve);
    expect(reserveRes.status).toBe(200);
    const { data: target } = await reserveRes.json();
    expect(target.fileAsset.status).toBe('pending');

    // 2. Send the bytes to the adapter's upload target.
    const put = await PUT_CONTENT(
      new Request(`http://localhost${target.upload.url}`, { method: 'PUT', body: new Uint8Array(jpegBytes(64)) }),
    );
    expect(put.status).toBe(204);

    // Sending the bytes did NOT attach the file — this is AC-5's boundary, at the server.
    const beforeFinalize = await GET_FILE(get(`${BASE}/${target.fileAsset.id}`, customer));
    expect(beforeFinalize.status).toBe(409);

    // 3. The server confirms: measures the object, sniffs its type, scans it.
    const finalizeRes = await FINALIZE(post(`${BASE}/${target.fileAsset.id}/finalize`, customer));
    expect(finalizeRes.status).toBe(200);
    const { data: finalized } = await finalizeRes.json();
    expect(finalized.status).toBe('ready');

    // 4. The preview: a signed URL, and the bytes behind it.
    const urlRes = await GET_FILE(get(`${BASE}/${target.fileAsset.id}`, customer));
    const { data: url } = await urlRes.json();
    expect(url.visibility).toBe('private');
    expect(url.expiresAt).not.toBeNull();

    const content = await GET_CONTENT(new Request(`http://localhost${url.url}`));
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(jpegBytes(64));
  });

  it('a stranger cannot read it with the id or a copied link', async () => {
    const customer = await registerAndLogin();
    const stranger = await registerAndLogin();
    const requestId = await createRequestOwnedBy(customer.userId);

    const reserve = post(`${BASE}/upload-url`, customer, {
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: jpegBytes(64).length,
      fileName: 'private.jpg',
      contextType: 'request_attachment',
      contextId: requestId,
    });
    reserve.headers.set(IDEMPOTENCY_KEY_HEADER, randomUUID());
    const { data: target } = await (await UPLOAD_URL(reserve)).json();
    await PUT_CONTENT(new Request(`http://localhost${target.upload.url}`, { method: 'PUT', body: new Uint8Array(jpegBytes(64)) }));
    await FINALIZE(post(`${BASE}/${target.fileAsset.id}/finalize`, customer));

    // Guessing the id: 404, never 403, so the id cannot even be confirmed to exist.
    const byId = await GET_FILE(get(`${BASE}/${target.fileAsset.id}`, stranger));
    expect(byId.status).toBe(404);
    expect((await byId.json()).code).toBe('FILE_NOT_FOUND');

    // Copying the owner's link: the signature is bound to the owner, so it is worthless here even
    // though the stranger holds a perfectly valid, unexpired URL.
    const { data: ownerUrl } = await (await GET_FILE(get(`${BASE}/${target.fileAsset.id}`, customer))).json();
    const copied = new URL(`http://localhost${ownerUrl.url}`);
    copied.searchParams.set('uid', stranger.userId);
    expect((await GET_CONTENT(new Request(copied.toString()))).status).toBe(404);

    // And the owner's own link still works — nothing above weakened it.
    expect((await GET_CONTENT(new Request(`http://localhost${ownerUrl.url}`))).status).toBe(200);
  });
});
