import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { createAddress, listAddresses } from '@/lib/location/addresses';
import type { CreateAddressRequest } from '@/lib/types/location';

/** Spec 012 §3, `GET /api/v1/addresses` — the caller's own saved addresses, session required. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const dto = await listAddresses(session.userId);
  return apiSuccess(dto, correlationId);
});

/** Spec 012 §3, `POST /api/v1/addresses` — save a new address for the caller. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<CreateAddressRequest>;
  const dto = await createAddress(session.userId, body);
  return apiSuccess(dto, correlationId, { status: 201 });
});
