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
  // Spec 019 additive lineage fields.
  revisionNumber: 0,
  previousOfferId: null,
  previousPriceAmountMinorUnits: null,
  supersededByOfferId: null,
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

  // ---- Spec 019 -----------------------------------------------------------

  const SECOND_LIVE: OfferDto = { ...LIVE, id: 'offer-2', providerProfileId: 'prov-2', providerBusinessName: 'Bilal Services' };
  const comparison = (available: boolean) => ({
    requestId: 'req-1',
    available,
    unavailableReason: available ? null : 'fewer_than_two_comparable_offers',
    offers: [],
    maxOffers: 3,
    serverNow: LIVE.serverNow,
  });

  it('AC-6: links to the comparison only when the server says it is available', async () => {
    mockFetch(json(true, { data: [LIVE, SECOND_LIVE] }), json(true, { data: comparison(true) }));
    renderPanel();

    const link = await screen.findByRole('link', { name: 'Compare offers' });
    expect(link).toHaveAttribute('href', '/requests/req-1/compare');
  });

  it('AC-6: hides Compare offers when the server says the comparison is unavailable', async () => {
    mockFetch(json(true, { data: [LIVE, SECOND_LIVE] }), json(true, { data: comparison(false) }));
    renderPanel();

    await screen.findByText('Ali Plumbing');
    expect(screen.queryByRole('link', { name: 'Compare offers' })).toBeNull();
  });

  it('AC-6: does not ask for a comparison when fewer than two offers are live', async () => {
    const fetchMock = mockFetch(json(true, { data: [LIVE] }));
    renderPanel();

    await screen.findByText('Ali Plumbing');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/offers/compare'))).toBe(false);
    expect(screen.queryByRole('link', { name: 'Compare offers' })).toBeNull();
  });

  it('AC-5: on OFFER_SUPERSEDED shows the revised-price alert and refetches', async () => {
    const user = userEvent.setup();
    const revisedHead: OfferDto = { ...LIVE, id: 'offer-3', previousOfferId: 'offer-1', previousPriceAmountMinorUnits: 320_000, revisionNumber: 1 };
    const fetchMock = mockFetch(
      json(true, { data: [LIVE] }),
      json(false, { code: 'OFFER_SUPERSEDED', message: 'replaced', details: { currentOfferId: 'offer-3' } }, 409),
      json(true, { data: [{ ...LIVE, status: 'revised' }, revisedHead] }),
    );
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Accept' }));

    expect(await screen.findByText('This offer was revised — review the new price before accepting.')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('AC-5: collapses a superseded row into its chain head, which shows the previous price', async () => {
    const superseded: OfferDto = { ...LIVE, id: 'old', status: 'revised', providerBusinessName: 'Ali Plumbing' };
    const head: OfferDto = {
      ...LIVE,
      id: 'new',
      priceAmountMinorUnits: 250_000,
      previousOfferId: 'old',
      previousPriceAmountMinorUnits: 320_000,
      revisionNumber: 1,
    };
    mockFetch(json(true, { data: [superseded, head] }));
    renderPanel();

    await screen.findByText('Ali Plumbing');
    // Only the head is actionable; the superseded row is not rendered as its own card.
    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(1);
    expect(screen.getAllByText(/Revised from/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Price history' })).toBeInTheDocument();
  });

  it('AC-3: Request change posts a change request with an Idempotency-Key and confirms it', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(
      json(true, { data: [LIVE] }),
      json(true, { data: { id: 'msg-1', kind: 'change_request' } }, 201),
      json(true, { data: [LIVE] }),
    );
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Request change' }));
    await user.type(screen.getByLabelText(/What would you like changed/), 'Can you do Sunday?');
    await user.click(screen.getByRole('button', { name: 'Send change request' }));

    expect(await screen.findByText('The provider can now send you a revised offer.')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/change-requests'))!;
    expect(url).toBe('/api/v1/offers/offer-1/change-requests');
    expect((init as RequestInit).headers).toMatchObject({ 'Idempotency-Key': expect.any(String) });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ note: 'Can you do Sunday?', proposedPriceAmountMinorUnits: null });
  });

  it('AC-3: a change request can carry a proposed price, and rejects an unparseable one before sending', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(json(true, { data: [LIVE] }), json(true, { data: { id: 'msg-1' } }, 201), json(true, { data: [LIVE] }));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Request change' }));
    await user.type(screen.getByLabelText(/What would you like changed/), 'Cheaper please');
    await user.type(screen.getByLabelText(/Proposed price/), 'abc');
    await user.click(screen.getByRole('button', { name: 'Send change request' }));
    expect(await screen.findByText('Enter a price greater than zero, with at most two decimal places.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/change-requests'))).toBe(false);

    await user.clear(screen.getByLabelText(/Proposed price/));
    await user.type(screen.getByLabelText(/Proposed price/), '2500');
    await user.click(screen.getByRole('button', { name: 'Send change request' }));

    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/change-requests'))!;
    expect(JSON.parse((init as RequestInit).body as string).proposedPriceAmountMinorUnits).toBe(250_000);
  });
});
