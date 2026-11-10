import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { recordPostActionReview } from '@/lib/admin-rbac/actions';
import type { PostActionReviewRequest, PostActionReviewResponse } from '@/lib/types/admin-rbac';

/** .../admin/actions/{actionId}/post-action-review */
function actionIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 009 §3.2/AC-3, `POST /api/v1/admin/actions/{actionId}/post-action-review` — the only way an
 * emergency-bypassed `AdminAction` leaves `PostActionReviewRequired`. `409 APPROVAL_NOT_ELIGIBLE`
 * if the action isn't in that status or the caller isn't authorized to review it.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const adminActionId = actionIdFromUrl(request);
  const body = (await request.json().catch(() => ({}))) as Partial<PostActionReviewRequest>;
  if (typeof body.notes !== 'string' || body.notes.trim().length === 0) {
    throw validationError([{ field: 'notes', message: 'is required' }]);
  }

  const result = await recordPostActionReview({ reviewerUserId: session.userId, adminActionId, notes: body.notes });
  const dto: PostActionReviewResponse = {
    id: result.id,
    status: 'PostActionReviewed',
    postActionReviewedAt: result.postActionReviewedAt,
  };
  return apiSuccess(dto, correlationId);
});
