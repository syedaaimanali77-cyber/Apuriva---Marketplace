/**
 * `authorize_payment` — spec 021's `authorizePayment`, the same function the payment route calls. The
 * server-generated key is also forwarded to the payment adapter as ITS idempotency key (spec 021), so
 * a repeat cannot double-charge (master spec §115). Customer mode; high risk (master spec §87
 * "Payment").
 *
 * The result is spec 021's `PaymentDto` — persisted, adapter-confirmed state only (spec 021 AC-8). A
 * `requires_action` or `failed` payment is reported as exactly that, never as success (§132.7).
 * `PaymentProviderUnavailable` becomes spec 021's own `paymentProviderUnavailableError`, exactly as the
 * route's `withProviderGuard` maps it — a domain answer, not an "unknown" outcome.
 */
import { requireBookingParticipant } from '@/lib/bookings';
import { authorizePayment, PaymentProviderUnavailable } from '@/lib/payments';
import { paymentProviderUnavailableError } from '@/lib/payments/errors';
import type { PaymentDto } from '@/lib/types/payments';
import { DISPLAY_LABELS } from '../display';
import { defineTool, ownedBy } from '../tool';
import { bookingDisplay } from './booking-display';

export const authorizePaymentTool = defineTool<{ bookingId: string }, PaymentDto>({
  name: 'authorize_payment',
  label: 'Pay for a booking',
  riskTier: 'high',
  reversible: false,
  modes: ['customer'],
  stateChanging: true,
  fields: [{ name: 'bookingId', kind: 'uuid', required: true }],
  displayLabels: DISPLAY_LABELS,
  checkOwnership: (input, context) => ownedBy(() => requireBookingParticipant(context.userId, input.bookingId, 'customer')),
  display: (input, context) => bookingDisplay(context.userId, input.bookingId, 'customer'),
  async run(input, context, idempotencyKey) {
    try {
      return await authorizePayment(context.userId, input.bookingId, idempotencyKey!);
    } catch (err) {
      if (err instanceof PaymentProviderUnavailable) throw paymentProviderUnavailableError();
      throw err;
    }
  },
  summarize: (payment) => ({ type: 'payment', id: payment.id, status: payment.status }),
  related: (input) => ({ type: 'booking', id: input.bookingId }),
});
