import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { decideAction } from '@/lib/admin-rbac/actions';
import type { ApprovalDto } from '@/lib/types/admin-rbac';

/** .../admin/approvals/{actionId}/approve */
function actionIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 009 §3/AC-2/§7, `POST /api/v1/admin/approvals/{actionId}/approve` — the second, distinct,
 * authorized admin's approval. `409 SELF_APPROVAL_NOT_ALLOWED` if the same admin who initiated it
 * calls this; `409 APPROVAL_NOT_ELIGIBLE` if the action is no longer `Pending` or the caller lacks
 * scope (lib/admin-rbac/actions.ts `decideAction`).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const adminActionId = actionIdFromUrl(request);
  const result = await decideAction({ approverUserId: session.userId, adminActionId, decision: 'approved' });

  const dto: ApprovalDto = {
    id: result.approvalId,
    adminActionId: result.adminActionId,
    decision: result.decision,
    status: result.status,
    decidedAt: result.decidedAt,
  };
  return apiSuccess(dto, correlationId);
});
