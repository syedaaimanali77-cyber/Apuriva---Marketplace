// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminOverviewPage from './page';
import { ADMIN_DASHBOARD_POLL_MS } from './_components/usePolledResource';
import type { AdminOverviewDto } from '@/lib/types/admin-dashboard';

const OVERVIEW: AdminOverviewDto = {
  activeRequests: 1_234,
  activeBookings: 56,
  revenueToday: [
    { amountMinorUnits: 150_000, currencyCode: 'PKR' },
    { amountMinorUnits: 7_000, currencyCode: 'USD' },
  ],
  alerts: [
    {
      rule: 'critical_safety_reports',
      severity: 'critical',
      count: 2,
      message: '2 critical safety reports need attention.',
      linkTo: '/admin/operations/safety',
    },
  ],
  generatedAt: '2026-09-25T10:00:00.000Z',
};

type Reply = { ok: boolean; status: number; body: unknown } | 'pending' | 'network-error';

/** A fetch stub answering each call with the next reply (the last one repeats). */
function stubFetch(...replies: Reply[]) {
  const fetchMock = vi.fn().mockImplementation(() => {
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    if (reply === 'pending') return new Promise(() => {});
    if (reply === 'network-error') return Promise.reject(new TypeError('network'));
    return Promise.resolve({ ok: reply.ok, status: reply.status, json: async () => reply.body });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ok = (data: unknown): Reply => ({ ok: true, status: 200, body: { data } });

let hidden = false;

async function tick(ms = ADMIN_DASHBOARD_POLL_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe('AdminOverviewPage (spec 037 §5, AC-1)', () => {
  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows a skeleton per widget while loading', () => {
    stubFetch('pending');
    render(<AdminOverviewPage />);
    expect(screen.getByRole('region', { name: 'Marketplace health' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('region', { name: 'Alerts' })).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the live figures, per-currency revenue, the "as of" time and the alert with its link', async () => {
    stubFetch(ok(OVERVIEW));
    render(<AdminOverviewPage />);
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('56')).toBeInTheDocument();
    expect(screen.getByText('Captured today (UTC)')).toBeInTheDocument();
    expect(screen.getByText('PKR 1,500.00')).toBeInTheDocument();
    expect(screen.getByText('$70.00')).toBeInTheDocument();
    expect(screen.getByText(/^As of /)).toHaveTextContent(new Date(OVERVIEW.generatedAt).toLocaleString());
    expect(screen.getByText('2 critical safety reports need attention.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/admin/operations/safety');
    expect(screen.getByRole('link', { name: 'Marketplace configuration' })).toHaveAttribute('href', '/admin/marketplace/config');
  });

  it('empty states: nothing captured and no alerts', async () => {
    stubFetch(ok({ ...OVERVIEW, revenueToday: [], alerts: [] }));
    render(<AdminOverviewPage />);
    expect(await screen.findByText('Nothing captured today')).toBeInTheDocument();
    expect(screen.getByText('No alerts')).toBeInTheDocument();
  });

  it('a first-load error shows ErrorState, and Try again recovers', async () => {
    stubFetch({ ok: false, status: 500, body: { code: 'INTERNAL_ERROR', message: 'Database unavailable' } }, ok(OVERVIEW));
    render(<AdminOverviewPage />);
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1,234')).toBeInTheDocument();
  });

  it('a network failure on first load is an error, not a blank page', async () => {
    stubFetch('network-error');
    render(<AdminOverviewPage />);
    expect(await screen.findByText('This information could not be loaded.')).toBeInTheDocument();
  });

  it('a non-admin (403) sees an access notice, never figures', async () => {
    stubFetch({ ok: false, status: 403, body: { code: 'FORBIDDEN', message: 'no' } });
    render(<AdminOverviewPage />);
    expect(await screen.findByText('Administrator access required')).toBeInTheDocument();
    expect(screen.queryByText('Active requests')).not.toBeInTheDocument();
  });

  it('polls every 10 seconds and shows the refreshed figures', async () => {
    const fetchMock = stubFetch(ok(OVERVIEW), ok({ ...OVERVIEW, activeRequests: 2_000, generatedAt: '2026-09-25T10:00:10.000Z' }));
    render(<AdminOverviewPage />);
    await screen.findByText('1,234');
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/admin/overview', { credentials: 'same-origin' });
    expect(await screen.findByText('2,000')).toBeInTheDocument();
  });

  it('pauses while the tab is hidden and refreshes immediately when it becomes visible', async () => {
    const fetchMock = stubFetch(ok(OVERVIEW));
    render(<AdminOverviewPage />);
    await screen.findByText('1,234');
    hidden = true;
    await tick();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never overlaps requests: a tick is skipped while the previous poll is in flight', async () => {
    const fetchMock = stubFetch(ok(OVERVIEW), 'pending');
    render(<AdminOverviewPage />);
    await screen.findByText('1,234');
    await tick();
    await tick();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed poll keeps the last good data and its original "as of", with a notice', async () => {
    stubFetch(ok(OVERVIEW), { ok: false, status: 503, body: { code: 'X', message: 'down' } });
    render(<AdminOverviewPage />);
    await screen.findByText('1,234');
    await tick();
    expect(await screen.findByText("Couldn't refresh")).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText(/^As of /)).toHaveTextContent(new Date(OVERVIEW.generatedAt).toLocaleString());
  });

  it('a network error during a poll is handled the same way', async () => {
    stubFetch(ok(OVERVIEW), 'network-error');
    render(<AdminOverviewPage />);
    await screen.findByText('1,234');
    await tick();
    expect(await screen.findByText("Couldn't refresh")).toBeInTheDocument();
  });

  it('stops polling and listening on unmount', async () => {
    const removeListener = vi.spyOn(document, 'removeEventListener');
    const fetchMock = stubFetch(ok(OVERVIEW));
    const { unmount } = render(<AdminOverviewPage />);
    await screen.findByText('1,234');
    unmount();
    await tick(ADMIN_DASHBOARD_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
