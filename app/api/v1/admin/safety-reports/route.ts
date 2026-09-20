import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { requireSession } from '@/lib/auth/require-session';
import { listSafetyQueue, requireSafetyReadPermission } from '@/lib/safety';

/**
 * Spec 030 §3, `GET /api/v1/admin/safety-reports` — S6, AC-3.
 *
 * Behind `safety_reports/read` (`low`), granted to Trust & Safety and Super Admin ONLY. Every other
 * admin role — including `support_admin`, which already reaches conversations through spec 025's
 * `messaging/read_conversation` — receives `403`, resolved server-side.
 *
 * ORDERED `priority DESC, created_at ASC`. Among equal priorities that is FIFO, which is what
 * actually protects a report no rule could have recognised as urgent (DECIDED-1): since nothing
 * classifies a report automatically, the ordering is the whole of the fairness guarantee.
 *
 * THE READ ITSELF IS AUDITED. `safety.queue_read` is written on every page load, because who looked
 * at a safety queue is as sensitive as what they did about it (master §64).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  await requireSafetyReadPermission(session.userId);

  const limit = checkRateLimit('safety', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const page = parsePageParams(new URL(request.url).searchParams);
  const { rows, total } = await listSafetyQueue(session.userId, page, correlationId);
  return apiPaged(rows, buildPage(total, page.limit, page.offset), correlationId);
});
