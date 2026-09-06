import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { isAdminUser } from '@/lib/auth/session';
import { getProfileFlags, setSessionActiveMode } from '@/lib/auth/profiles';
import { profileNotFoundForModeError } from '@/lib/auth/profile-errors';
import { isActiveMode, type SwitchModeRequest, type UserDto } from '@/lib/types/users';

/**
 * Spec 006 AC-2/AC-5, `PATCH /api/v1/users/me/active-mode` — sets `active_mode` on the CURRENT
 * SESSION (`Session`, spec 005), never on `User`. Rejected with `422 PROFILE_NOT_FOUND_FOR_MODE`
 * unless the corresponding profile already exists (spec 006 §4: "a mode cannot be selected
 * unless the corresponding profile exists"). The server is the sole authority on the result.
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<SwitchModeRequest>;
  if (!isActiveMode(body.mode)) {
    throw validationError([{ field: 'mode', message: "must be 'customer' or 'provider'" }]);
  }
  const mode = body.mode;

  const flags = await getProfileFlags(session.userId);
  const hasTargetProfile = mode === 'customer' ? flags.hasCustomerProfile : flags.hasProviderProfile;
  if (!hasTargetProfile) throw profileNotFoundForModeError(mode);

  await setSessionActiveMode(session.id, mode);

  const isAdmin = await isAdminUser(session.userId);
  const dto: UserDto = {
    id: session.userId,
    hasCustomerProfile: flags.hasCustomerProfile,
    hasProviderProfile: flags.hasProviderProfile,
    activeMode: mode,
    isAdmin,
  };
  return apiSuccess(dto, correlationId);
});
