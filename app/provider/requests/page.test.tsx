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
};

const QUOTE_REQUEST: IncomingRequestDto = {
  ...FIXED_PRICE_REQUEST,
  requestId: 'req-2',
  serviceName: 'Custom Renovation',
  availableAction: 'send_offer',
  urgency: 'urgent',
};

function mockFetchSequence(...responses: { ok: boolean; status: number; json: () => Promise<unknown> }[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('ProviderRequestsPage (spec 017 §5)', () => {
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

  it('renders a disabled "Send offer (coming soon)" action for a quote-priced service — spec 018 owns the endpoint', async () => {
    mockFetchSequence({ ok: true, status: 200, json: async () => ({ data: [QUOTE_REQUEST] }) });
    render(<ProviderRequestsPage />);
    expect(await screen.findByText('Custom Renovation')).toBeInTheDocument();
    const sendOfferButton = screen.getByRole('button', { name: /Send offer \(coming soon\)/ });
    expect(sendOfferButton).toBeDisabled();
    // Decline remains available regardless of pricing model (AC-5).
    expect(screen.getByRole('button', { name: 'Decline' })).toBeEnabled();
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
    // Only the initial GET has fired so far — confirming is a separate, deliberate step.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: 'Decline' }));
    expect(await screen.findByText('You declined this request')).toBeInTheDocument();
  });
});
