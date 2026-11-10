import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { getAuditLog } from '@/lib/audit/read';

/** `{id}` is the last path segment — `withApiRoute` forwards no route context. */
function idFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/**
 * Spec 039 §3.8 L2, `GET /api/v1/admin/audit-logs/{id}` — one audit entry. Requires
 * `audit_logs/read`. An unknown id and an id outside the caller's scope are the same `404`, so ids
 * cannot be probed (AC-4).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const entry = await getAuditLog(session.userId, idFromUrl(request));
  return apiSuccess(entry, correlationId);
});
