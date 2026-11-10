import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { getProviderProfile, updateProviderBusinessName } from '@/lib/account/profile';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';

/** Account → Profile (provider mode), `GET /api/v1/providers/me/profile` — the business name. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');
  return apiSuccess(await getProviderProfile(session.userId), correlationId);
});

/**
 * `PATCH /api/v1/providers/me/profile` — body `{ businessName: string | null, expectedVersion }`. Provider mode
 * only (spec 006 AC-3), CSRF; `400` invalid name, `409` stale version. Published immediately (search, offers,
 * messaging and bookings read it); spec 038 moderates provider profiles after publication.
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');
  const parsed: unknown = await request.json().catch(() => ({}));
  const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return apiSuccess(await updateProviderBusinessName(session.userId, body), correlationId);
});
