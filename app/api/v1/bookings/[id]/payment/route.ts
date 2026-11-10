import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { loadPaymentDto } from '@/lib/payments';
import { guardPaymentRead, idFromUrl } from '../../../payments/route-guards';

/**
 * Spec 021 §3, `GET /api/v1/bookings/{id}/payment` — AC-8.
 *
 * The read-only projection every consumer reports from. `loadPaymentDto()` returns only persisted,
 * adapter-confirmed state and never `providerReference`, so nothing downstream — the UI, spec 033's
 * assistant, spec 036's tools — can report a payment outcome the backend did not confirm
 * (master spec §132.7).
 *
 * Open to EITHER participant in their own mode. A non-participant gets `404`, never `403`, so
 * booking ids cannot be probed.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const { userId, mode } = await guardPaymentRead(request);
  const bookingId = idFromUrl(request, 1);

  const payment = await loadPaymentDto(userId, bookingId, mode);
  return apiSuccess(payment, correlationId);
});
