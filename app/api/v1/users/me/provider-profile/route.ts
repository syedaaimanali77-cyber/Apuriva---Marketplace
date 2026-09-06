import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { ensureProviderProfile } from '@/lib/auth/profiles';
import type { ProviderProfileDto } from '@/lib/types/users';

/**
 * Spec 006 AC-1, `POST /api/v1/users/me/provider-profile` — "Become a Provider". Idempotent:
 * creates a `ProviderProfile` linked to the current user (201) if one doesn't already exist, or
 * returns the existing one (200) otherwise — either way, without creating a new account and
 * without changing the session's active mode. Switching to provider mode is a separate, explicit
 * action via `PATCH /api/v1/users/me/active-mode` (AC-2).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const { profile, created } = await ensureProviderProfile(session.userId);

  const dto: ProviderProfileDto = {
    id: profile.id,
    userId: profile.userId,
    businessName: profile.businessName,
    lifecycleStatus: profile.lifecycleStatus,
  };
  return apiSuccess(dto, correlationId, { status: created ? 201 : 200 });
});
