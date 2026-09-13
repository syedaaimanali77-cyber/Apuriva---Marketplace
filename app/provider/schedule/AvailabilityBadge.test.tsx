// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AvailabilityBadge } from './_components/AvailabilityBadge';
import type { AvailabilitySummaryDto } from '@/lib/types/availability';

const BOOKING_ACTIONS = [{ label: 'Request a booking' }, { label: 'Ask for an offer' }];

function summary(overrides: Partial<AvailabilitySummaryDto> = {}): AvailabilitySummaryDto {
  return { state: 'unavailable', reason: 'Outside working hours', nextAvailableDate: null, ...overrides };
}

describe('AvailabilityBadge (spec 016 AC-5)', () => {
  it('renders the reason text beside the state and disables booking actions', () => {
    render(<AvailabilityBadge summary={summary()} actions={BOOKING_ACTIONS} />);

    // The state word and the reason are BOTH real text — master spec §3.5 forbids relying on
    // colour alone, so a bare coloured dot would not satisfy this.
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Outside working hours')).toBeInTheDocument();

    for (const action of BOOKING_ACTIONS) {
      const button = screen.getByRole('button', { name: action.label });
      expect(button).toBeDisabled();
      // The same reason is the accessible explanation for why the action is unavailable.
      expect(button).toHaveAccessibleDescription('Outside working hours');
    }
  });

  it('keeps the provider discoverable — the component renders normally when unavailable', () => {
    const { container } = render(<AvailabilityBadge summary={summary()} actions={BOOKING_ACTIONS} />);
    // Nothing is hidden or omitted: the profile surface still shows state, reason and actions.
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('enables booking actions only when the state is available', () => {
    render(<AvailabilityBadge summary={summary({ state: 'available', reason: 'Available now' })} actions={BOOKING_ACTIONS} />);

    const button = screen.getByRole('button', { name: 'Request a booking' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAccessibleDescription('Available now');
  });

  it('shows the busy state with its own reason, still disabling actions', () => {
    render(<AvailabilityBadge summary={summary({ state: 'busy', reason: 'Fully booked today' })} actions={BOOKING_ACTIONS} />);

    expect(screen.getByText('Busy')).toBeInTheDocument();
    expect(screen.getByText('Fully booked today')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request a booking' })).toBeDisabled();
  });

  it('surfaces a coarse next-available date when the provider cannot be booked now', () => {
    render(<AvailabilityBadge summary={summary({ nextAvailableDate: '2026-09-18' })} />);
    expect(screen.getByText('Next available 2026-09-18')).toBeInTheDocument();
  });

  it('does not repeat the next-available date once the provider is available', () => {
    render(<AvailabilityBadge summary={summary({ state: 'available', reason: 'Available now', nextAvailableDate: '2026-09-13' })} />);
    expect(screen.queryByText(/Next available/)).not.toBeInTheDocument();
  });
});
