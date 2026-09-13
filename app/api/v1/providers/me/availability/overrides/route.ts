import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { createOverride, listOverrides } from '@/lib/availability/schedule';
import { parseDateRange } from '../date-range';
import type { CreateOverrideRequest } from '@/lib/types/availability';

/** Spec 016 §3, `GET /api/v1/providers/me/availability/overrides?from=&to=` — owner-only. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const { from, to } = parseDateRange(request);
  return apiSuccess(await listOverrides(profile.id, from, to), correlationId);
});

/**
 * Spec 016 §3, `POST /api/v1/providers/me/availability/overrides` — AC-1's override half (R3/R4).
 * A date that already has a row is `409 CONFLICT`; updating goes through `PUT .../{date}`, so a
 * create can never silently overwrite an existing override.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const body = (await request.json().catch(() => ({}))) as Partial<CreateOverrideRequest>;
  const dto = await createOverride(profile.id, profile.timezone, body);
  return apiSuccess(dto, correlationId, { status: 201 });
});
