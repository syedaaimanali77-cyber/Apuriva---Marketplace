import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { getMarketplaceConfig, logServed } from '@/lib/admin-dashboard';

/**
 * Spec 037 §3, `GET /api/v1/admin/marketplace/config` — AC-3, AC-4, AC-6.
 *
 * READ-ONLY. Behind `matching.config`/`read` or `cancellation_policy`/`read` (operations_admin,
 * super_admin today); each section only for its own permission. There is deliberately no PATCH:
 * spec 017's and spec 023's write paths remain the only writers of these settings (D-3).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const startedAt = Date.now();
  const session = await requireSession(request);
  const config = await getMarketplaceConfig(session.userId);
  logServed('admin_dashboard.config_served', correlationId, startedAt);
  return apiSuccess(config, correlationId);
});
