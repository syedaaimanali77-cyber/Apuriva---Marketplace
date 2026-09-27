// @vitest-environment jsdom
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountPage from '../page';
import { AccountMenu } from './AccountMenu';
import { useAccountUser } from './useAccountUser';

/**
 * A request that never completes (dev-server recompile, dropped connection) makes `fetch` REJECT
 * with `TypeError: Failed to fetch`. It must resolve into the `unavailable` state with a retry —
 * never an unhandled rejection (which Vitest itself would fail the run on), and never the
 * signed-out screen. Real HTTP answers keep their existing meaning.
 */
const USER = { id: 'user-1', hasCustomerProfile: true, hasProviderProfile: false, activeMode: 'customer' as const, isAdmin: false };

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const httpError = (status: number, body: unknown) => Promise.resolve({ ok: false, status, json: async () => body });
const networkFailure = () => Promise.reject(new TypeError('Failed to fetch'));

describe('useAccountUser — network failures (Failed to fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a failed /users/me request becomes `unavailable`, not an unhandled rejection and not `anonymous`', async () => {
    vi.stubGlobal('fetch', vi.fn(networkFailure));
    const { result } = renderHook(() => useAccountUser());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(result.current.user).toBeNull();
  });

  it('retry() re-requests /users/me and recovers to `ready`', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(networkFailure).mockImplementation(() => ok({ data: USER }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAccountUser());
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.user).toEqual(USER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a real 401 still means signed out (`anonymous`) — HTTP errors are not disguised', async () => {
    vi.stubGlobal('fetch', vi.fn(() => httpError(401, { code: 'UNAUTHENTICATED', message: 'No valid session.' })));
    const { result } = renderHook(() => useAccountUser());
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
  });

  it('a network failure during a mode switch shows an error and leaves the user unchanged', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => ok({ data: USER })).mockImplementation(networkFailure);
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAccountUser());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let switched = true;
    await act(async () => {
      switched = await result.current.switchMode('provider');
    });
    expect(switched).toBe(false);
    expect(result.current.error).toBe('We could not reach the server.');
    expect(result.current.user).toEqual(USER);
    expect(result.current.status).toBe('ready');
  });
});

describe('Account page and header menu — unreachable /users/me', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the Account page shows an ErrorState with Try again (not the guest screen), and Try again recovers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(networkFailure).mockImplementation(() => ok({ data: USER })));
    render(<AccountPage />);
    expect(await screen.findByText('We could not reach the server.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Customer Mode' })).toBeInTheDocument();
  });

  it('the header AccountMenu renders nothing while /users/me is unreachable', async () => {
    const fetchMock = vi.fn(networkFailure);
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<AccountMenu />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
