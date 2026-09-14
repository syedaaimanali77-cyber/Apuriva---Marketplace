// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CompareOffersPage from './page';
import type { ComparedOfferDto, OfferComparisonDto } from '@/lib/types/negotiation';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'req-1' }),
}));

const OFFER_A: ComparedOfferDto = {
  offerId: 'offer-a',
  providerProfileId: 'prov-a',
  providerBusinessName: 'Ali Plumbing',
  status: 'sent',
  priceAmountMinorUnits: 300_000,
  currencyCode: 'PKR',
  previousPriceAmountMinorUnits: null,
  revisionNumber: 0,
  includedItems: ['Labour', 'Parts'],
  providerMessage: 'Can come today.',
  estimatedDurationMinutes: 90,
  availabilityFit: 'exact',
  approxDistanceKm: 3.2,
  rating: null,
  badges: ['verified'],
  isTopMatch: true,
  whyThisProvider: ['top_match', 'available_at_requested_time', 'nearby'],
  expiresAt: '2026-09-14T10:02:00.000Z',
};

const OFFER_B: ComparedOfferDto = {
  ...OFFER_A,
  offerId: 'offer-b',
  providerProfileId: 'prov-b',
  providerBusinessName: 'Bilal Services',
  priceAmountMinorUnits: 250_000,
  previousPriceAmountMinorUnits: 300_000,
  revisionNumber: 1,
  availabilityFit: 'same_day',
  approxDistanceKm: null,
  badges: [],
  isTopMatch: false,
  whyThisProvider: [],
};

const COMPARISON: OfferComparisonDto = {
  requestId: 'req-1',
  available: true,
  unavailableReason: null,
  offers: [OFFER_A, OFFER_B],
  maxOffers: 3,
  serverNow: '2026-09-14T10:00:30.000Z',
};

function json(ok: boolean, body: unknown, status = ok ? 200 : 422) {
  return { ok, status, json: async () => body, headers: { get: () => null } };
}

/** Routes by URL rather than by call order, so an extra refresh never breaks a test. */
function stubFetch(options?: { comparison?: OfferComparisonDto; preferredAt?: string | null; accept?: ReturnType<typeof json> }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/offers/compare')) return Promise.resolve(json(true, { data: options?.comparison ?? COMPARISON }));
    if (url.includes('/accept')) return Promise.resolve(options?.accept ?? json(true, { data: { id: 'offer-a', status: 'accepted' } }));
    return Promise.resolve(json(true, { data: { id: 'req-1', preferredAt: options?.preferredAt ?? null } }));
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

describe('CompareOffersPage (spec 019 §5, AC-2/AC-6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders a table of up to 3 offers with the required rows', async () => {
    stubFetch();
    render(<CompareOffersPage />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Ali Plumbing')).toBeInTheDocument();
    expect(within(table).getByText('Bilal Services')).toBeInTheDocument();
    for (const label of [
      'Price',
      'Time left',
      'Availability',
      'Distance',
      'Rating',
      'Badges',
      "What's included",
      'Provider message',
      'Estimated duration',
      'Why this provider',
    ]) {
      expect(within(table).getByText(label), label).toBeInTheDocument();
    }

    // Required per-offer values.
    expect(within(table).getAllByText('Not yet rated')).toHaveLength(2);
    expect(within(table).getByText('~3.2 km away')).toBeInTheDocument();
    expect(within(table).getByText('Not available')).toBeInTheDocument();
    expect(within(table).getAllByText(/Revised from/).length).toBeGreaterThan(0);
    expect(within(table).getByText('Verified')).toBeInTheDocument();
    expect(within(table).getAllByText('About 90 min')).toHaveLength(2);
  });

  it('renders stacked OfferCards as well as the table, so the layout works below md', async () => {
    stubFetch();
    render(<CompareOffersPage />);
    await screen.findByRole('table');

    // One Accept in the table view and one in the stacked view, per offer.
    expect(screen.getAllByRole('button', { name: /Accept Ali Plumbing/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Accept Bilal Services/ })).toHaveLength(2);
  });

  it('conveys Top Match with icon and text, on exactly one offer', async () => {
    stubFetch();
    render(<CompareOffersPage />);
    await screen.findByRole('table');

    // The table header badge plus the OfferCard badge — both carry text, never colour alone.
    const topMatches = screen.getAllByText(/top match/i);
    expect(topMatches.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Bilal Services').length).toBeGreaterThan(0);
  });

  it('renders the fixed "why this provider" copy and no score or rank', async () => {
    stubFetch({ preferredAt: '2026-09-20T09:00:00.000Z' });
    render(<CompareOffersPage />);
    await screen.findByRole('table');

    expect(screen.getAllByText('Available at your requested time').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Close to your address').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/score|rank|weight|normalized/i);
  });

  it('uses the no-preferred-time copy when the request has no preferred time', async () => {
    stubFetch({ preferredAt: null });
    render(<CompareOffersPage />);
    await screen.findByRole('table');
    await waitFor(() => expect(screen.getAllByText('Available when you requested').length).toBeGreaterThan(0));
  });

  it('shows EmptyState when the comparison is unavailable', async () => {
    stubFetch({
      comparison: { ...COMPARISON, available: false, unavailableReason: 'fewer_than_two_comparable_offers', offers: [] },
    });
    render(<CompareOffersPage />);

    expect(await screen.findByText('Nothing to compare right now')).toBeInTheDocument();
    expect(screen.getByText('Comparison needs at least two live offers.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    // The breadcrumb link plus the empty state's own action.
    expect(screen.getAllByRole('link', { name: 'Back to request' })).toHaveLength(2);
  });

  it('explains each unavailable reason in its own words', async () => {
    stubFetch({ comparison: { ...COMPARISON, available: false, unavailableReason: 'request_not_open_for_offers', offers: [] } });
    render(<CompareOffersPage />);
    expect(await screen.findByText('This request is no longer open for offers.')).toBeInTheDocument();
  });

  it('accepting sends an Idempotency-Key for that exact offer row and shows the success notice', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch();
    render(<CompareOffersPage />);
    await screen.findByRole('table');

    await user.click(screen.getAllByRole('button', { name: /Accept Bilal Services/ })[0]!);

    expect(await screen.findByText('Provider selected — booking is the next step.')).toBeInTheDocument();
    const acceptCall = calls.find((c) => c.url.includes('/accept'))!;
    expect(acceptCall.url).toBe('/api/v1/offers/offer-b/accept');
    expect((acceptCall.init as RequestInit).headers).toMatchObject({ 'Idempotency-Key': expect.any(String) });
  });

  it('shows the revised-price message when the server reports OFFER_SUPERSEDED', async () => {
    const user = userEvent.setup();
    stubFetch({ accept: json(false, { code: 'OFFER_SUPERSEDED', message: 'replaced' }, 409) });
    render(<CompareOffersPage />);
    await screen.findByRole('table');

    await user.click(screen.getAllByRole('button', { name: /Accept Ali Plumbing/ })[0]!);
    expect(await screen.findByText('This offer was revised — review the new price before accepting.')).toBeInTheDocument();
  });

  it('shows the DS ErrorState with retry when the comparison fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json(false, { code: 'INTERNAL_ERROR', message: 'boom' }, 500))),
    );
    render(<CompareOffersPage />);
    expect(await screen.findByText("Couldn't load the comparison.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
