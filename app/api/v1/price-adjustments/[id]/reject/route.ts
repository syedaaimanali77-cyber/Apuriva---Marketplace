import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rejectPriceAdjustment } from '@/lib/payments';
import { guardPaymentMutation, idFromUrl, paymentIdempotencyKey } from '../../../payments/route-guards';

/**
 * Spec 021 §3, `POST /api/v1/price-adjustments/{id}/reject` — AC-4's negative branch.
 *
 * Without a decline path, "the customer must explicitly approve" would have no meaning: the only
 * alternative to approving would be leaving the proposal open forever. Rejecting is terminal and
 * charges nothing; no payment adapter is reached.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardPaymentMutation(request, 'customer');
  paymentIdempotencyKey(request);
  const adjustmentId = idFromUrl(request, 1);

  const adjustment = await rejectPriceAdjustment(userId, adjustmentId);
  return apiSuccess(adjustment, correlationId);
});
