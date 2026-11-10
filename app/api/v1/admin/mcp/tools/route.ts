import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { listMcpToolMetadata, requireMcpRegistryPermission } from '@/lib/mcp';

/**
 * Spec 035 §3 "Admin surface", `GET /api/v1/admin/mcp/tools` — the registered tools and what each
 * is allowed to do. Requires `mcp/read_registry`, seeded for Super Admin only (migration 0031).
 *
 * METADATA ONLY: name, risk tier, label, reversibility, mode and confirmation/idempotency
 * declarations. No tool input, no tool output and no call history — the persisted tool-call log is
 * spec 036's, and so is any view of it (§3, §7).
 *
 * Read-only, so no CSRF (the double-submit check guards state-changing requests, spec 005 §3).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  await requireMcpRegistryPermission(session.userId);

  return apiSuccess(listMcpToolMetadata(), correlationId);
});
