// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OffersPanel } from './OffersPanel';
import type { OfferDto } from '@/lib/types/offers';

const LIVE: OfferDto = {
  id: 'offer-1',
  requestId: 'req-1',
  providerProfileId: 'prov-1',
  providerBusinessName: 'Ali Plumbing',
  status: 'sent',
  priceAmountMinorUnits: 320_000,
  currencyCode: 'PKR',
  includedItems: ['Labour', 'Parts'],
  providerMessage: 'Can come today.',
  estimatedDurationMinutes: 90,
  sentAt: '2026-09-14T10:00:00.000Z',
  expiresAt: '2026-09-14T10:02:00.000Z',
  viewedAt: null,
  decidedAt: null,
  serverNow: '2026-09-14T10:00:30.000Z',
  version: 1,
};

function json(ok: boolean, body: unknown, status = ok ? 200 : 422) {
  return { ok, status, json: async () => body };
}

function mockFetch(...responses: ReturnType<typeof json>[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  fn.mockResolvedValue(json(true, { data: [] }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPanel(overrides?: Partial<Parameters<typeof OffersPanel>[0]>) {
  const onRequestChanged = vi.fn();
  render(
    <OffersPanel
      requestId="req-1"
      requestStatus="offers_open"
      requestCreatedAt={new Date(Date.now() - 5 * 60_000).toISOString()}
      onRequestChanged={onRequestChanged}
      {...overrides}
    />,
  );
  return { onRequestChanged };
}

describe('OffersPanel (spec 018 §5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Empty: "Waiting for offers" with elapsed time, never a blank panel', async () => {
    mockFetch(json(true, { data: [] }));
    renderPanel();
    expect(await screen.findByText(/Waiting for offers — your request was sent 5 min ago/)).toBeInTheDocument();
  });

  it('Error: a failed load shows the DS ErrorState with retry', async () => {
    mockFetch(json(false, { code: 'INTERNAL_ERROR', message: 'boom' }, 500));
    renderPanel();
    expect(await screen.findByText("Couldn't load offers for this request.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('Success: a live offer shows price, inclusions, the cosmetic countdown and Accept/Decline', async () => {
    mockFetch(json(true, { data: [LIVE] }));
    renderPanel();
    expect(await screen.findByText('Ali Plumbing')).toBeInTheDocument();
    expect(screen.getByText('Labour')).toBeInTheDocument();
    expect(screen.getByTestId('offer-countdown')).toHaveAttribute('data-seconds-remaining', '90');
    expect(screen.getByRole('button', { name: 'Accept' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
  });

  it('the countdown never gates actions: a server-live offer stays acceptable even when the display shows 0', async () => {
    mockFetch(json(true, { data: [{ ...LIVE, serverNow: '2026-09-14T10:05:00.000Z' }] }));
    renderPanel();
    await screen.findByText('Ali Plumbing');
    expect(screen.getAllByTestId('offer-countdown')[0]).toHaveAttribute('data-seconds-remaining', '0');
    expect(screen.getAllByRole('button', { name: 'Accept' })[0]).toBeEnabled();
  });

  it('accept sends an Idempotency-Key, shows "Provider selected", refreshes the request, and creates no booking', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(
      json(true, { data: [LIVE] }),
      json(true, { data: { ...LIVE, status: 'accepted' } }),
      json(true, { data: [{ ...LIVE, status: 'accepted', decidedAt: '2026-09-14T10:00:40.000Z' }] }),
    );
    const { onRequestChanged } = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));

    expect(await screen.findByText('Provider selected — booking is the next step.')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/v1/offers/offer-1/accept');
    expect((init as RequestInit).headers).toMatchObject({ 'Idempotency-Key': expect.any(String) });
    expect(onRequestChanged).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/bookings'))).toBe(false);
  });

  it('OFFER_EXPIRED shows the specific copy and refetches authoritative state', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(
      json(true, { data: [LIVE] }),
      json(false, { code: 'OFFER_EXPIRED', message: 'This offer expired.' }),
      json(true, { data: [{ ...LIVE, status: 'expired' }] }),
    );
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('This offer expired — the provider can send a new one.')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('REQUEST_ALREADY_CLAIMED shows its own message', async () => {
    const user = userEvent.setup();
    mockFetch(json(true, { data: [LIVE] }), json(false, { code: 'REQUEST_ALREADY_CLAIMED', message: 'x' }, 409), json(true, { data: [LIVE] }));
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText("You've already selected a provider for this request.")).toBeInTheDocument();
  });

  it('AC-4: terminal offers stay listed with their status and no actions', async () => {
    mockFetch(
      json(true, {
        data: [
          { ...LIVE, id: 'a', providerBusinessName: 'Accepted Co', status: 'accepted', decidedAt: LIVE.sentAt },
          { ...LIVE, id: 'b', providerBusinessName: 'Declined Co', status: 'declined', decidedAt: LIVE.sentAt },
          { ...LIVE, id: 'c', providerBusinessName: 'Expired Co', status: 'expired' },
          { ...LIVE, id: 'd', providerBusinessName: 'Withdrawn Co', status: 'withdrawn', decidedAt: LIVE.sentAt },
        ],
      }),
    );
    renderPanel({ requestStatus: 'provider_selected' });
    expect(await screen.findByText('Accepted Co')).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Declined')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn')).toBeInTheDocument();
    expect(screen.getByText('Offer expired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(within(document.body).queryByTestId('offer-countdown')).toBeNull();
  });
});
