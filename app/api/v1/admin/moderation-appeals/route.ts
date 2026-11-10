import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { validationError } from '@/lib/api/errors';
import { requireSession } from '@/lib/auth/require-session';
import { MODERATION_APPEAL_STATUSES } from '@/lib/db/schema';
import { listModerationAppeals } from '@/lib/moderation';
import type { ModerationAppealStatus } from '@/lib/types/moderation';
import { enforceModerationRateLimit } from '../../moderation-actions/moderation-route';

/** Spec 038 §3.13 A1, `GET /api/v1/admin/moderation-appeals` — behind `moderation/review_appeal`. FIFO. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceModerationRateLimit(session.userId);
  const params = new URL(request.url).searchParams;
  const status = params.get('status');
  if (status && !(MODERATION_APPEAL_STATUSES as readonly string[]).includes(status)) {
    throw validationError([{ field: 'status', message: 'is not an appeal status' }]);
  }
  const page = parsePageParams(params);
  const { rows, total } = await listModerationAppeals(session.userId, (status as ModerationAppealStatus) ?? undefined, page);
  return apiPaged(rows, buildPage(total, page.limit, page.offset), correlationId);
});
