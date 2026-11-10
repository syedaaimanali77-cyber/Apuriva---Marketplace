// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NotificationsPage from './page';
import type { NotificationDto, NotificationPreferencesDto } from '@/lib/types/notifications';

const UNREAD: NotificationDto = {
  id: 'n1',
  category: 'payments',
  type: 'refund_completed',
  title: 'Refund completed',
  body: 'Your refund has been completed and is on its way back to your payment method.',
  readAt: null,
  createdAt: '2026-09-17T10:00:00.000Z',
};
const READ: NotificationDto = { ...UNREAD, id: 'n2', title: 'Payout sent', type: 'payout_paid', readAt: '2026-09-17T11:00:00.000Z' };

const channels = (email: boolean) => ({ email, push: false, sms: false });
const PREFS: NotificationPreferencesDto = {
  categories: {
    booking: channels(false),
    messages: channels(false),
    payments: channels(true),
    security: channels(true),
    promotions: channels(false),
    provider_activity: channels(false),
    operational: channels(true),
  },
  nonOverridableCategories: ['security', 'payments', 'operational'],
  marketingConsentAt: null,
  version: 0,
};

type Handler = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;

function stubFetch(handler: Handler) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const custom = handler(url, init);
    const response =
      custom ??
      (url.startsWith('/api/v1/users/me/notifications?')
        ? { status: 200, body: { data: [UNREAD, READ], page: { limit: 20, offset: 0, total: 2, nextOffset: null } } }
        : url === '/api/v1/users/me/notification-preferences' && method === 'GET'
          ? { status: 200, body: { data: PREFS } }
          : { status: 500, body: { code: 'INTERNAL_ERROR', message: 'unexpected' } });
    return { ok: response.status < 400, status: response.status, json: async () => response.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('NotificationsPage (spec 026 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state, then the list', async () => {
    stubFetch(() => undefined);
    render(<NotificationsPage />);
    expect(screen.getByTestId('notifications-loading')).toBeInTheDocument();
    expect(await screen.findByText('Refund completed')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    stubFetch((url) =>
      url.startsWith('/api/v1/users/me/notifications?') ? { status: 200, body: { data: [], page: { nextOffset: null } } } : undefined,
    );
    render(<NotificationsPage />);
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    let fail = true;
    stubFetch((url) => {
      if (!url.startsWith('/api/v1/users/me/notifications?')) return undefined;
      if (fail) return { status: 500, body: { code: 'INTERNAL_ERROR', message: 'x' } };
      return { status: 200, body: { data: [UNREAD], page: { nextOffset: null } } };
    });
    render(<NotificationsPage />);
    expect(await screen.findByText("We couldn't load your notifications")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Refund completed')).toBeInTheDocument();
  });

  it('unread is not conveyed by colour alone, and rendering does NOT mark read', async () => {
    const calls = stubFetch(() => undefined);
    render(<NotificationsPage />);
    const unreadTitle = await screen.findByText('Refund completed');
    // A text marker, not just styling.
    expect(within(unreadTitle).getByText('Unread')).toBeInTheDocument();
    expect(within(screen.getByText('Payout sent')).queryByText('Unread')).not.toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url.includes('notification-preferences'))).toBe(true));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('marks one read explicitly, keeping the row in place', async () => {
    const calls = stubFetch((url, init) =>
      url === '/api/v1/users/me/notifications/n1/read' && init?.method === 'POST'
        ? { status: 200, body: { data: { ...UNREAD, readAt: '2026-09-17T12:00:00.000Z' } } }
        : undefined,
    );
    render(<NotificationsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark "Refund completed" as read' }));
    await waitFor(() => expect(within(screen.getByText('Refund completed')).queryByText('Unread')).not.toBeInTheDocument());
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Refund completed'),
      expect.stringContaining('Payout sent'),
    ]);
    expect(calls.find((c) => c.method === 'POST')!.url).toBe('/api/v1/users/me/notifications/n1/read');
  });

  it('a failed mark-read restores the unread state and says so', async () => {
    stubFetch((url, init) =>
      url.endsWith('/read') && init?.method === 'POST' ? { status: 500, body: { code: 'INTERNAL_ERROR', message: 'x' } } : undefined,
    );
    render(<NotificationsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Mark "Refund completed" as read' }));
    expect(await screen.findByText(/couldn't mark that notification as read/)).toBeInTheDocument();
    expect(within(screen.getByText('Refund completed')).getByText('Unread')).toBeInTheDocument();
  });

  it('locked categories show their reason instead of toggles', async () => {
    stubFetch(() => undefined);
    render(<NotificationsPage />);
    expect(await screen.findByText(/Security notifications can't be turned off/)).toBeInTheDocument();
    expect(screen.getByText(/Payment notifications can't be turned off/)).toBeInTheDocument();
    expect(screen.getByText(/account and service notices can't be turned off/)).toBeInTheDocument();
    const security = screen.getByRole('group', { name: 'Security' });
    expect(within(security).queryAllByRole('switch')).toEqual([]);
    const booking = screen.getByRole('group', { name: 'Bookings' });
    expect(within(booking).getAllByRole('switch')).toHaveLength(3);
  });

  it('marketing consent is a separate explicit control that states both are required', async () => {
    stubFetch(() => undefined);
    render(<NotificationsPage />);
    const consent = await screen.findByRole('switch', { name: /I agree to receive promotional notifications/ });
    expect(consent).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/only sent if you also give marketing consent below — both are required/)).toBeInTheDocument();
    const promotions = screen.getByRole('group', { name: 'Promotions' });
    expect(within(promotions).queryByRole('switch', { name: /I agree/ })).not.toBeInTheDocument();
  });

  it('a failed save reverts the toggle and tells the user why', async () => {
    const calls = stubFetch((url, init) =>
      url === '/api/v1/users/me/notification-preferences' && init?.method === 'PATCH'
        ? { status: 409, body: { code: 'CONFLICT', message: 'changed' } }
        : undefined,
    );
    render(<NotificationsPage />);
    const booking = await screen.findByRole('group', { name: 'Bookings' });
    const emailSwitch = within(booking).getAllByRole('switch')[1]!;
    expect(emailSwitch).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(emailSwitch);
    expect(await screen.findByText(/Bookings Email was not changed\. Your preferences were changed elsewhere/)).toBeInTheDocument();
    const patchCall = calls.find((c) => c.method === 'PATCH')!;
    expect(patchCall.body).toEqual({ categories: { booking: { email: true } }, version: 0 });
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Bookings' })).getAllByRole('switch')[1]).toHaveAttribute('aria-checked', 'false'));
  });
});
