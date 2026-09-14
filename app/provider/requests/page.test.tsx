// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProviderRequestsPage from './page';
import type { IncomingRequestDto } from '@/lib/types/matching';

const FIXED_PRICE_REQUEST: IncomingRequestDto = {
  requestId: 'req-1',
  serviceId: 'svc-1',
  serviceName: 'Deep Cleaning',
  availableAction: 'accept',
  approxDistanceKm: 3.2,
  approxAreaLabel: 'Gulberg, Lahore',
  description: 'Full apartment deep clean, two bedrooms.',
  urgency: 'normal',
  budget: null,
  preferredAt: null,
  distributedAt: '2026-09-13T10:00:00.000Z',
  providerResponse: 'none',
  currentOffer: null,
};

const QUOTE_REQUEST: IncomingRequestDto = {
  ...FIXED_PRICE_REQUEST,
  requestId: 'req-2',
  serviceName: 'Custom Renovation',
  availableAction: 'send_offer',
  urgency: 'urgent',
  budget: { minAmountMinorUnits: 100_000, maxAmountMinorUnits: 500_000, currencyCode: 'PKR' },
};

function mockFetchSequence(...responses: { ok: boolean; status: number; json: () => Promise<unknown> }[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('ProviderRequestsPage (spec 017 §5 / spec 018 §5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the DS EmptyState with next steps when there are no distributed requests', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ data: [] }) });
    render(<ProviderRequestsPage />);
    expect(await screen.findByText('No new requests right now')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review my schedule' })).toHaveAttribute('href', '/provider/schedule');
  });

  it('shows the DS ErrorState with a retry action when the list fails to load', async () => {
    mockFetchSequence({ ok: false, status: 500, json: async () => ({ code: 'INTERNAL_ERROR', message: 'boom' }) });
    render(<ProviderRequestsPage />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders an Accept action for a fixed-price service and a Decline action always', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ data: [FIXED_PRICE_REQUEST] }) });
    render(<ProviderRequestsPage />);
    expect(await screen.findByText('Deep Cleaning')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('accepting updates the row in place to show the accepted state, without a full reload', async () => {
    const user = userEvent.setup();
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ data: [FIXED_PRICE_REQUEST] }) },
      { ok: true, status: 200, json: async () => ({ data: { requestId: 'req-1', providerResponse: 'accepted', respondedAt: '2026-09-13T10:05:00.000Z' } }) },
    );
    render(<ProviderRequestsPage />);
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('You accepted this request')).toBeInTheDocument();
  });

  it('a lost race (already claimed) surfaces the specific "another provider" message, not a generic error', async () => {
    const user = userEvent.setup();
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ data: [FIXED_PRICE_REQUEST] }) },
      { ok: false, status: 409, json: async () => ({ code: 'REQUEST_ALREADY_CLAIMED', message: 'nope' }) },
      { ok: true, status: 200, json: async () => ({ data: [FIXED_PRICE_REQUEST] }) },
    );
    render(<ProviderRequestsPage />);
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Another provider has already taken this request.')).toBeInTheDocument();
  });

  it('declining requires confirmation through the DS ConfirmDialog before the request is submitted', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ data: [FIXED_PRICE_REQUEST] }) },
      { ok: true, status: 200, json: async () => ({ data: { requestId: 'req-1', providerResponse: 'declined', respondedAt: '2026-09-13T10:05:00.000Z' } }) },
    );
    render(<ProviderRequestsPage />);
    await user.click(await screen.findByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('You declined this request')).toBeInTheDocument();
  });

  describe('spec 018 — sending offers', () => {
    it('a quote-priced request offers a working "Send offer" form that posts minor units with a fresh Idempotency-Key', async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetchSequence(
        { ok: true, status: 200, json: async () => ({ data: [QUOTE_REQUEST] }) },
        { ok: true, status: 201, json: async () => ({ data: { id: 'offer-1', status: 'sent' } }) },
        { ok: true, status: 200, json: async () => ({ data: [QUOTE_REQUEST] }) },
      );
      render(<ProviderRequestsPage />);
      await user.click(await screen.findByRole('button', { name: 'Send offer' }));

      const form = screen.getByRole('form', { name: 'Send an offer for Custom Renovation' });
      // Defaults to the request budget's currency.
      expect(within(form).getByLabelText(/Currency/)).toHaveValue('PKR');
      await user.type(within(form).getByLabelText(/^Price/), '3200.50');
      await user.type(within(form).getByLabelText(/What's included/), 'Labour\nParts');
      await user.type(within(form).getByLabelText(/Estimated duration/), '90');
      await user.click(within(form).getByRole('button', { name: 'Send offer' }));

      expect(await screen.findByText('Offer sent. The customer has 2 minutes to respond.')).toBeInTheDocument();
      const [url, init] = fetchMock.mock.calls[1]!;
      expect(url).toBe('/api/v1/offers');
      const request = init as RequestInit;
      expect(request.headers).toMatchObject({ 'Idempotency-Key': expect.any(String) });
      const body = JSON.parse(String(request.body));
      expect(body).toEqual({
        requestId: 'req-2',
        priceAmountMinorUnits: 320_050,
        currencyCode: 'PKR',
        includedItems: ['Labour', 'Parts'],
        providerMessage: '',
        estimatedDurationMinutes: 90,
      });
      // The client never supplies timing.
      expect(body).not.toHaveProperty('expiresAt');
      expect(body).not.toHaveProperty('sentAt');
    });

    it('rejects an invalid price before submitting', async () => {
      const user = userEvent.setup();
      const fetchMock = mockFetchSequence({ ok: true, status: 200, json: async () => ({ data: [QUOTE_REQUEST] }) });
      render(<ProviderRequestsPage />);
      await user.click(await screen.findByRole('button', { name: 'Send offer' }));
      const form = screen.getByRole('form', { name: 'Send an offer for Custom Renovation' });
      await user.type(within(form).getByLabelText(/^Price/), '12.345');
      await user.click(within(form).getByRole('button', { name: 'Send offer' }));
      expect(await screen.findByText(/Enter a price greater than zero/)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('LIVE_OFFER_EXISTS shows its specific message', async () => {
      const user = userEvent.setup();
      mockFetchSequence(
        { ok: true, status: 200, json: async () => ({ data: [QUOTE_REQUEST] }) },
        { ok: false, status: 409, json: async () => ({ code: 'LIVE_OFFER_EXISTS', message: 'x' }) },
        { ok: true, status: 200, json: async () => ({ data: [QUOTE_REQUEST] }) },
      );
      render(<ProviderRequestsPage />);
      await user.click(await screen.findByRole('button', { name: 'Send offer' }));
      const form = screen.getByRole('form', { name: 'Send an offer for Custom Renovation' });
      await user.type(within(form).getByLabelText(/^Price/), '3200');
      await user.click(within(form).getByRole('button', { name: 'Send offer' }));
      expect(await screen.findByText('You already have an offer waiting on this request.')).toBeInTheDocument();
    });

    it('a live offer shows the display-only countdown and Withdraw, with no second Send offer', async () => {
      mockFetchSequence({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              ...QUOTE_REQUEST,
              availableAction: 'decline_only',
              providerResponse: 'offer_sent',
              currentOffer: {
                offerId: 'offer-1',
                status: 'sent',
                expiresAt: '2026-09-14T10:02:00.000Z',
                serverNow: '2026-09-14T10:01:00.000Z',
              },
            },
          ],
        }),
      });
      render(<ProviderRequestsPage />);
      expect(await screen.findByRole('button', { name: 'Withdraw offer' })).toBeInTheDocument();
      expect(screen.getByTestId('offer-countdown')).toHaveAttribute('data-seconds-remaining', '60');
      expect(screen.queryByRole('button', { name: /Send (a new )?offer/ })).toBeNull();
    });

    it('AC-5: an expired offer with send_offer from the server shows its status and "Send a new offer"', async () => {
      mockFetchSequence({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              ...QUOTE_REQUEST,
              providerResponse: 'offer_sent',
              currentOffer: {
                offerId: 'offer-1',
                status: 'expired',
                expiresAt: '2026-09-14T10:02:00.000Z',
                serverNow: '2026-09-14T10:05:00.000Z',
              },
            },
          ],
        }),
      });
      render(<ProviderRequestsPage />);
      expect(await screen.findByText('Offer expired')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Send a new offer' })).toBeInTheDocument();
      expect(screen.queryByTestId('offer-countdown')).toBeNull();
    });
  });
});
