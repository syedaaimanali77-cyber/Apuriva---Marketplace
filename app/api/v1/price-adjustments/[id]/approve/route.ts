import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { approvePriceAdjustment } from '@/lib/payments';
import {
  guardPaymentMutation,
  idFromUrl,
  paymentIdempotencyKey,
  withProviderGuard,
} from '../../../payments/route-guards';

/**
 * Spec 021 §3, `POST /api/v1/price-adjustments/{id}/approve` — AC-4.
 *
 * THE ONLY PATH THAT MAY CHARGE AN ADJUSTMENT. Customer mode only, and only the customer who owns
 * the booking. Approval and charge are bound to the same row, so the amount charged is necessarily
 * the amount that was shown — master spec §46 "never silently charge a changed amount" and §132.15
 * "do not silently change confirmed prices".
 *
 * Two concurrent approvals resolve to exactly one charge: the losing request gets
 * `409 ADJUSTMENT_ALREADY_RESOLVED` and makes no adapter call at all.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardPaymentMutation(request, 'customer');
  const idempotencyKey = paymentIdempotencyKey(request);
  const adjustmentId = idFromUrl(request, 1);

  const adjustment = await withProviderGuard(() => approvePriceAdjustment(userId, adjustmentId, idempotencyKey));
  return apiSuccess(adjustment, correlationId);
});
