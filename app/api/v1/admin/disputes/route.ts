import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { listDisputeQueue, requireDisputeReadPermission } from '@/lib/disputes';
import { isDisputeStatus } from '@/lib/types/disputes';

/**
 * Spec 031 §3, `GET /api/v1/admin/disputes` — the Trust & Safety queue (DECIDED-2).
 *
 * ORDERING: live disputes first, then `created_at ASC` — FIFO among equals, the same fairness
 * property spec 030's queue has. Nothing waits indefinitely because something newer keeps arriving.
 *
 * `disputes/read` is held by `operations_admin`, `trust_safety_admin` and `super_admin`. Operations
 * can WATCH the queue because master §2970 lists Disputes under their nav and a booking's dispute
 * is booking context they legitimately need — but they hold neither `disputes/resolve` nor
 * `disputes/review_appeal`, so they cannot decide anything. `finance_admin` is deliberately absent:
 * Finance sees the refund request through spec 022's own `refunds/read`.
 *
 * THE READ ITSELF IS AUDITED. Scanning a list of who is arguing with whom is not a neutral act, and
 * `disputes.queue_read` records it. Opening one dispute is audited separately, because who opened a
 * given case is a different fact from who scanned the list.
 *
 * Deliberately NOT rate-limited more loosely than the participant routes: an admin queue is exactly
 * where an enumeration attempt should be bounded.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  await requireDisputeReadPermission(session.userId);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const params = new URL(request.url).searchParams;
  const statusParam = params.get('status');
  if (statusParam !== null && !isDisputeStatus(statusParam)) {
    throw validationError([{ field: 'status', message: 'is not a valid dispute status' }]);
  }

  const page = parsePageParams(params);
  const { items, total } = await listDisputeQueue(session.userId, page, correlationId, {
    status: isDisputeStatus(statusParam) ? statusParam : undefined,
  });

  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
