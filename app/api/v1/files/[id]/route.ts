import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { deleteFileAsset, issueFileUrl } from '@/lib/files';

function fileAssetIdFrom(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1] ?? '');
}

/**
 * Spec 027 §3, `GET /api/v1/files/{id}` (AC-2, AC-3, AC-6).
 *
 * Authorization is re-resolved here on EVERY issue — the URL it hands back is a credential, not a
 * decision. A private asset gets a signed URL bound to this caller and expiring after
 * `FILE_SIGNED_URL_TTL_SECONDS`; a public-eligible `ready` asset gets a CDN URL carrying the
 * delivery transform. A non-`ready` asset yields no URL at all: `409 FILE_NOT_READY`.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('files', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return apiSuccess(await issueFileUrl(session, fileAssetIdFrom(request), correlationId), correlationId);
});

/**
 * Spec 027 §3, `DELETE /api/v1/files/{id}` (AC-9). Owner only; anyone else is `404`, never `403`.
 * Soft delete: the asset immediately reads as `404` to everyone, its linkage rows are untouched
 * (every FK is RESTRICT) and its bytes are purged later by the maintenance sweep.
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('files', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  await deleteFileAsset(session, fileAssetIdFrom(request), correlationId);
  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
