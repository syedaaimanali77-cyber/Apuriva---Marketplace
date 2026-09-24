/**
 * `create_booking` — spec 020's `createBooking`, the same function `POST /api/v1/bookings` calls, so
 * every guarantee is inherited: ownership, revalidation, the slot reservation and — master spec
 * §115's critical example — `bookings_customer_idempotency_key_uq` + `bookings_offer_id_uq`, which a
 * repeated call with the same server key REPLAYS rather than duplicates (AC-3).
 *
 * Input is exactly what `createBooking` accepts from a caller besides the key: `offerId` and optional
 * `scheduledAt`. High risk (master spec §87 "Booking"), customer mode (the route's own
 * `requireActiveMode(session, 'customer')`).
 *
 * The card reads the offer with `loadOfferDto`, which never marks it viewed — resolving a
 * confirmation must not change spec 018 state.
 */
import { findProviderSchedulingProfile } from '@/lib/availability/repository';
import { createBooking } from '@/lib/bookings';
import { assertCustomerOwnsRequest, loadOfferDto } from '@/lib/offers/read';
import { getRequestForOwner } from '@/lib/requests/read';
import type { BookingDto } from '@/lib/types/bookings';
import { DISPLAY_LABELS, displayRows } from '../display';
import { defineTool, ownedBy } from '../tool';

interface Input extends Record<string, unknown> {
  offerId: string;
  scheduledAt?: string;
}

async function ownedOffer(userId: string, offerId: string) {
  const offer = await loadOfferDto(offerId);
  await assertCustomerOwnsRequest(userId, offer.requestId);
  return offer;
}

export const createBookingTool = defineTool<Input, BookingDto>({
  name: 'create_booking',
  label: 'Book a service',
  riskTier: 'high',
  reversible: false,
  modes: ['customer'],
  stateChanging: true,
  fields: [
    { name: 'offerId', kind: 'uuid', required: true },
    { name: 'scheduledAt', kind: 'timestamp', required: false },
  ],
  displayLabels: DISPLAY_LABELS,
  checkOwnership: (input, context) => ownedBy(() => ownedOffer(context.userId, input.offerId)),
  async display(input, context) {
    const offer = await ownedOffer(context.userId, input.offerId);
    const request = await getRequestForOwner(context.userId, offer.requestId);
    const provider = await findProviderSchedulingProfile(offer.providerProfileId);
    // The slot `createBooking` will use: the chosen time, else the request's preferred time.
    const instant = input.scheduledAt ?? request.preferredAt;
    return displayRows({
      service: request.serviceName,
      provider: offer.providerBusinessName,
      when: instant && provider ? { instant, timeZone: provider.timezone } : null,
      price: { amountMinorUnits: offer.priceAmountMinorUnits, currencyCode: offer.currencyCode },
    });
  },
  async run(input, context, idempotencyKey) {
    const body = input.scheduledAt ? { offerId: input.offerId, scheduledAt: input.scheduledAt } : { offerId: input.offerId };
    const { booking } = await createBooking(context.userId, idempotencyKey!, body);
    return booking;
  },
  summarize: (booking) => ({ type: 'booking', id: booking.id, status: booking.status }),
});
