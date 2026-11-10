import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError } from '@/lib/api/errors';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { adapterOrThrow, findLiveAsset, serveFileContent } from '@/lib/files';
import { fileNotFoundError, fileTooLargeError } from '@/lib/files/errors';
import { verifyContentSignature, verifyUploadSignature } from '@/lib/files/storage';
import { maxBytesFor } from '@/lib/files/config';

export const dynamic = 'force-dynamic';

function fileAssetIdFrom(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2] ?? '');
}

/**
 * Spec 027 §3, `GET /api/v1/files/{id}/content` (AC-3, AC-6) — the target a signed URL points at.
 *
 * Authenticated by SIGNATURE, not by session, exactly as spec 008's export download is: a real
 * signed URL stands on its own. But a signature only says which user the link was issued to — it is
 * never an authorization of its own. Every single fetch re-verifies the signature and its expiry,
 * reloads the asset, refuses anything not `ready`, and re-runs the context policy's `canRead` for
 * the bound user. That is what makes a leaked link worthless to a third party, an expired link
 * worthless to everyone, and a link whose underlying access was revoked stop working immediately.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const url = new URL(request.url);
  const fileAssetId = fileAssetIdFrom(request);

  // Rate limited on the BOUND user id (the same `files` budget): a signed link is a credential, and
  // an unauthenticated route that reads storage must still be bounded per caller.
  const bound = verifyContentSignature(fileAssetId, url.searchParams);
  if (bound) {
    const limit = checkRateLimit('files', bound.userId);
    if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
  }

  const content = await serveFileContent(fileAssetId, url);
  const res = new NextResponse(new Uint8Array(content.bytes), {
    status: 200,
    headers: {
      'content-type': content.contentType,
      'content-length': String(content.bytes.length),
      // Private bytes behind a per-user signed link must never be cached by a shared cache.
      'cache-control': 'private, no-store',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
    },
  });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});

/**
 * Spec 027 §3 "Storage adapter seam" — the LOCAL development adapter's upload target.
 *
 * This exists because the local adapter has no vendor to pre-sign a URL with, so it points the
 * client back at this application. It is authenticated by the adapter's own upload signature (a
 * distinct HMAC purpose from the download one, so an upload credential can never be replayed as a
 * download), and it writes bytes through the adapter and nothing else — it creates no row, changes
 * no status and grants no readability. Only `POST /files/{id}/finalize` can do any of that.
 *
 * A real object-storage adapter returns its own pre-signed URL from `createUploadTarget` and this
 * route is simply never used.
 */
export const PUT = withApiRoute(async (request, correlationId) => {
  const url = new URL(request.url);
  const fileAssetId = fileAssetIdFrom(request);

  const verified = verifyUploadSignature(url.searchParams);
  // Missing, forged or expired: indistinguishable from an unknown asset (AC-6).
  if (!verified) throw fileNotFoundError();

  const asset = await findLiveAsset(fileAssetId);
  // Only a reservation that is still `pending` accepts bytes: a terminal asset's object is frozen.
  if (!asset || asset.status !== 'pending' || asset.storage_key !== verified.storageKey) throw fileNotFoundError();

  const bytes = Buffer.from(await request.arrayBuffer());
  // A hard ceiling before anything touches the disk. `finalize` re-checks the stored object anyway
  // (AC-1), but refusing here means an oversized body is never written in the first place.
  const maxBytes = maxBytesFor(asset.kind);
  if (bytes.length > maxBytes) throw fileTooLargeError(maxBytes);

  await adapterOrThrow().write(asset.storage_key, bytes, asset.mime_type ?? 'application/octet-stream');

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
