import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { getUserProfile, updateUserDisplayName } from '@/lib/account/profile';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';

/** Account → Profile, `GET /api/v1/users/me/profile` — display name, and email/phone read-only with verified state. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  return apiSuccess(await getUserProfile(session.userId), correlationId);
});

/**
 * `PATCH /api/v1/users/me/profile` — body `{ displayName: string | null, expectedVersion }`. CSRF; `400` for an
 * invalid name, `409` for a stale version. Email and phone are not editable here.
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  const parsed: unknown = await request.json().catch(() => ({}));
  const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return apiSuccess(await updateUserDisplayName(session.userId, body), correlationId);
});
