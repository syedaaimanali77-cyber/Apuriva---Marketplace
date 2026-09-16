import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { removePayoutMethod, setDefaultPayoutMethod } from '@/lib/payouts';
import { guardProviderPayoutMethodMutation, pathSegment, withPayoutProviderGuard } from '../../../../payouts/route-guards';

/**
 * Spec 024 §3.9, `PATCH /api/v1/providers/me/payout-methods/{id}` — body `{ isDefault: true }`, the
 * sole mutable field. Requires a fresh step-up token (AC-4); one default per currency (AC-11).
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const { userId, providerProfileId } = await guardProviderPayoutMethodMutation(request);
  const body = await request.json().catch(() => ({}));
  const method = await setDefaultPayoutMethod({ userId, providerProfileId, methodId: pathSegment(request, 1), body, correlationId });
  return apiSuccess(method, correlationId);
});

/**
 * Spec 024 §3.9, `DELETE /api/v1/providers/me/payout-methods/{id}` — a soft delete, then rail
 * revocation after commit. Refused `422 PAYOUT_METHOD_IN_USE` while a payout still needs it.
 */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const { userId, providerProfileId } = await guardProviderPayoutMethodMutation(request);
  const method = await withPayoutProviderGuard(() =>
    removePayoutMethod({ userId, providerProfileId, methodId: pathSegment(request, 1), correlationId }),
  );
  return apiSuccess(method, correlationId);
});
