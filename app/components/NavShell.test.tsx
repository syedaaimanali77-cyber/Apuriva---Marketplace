// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavShell } from './NavShell';

const { getPathname, setPathname } = vi.hoisted(() => {
  let pathname = '/';
  return {
    getPathname: () => pathname,
    setPathname: (next: string) => {
      pathname = next;
    },
  };
});

vi.mock('next/navigation', () => ({
  usePathname: () => getPathname(),
}));

function jsonResponse(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

const CUSTOMER_USER = { id: 'u1', hasCustomerProfile: true, hasProviderProfile: false, activeMode: 'customer' as const, isAdmin: false };
const PROVIDER_USER = { ...CUSTOMER_USER, hasProviderProfile: true, activeMode: 'provider' as const };

async function expectExactNavLabels(labels: string[]) {
  await waitFor(() => expect(screen.getAllByRole('link', { name: labels[0] }).length).toBeGreaterThan(0));
  for (const label of labels) {
    expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
  }
  // Both BottomTabBar and SideNav render in the DOM (CSS media queries pick one visually); every
  // link's text must be one of the expected labels — nothing extra sneaks in. Whitespace is
  // normalized first: the icon SVGs' path data contains literal whitespace between sibling
  // <path> elements, which is real (if invisible) text content unrelated to the label itself.
  const allLinks = screen.getAllByRole('link');
  for (const link of allLinks) {
    expect(labels).toContain(link.textContent?.replace(/\s+/g, ''));
  }
}

describe('NavShell (spec 014 §2 AC-4/AC-5/AC-6/AC-8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setPathname('/');
  });

  it('AC-4: customer mode shows exactly Home, Explore, Requests, Bookings, Account', async () => {
    setPathname('/');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: CUSTOMER_USER })));
    render(<NavShell />);
    await expectExactNavLabels(['Home', 'Explore', 'Requests', 'Bookings', 'Account']);
  });

  it('a guest (401 from /users/me) also gets the customer item set', async () => {
    setPathname('/');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(false, { status: 401, code: 'UNAUTHENTICATED', message: 'No valid session.' })));
    render(<NavShell />);
    await expectExactNavLabels(['Home', 'Explore', 'Requests', 'Bookings', 'Account']);
  });

  it('AC-5: provider mode shows exactly Dashboard, Requests, Schedule, Earnings, Account', async () => {
    setPathname('/provider/dashboard');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: PROVIDER_USER })));
    render(<NavShell />);
    await expectExactNavLabels(['Dashboard', 'Requests', 'Schedule', 'Earnings', 'Account']);
  });

  it('AC-6: admin (any /admin route) shows exactly Overview, Operations, Users, Marketplace, Analytics, Settings', async () => {
    setPathname('/admin/roles');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: { ...CUSTOMER_USER, isAdmin: true } })));
    render(<NavShell />);
    await expectExactNavLabels(['Overview', 'Operations', 'Users', 'Marketplace', 'Analytics', 'Settings']);
  });

  it('AC-8: no persona item set ever includes an AI/Assistant tab', async () => {
    for (const [pathname, user] of [
      ['/', CUSTOMER_USER],
      ['/provider/dashboard', PROVIDER_USER],
      ['/admin', { ...CUSTOMER_USER, isAdmin: true }],
    ] as const) {
      setPathname(pathname);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: user })));
      const { unmount } = render(<NavShell />);
      await waitFor(() => expect(screen.getAllByRole('link').length).toBeGreaterThan(0));
      for (const link of screen.getAllByRole('link')) {
        expect(link.textContent ?? '').not.toMatch(/ai|assistant/i);
      }
      unmount();
    }
  });

  it('renders nothing on the headerless auth routes (login/register)', () => {
    setPathname('/login');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: CUSTOMER_USER })));
    const { container } = render(<NavShell />);
    expect(container).toBeEmptyDOMElement();
  });

  it('marks the current page as aria-current="page"', async () => {
    setPathname('/explore');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: CUSTOMER_USER })));
    render(<NavShell />);
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Explore', current: 'page' }).length).toBeGreaterThan(0));
  });
});
