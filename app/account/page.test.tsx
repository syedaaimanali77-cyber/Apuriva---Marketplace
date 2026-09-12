// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountPage from './page';

function jsonResponse(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

const CUSTOMER_ONLY = {
  id: 'user-1',
  hasCustomerProfile: true,
  hasProviderProfile: false,
  activeMode: 'customer' as const,
  isAdmin: false,
};

const DUAL_CUSTOMER_ACTIVE = { ...CUSTOMER_ONLY, hasProviderProfile: true };
const DUAL_PROVIDER_ACTIVE = { ...DUAL_CUSTOMER_ACTIVE, activeMode: 'provider' as const };

describe('AccountPage (spec 006/014 — guest entry point and mode switching)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('guest: shows Log in and Create account, linked to the existing auth routes, no mode UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(false, { status: 401, code: 'UNAUTHENTICATED', message: 'No valid session.' })),
    );
    render(<AccountPage />);

    const login = await screen.findByRole('link', { name: 'Log in' });
    const register = await screen.findByRole('link', { name: 'Create an account' });
    expect(login).toHaveAttribute('href', '/login');
    expect(register).toHaveAttribute('href', '/register');
    expect(screen.getByRole('heading', { name: 'Welcome to APURIVA' })).toBeInTheDocument();
    expect(screen.queryByText(/Customer Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();
  });

  it('customer-only user: customer mode shown as active, and a "Become a Provider" prompt (no provider switch)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: CUSTOMER_ONLY })));
    render(<AccountPage />);

    expect(await screen.findByRole('heading', { name: 'Customer Mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Become a Provider' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to/ })).not.toBeInTheDocument();
  });

  it('customer-only user: "Become a Provider" calls the spec 006 API, keeps customer mode, and offers the switch', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(true, { data: CUSTOMER_ONLY }));
      if (init.method === 'POST' && url.includes('provider-profile')) {
        return Promise.resolve(jsonResponse(true, { data: { id: 'pp-1', userId: 'user-1', businessName: null, lifecycleStatus: 'draft' } }));
      }
      return Promise.resolve(jsonResponse(true, { data: CUSTOMER_ONLY }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Become a Provider' }));

    expect(await screen.findByRole('button', { name: 'Switch to Service Provider Mode' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/users/me/provider-profile'),
      expect.objectContaining({ method: 'POST' }),
    );
    // AC-1: becoming a provider never switches the active mode.
    expect(screen.getByRole('heading', { name: 'Customer Mode' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Become a Provider' })).not.toBeInTheDocument();
  });

  it('dual-capability user in customer mode: switching to provider mode calls the spec 006 API and updates the indicator', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(true, { data: DUAL_CUSTOMER_ACTIVE }));
      if (init.method === 'PATCH' && url.includes('active-mode')) {
        return Promise.resolve(jsonResponse(true, { data: DUAL_PROVIDER_ACTIVE }));
      }
      return Promise.resolve(jsonResponse(true, { data: DUAL_CUSTOMER_ACTIVE }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountPage />);
    expect(await screen.findByRole('heading', { name: 'Customer Mode' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch to Service Provider Mode' }));

    await waitFor(() => expect(screen.getByText('Switched to provider mode.')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Service Provider Mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Customer Mode' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/users/me/active-mode'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('dual-capability user in provider mode: switching back to customer mode works', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(true, { data: DUAL_PROVIDER_ACTIVE }));
      if (init.method === 'PATCH' && url.includes('active-mode')) {
        return Promise.resolve(jsonResponse(true, { data: DUAL_CUSTOMER_ACTIVE }));
      }
      return Promise.resolve(jsonResponse(true, { data: DUAL_PROVIDER_ACTIVE }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountPage />);
    expect(await screen.findByRole('heading', { name: 'Service Provider Mode' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch to Customer Mode' }));

    await waitFor(() => expect(screen.getByText('Switched to customer mode.')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Customer Mode' })).toBeInTheDocument();
  });

  it('a failed switch shows an inline error and leaves the active mode unchanged', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(true, { data: DUAL_CUSTOMER_ACTIVE }));
      if (init.method === 'PATCH') {
        return Promise.resolve(jsonResponse(false, { status: 422, code: 'PROFILE_NOT_FOUND_FOR_MODE', message: 'No provider profile exists for this account.' }));
      }
      return Promise.resolve(jsonResponse(true, { data: DUAL_CUSTOMER_ACTIVE }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Switch to Service Provider Mode' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No provider profile exists for this account.');
    expect(screen.getByRole('heading', { name: 'Customer Mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Service Provider Mode' })).toBeInTheDocument();
  });

  it('authenticated user sees links to the existing Addresses and Privacy & security settings', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: CUSTOMER_ONLY })));
    render(<AccountPage />);

    expect(await screen.findByRole('link', { name: /Addresses/ })).toHaveAttribute('href', '/account/addresses');
    expect(screen.getByRole('link', { name: /Privacy & Security/ })).toHaveAttribute('href', '/account/privacy-security');
    // No page exists for these yet — listed as unavailable, never as links that would 404.
    expect(screen.queryByRole('link', { name: /Profile/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Preferences/ })).not.toBeInTheDocument();
  });

  it('never renders placeholder identity data (the /users/me payload has no name or email)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: CUSTOMER_ONLY })));
    render(<AccountPage />);

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(screen.queryByText(/user-1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Administrator/)).not.toBeInTheDocument();
  });

  it('logging out calls the existing spec 005 logout endpoint and returns to the guest state', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(jsonResponse(true, { data: CUSTOMER_ONLY }));
      if (init.method === 'POST' && url.includes('/auth/logout')) return Promise.resolve(jsonResponse(true, {}));
      return Promise.resolve(jsonResponse(true, { data: CUSTOMER_ONLY }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountPage />);
    await user.click(await screen.findByRole('button', { name: 'Log out' }));

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/v1/auth/logout'), expect.objectContaining({ method: 'POST' }));
    expect(await screen.findByRole('link', { name: 'Log in' })).toBeInTheDocument();
  });
});
