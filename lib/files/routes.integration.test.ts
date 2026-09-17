import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as UPLOAD_URL } from '@/app/api/v1/files/upload-url/route';
import { POST as FINALIZE } from '@/app/api/v1/files/[id]/finalize/route';
import { GET as GET_FILE, DELETE as DELETE_FILE } from '@/app/api/v1/files/[id]/route';
import { GET as GET_CONTENT, PUT as PUT_CONTENT } from '@/app/api/v1/files/[id]/content/route';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { RATE_LIMIT_DEFAULTS, resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { IDEMPOTENCY_KEY_HEADER } from '@/lib/api/idempotency';
import { CSRF_HEADER_NAME } from '@/lib/auth/csrf';
import { authenticatedRequest, registerAndLogin } from '@/app/api/v1/search/search-test-support';
import { getDb } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createRequestOwnedBy, isDatabaseReachable, jpegBytes, useTemporaryStorageDir, withShippedPolicies } from './files-test-support';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/files';

type Session = Awaited<ReturnType<typeof registerAndLogin>>;

/** Spec 027 §3 "Endpoints" — the guards, the status/error matrix and OpenAPI registration. */
describe.skipIf(!dbReachable)('file routes (spec 027, integration)', () => {
  const storage = useTemporaryStorageDir();
  const originalProvider = process.env.FILE_STORAGE_PROVIDER;

  afterAll(() => storage.cleanup());
  beforeEach(() => {
    resetRateLimitState();
    withShippedPolicies();
  });
  afterEach(() => {
    if (originalProvider === undefined) delete process.env.FILE_STORAGE_PROVIDER;
    else process.env.FILE_STORAGE_PROVIDER = originalProvider;
  });

  /** Gives the registered session's user a customer profile + request to attach to. */
  async function ownedRequest(session: Session): Promise<string> {
    const requestId = await createRequestOwnedBy(await createUserForSession(session));
    return requestId;
  }

  /** `createRequestOwnedBy` makes its own customer profile; point it at this session's user. */
  async function createUserForSession(session: Session): Promise<string> {
    return session.userId;
  }

  const uploadBody = (requestId: string) => ({
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 64,
    fileName: 'photo.jpg',
    contextType: 'request_attachment',
    contextId: requestId,
  });

  function withKey(request: Request, key = randomUUID()): Request {
    request.headers.set(IDEMPOTENCY_KEY_HEADER, key);
    return request;
  }

  const post = (url: string, s: Session, body?: unknown) =>
    authenticatedRequest(url, s.sessionId, s.csrfToken, { method: 'POST', body });

  /** Reserves, uploads bytes through the PUT target and finalizes — all through the ROUTES. */
  async function uploadThroughRoutes(session: Session): Promise<{ id: string; uploadUrl: string }> {
    const requestId = await ownedRequest(session);
    const res = await UPLOAD_URL(withKey(post(`${BASE}/upload-url`, session, uploadBody(requestId))));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    const put = await PUT_CONTENT(
      new Request(`http://localhost${data.upload.url}`, { method: 'PUT', body: new Uint8Array(jpegBytes(64)) }),
    );
    expect(put.status).toBe(204);

    const finalized = await FINALIZE(post(`${BASE}/${data.fileAsset.id}/finalize`, session));
    expect(finalized.status).toBe(200);
    return { id: data.fileAsset.id, uploadUrl: data.upload.url };
  }

  it('session required on every browser route', async () => {
    const anonymous = (url: string, method = 'GET') => new Request(url, { method });
    const id = randomUUID();
    for (const res of [
      await UPLOAD_URL(anonymous(`${BASE}/upload-url`, 'POST')),
      await FINALIZE(anonymous(`${BASE}/${id}/finalize`, 'POST')),
      await GET_FILE(anonymous(`${BASE}/${id}`)),
      await DELETE_FILE(anonymous(`${BASE}/${id}`, 'DELETE')),
    ]) {
      expect(res.status).toBe(401);
    }
  });

  it('CSRF on every mutation', async () => {
    const user = await registerAndLogin();
    const id = randomUUID();
    const noCsrf = (url: string, method: string, body?: unknown) =>
      new Request(url, {
        method,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${user.sessionId}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    for (const res of [
      await UPLOAD_URL(withKey(noCsrf(`${BASE}/upload-url`, 'POST', uploadBody(randomUUID())))),
      await FINALIZE(noCsrf(`${BASE}/${id}/finalize`, 'POST')),
      await DELETE_FILE(noCsrf(`${BASE}/${id}`, 'DELETE')),
    ]) {
      expect(res.status).toBe(403);
    }
    expect(CSRF_HEADER_NAME).toBeTruthy();
  });

  it('Idempotency-Key is required on upload-url', async () => {
    const user = await registerAndLogin();
    const requestId = await ownedRequest(user);

    const missing = await UPLOAD_URL(post(`${BASE}/upload-url`, user, uploadBody(requestId)));
    expect(missing.status).toBe(400);
    const body = await missing.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors?.[0]?.field).toBe(IDEMPOTENCY_KEY_HEADER);
  });

  it('the full route pipeline: upload-url -> PUT -> finalize -> GET url -> GET content -> DELETE', async () => {
    const user = await registerAndLogin();
    const { id } = await uploadThroughRoutes(user);

    const urlRes = await GET_FILE(authenticatedRequest(`${BASE}/${id}`, user.sessionId, user.csrfToken, { method: 'GET' }));
    expect(urlRes.status).toBe(200);
    const { data: url } = await urlRes.json();
    expect(url.visibility).toBe('private');
    expect(url.expiresAt).not.toBeNull();

    const content = await GET_CONTENT(new Request(`http://localhost${url.url}`));
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/jpeg');
    // Private bytes behind a per-user link must never sit in a shared cache.
    expect(content.headers.get('cache-control')).toContain('no-store');
    expect(Buffer.from(await content.arrayBuffer())).toEqual(jpegBytes(64));

    const deleted = await DELETE_FILE(
      authenticatedRequest(`${BASE}/${id}`, user.sessionId, user.csrfToken, { method: 'DELETE' }),
    );
    expect(deleted.status).toBe(204);

    // Immediately 404 to everyone, and the signed link stops working too.
    const afterDelete = await GET_FILE(
      authenticatedRequest(`${BASE}/${id}`, user.sessionId, user.csrfToken, { method: 'GET' }),
    );
    expect(afterDelete.status).toBe(404);
    expect((await GET_CONTENT(new Request(`http://localhost${url.url}`))).status).toBe(404);
  });

  it('the status/error matrix', async () => {
    const user = await registerAndLogin();
    const requestId = await ownedRequest(user);
    const get = (id: string, s: Session) => GET_FILE(authenticatedRequest(`${BASE}/${id}`, s.sessionId, s.csrfToken, { method: 'GET' }));

    // 404 for an unknown id.
    expect((await get(randomUUID(), user)).status).toBe(404);

    // 409 FILE_NOT_READY for a reserved but unfinalized asset.
    const reserved = await UPLOAD_URL(withKey(post(`${BASE}/upload-url`, user, uploadBody(requestId))));
    const { data: reservedData } = await reserved.json();
    const notReady = await get(reservedData.fileAsset.id, user);
    expect(notReady.status).toBe(409);
    expect((await notReady.json()).code).toBe('FILE_NOT_READY');

    // 422 FILE_CONTEXT_NOT_AVAILABLE for a reserved context.
    const reservedContext = await UPLOAD_URL(
      withKey(post(`${BASE}/upload-url`, user, { ...uploadBody(requestId), contextType: 'dispute_evidence' })),
    );
    expect(reservedContext.status).toBe(422);
    expect((await reservedContext.json()).code).toBe('FILE_CONTEXT_NOT_AVAILABLE');

    // 400 FILE_TYPE_NOT_ALLOWED / FILE_TOO_LARGE on the declared values.
    const badType = await UPLOAD_URL(
      withKey(post(`${BASE}/upload-url`, user, { ...uploadBody(requestId), kind: 'document', mimeType: 'application/x-msdownload' })),
    );
    expect(badType.status).toBe(400);
    expect((await badType.json()).code).toBe('FILE_TYPE_NOT_ALLOWED');

    const tooLarge = await UPLOAD_URL(
      withKey(post(`${BASE}/upload-url`, user, { ...uploadBody(requestId), sizeBytes: 999_999_999 })),
    );
    expect((await tooLarge.json()).code).toBe('FILE_TOO_LARGE');

    // 409 FILE_REJECTED once terminal.
    await getDb().execute(sql`
      UPDATE file_assets SET status = 'rejected', rejection_reason = 'test_marker'
       WHERE id = ${reservedData.fileAsset.id}
    `);
    const rejected = await get(reservedData.fileAsset.id, user);
    expect(rejected.status).toBe(409);
    const rejectedBody = await rejected.json();
    expect(rejectedBody.code).toBe('FILE_REJECTED');
    expect(rejectedBody.details.reasonCode).toBe('test_marker');
  });

  it("another user's asset is 404, never 403 — so ids cannot be probed", async () => {
    const owner = await registerAndLogin();
    const stranger = await registerAndLogin();
    const { id } = await uploadThroughRoutes(owner);

    for (const res of [
      await GET_FILE(authenticatedRequest(`${BASE}/${id}`, stranger.sessionId, stranger.csrfToken, { method: 'GET' })),
      await FINALIZE(post(`${BASE}/${id}/finalize`, stranger)),
      await DELETE_FILE(authenticatedRequest(`${BASE}/${id}`, stranger.sessionId, stranger.csrfToken, { method: 'DELETE' })),
    ]) {
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('FILE_NOT_FOUND');
    }
  });

  it('no route accepts status, visibility, owner or storageKey', async () => {
    const user = await registerAndLogin();
    const requestId = await ownedRequest(user);

    const res = await UPLOAD_URL(
      withKey(
        post(`${BASE}/upload-url`, user, {
          ...uploadBody(requestId),
          status: 'ready',
          storageKey: 'attacker/controlled',
          uploadedByUserId: randomUUID(),
          readyAt: new Date().toISOString(),
        }),
      ),
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();

    // Every one of those was ignored: the row is server-derived throughout.
    expect(data.fileAsset.status).toBe('pending');
    expect(data.fileAsset.readyAt).toBeNull();
    const rows = (await getDb().execute(sql`SELECT storage_key, uploaded_by_user_id FROM file_assets WHERE id = ${data.fileAsset.id}`))
      .rows as { storage_key: string; uploaded_by_user_id: string }[];
    expect(rows[0]!.storage_key).toBe(`${user.userId}/${data.fileAsset.id}`);
    expect(rows[0]!.uploaded_by_user_id).toBe(user.userId);
  });

  it('an unavailable adapter is 503, and nothing is marked ready', async () => {
    const user = await registerAndLogin();
    const requestId = await ownedRequest(user);
    process.env.FILE_STORAGE_PROVIDER = 'a-vendor-we-have-no-account-with';

    const res = await UPLOAD_URL(withKey(post(`${BASE}/upload-url`, user, uploadBody(requestId))));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('FILE_STORAGE_UNAVAILABLE');

    const ready = (await getDb().execute(
      sql`SELECT count(*)::int AS n FROM file_assets WHERE uploaded_by_user_id = ${user.userId} AND status = 'ready'`,
    )).rows as { n: number }[];
    expect(ready[0]!.n).toBe(0);
  });

  it('the PUT upload target grants no readability — only finalize does', async () => {
    const user = await registerAndLogin();
    const requestId = await ownedRequest(user);
    const res = await UPLOAD_URL(withKey(post(`${BASE}/upload-url`, user, uploadBody(requestId))));
    const { data } = await res.json();

    await PUT_CONTENT(new Request(`http://localhost${data.upload.url}`, { method: 'PUT', body: new Uint8Array(jpegBytes(64)) }));

    // Bytes are stored, but the asset is still `pending` and still unreadable.
    const after = await GET_FILE(authenticatedRequest(`${BASE}/${data.fileAsset.id}`, user.sessionId, user.csrfToken, { method: 'GET' }));
    expect(after.status).toBe(409);
    expect((await after.json()).code).toBe('FILE_NOT_READY');
  });

  it('an unsigned PUT to the upload target is refused', async () => {
    const user = await registerAndLogin();
    const requestId = await ownedRequest(user);
    const res = await UPLOAD_URL(withKey(post(`${BASE}/upload-url`, user, uploadBody(requestId))));
    const { data } = await res.json();

    const unsigned = await PUT_CONTENT(
      new Request(`${BASE}/${data.fileAsset.id}/content`, { method: 'PUT', body: new Uint8Array(jpegBytes(64)) }),
    );
    expect(unsigned.status).toBe(404);
  });

  it('all six routes are registered and tagged files; the cron route is absent', () => {
    const registered = OPENAPI_ROUTES.filter((r) => r.tags.includes('files'));
    expect(registered.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        'POST /files/upload-url',
        'POST /files/{id}/finalize',
        'GET /files/{id}',
        'GET /files/{id}/content',
        'PUT /files/{id}/content',
        'DELETE /files/{id}',
      ].sort(),
    );
    expect(OPENAPI_ROUTES.some((r) => r.path.includes('cron'))).toBe(false);
  });

  it('the files rate-limit domain exists with a write-surface budget', () => {
    expect(RATE_LIMIT_DEFAULTS.files).toEqual({ limit: 30, windowMs: 60_000 });
  });
});
