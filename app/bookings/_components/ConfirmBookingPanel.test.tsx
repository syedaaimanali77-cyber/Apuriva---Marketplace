// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmBookingPanel } from './ConfirmBookingPanel';

// The panel navigates with `window.location.assign` once the server confirms the booking.
const push = vi.fn();

const CONFLICT_WITH_ALTERNATIVES = {
  code: 'SLOT_NO_LONGER_AVAILABLE',
  message: 'This time is no longer available.',
  details: {
    requestedStartAt: '2026-10-01T09:00:00.000Z',
    durationMinutes: 60,
    scheduledTimezone: 'Asia/Karachi',
    nextAvailableDate: null,
    alternatives: [
      { startAt: '2026-10-02T09:00:00.000Z', scheduledTimezone: 'Asia/Karachi', localDate: '2026-10-02', localTimeOfDay: '14:00' },
      { startAt: '2026-10-03T09:00:00.000Z', scheduledTimezone: 'Asia/Karachi', localDate: '2026-10-03', localTimeOfDay: '14:00' },
    ],
  },
};

const CONFLICT_WITHOUT_ALTERNATIVES = {
  code: 'SLOT_NO_LONGER_AVAILABLE',
  message: 'This time is no longer available.',
  details: {
    requestedStartAt: '2026-10-01T09:00:00.000Z',
    durationMinutes: 60,
    scheduledTimezone: 'Asia/Karachi',
    nextAvailableDate: '2026-11-04',
    alternatives: [],
  },
};

/** Spec 020 §5 — the booking-confirmation step and AC-2's alternatives, rendered in place. */
describe('ConfirmBookingPanel (spec 020 §5, AC-2)', () => {
  beforeEach(() => {
    push.mockReset();
    vi.stubGlobal('location', { ...window.location, assign: push });
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => `key-${Math.random()}` });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Master spec §103/§132.7 — never claim a booking before the server confirms it. */
  it('never shows a booked state before the server responds, and navigates only after the 201', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { id: 'booking-9' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfirmBookingPanel offerId="offer-1" />);
    // Before any request: no confirmed booking is claimed and nowhere has been navigated to. (The
    // panel's standing copy deliberately says nothing IS booked yet, so absence of the word
    // "booked" would be the wrong assertion — what must be absent is a success signal.)
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByText(/confirmed/i)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/bookings/booking-9'));
  });

  it('sends an Idempotency-Key with the creation request', async () => {
    // Args are declared so `mock.calls` stays typed — an untyped `vi.fn(async () => …)` infers a
    // zero-length tuple and the header assertion below could not be written at all.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 201,
      json: async () => ({ data: { id: 'booking-9' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfirmBookingPanel offerId="offer-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeTruthy();
  });

  /** AC-2: the conflict renders the alternatives as selectable times. */
  it('renders up to three alternatives on 422 SLOT_NO_LONGER_AVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 422, json: async () => CONFLICT_WITH_ALTERNATIVES })),
    );

    render(<ConfirmBookingPanel offerId="offer-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    expect(await screen.findByLabelText('Alternative times')).toBeInTheDocument();
    expect(screen.getByText(/This time is no longer available/i)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  /** AC-2: choosing one re-submits it as `scheduledAt`, with a FRESH key — a new attempt, not a replay. */
  it('re-submits a chosen alternative as scheduledAt with a fresh Idempotency-Key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => CONFLICT_WITH_ALTERNATIVES })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ data: { id: 'booking-10' } }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfirmBookingPanel offerId="offer-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    await screen.findByLabelText('Alternative times');

    const [first] = screen.getAllByRole('listitem');
    await userEvent.click(first!.querySelector('button')!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body as string);
    expect(secondBody).toEqual({ offerId: 'offer-1', scheduledAt: '2026-10-02T09:00:00.000Z' });

    const keyOf = (index: number) =>
      ((fetchMock.mock.calls[index]?.[1] as RequestInit | undefined)?.headers as Record<string, string>)['Idempotency-Key'];
    const firstKey = keyOf(0);
    const secondKey = keyOf(1);
    expect(secondKey).not.toBe(firstKey);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/bookings/booking-10'));
  });

  /** AC-2: with no alternatives, the coarse date is plain text and there is no misleading retry. */
  it('shows the next available date and no alternative buttons when none qualify', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 422, json: async () => CONFLICT_WITHOUT_ALTERNATIVES })),
    );

    render(<ConfirmBookingPanel offerId="offer-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    expect(await screen.findByText(/next available day is 2026-11-04/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Alternative times')).toBeNull();
  });

  it('shows a plain error for a non-conflict failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        json: async () => ({ code: 'OFFER_NOT_ACCEPTABLE', message: 'That offer was replaced by a revised offer.' }),
      })),
    );

    render(<ConfirmBookingPanel offerId="offer-1" />);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));

    expect(await screen.findByText('That offer was replaced by a revised offer.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Alternative times')).toBeNull();
  });
});
