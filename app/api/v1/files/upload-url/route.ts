import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { createUploadTarget, parseUploadUrlRequest } from '@/lib/files';

/**
 * Spec 027 §3, `POST /api/v1/files/upload-url` (AC-1, AC-8). Guard order is spec 004's:
 * session -> CSRF -> rate limit.
 *
 * `Idempotency-Key` is REQUIRED here specifically because this call creates a row and reserves
 * storage: a retried request must not leave a second orphaned reservation behind. A replay with the
 * same body returns the same target; the same key with a different body is `409`.
 *
 * Nothing in the body can set `status`, `visibility`, `owner`, `context` or `storage_key` — the
 * body is a DECLARATION the server checks, and every one of those columns is server-derived (AC-7).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('files', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const key = requireIdempotencyKey(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw validationError([{ field: 'body', message: 'must be valid JSON' }]);
  }

  const parsed = parseUploadUrlRequest(body);
  const target = await createUploadTarget({
    session,
    request: parsed,
    idempotencyKey: key,
    idempotencyFingerprint: idempotencyFingerprint(body),
    correlationId,
  });
  return apiSuccess(target, correlationId);
});
