import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { finalizeUpload } from '@/lib/files';

/**
 * Spec 027 §3, `POST /api/v1/files/{id}/finalize` (AC-1, AC-4, AC-5).
 *
 * This is the server confirmation AC-5 turns on: a client that has finished sending bytes has NOT
 * finished uploading — the actual stored object is measured and sniffed here, and only a `clean`
 * scan afterwards makes the file readable. Naturally idempotent (a second call returns the current
 * row), so it needs no `Idempotency-Key` of its own.
 *
 * `withApiRoute` forwards no route context, so `{id}` is read from the URL.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('files', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  const fileAssetId = decodeURIComponent(segments[segments.length - 2] ?? '');
  return apiSuccess(await finalizeUpload(session, fileAssetId, correlationId), correlationId);
});
