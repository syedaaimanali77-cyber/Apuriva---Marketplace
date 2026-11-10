import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { listPriceAdjustments, proposePriceAdjustment } from '@/lib/payments';
import {
  guardPaymentMutation,
  guardPaymentRead,
  idFromUrl,
  paymentIdempotencyKey,
} from '../../../payments/route-guards';

/**
 * Spec 021 §3 "Price adjustments" — AC-4.
 *
 * `POST` is the PROVIDER's proposal. It charges nothing, reaches no payment adapter, and fixes the
 * exact amount and currency the customer will be shown before approving. Provider mode only: a
 * customer cannot propose a change to their own price, and a provider cannot approve one.
 *
 * `GET` is open to either participant, so the customer can see what was proposed and the provider
 * can see what was decided.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardPaymentMutation(request, 'provider');
  const idempotencyKey = paymentIdempotencyKey(request);
  const bookingId = idFromUrl(request, 1);
  const body = await request.json().catch(() => ({}));

  const { adjustment, created } = await proposePriceAdjustment(userId, bookingId, idempotencyKey, body);
  return apiSuccess(adjustment, correlationId, { status: created ? 201 : 200 });
});

export const GET = withApiRoute(async (request, correlationId) => {
  const { userId, mode } = await guardPaymentRead(request);
  const bookingId = idFromUrl(request, 1);

  const adjustments = await listPriceAdjustments(userId, bookingId, mode);
  return apiSuccess(adjustments, correlationId);
});
