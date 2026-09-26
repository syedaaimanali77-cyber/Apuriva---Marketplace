import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { listAuditLogs, parseAuditLogQuery } from '@/lib/audit/read';

/**
 * Spec 039 §3.8 L1, `GET /api/v1/admin/audit-logs` — the caller's visible audit entries, newest
 * first. Requires `audit_logs/read`; entries are limited to the caller's domain scope IN SQL
 * (§3.7, AC-4), so `total` counts only what the caller may see. A `resource` filter outside that
 * scope is `403`. Read-only: no CSRF, no `Idempotency-Key`; the existing `default` rate-limit bucket.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const params = new URL(request.url).searchParams;
  const page = parsePageParams(params);
  const query = parseAuditLogQuery(params);
  const { rows, total } = await listAuditLogs(session.userId, query, page);
  return apiPaged(rows, buildPage(total, page.limit, page.offset), correlationId);
});
