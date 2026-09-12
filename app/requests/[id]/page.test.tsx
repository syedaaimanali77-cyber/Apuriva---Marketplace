// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RequestStatusPage from './page';
import type { CancelPreviewDto, RequestDto } from '@/lib/types/requests';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'req-1' }),
}));

const REQUEST: RequestDto = {
  id: 'req-1',
  status: 'submitted',
  serviceId: 'service-1',
  serviceName: 'Plumbing',
  description: 'Kitchen tap is leaking under the sink.',
  fieldValues: { problem: 'Leaking tap' },
  budget: null,
  preferredAt: null,
  preferredTimezone: null,
  addressId: 'addr-1',
  urgency: 'normal',
  offerCount: 0,
  customerFacingStep: 'Request sent',
  version: 3,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
};

const NO_CONSEQUENCE: CancelPreviewDto = {
  cancellable: true,
  consequence: null,
  feeAmountMinorUnits: null,
  currencyCode: null,
};

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

interface Call {
  url: string;
  method: string;
}

/**
 * Routes the three calls this screen makes. Nothing under `lib/requests/*` is mocked — only the
 * network — so the component's real ordering and rendering logic is what's under test (spec 015 §6:
 * "No test may assert behaviour only against a mock of the domain module").
 */
function stubFetch(options: { preview?: CancelPreviewDto; request?: RequestDto } = {}) {
  const calls: Call[] = [];
  const preview = options.preview ?? NO_CONSEQUENCE;
  const request = options.request ?? REQUEST;

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/cancel-preview')) return Promise.resolve(jsonResponse(true, { data: preview }));
      if (url.endsWith('/cancel')) {
        return Promise.resolve(
          jsonResponse(true, { data: { ...request, status: 'cancelled', customerFacingStep: 'Cancelled', version: request.version + 1 } }),
        );
      }
      return Promise.resolve(jsonResponse(true, { data: request }));
    }),
  );

  return {
    calls,
    /** The destructive call, which must never precede the dry run. */
    cancelPosts: () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/cancel')),
    previewGets: () => calls.filter((c) => c.url.includes('/cancel-preview')),
  };
}

/** Opens the confirmation dialog via the page's own trigger and returns it. */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole('button', { name: 'Cancel request' });
  await user.click(trigger);
  return screen.findByRole('alertdialog');
}

describe('RequestStatusPage (spec 015 §5 — cancellation dialog)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('§6: opening the dialog calls cancel-preview BEFORE any POST /cancel', async () => {
    const user = userEvent.setup();
    const net = stubFetch();
    render(<RequestStatusPage />);

    // No dialog, and nothing destructive, before the customer asks.
    await screen.findByRole('button', { name: 'Cancel request' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(net.cancelPosts()).toHaveLength(0);

    await openDialog(user);

    expect(net.previewGets()).toHaveLength(1);
    // The dry run has happened; the destructive call has not.
    expect(net.cancelPosts()).toHaveLength(0);

    const previewIndex = net.calls.findIndex((c) => c.url.includes('/cancel-preview'));
    const postIndex = net.calls.findIndex((c) => c.method === 'POST');
    expect(previewIndex).toBeGreaterThanOrEqual(0);
    expect(postIndex).toBe(-1);
  });

  it('§6: the dialog shows the consequence the server returned, not one it composed', async () => {
    const user = userEvent.setup();
    stubFetch({
      preview: {
        cancellable: true,
        consequence: 'A PKR 500 cancellation fee applies because a provider is on the way.',
        feeAmountMinorUnits: 50_000,
        currencyCode: 'PKR',
      },
    });
    render(<RequestStatusPage />);

    const dialog = await openDialog(user);
    expect(
      within(dialog).getByText('A PKR 500 cancellation fee applies because a provider is on the way.'),
    ).toBeInTheDocument();
    // The server said there IS a consequence, so the no-fee fallback must not appear.
    expect(within(dialog).queryByText(/No fee/i)).not.toBeInTheDocument();
  });

  it('§6: a null consequence shows the shipped fallback and invents no fee', async () => {
    const user = userEvent.setup();
    stubFetch({ preview: NO_CONSEQUENCE });
    render(<RequestStatusPage />);

    const dialog = await openDialog(user);
    expect(within(dialog).getByText(/No fee/i)).toBeInTheDocument();
    // Nothing resembling a charge may be asserted when the server returned none.
    expect(within(dialog).queryByText(/\bfee applies\b/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/PKR/)).not.toBeInTheDocument();
  });

  it('§6: dismissing the dialog issues no POST /cancel', async () => {
    const user = userEvent.setup();
    const net = stubFetch();
    render(<RequestStatusPage />);

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(net.cancelPosts()).toHaveLength(0);
    // The request is untouched and still cancellable.
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
  });

  it('§6: confirming issues POST /cancel, carrying the version the page read', async () => {
    const user = userEvent.setup();
    const net = stubFetch();
    render(<RequestStatusPage />);

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel request' }));

    await waitFor(() => expect(net.cancelPosts()).toHaveLength(1));
    // Ordering holds end to end: dry run first, destructive call second.
    expect(net.calls.findIndex((c) => c.url.includes('/cancel-preview'))).toBeLessThan(
      net.calls.findIndex((c) => c.method === 'POST'),
    );

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST')![1] as RequestInit)
        .body as string,
    );
    expect(body).toEqual({ expectedVersion: REQUEST.version });
  });

  it('AC-5: renders the §37 progression from customerFacingStep, never the internal status', async () => {
    stubFetch({ request: { ...REQUEST, status: 'offers_open', customerFacingStep: 'Offers received' } });
    render(<RequestStatusPage />);

    const timeline = await screen.findByRole('list', { name: 'Request progress' });
    const steps = within(timeline).getAllByRole('listitem');
    expect(steps.map((li) => li.textContent)).toEqual([
      'Request sent',
      'Providers notified',
      'Offers received',
      'Provider selected',
      'Payment',
      'Booking confirmed',
    ]);
    expect(steps[2]).toHaveAttribute('aria-current', 'step');

    // AC-5: no internal status string or matching mechanic reaches the customer's screen.
    expect(screen.queryByText(/offers_open/)).not.toBeInTheDocument();
    expect(screen.queryByText(/matching/i)).not.toBeInTheDocument();
  });
});
