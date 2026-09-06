import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { assignRole } from '@/lib/admin-rbac/role-assignment';
import type { AssignRoleRequest, AssignRoleResponse } from '@/lib/types/admin-rbac';

/** Extracted from the URL directly, matching sessions/[id]/route.ts's convention — `withApiRoute`
 * only forwards `(request, correlationId)`, not Next's route `context`. */
function userIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  // .../admin/users/{userId}/roles
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 009 §3/AC-5, `POST /api/v1/admin/users/{userId}/roles` — a role-management operation:
 * Super Admin only (enforced inside `assignRole`), and itself audited. Idempotent re-assignment.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const targetUserId = userIdFromUrl(request);
  const body = (await request.json().catch(() => ({}))) as Partial<AssignRoleRequest>;
  if (typeof body.role !== 'string') {
    throw validationError([{ field: 'role', message: 'must be one of the seven canonical admin roles' }]);
  }

  const role = await assignRole(session.userId, targetUserId, body.role);
  const dto: AssignRoleResponse = { userId: targetUserId, role };
  return apiSuccess(dto, correlationId);
});
