// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu } from './AccountMenu';

function jsonResponse(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

const BASE_USER = {
  id: 'user-1',
  hasCustomerProfile: true,
  hasProviderProfile: false,
  activeMode: 'customer' as const,
  isAdmin: false,
};

describe('AccountMenu (spec 006 §5 UI states)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing for a signed-out visitor (401 from /users/me)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(false, { status: 401, code: 'UNAUTHENTICATED', message: 'No valid session.' })),
    );
    const { container } = render(<AccountMenu />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows a loading indicator while profile data resolves', async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(new Promise((resolve) => (resolveFetch = resolve))),
    );
    render(<AccountMenu />);
    expect(screen.getByRole('status', { name: 'Loading account' })).toBeInTheDocument();
    resolveFetch(jsonResponse(true, { data: BASE_USER }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Loading account' })).not.toBeInTheDocument());
  });

  it('Empty state: offers "Become a Provider" when no ProviderProfile exists, and does not switch mode on success', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(true, { data: BASE_USER }));
      if (init.method === 'POST' && url.includes('provider-profile')) {
        return Promise.resolve(jsonResponse(true, { data: { id: 'pp-1', userId: 'user-1', businessName: null, lifecycleStatus: 'draft' } }));
      }
      return Promise.resolve(jsonResponse(true, { data: BASE_USER }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountMenu />);
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menuitem', { name: 'Become a Provider' })).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: 'Become a Provider' }));

    expect(await screen.findByRole('menuitem', { name: 'Switch to provider mode' })).toBeInTheDocument();
    // AC-1: becoming a provider never switches the active mode.
    expect(screen.getByRole('menuitem', { name: 'Currently in customer mode' })).toBeInTheDocument();
  });

  it('Success state: switching mode updates the indicator immediately on confirmation and announces it', async () => {
    const user = userEvent.setup();
    const withProvider = { ...BASE_USER, hasProviderProfile: true };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(true, { data: withProvider }));
      if (init.method === 'PATCH') {
        return Promise.resolve(jsonResponse(true, { data: { ...withProvider, activeMode: 'provider' } }));
      }
      return Promise.resolve(jsonResponse(true, { data: withProvider }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountMenu />);
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Switch to provider mode' }));

    await waitFor(() => expect(screen.getByText('Switched to provider mode.')).toBeInTheDocument());
  });

  it('Error state: a failed switch shows an inline error and leaves the mode unchanged', async () => {
    const user = userEvent.setup();
    const withProvider = { ...BASE_USER, hasProviderProfile: true };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(true, { data: withProvider }));
      if (init.method === 'PATCH') {
        return Promise.resolve(jsonResponse(false, { status: 422, code: 'PROFILE_NOT_FOUND_FOR_MODE', message: 'No provider profile exists for this account.' }));
      }
      return Promise.resolve(jsonResponse(true, { data: withProvider }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountMenu />);
    await user.click(await screen.findByRole('button', { name: 'Account menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Switch to provider mode' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No provider profile exists for this account.');
    expect(screen.getByRole('menuitem', { name: 'Currently in customer mode' })).toBeInTheDocument();
  });

  it('is keyboard operable: Escape closes the menu and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: BASE_USER })));

    render(<AccountMenu />);
    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
