import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { initiateModerationAction, listModerationActions, parseModerationListFilters } from '@/lib/moderation';
import { enforceModerationRateLimit } from '../../moderation-actions/moderation-route';

/**
 * Spec 038 §3.13 M2, `GET /api/v1/admin/moderation-actions` — behind `moderation/read`.
 * Filters `targetUserId`, `status`, `actionType`; newest first.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceModerationRateLimit(session.userId);
  const params = new URL(request.url).searchParams;
  const page = parsePageParams(params);
  const { rows, total } = await listModerationActions(session.userId, parseModerationListFilters(params), page, correlationId);
  return apiPaged(rows, buildPage(total, page.limit, page.offset), correlationId);
});

/**
 * Spec 038 §3.13 M1, `POST /api/v1/admin/moderation-actions` — behind the per-type permission
 * (§3.9). `reason` is required. Low/medium (`warning`, `restriction`) apply at once → `201`;
 * high/critical go through spec 009's four-eyes → `202` with the row `pending_approval` and nothing
 * in effect. `Idempotency-Key` is required: a replay is `200`, a different body `409`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceModerationRateLimit(session.userId);
  const idempotencyKey = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));

  const { action, outcome } = await initiateModerationAction({ adminUserId: session.userId, idempotencyKey, body, correlationId });
  const status = outcome === 'applied' ? 201 : outcome === 'pending_approval' ? 202 : 200;
  return apiSuccess(action, correlationId, { status });
});
