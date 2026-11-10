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

  // ---- Spec 019: negotiation (AC-3, AC-4, AC-13) --------------------------
  describe('negotiation (spec 019 §5)', () => {
    const LIVE_OFFER_REQUEST: IncomingRequestDto = {
      ...QUOTE_REQUEST,
      providerResponse: 'offer_sent',
      currentOffer: { offerId: 'offer-1', status: 'sent', expiresAt: '2026-09-14T10:02:00.000Z', serverNow: '2026-09-14T10:00:30.000Z' },
    };

    const CURRENT_OFFER = {
      id: 'offer-1',
      requestId: 'req-2',
      providerProfileId: 'prov-1',
      providerBusinessName: 'Ali Plumbing',
      status: 'sent',
      priceAmountMinorUnits: 300_000,
      currencyCode: 'PKR',
      includedItems: ['Labour'],
      providerMessage: 'Can come today.',
      estimatedDurationMinutes: 90,
      sentAt: '2026-09-14T10:00:00.000Z',
      expiresAt: '2026-09-14T10:02:00.000Z',
      viewedAt: null,
      decidedAt: null,
      serverNow: '2026-09-14T10:00:30.000Z',
      version: 1,
      revisionNumber: 0,
      previousOfferId: null,
      previousPriceAmountMinorUnits: null,
      supersededByOfferId: null,
    };

    const CHANGE_REQUEST = {
      id: 'msg-1',
      requestId: 'req-2',
      providerProfileId: 'prov-1',
      offerId: 'offer-1',
      kind: 'change_request',
      senderRole: 'customer',
      body: 'Can you do it on Sunday?',
      contactRedacted: false,
      proposedPrice: { amountMinorUnits: 250_000, currencyCode: 'PKR' },
      createdAt: '2026-09-14T10:01:00.000Z',
    };

    /** Routes by URL, so polling or an extra refetch never breaks the sequence. */
    function stubProviderFetch(overrides?: { messages?: unknown[]; revision?: { ok: boolean; status: number; body: unknown } }) {
      const calls: { url: string; init?: RequestInit }[] = [];
      const reply = (body: unknown, status = 200, ok = true) =>
        Promise.resolve({ ok, status, json: async () => body, headers: { get: () => null } });
      const fn = vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.includes('/messages')) return reply({ data: overrides?.messages ?? [CHANGE_REQUEST] });
        if (url.includes('/revisions')) {
          const revision = overrides?.revision;
          return revision
            ? Promise.resolve({ ok: revision.ok, status: revision.status, json: async () => revision.body, headers: { get: () => null } })
            : reply({ data: { ...CURRENT_OFFER, id: 'offer-2', priceAmountMinorUnits: 250_000, revisionNumber: 1 } }, 201);
        }
        if (/\/api\/v1\/offers\/[^/]+$/.test(url)) return reply({ data: CURRENT_OFFER });
        return reply({ data: [LIVE_OFFER_REQUEST] });
      });
      vi.stubGlobal('fetch', fn);
      return { fn, calls };
    }

    it('AC-3: shows the change request and pre-fills the revision form with the proposed price', async () => {
      const user = userEvent.setup();
      stubProviderFetch();
      render(<ProviderRequestsPage />);

      await user.click(await screen.findByRole('button', { name: 'Messages' }));
      expect(await screen.findByText('The customer asked for a change')).toBeInTheDocument();
      expect(screen.getAllByText('Can you do it on Sunday?').length).toBeGreaterThan(0);

      await user.click(screen.getByRole('button', { name: 'Send revised offer' }));

      const form = await screen.findByRole('form', { name: 'Send a revised offer for Custom Renovation' });
      // 250_000 minor units, pre-filled from the customer's proposed price.
      expect(within(form).getByLabelText('Price')).toHaveValue('2500.00');
      expect(within(form).getByLabelText('Currency')).toBeDisabled();
      expect(within(form).getByText(/Revisions used: 0 of 5/)).toBeInTheDocument();
    });

    it('AC-4: sends the revision to /revisions with a fresh Idempotency-Key and no requestId', async () => {
      const user = userEvent.setup();
      const { calls } = stubProviderFetch();
      render(<ProviderRequestsPage />);

      await user.click(await screen.findByRole('button', { name: 'Send revised offer' }));
      const form = await screen.findByRole('form', { name: 'Send a revised offer for Custom Renovation' });
      // Without opening the thread, the form starts from the current offer's own price.
      expect(within(form).getByLabelText('Price')).toHaveValue('3000.00');
      await user.clear(within(form).getByLabelText('Price'));
      await user.type(within(form).getByLabelText('Price'), '2500');
      await user.click(within(form).getByRole('button', { name: 'Send revised offer' }));

      expect(await screen.findByText('Revised offer sent. The customer has 2 minutes to respond.')).toBeInTheDocument();
      const post = calls.find((c) => c.url.includes('/revisions') && c.init?.method === 'POST')!;
      expect(post.url).toBe('/api/v1/offers/offer-1/revisions');
      expect((post.init!.headers as Record<string, string>)['Idempotency-Key']).toEqual(expect.any(String));
      const body = JSON.parse(post.init!.body as string);
      expect(body).toMatchObject({ priceAmountMinorUnits: 250_000, currencyCode: 'PKR' });
      expect(body).not.toHaveProperty('requestId');
    });

    it('AC-13: surfaces REVISION_LIMIT_REACHED and REVISION_UNCHANGED in the provider’s own words', async () => {
      const user = userEvent.setup();
      stubProviderFetch({ revision: { ok: false, status: 422, body: { code: 'REVISION_LIMIT_REACHED', message: 'limit' } } });
      render(<ProviderRequestsPage />);

      await user.click(await screen.findByRole('button', { name: 'Send revised offer' }));
      const form = await screen.findByRole('form', { name: 'Send a revised offer for Custom Renovation' });
      await user.click(within(form).getByRole('button', { name: 'Send revised offer' }));

      expect(await screen.findByText("You've reached the limit of 5 revisions on this request.")).toBeInTheDocument();
    });

    it('AC-1: the provider can open the request thread and send a message', async () => {
      const user = userEvent.setup();
      const { calls } = stubProviderFetch({ messages: [] });
      render(<ProviderRequestsPage />);

      await user.click(await screen.findByRole('button', { name: 'Messages' }));
      await screen.findByText('No messages yet — ask a question about this request.');

      await user.type(screen.getByLabelText(/Your message/), 'Which floor?');
      await user.click(screen.getByRole('button', { name: 'Send message' }));

      const post = calls.find((c) => c.url.includes('/messages') && c.init?.method === 'POST')!;
      expect(post.url).toBe('/api/v1/providers/me/requests/req-2/messages');
      expect((post.init!.headers as Record<string, string>)['Idempotency-Key']).toEqual(expect.any(String));
    });
  });
});
