import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { listSupportInbox, requireSupportReadPermission, type SupportInboxFilters } from '@/lib/support';
import {
  isSupportCategory,
  isSupportPriority,
  isSupportTicketStatus,
} from '@/lib/types/support';

/**
 * Spec 032 §3, `GET /api/v1/admin/support/tickets` — the unified support inbox (AC-5).
 *
 * This is master §63's queue. The draft called it `/admin/support/inbox`; it is named `tickets`
 * here to match `/admin/disputes` and `/admin/safety-reports`, so the admin surfaces read alike.
 *
 * DEFAULT SORT IS SLA DEADLINE ASCENDING, because a queue's job is to surface what is running out
 * of time. `slaBreached` is COMPUTED, never stored, so it cannot go stale relative to the clock —
 * and a `awaiting_user` ticket is never breached however old its deadline, because the clock is
 * paused and the platform is not the one holding things up (AC-8).
 *
 * `operations_admin` reaches this route and nothing else: master §69 gives support tickets to the
 * Support Admin, so Operations watches the queue it navigates to and decides nothing on it.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  await requireSupportReadPermission(session.userId);

  const limit = checkRateLimit('support', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const url = new URL(request.url);
  const params = url.searchParams;
  const filters: SupportInboxFilters = {};

  const status = params.get('status');
  if (status !== null) {
    if (!isSupportTicketStatus(status)) throw validationError([{ field: 'status', message: 'is not a support ticket status' }]);
    filters.status = status;
  }

  const priority = params.get('priority');
  if (priority !== null) {
    if (!isSupportPriority(priority)) throw validationError([{ field: 'priority', message: 'is not a support priority' }]);
    filters.priority = priority;
  }

  const category = params.get('category');
  if (category !== null) {
    if (!isSupportCategory(category)) throw validationError([{ field: 'category', message: 'is not a support category' }]);
    filters.category = category;
  }

  if (params.get('assignedToMe') === 'true') filters.assignedToMe = true;

  const breached = params.get('slaBreached');
  if (breached !== null) filters.slaBreached = breached === 'true';

  const sort = params.get('sort');
  if (sort === 'createdAt' || sort === 'slaDeadlineAt') filters.sort = sort;

  const page = parsePageParams(params);
  const { items, total } = await listSupportInbox(session.userId, filters, page);

  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
