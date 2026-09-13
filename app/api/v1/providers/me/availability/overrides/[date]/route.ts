import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireOwnProviderProfile } from '@/lib/availability/owner';
import { deleteOverride, updateOverride } from '@/lib/availability/schedule';
import { segmentFromUrl } from '../../../../path-params';
import type { UpdateOverrideRequest } from '@/lib/types/availability';

/** Spec 016 §3 R4, `PUT /api/v1/providers/me/availability/overrides/{date}` — updates in place. */
export const PUT = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  const body = (await request.json().catch(() => ({}))) as Partial<UpdateOverrideRequest>;
  const dto = await updateOverride(profile.id, profile.timezone, segmentFromUrl(request), body);
  return apiSuccess(dto, correlationId);
});

/**
 * Spec 016 §3 R4, `DELETE /api/v1/providers/me/availability/overrides/{date}` — removing the
 * override restores the weekly pattern for that date. `204`, so no envelope body.
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');

  const limit = checkRateLimit('availability', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const profile = await requireOwnProviderProfile(session.userId);
  await deleteOverride(profile.id, segmentFromUrl(request));

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
