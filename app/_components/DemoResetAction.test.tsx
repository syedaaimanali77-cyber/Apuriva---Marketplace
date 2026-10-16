// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import AccountPage from '@/app/account/page';
import { DemoResetAction } from './DemoResetAction';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/account',
}));

function json(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

const ME = { id: 'u', hasCustomerProfile: true, hasProviderProfile: false, activeMode: 'customer', isAdmin: false, locale: null };

/** Spec 045 §5 (X-4, AC-5) — "Reset demo" on /account. */
describe('DemoResetAction', () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('/account offers it to a demo user only (UserDto.isDemo, X-7)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(true, { data: { ...ME, isDemo: true } })));
    const { unmount } = render(<AccountPage />);
    expect(await screen.findByRole('button', { name: en.demo.reset.button })).toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(true, { data: { ...ME, isDemo: false } })));
    render(<AccountPage />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: en.demo.reset.button })).not.toBeInTheDocument();
  });

  it('confirms first, then calls D2 with the CSRF header and lands the customer persona on the home page', async () => {
    document.cookie = 'apuriva_csrf=csrf-token';
    const fetchMock = vi.fn().mockResolvedValue(json(true, { data: { userId: 'new', sessionId: 's', mfaRequired: false, roles: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<DemoResetAction provider={false} />);

    await user.click(screen.getByRole('button', { name: en.demo.reset.button }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(en.demo.reset.confirmDescription);

    const dialogButtons = screen.getAllByRole('button', { name: en.demo.reset.button });
    await user.click(dialogButtons[dialogButtons.length - 1]!);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/demo/reset',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'x-csrf-token': 'csrf-token' }) }),
    );
  });

  it('a provider persona is switched back to provider mode and lands on the dashboard', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(true, { data: { userId: 'new', sessionId: 's', mfaRequired: false, roles: [] } }))
      .mockResolvedValueOnce(json(true, { data: { activeMode: 'provider' } }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<DemoResetAction provider />);
    await user.click(screen.getByRole('button', { name: en.demo.reset.button }));
    const dialogButtons = screen.getAllByRole('button', { name: en.demo.reset.button });
    await user.click(dialogButtons[dialogButtons.length - 1]!);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/provider/dashboard'));
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/users/me/active-mode');
  });

  it('a failed reset shows the error and leaves the visitor where they are', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(false, { code: 'INTERNAL_ERROR', message: 'boom' })));
    const user = userEvent.setup();
    render(<DemoResetAction provider={false} />);
    await user.click(screen.getByRole('button', { name: en.demo.reset.button }));
    const dialogButtons = screen.getAllByRole('button', { name: en.demo.reset.button });
    await user.click(dialogButtons[dialogButtons.length - 1]!);
    expect(await screen.findByText(en.demo.reset.error)).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });
});
