/**
 * `get_booking` — spec 020's `requireBookingParticipant`, exactly as `GET /api/v1/bookings/{id}`
 * uses it: either participant, anyone else gets spec 020's own 404. Low risk, read-only.
 */
import { requireBookingParticipant } from '@/lib/bookings';
import type { BookingDto } from '@/lib/types/bookings';
import { defineTool } from '../tool';

export const getBookingTool = defineTool<{ bookingId: string }, BookingDto>({
  name: 'get_booking',
  label: 'Look up a booking',
  riskTier: 'low',
  reversible: false,
  modes: ['customer', 'provider'],
  stateChanging: false,
  fields: [{ name: 'bookingId', kind: 'uuid', required: true }],
  run: async (input, context) => (await requireBookingParticipant(context.userId, input.bookingId)).booking,
  summarize: (booking) => ({ type: 'booking', id: booking.id, status: booking.status }),
  related: (input) => ({ type: 'booking', id: input.bookingId }),
});
