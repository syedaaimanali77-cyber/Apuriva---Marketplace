import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { authorizePayment } from '@/lib/payments';
import {
  guardPaymentMutation,
  idFromUrl,
  paymentIdempotencyKey,
  withProviderGuard,
} from '../../../../payments/route-guards';

/**
 * Spec 021 §3, `POST /api/v1/bookings/{id}/payment/authorize` — AC-1, AC-2, AC-6, AC-7, AC-10.
 *
 * OWNED BY SPEC 021, not spec 020. It sits in the bookings URL namespace because that is where a
 * booking's payment belongs to a caller, but every line of its behaviour is this spec's: spec 020's
 * own modules and routes still contain no payment reference at all (its §3 "Payment boundary", and
 * `lib/bookings/payment-boundary.test.ts`, which this file is explicitly scoped out of).
 *
 * `Idempotency-Key` is REQUIRED: without it a retried authorization could become a second charge,
 * which master spec §132.6 forbids. The same key is forwarded to the provider as its own
 * idempotency key, so both levels deduplicate (§3 "Idempotency and concurrency").
 *
 * A failed provider outcome answers `422 PAYMENT_FAILED` carrying master spec §105's exact wording
 * and leaves the booking `pending` — never confirmed (AC-6).
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardPaymentMutation(request, 'customer');
  const idempotencyKey = paymentIdempotencyKey(request);
  const bookingId = idFromUrl(request, 2);

  const payment = await withProviderGuard(() => authorizePayment(userId, bookingId, idempotencyKey));
  return apiSuccess(payment, correlationId);
});
