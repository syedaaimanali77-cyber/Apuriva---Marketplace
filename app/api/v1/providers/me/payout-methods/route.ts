import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { createPayoutMethod, listPayoutMethods } from '@/lib/payouts';
import {
  guardProviderPayoutMethodMutation,
  guardProviderPayoutRead,
  payoutIdempotencyKey,
  withPayoutProviderGuard,
} from '../../../payouts/route-guards';

/** Spec 024 §3.12, `GET /api/v1/providers/me/payout-methods` — masked detail only (AC-10). */
export const GET = withApiRoute(async (request, correlationId) => {
  const { providerProfileId } = await guardProviderPayoutRead(request);
  return apiSuccess(await listPayoutMethods(providerProfileId), correlationId);
});

/**
 * Spec 024 §3.9, `POST /api/v1/providers/me/payout-methods` — AC-4. Requires a fresh
 * `manage_payout_method` step-up token. The body carries ONLY the rail's `setupToken`; every stored
 * detail comes from the rail, never from the client. `201` on creation, `200` on idempotent replay.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId, providerProfileId } = await guardProviderPayoutMethodMutation(request);
  const idempotencyKey = payoutIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const { method, replayed } = await withPayoutProviderGuard(() =>
    createPayoutMethod({ userId, providerProfileId, idempotencyKey, body, correlationId }),
  );
  return apiSuccess(method, correlationId, { status: replayed ? 200 : 201 });
});
