import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { capturePayment } from '@/lib/payments';
import {
  guardPaymentMutation,
  idFromUrl,
  paymentIdempotencyKey,
  withProviderGuard,
} from '../../../../payments/route-guards';

/**
 * Spec 021 §3, `POST /api/v1/bookings/{id}/payment/capture` — AC-7.
 *
 * For `at_booking_confirmation` timing — the only timing reachable in this repository — the
 * authorize route already captured, so this is normally an idempotent no-op replay. It is a real
 * endpoint because an adapter that separates authorization from capture needs one, and because a
 * crash between those two round trips must be recoverable without re-authorizing.
 *
 * A capture on an already-captured payment under a DIFFERENT `Idempotency-Key` is a genuine
 * duplicate and answers `409 PAYMENT_ALREADY_CAPTURED` rather than silently succeeding.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardPaymentMutation(request, 'customer');
  const idempotencyKey = paymentIdempotencyKey(request);
  const bookingId = idFromUrl(request, 2);

  const payment = await withProviderGuard(() => capturePayment(userId, bookingId, idempotencyKey));
  return apiSuccess(payment, correlationId);
});
