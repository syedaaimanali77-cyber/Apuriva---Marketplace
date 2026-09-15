import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { listRefundsForBooking, requestPolicyRefund } from '@/lib/refunds';
import {
  guardRefundMutation,
  guardRefundRead,
  idFromUrl,
  refundIdempotencyKey,
  withRefundProviderGuard,
} from '../../../refunds/route-guards';

/**
 * Spec 022 §3, `POST /api/v1/bookings/{id}/refunds` — AC-1, AC-5, AC-8.
 *
 * OWNED BY SPEC 022, not spec 020. It sits in the bookings URL namespace because a refund belongs
 * to a booking, but every line of its behaviour is this spec's.
 *
 * THE BODY CARRIES NO AMOUNT, deliberately. A client-supplied refund amount would be a client
 * deciding how much money to send itself; the amount comes from spec 023's eligibility decision,
 * resolved server-side inside the refund transaction under the payment row lock. With no policy
 * registered the gate declines and this route answers `422 REFUND_NOT_ELIGIBLE` — correct, because
 * nothing is automatically refundable until a policy exists.
 *
 * `Idempotency-Key` is REQUIRED: without it a retried refund could become a second refund.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardRefundMutation(request, 'customer');
  const idempotencyKey = refundIdempotencyKey(request);
  const bookingId = idFromUrl(request, 1);

  const { refund, created } = await withRefundProviderGuard(() => requestPolicyRefund(userId, bookingId, idempotencyKey));
  return apiSuccess(refund, correlationId, { status: created ? 201 : 200 });
});

/**
 * `GET /api/v1/bookings/{id}/refunds` — open to either participant in their own mode.
 *
 * The provider legitimately needs to know a refund happened and for how much. Neither party ever
 * sees a provider reference, a failure code or the approval chain (§4 "Retention and privacy").
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const { userId, mode } = await guardRefundRead(request);
  const bookingId = idFromUrl(request, 1);

  const refunds = await listRefundsForBooking(userId, bookingId, mode);
  return apiSuccess(refunds, correlationId);
});
