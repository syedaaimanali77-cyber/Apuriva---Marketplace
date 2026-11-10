/**
 * `cancel_booking` — spec 023's `cancelBookingAsParticipant`, the same function the cancel route
 * calls, in the caller's CURRENT mode (AC-8). High risk (master spec §87 "Cancellation").
 *
 * Input is exactly `{ bookingId }` (spec 036 D-18): spec 023's optional `note` is free text, and its
 * optional `reasonCode` has no closed list in the repository, so neither can be carried as a safe
 * binding value — the domain call passes no body, exactly as a cancellation without a reason does.
 */
import { requireBookingParticipant } from '@/lib/bookings';
import { cancelBookingAsParticipant } from '@/lib/cancellation';
import type { CancellationDto } from '@/lib/types/cancellation';
import { DISPLAY_LABELS } from '../display';
import { defineTool, ownedBy } from '../tool';
import { bookingDisplay } from './booking-display';

export const cancelBookingTool = defineTool<{ bookingId: string }, CancellationDto>({
  name: 'cancel_booking',
  label: 'Cancel a booking',
  riskTier: 'high',
  reversible: false,
  modes: ['customer', 'provider'],
  stateChanging: true,
  fields: [{ name: 'bookingId', kind: 'uuid', required: true }],
  displayLabels: DISPLAY_LABELS,
  checkOwnership: (input, context) => ownedBy(() => requireBookingParticipant(context.userId, input.bookingId, context.activeMode)),
  display: (input, context) => bookingDisplay(context.userId, input.bookingId, context.activeMode),
  run: (input, context, idempotencyKey) =>
    cancelBookingAsParticipant(context.userId, input.bookingId, context.activeMode, idempotencyKey!),
  // The resource this creates is spec 023's cancellation record; it carries no status of its own.
  summarize: (cancellation) => ({ type: 'cancellation', id: cancellation.id, status: null }),
  related: (input) => ({ type: 'booking', id: input.bookingId }),
});
