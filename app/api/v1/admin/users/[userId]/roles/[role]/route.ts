import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { revokeRole } from '@/lib/admin-rbac/role-assignment';

/** .../admin/users/{userId}/roles/{role} — extracted from the URL directly, matching
 * sessions/[id]/route.ts's convention. */
function userIdAndRoleFromUrl(request: Request): { userId: string; role: string } {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return {
    userId: decodeURIComponent(segments[segments.length - 3]!),
    role: decodeURIComponent(segments[segments.length - 1]!),
  };
}

/**
 * Spec 009 §3/AC-5, `DELETE /api/v1/admin/users/{userId}/roles/{role}` — a role-management
 * operation: Super Admin only, itself audited, and guarded against leaving zero remaining
 * `super_admin` holders (`409 LAST_SUPER_ADMIN`, `lib/admin-rbac/role-assignment.ts`).
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const { userId: targetUserId, role } = userIdAndRoleFromUrl(request);
  await revokeRole(session.userId, targetUserId, role);

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
