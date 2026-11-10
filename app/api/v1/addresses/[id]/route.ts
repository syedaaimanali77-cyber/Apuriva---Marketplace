import { NextResponse } from 'next/server';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { deleteAddress, updateAddress } from '@/lib/location/addresses';
import type { UpdateAddressRequest } from '@/lib/types/location';

/** Extracted from the URL directly — `withApiRoute` (spec 004) only forwards
 * `(request, correlationId)`, not Next's route `context` (same pattern as
 * app/api/v1/users/me/sessions/[id]/route.ts). */
function addressIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/** Spec 012 §3, `PATCH /api/v1/addresses/{id}` — owner only. */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const id = addressIdFromUrl(request);
  const body = (await request.json().catch(() => ({}))) as UpdateAddressRequest;
  const dto = await updateAddress(session.userId, id, body);
  return apiSuccess(dto, correlationId);
});

/** Spec 012 §3, `DELETE /api/v1/addresses/{id}` — owner only; `409 ADDRESS_IN_USE` if a booking
 * still references it. */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const id = addressIdFromUrl(request);
  await deleteAddress(session.userId, id);

  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
});
