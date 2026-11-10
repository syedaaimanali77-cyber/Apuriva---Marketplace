import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { getPersonalizationSettings, updatePersonalizationSettings } from '@/lib/home/settings';
import type { UpdatePersonalizationSettingsRequest } from '@/lib/types/home';

/** Spec 014 §3, `GET /api/v1/users/me/personalization-settings`. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const dto = await getPersonalizationSettings(session.userId);
  return apiSuccess(dto, correlationId);
});

/** Spec 014 §3/AC-7, `PATCH /api/v1/users/me/personalization-settings` — opt out/adjust. */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<UpdatePersonalizationSettingsRequest>;
  if (typeof body.personalizationEnabled !== 'boolean') {
    throw validationError([{ field: 'personalizationEnabled', message: 'must be a boolean' }]);
  }

  const dto = await updatePersonalizationSettings(session.userId, body.personalizationEnabled);
  return apiSuccess(dto, correlationId);
});
