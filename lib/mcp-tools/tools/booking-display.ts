/**
 * The confirmation card for an action on an EXISTING booking (`cancel_booking`, `authorize_payment`):
 * master spec §90's Service, Provider, Date/time and Price, read live through spec 020's
 * `requireBookingParticipant` — which is also the ownership answer, so a stranger's booking is
 * spec 020's own 404 and never a card.
 */
import { requireBookingParticipant } from '@/lib/bookings';
import type { McpBoundParameter } from '@/lib/mcp';
import { displayRows, providerNameOf, serviceNameOf } from '../display';

export async function bookingDisplay(userId: string, bookingId: string, role?: 'customer' | 'provider'): Promise<McpBoundParameter[]> {
  const { booking } = await requireBookingParticipant(userId, bookingId, role);
  return displayRows({
    service: await serviceNameOf(booking.serviceId),
    provider: await providerNameOf(booking.providerProfileId),
    when: { instant: booking.scheduledAt, timeZone: booking.scheduledTimezone },
    price: { amountMinorUnits: booking.priceAmountMinorUnits, currencyCode: booking.currencyCode },
  });
}
