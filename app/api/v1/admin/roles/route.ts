import { getDb } from '@/lib/db';
import { roles } from '@/lib/db/schema';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { adminForbiddenError } from '@/lib/admin-rbac/errors';
import { getAdminRoleNames } from '@/lib/admin-rbac/permissions';
import type { AdminRoleDto } from '@/lib/types/admin-rbac';

/** Spec 009 §3, `GET /api/v1/admin/roles` — the seven canonical roles (§4.3). Super Admin only:
 * seeing the role catalog at all is itself scoped, not open to every admin. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const roleNames = await getAdminRoleNames(session.userId);
  if (!roleNames.includes('super_admin')) throw adminForbiddenError();

  const rows = await getDb().select({ id: roles.id, name: roles.name }).from(roles).orderBy(roles.name);
  const dto: AdminRoleDto[] = rows.map((r) => ({ id: r.id, name: r.name as AdminRoleDto['name'] }));
  return apiSuccess(dto, correlationId);
});
