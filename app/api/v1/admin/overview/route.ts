import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { getAdminOverview, logServed } from '@/lib/admin-dashboard';

/**
 * Spec 037 §3, `GET /api/v1/admin/overview` — AC-1, AC-6.
 *
 * Any spec 009 admin role; everyone else `403 FORBIDDEN`. Live transactional figures (active
 * requests, active bookings, gross captured revenue for the current UTC day per currency) plus the
 * alerts the caller may see. Read-only: nothing is written and nothing is audited.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const startedAt = Date.now();
  const session = await requireSession(request);
  const overview = await getAdminOverview(session.userId);
  logServed('admin_dashboard.overview_served', correlationId, startedAt);
  return apiSuccess(overview, correlationId);
});
