// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminOperationsPage from './page';
import { ADMIN_DASHBOARD_POLL_MS } from '../_components/usePolledResource';
import type { OperationsQueueItemDto } from '@/lib/types/admin-dashboard';

const ITEMS: OperationsQueueItemDto[] = [
  {
    type: 'safety_report',
    id: 's1',
    status: 'under_review',
    priority: 'critical',
    createdAt: '2026-09-25T08:00:00.000Z',
    linkTo: '/admin/operations/safety',
  },
  {
    type: 'support_ticket',
    id: 't1',
    status: 'awaiting_user',
    priority: 'high',
    createdAt: '2026-09-25T09:00:00.000Z',
    linkTo: '/admin/operations/support/t1',
  },
  { type: 'dispute', id: 'd1', status: 'open', priority: null, createdAt: '2026-09-24T09:00:00.000Z', linkTo: '/admin/operations/disputes/d1' },
];

function page(items: OperationsQueueItemDto[], total: number, offset: number, nextOffset: number | null) {
  return { ok: true, status: 200, json: async () => ({ data: items, page: { limit: 20, offset, total, nextOffset } }) };
}

describe('AdminOperationsPage (spec 037 §5, AC-2)', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows a skeleton while the queue loads', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const { container } = render(<AdminOperationsPage />);
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    expect(container.querySelector('table')).toBeNull();
  });

  it('lists each item with its type, status, priority and a link to its existing workflow', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(ITEMS, 3, 0, null)));
    render(<AdminOperationsPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Safety report')).toBeInTheDocument();
    expect(within(table).getByText('awaiting user')).toBeInTheDocument();
    expect(within(table).getByText('critical')).toBeInTheDocument();
    expect(within(table).getByText('—')).toBeInTheDocument(); // the dispute has no priority
    const links = within(table).getAllByRole('link', { name: 'Open' }).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/admin/operations/safety', '/admin/operations/support/t1', '/admin/operations/disputes/d1']);
    // The existing workspace links stay.
    expect(screen.getByRole('link', { name: 'Pending approvals' })).toHaveAttribute('href', '/admin/approvals');
  });

  it('empty state: "No items need attention"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page([], 0, 0, null)));
    render(<AdminOperationsPage />);
    expect(await screen.findByText('No items need attention')).toBeInTheDocument();
  });

  it('pages with limit/offset: Next requests offset 20, Previous is disabled on the first page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(ITEMS, 25, 0, 20))
      .mockResolvedValue(page(ITEMS.slice(0, 1), 25, 20, null));
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminOperationsPage />);
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/admin/operations/queue?limit=20&offset=20', { credentials: 'same-origin' });
    expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/admin/operations/queue?limit=20&offset=0', { credentials: 'same-origin' });
  });

  it('error state with retry, and a 403 access notice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: 'Queue unavailable' }) }));
    const first = render(<AdminOperationsPage />);
    expect(await screen.findByText('Queue unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    first.unmount();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ code: 'FORBIDDEN' }) }));
    render(<AdminOperationsPage />);
    expect(await screen.findByText('Administrator access required')).toBeInTheDocument();
  });

  it('polls the current page every 10 seconds and keeps the last queue if a poll fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page(ITEMS, 3, 0, null))
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminOperationsPage />);
    await screen.findByRole('table');
    await act(async () => {
      vi.advanceTimersByTime(ADMIN_DASHBOARD_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Couldn't refresh")).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });
});
