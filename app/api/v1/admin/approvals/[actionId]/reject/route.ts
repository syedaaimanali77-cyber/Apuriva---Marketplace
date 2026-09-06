import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { decideAction } from '@/lib/admin-rbac/actions';
import type { ApprovalDto } from '@/lib/types/admin-rbac';

/** .../admin/approvals/{actionId}/reject */
function actionIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 009 §3/§7, `POST /api/v1/admin/approvals/{actionId}/reject` — same eligibility rules as
 * approve (lib/admin-rbac/actions.ts `decideAction`): a different, authorized admin, deciding a
 * still-`Pending` action exactly once.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const adminActionId = actionIdFromUrl(request);
  const result = await decideAction({ approverUserId: session.userId, adminActionId, decision: 'rejected' });

  const dto: ApprovalDto = {
    id: result.approvalId,
    adminActionId: result.adminActionId,
    decision: result.decision,
    status: result.status,
    decidedAt: result.decidedAt,
  };
  return apiSuccess(dto, correlationId);
});
