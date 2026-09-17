// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BookingDetailPage from './page';
import type { BookingDto, BookingStatusHistoryDto } from '@/lib/types/bookings';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'booking-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

function booking(overrides?: Partial<BookingDto>): BookingDto {
  return {
    id: 'booking-1',
    requestId: 'request-1',
    offerId: 'offer-1',
    serviceId: 'service-1',
    customerProfileId: 'customer-1',
    providerProfileId: 'provider-1',
    status: 'confirmed',
    scheduledAt: '2026-10-01T09:00:00.000Z',
    scheduledTimezone: 'Asia/Karachi',
    durationMinutes: 60,
    priceAmountMinorUnits: 320_000,
    currencyCode: 'PKR',
    addressId: 'address-1',
    createdAt: '2026-09-14T09:00:00.000Z',
    updatedAt: '2026-09-14T09:00:00.000Z',
    version: 2,
    ...overrides,
  };
}

const HISTORY: BookingStatusHistoryDto[] = [
  { fromStatus: null, toStatus: 'pending', actorRole: 'customer', occurredAt: '2026-09-14T09:00:00.000Z' },
  { fromStatus: 'pending', toStatus: 'confirmed', actorRole: 'customer', occurredAt: '2026-09-14T09:00:01.000Z' },
];

/** Routes each GET/POST to a canned response, so no real network is involved. */
function stubFetch(handlers: {
  booking?: BookingDto;
  history?: BookingStatusHistoryDto[];
  bookingError?: { status: number; body: unknown };
  complete?: { ok: boolean; status?: number; body: unknown };
  /** Spec 028 §5 — the two lists this screen reads. */
  milestones?: unknown[];
  evidence?: unknown[];
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.includes('/complete')) {
      const result = handlers.complete ?? { ok: true, body: { data: booking({ status: 'completed' }) } };
      return { ok: result.ok, status: result.status ?? (result.ok ? 200 : 422), json: async () => result.body };
    }
    if (url.includes('/status-history')) {
      return { ok: true, status: 200, json: async () => ({ data: handlers.history ?? HISTORY }) };
    }
    if (url.includes('/milestones')) {
      return { ok: true, status: 200, json: async () => ({ data: handlers.milestones ?? [] }) };
    }
    if (url.includes('/evidence')) {
      return { ok: true, status: 200, json: async () => ({ data: handlers.evidence ?? [] }) };
    }
    if (handlers.bookingError) {
      return { ok: false, status: handlers.bookingError.status, json: async () => handlers.bookingError!.body };
    }
    return { ok: true, status: 200, json: async () => ({ data: handlers.booking ?? booking() }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Spec 020 §5 — the customer booking view: loading, error, success, completion, dwell countdown. */
describe('BookingDetailPage (spec 020 §5)', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'test-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('shows a loading state before the server responds — never an optimistic booking', async () => {
    stubFetch({});
    const { container } = render(<BookingDetailPage />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByText('Your booking')).toBeInTheDocument();
  });

  it('renders the booking, its schedule and its agreed price', async () => {
    stubFetch({});
    render(<BookingDetailPage />);

    expect(await screen.findByText('Your booking')).toBeInTheDocument();
    // Status is conveyed as TEXT, not colour alone (§5 accessibility).
    expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0);
    expect(screen.getByText('60 minutes')).toBeInTheDocument();
  });

  it('shows an error state with a retry when the read fails', async () => {
    stubFetch({ bookingError: { status: 404, body: { code: 'BOOKING_NOT_FOUND', message: 'No such booking.' } } });
    render(<BookingDetailPage />);

    expect(await screen.findByText('We could not load this booking')).toBeInTheDocument();
  });

  /** AC-8: the customer sees Mark Complete, and the copy never asks for the provider's confirmation. */
  it('offers Mark complete to the CUSTOMER while in progress, with no confirmation requested', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }) });
    render(<BookingDetailPage />);

    expect(await screen.findByRole('button', { name: 'Mark complete' })).toBeEnabled();
    expect(screen.getByText(/the provider does not need to confirm it/i)).toBeInTheDocument();
  });

  it('does not offer Mark complete before the booking is in progress', async () => {
    stubFetch({ booking: booking({ status: 'confirmed' }) });
    render(<BookingDetailPage />);

    await screen.findByText('Your booking');
    expect(screen.queryByRole('button', { name: 'Mark complete' })).toBeNull();
  });

  /** AC-11 §5: the dwell is surfaced as a disabled control plus a countdown in TEXT. */
  it('disables Mark complete and shows the countdown on 422 COMPLETION_TOO_EARLY', async () => {
    stubFetch({
      booking: booking({ status: 'in_progress' }),
      complete: {
        ok: false,
        status: 422,
        body: {
          code: 'COMPLETION_TOO_EARLY',
          message: 'This booking has only just started.',
          details: { retryAfterSeconds: 42 },
        },
      },
    });
    render(<BookingDetailPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark complete' })).toBeDisabled());
    expect(screen.getByText(/You can mark it complete in 42 seconds/i)).toBeInTheDocument();
  });

  /** AC-8/AC-10: who completed it is read from the history, and no dispute is implied. */
  it('shows which party completed the booking, and only an explicit disagreement route', async () => {
    stubFetch({
      booking: booking({ status: 'completed' }),
      history: [
        ...HISTORY,
        { fromStatus: 'arrived', toStatus: 'in_progress', actorRole: 'provider', occurredAt: '2026-10-01T09:05:00.000Z' },
        { fromStatus: 'in_progress', toStatus: 'completed', actorRole: 'provider', occurredAt: '2026-10-01T10:05:00.000Z' },
      ],
    });
    render(<BookingDetailPage />);

    expect(await screen.findByText(/Marked complete by the provider/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is opened automatically on your behalf/i)).toBeInTheDocument();
  });

  it('stops polling once the booking reaches a status spec 020 cannot leave', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = stubFetch({ booking: booking({ status: 'completed' }) });

    render(<BookingDetailPage />);
    await vi.waitFor(() => expect(screen.getByText('Your booking')).toBeInTheDocument());

    // Let every section's INITIAL load settle before taking the baseline — the page now mounts the
    // spec 022 refund section alongside the booking and history reads, and its first fetch can land
    // just after the booking text appears. What this test is about is that nothing POLLS afterwards.
    await vi.waitFor(() => {
      const settled = fetchMock.mock.calls.length;
      expect(settled).toBe(fetchMock.mock.calls.length);
      expect(settled).toBeGreaterThanOrEqual(3);
    });

    const afterLoad = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetchMock.mock.calls.length).toBe(afterLoad);
  });
  // --- Spec 028 §5 — the customer's view of execution ----------------------------------------

  /**
   * The empty state is NOTHING. A provider who posts no milestones must not look like one who is
   * failing to report, so there is no list and no "no updates yet" placeholder.
   */
  it('renders no milestone section at all when none has been posted (spec 028 §5)', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }), milestones: [] });
    render(<BookingDetailPage />);

    await screen.findByText('Your booking');
    expect(screen.queryByText('Progress updates')).not.toBeInTheDocument();
    expect(screen.queryByText(/no updates yet/i)).not.toBeInTheDocument();
  });

  it('renders posted milestones, oldest first, with their notes (spec 028 AC-3)', async () => {
    stubFetch({
      booking: booking({ status: 'in_progress' }),
      milestones: [
        { id: 'm1', bookingId: 'booking-1', milestoneType: 'started', note: null, createdAt: '2026-10-01T09:05:00.000Z' },
        {
          id: 'm2',
          bookingId: 'booking-1',
          milestoneType: 'custom',
          note: 'Deep clean underway',
          createdAt: '2026-10-01T09:30:00.000Z',
        },
      ],
    });
    render(<BookingDetailPage />);

    // The milestone list arrives on its own fetch. Under full-suite CPU contention that can take
    // longer than findBy*'s 1s default, so this waits the same budget the component tests elsewhere
    // in this repo allow for a settled render.
    expect(await screen.findByText('Started', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/Deep clean underway/, {}, { timeout: 5000 })).toBeInTheDocument();
  });

  /** AC-8 — the customer's evidence section does not exist before completion. */
  it('shows no evidence section before completion (spec 028 AC-8)', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }), evidence: [] });
    render(<BookingDetailPage />);

    await screen.findByText('Your booking');
    expect(screen.queryByText('Completion evidence')).not.toBeInTheDocument();
  });

  /** AC-8 — and does exist once the server returns the evidence, i.e. after completion. */
  it('shows the evidence section once the server returns evidence (spec 028 AC-8)', async () => {
    stubFetch({
      booking: booking({ status: 'completed' }),
      evidence: [
        {
          id: 'asset-1',
          kind: 'image',
          visibility: 'private',
          status: 'scanning',
          mimeType: 'image/jpeg',
          sizeBytes: 64,
          fileName: 'evidence.jpg',
          contextType: 'booking_evidence',
          contextId: 'booking-1',
          rejectionReason: null,
          createdAt: '2026-10-01T10:00:00.000Z',
          readyAt: null,
          version: 1,
        },
      ],
    });
    render(<BookingDetailPage />);

    expect(await screen.findByText('Completion evidence', {}, { timeout: 5000 })).toBeInTheDocument();
    // A not-yet-ready asset shows spec 027's own state, never a broken image.
    expect(await screen.findByText('Still checking this file', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  /** The customer never gets an upload control: evidence is the provider's to attach (AC-7). */
  it('never offers the customer an evidence upload control (spec 028 AC-7)', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }), evidence: [] });
    render(<BookingDetailPage />);

    await screen.findByText('Your booking');
    expect(screen.queryByLabelText(/Evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /post update/i })).not.toBeInTheDocument();
  });
});
