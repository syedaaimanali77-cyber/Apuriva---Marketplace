// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderBookingPage from './page';
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

function stubFetch(handlers: {
  booking?: BookingDto;
  history?: BookingStatusHistoryDto[];
  action?: { ok: boolean; status?: number; body: unknown };
  /** Spec 028 §5 — the milestone list this screen reads. */
  milestones?: unknown[];
  /** Spec 028 §5 — the evidence list this screen reads. */
  evidence?: unknown[];
  /** Spec 028 §5 — the service's catalog `completionEvidenceRequired`. */
  evidenceRequired?: boolean;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const result = handlers.action ?? { ok: true, body: { data: handlers.booking ?? booking() } };
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
    if (url.includes('/services/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { completionEvidenceRequired: handlers.evidenceRequired ?? false } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ data: handlers.booking ?? booking() }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Spec 020 §5 — the provider active-job view: AC-4's actions, AC-8's symmetry, AC-7's explicitness. */
describe('ProviderBookingPage (spec 020 §5)', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'test-key' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** AC-4: three explicit actions, and the en-route step is optional — both are offered at once. */
  it('offers both "I\'m on my way" and "I\'ve arrived" from a confirmed booking', async () => {
    stubFetch({ booking: booking({ status: 'confirmed' }) });
    render(<ProviderBookingPage />);

    expect(await screen.findByRole('button', { name: "I'm on my way" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "I've arrived" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start service' })).toBeNull();
  });

  it('offers only Start service once the provider has arrived', async () => {
    stubFetch({ booking: booking({ status: 'arrived' }) });
    render(<ProviderBookingPage />);

    expect(await screen.findByRole('button', { name: 'Start service' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "I've arrived" })).toBeNull();
  });

  /** AC-7: the transition happens only because the provider tapped — an explicit POST. */
  it('posts to the lifecycle route when the provider taps an action', async () => {
    const fetchMock = stubFetch({ booking: booking({ status: 'confirmed' }) });
    render(<ProviderBookingPage />);

    await userEvent.click(await screen.findByRole('button', { name: "I've arrived" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => String(url).endsWith('/arrived') && (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    );
  });

  /** AC-8: the PROVIDER also gets Mark complete, with no customer confirmation requested. */
  it('offers Mark complete to the provider while in progress, with no confirmation requested', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }) });
    render(<ProviderBookingPage />);

    expect(await screen.findByRole('button', { name: 'Mark complete' })).toBeEnabled();
    expect(screen.getByText(/the customer does not need to confirm it/i)).toBeInTheDocument();
  });

  /** AC-11: the dwell surfaces as a disabled control and a countdown in text. */
  it('disables Mark complete and shows the countdown on 422 COMPLETION_TOO_EARLY', async () => {
    stubFetch({
      booking: booking({ status: 'in_progress' }),
      action: {
        ok: false,
        status: 422,
        body: { code: 'COMPLETION_TOO_EARLY', message: 'Too early.', details: { retryAfterSeconds: 15 } },
      },
    });
    render(<ProviderBookingPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark complete' })).toBeDisabled());
    expect(screen.getByText(/You can mark it complete in 15 seconds/i)).toBeInTheDocument();
  });

  it('shows an inline error when an action is rejected', async () => {
    stubFetch({
      booking: booking({ status: 'confirmed' }),
      action: {
        ok: false,
        status: 422,
        body: { code: 'BOOKING_NOT_STARTABLE_YET', message: 'It is too early to start this booking.' },
      },
    });
    render(<ProviderBookingPage />);

    await userEvent.click(await screen.findByRole('button', { name: "I've arrived" }));

    expect(await screen.findByText('It is too early to start this booking.')).toBeInTheDocument();
  });

  it('shows an error state when the booking cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ code: 'BOOKING_NOT_FOUND', message: 'Gone.' }) })),
    );
    render(<ProviderBookingPage />);

    expect(await screen.findByText('We could not load this booking')).toBeInTheDocument();
  });
  // --- Spec 028 §5 — the provider's execution controls ----------------------------------------

  /** AC-3 — the milestone poster appears mid-job and says, in words, that it is optional. */
  it('offers an optional milestone poster while the job is running (spec 028 AC-3)', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }) });
    render(<ProviderBookingPage />);

    expect(await screen.findByText('Progress updates', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post update' })).toBeInTheDocument();
    expect(screen.getByText(/Progress updates are optional/i)).toBeInTheDocument();
    expect(screen.getByText(/finish this job without posting any/i)).toBeInTheDocument();
  });

  /** Milestones belong to the execution window only — not before arrival. */
  it('offers no milestone poster before the provider has arrived', async () => {
    stubFetch({ booking: booking({ status: 'confirmed' }) });
    render(<ProviderBookingPage />);

    await screen.findByText('Active job');
    expect(screen.queryByRole('button', { name: 'Post update' })).not.toBeInTheDocument();
  });

  /**
   * §5 "Evidence required" — the requirement is stated BEFORE the completion control is pressed,
   * so a 422 is a backstop rather than the first the provider hears of it.
   */
  it('states the evidence requirement before Mark complete is pressed (spec 028 §5)', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }), evidenceRequired: true, evidence: [] });
    render(<ProviderBookingPage />);

    expect(await screen.findByText('Completion evidence', {}, { timeout: 5000 })).toBeInTheDocument();
    // The service's `completionEvidenceRequired` arrives on its own fetch, so await the copy it
    // drives rather than asserting on whatever happened to be rendered first.
    expect(
      await screen.findByText(
        /needs at least one photo, video or document attached before you can mark it complete/i,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Nothing attached yet.')).toBeInTheDocument();
    expect(
      await screen.findByText(/Attach a file above before marking it complete/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  /** A service that requires nothing says so, rather than implying evidence is needed. */
  it('describes evidence as optional when the service does not require it', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }), evidenceRequired: false, evidence: [] });
    render(<ProviderBookingPage />);

    expect(
      await screen.findByText(/Optional\. Attach a photo, video or document/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs at least one photo/i)).not.toBeInTheDocument();
  });

  /** AC-4's backstop rendered inline on the same screen, not as a navigation away. */
  it('shows COMPLETION_EVIDENCE_REQUIRED inline on the same screen (spec 028 §5)', async () => {
    stubFetch({
      booking: booking({ status: 'in_progress' }),
      evidenceRequired: true,
      action: {
        ok: false,
        status: 422,
        body: {
          code: 'COMPLETION_EVIDENCE_REQUIRED',
          message: 'This service needs completion evidence attached before it can be marked complete.',
        },
      },
    });
    render(<ProviderBookingPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Mark complete' }, { timeout: 5000 }));
    expect(await screen.findByText(/needs completion evidence attached/i, {}, { timeout: 5000 })).toBeInTheDocument();
    // Still on the same screen.
    expect(screen.getByText('Active job')).toBeInTheDocument();
  });

  /** AC-3 — the completion control is never gated on a milestone having been posted. */
  it('never gates Mark complete on a milestone (spec 028 AC-3)', async () => {
    stubFetch({ booking: booking({ status: 'in_progress' }), milestones: [] });
    render(<ProviderBookingPage />);

    expect(await screen.findByRole('button', { name: 'Mark complete' }, { timeout: 5000 })).toBeEnabled();
  });
});
