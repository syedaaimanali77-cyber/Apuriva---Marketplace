// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminMarketplaceConfigPage from './page';
import { ADMIN_DASHBOARD_POLL_MS } from '../../_components/usePolledResource';
import type { MarketplaceConfigDto } from '@/lib/types/admin-dashboard';

const CONFIG: MarketplaceConfigDto = {
  matching: {
    platformDefaultWeights: { serviceMatch: 25, availability: 20 },
    serviceOverrideCount: 4,
    linkTo: '/admin/marketplace/matching',
  },
  cancellation: {
    activePlatformPolicy: { policyId: 'p1', effectiveFrom: '2026-09-01T00:00:00.000Z', config: { tiers: [] } },
    linkTo: null,
  },
  generatedAt: '2026-09-25T10:00:00.000Z',
};

function respond(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body });
}

describe('AdminMarketplaceConfigPage (spec 037 §3/§5, AC-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is a read-only overview: values, the link to the matching editor, and no form or button', async () => {
    vi.stubGlobal('fetch', respond({ data: CONFIG }));
    const { container } = render(<AdminMarketplaceConfigPage />);

    const matching = await screen.findByRole('region', { name: 'Matching weights' });
    expect(within(matching).getByText('serviceMatch')).toBeInTheDocument();
    expect(within(matching).getByText('25')).toBeInTheDocument();
    expect(within(matching).getByText(/Services with their own weights: 4/)).toBeInTheDocument();
    expect(within(matching).getByRole('link', { name: 'Manage matching weights' })).toHaveAttribute('href', '/admin/marketplace/matching');

    const cancellation = screen.getByRole('region', { name: 'Cancellation policy' });
    expect(within(cancellation).getByText(/Platform policy in effect since/)).toBeInTheDocument();
    expect(within(cancellation).getByText('Managed separately.')).toBeInTheDocument();
    expect(within(cancellation).queryByRole('link')).toBeNull(); // no editor page exists (spec 041)

    expect(container.querySelector('form, input, textarea, select')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/^As of /)).toBeInTheDocument();
  });

  it('shows only the sections the server returned (matching only), and the no-policy text', async () => {
    vi.stubGlobal('fetch', respond({ data: { matching: CONFIG.matching, generatedAt: CONFIG.generatedAt } }));
    const first = render(<AdminMarketplaceConfigPage />);
    await screen.findByRole('region', { name: 'Matching weights' });
    expect(screen.queryByRole('region', { name: 'Cancellation policy' })).toBeNull();
    first.unmount();

    vi.stubGlobal(
      'fetch',
      respond({ data: { cancellation: { activePlatformPolicy: null, linkTo: null }, generatedAt: CONFIG.generatedAt } }),
    );
    render(<AdminMarketplaceConfigPage />);
    expect(await screen.findByText('No platform cancellation policy is published.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Matching weights' })).toBeNull();
  });

  it('403 shows the permission notice; an error shows ErrorState with retry', async () => {
    vi.stubGlobal('fetch', respond({ code: 'FORBIDDEN' }, 403));
    const first = render(<AdminMarketplaceConfigPage />);
    expect(await screen.findByText('Configuration permission required')).toBeInTheDocument();
    first.unmount();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ message: 'Config unavailable' }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: CONFIG }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminMarketplaceConfigPage />);
    expect(await screen.findByText('Config unavailable')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Matching weights' })).toBeInTheDocument();
  });

  it('loads once and never polls', async () => {
    const fetchMock = respond({ data: CONFIG });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminMarketplaceConfigPage />);
    await screen.findByRole('region', { name: 'Matching weights' });
    await act(async () => {
      vi.advanceTimersByTime(ADMIN_DASHBOARD_POLL_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/admin/marketplace/config', { credentials: 'same-origin' });
  });
});
