import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { isAdminUser } from '@/lib/auth/session';
import { getProfileFlags } from '@/lib/auth/profiles';
import type { ActiveMode, UserDto } from '@/lib/types/users';

/** Spec 006 §3, `GET /api/v1/users/me` — which profiles exist, and the current session's
 * active mode (never a global `User` preference — see spec 006 §4). */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const [flags, isAdmin] = await Promise.all([getProfileFlags(session.userId), isAdminUser(session.userId)]);

  const dto: UserDto = {
    id: session.userId,
    hasCustomerProfile: flags.hasCustomerProfile,
    hasProviderProfile: flags.hasProviderProfile,
    activeMode: session.activeMode as ActiveMode,
    isAdmin,
  };
  return apiSuccess(dto, correlationId);
});
