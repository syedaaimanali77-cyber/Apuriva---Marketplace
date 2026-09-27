'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, mutateHeaders, type ApiResult } from '@/app/requests/api-client';
import type { ActiveMode, UserDto } from '@/lib/types/users';

/**
 * The repository's shared client fetch helper (`app/requests/api-client.ts`): it turns a request
 * that never completed (dev-server recompile, dropped connection, offline) into
 * `{ ok: false, error: { code: 'NETWORK_ERROR' } }` instead of an unhandled `Failed to fetch`,
 * while real HTTP errors keep their own status body.
 */
function mutateJson<T>(url: string, method: 'POST' | 'PATCH', body?: unknown): Promise<ApiResult<T>> {
  return apiFetch<T>(url, {
    method,
    headers: mutateHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/**
 * `unavailable` — `/users/me` could not be REACHED (a network failure, not an HTTP answer). It is
 * deliberately not `anonymous`: a momentary blip must never present a signed-in user with the
 * signed-out screen. Callers offer `retry()`.
 */
export type AccountLoadStatus = 'loading' | 'anonymous' | 'unavailable' | 'ready';

/** Dispatched after a confirmed mode switch or provider-profile creation, so any other mounted
 * consumer of `/users/me` (namely NavShell's persona-aware navigation) can refresh immediately
 * instead of waiting for the next route change or window focus. */
export const ACCOUNT_UPDATED_EVENT = 'apuriva:account-updated';

/**
 * Spec 006 (identity/active-mode) and spec 005 (session logout) — the single client-side source
 * of identity state and its mutations (`PATCH /users/me/active-mode`, `POST
 * /users/me/provider-profile`, `POST /auth/logout`), backed by `GET /users/me`. Extracted so
 * `AccountMenu` (the header dropdown) and the `/account` page itself are two views onto the same
 * session state rather than two separate implementations of spec 006's mode switching — neither
 * the API calls nor the switch/become-provider semantics are duplicated.
 */
export function useAccountUser() {
  const [status, setStatus] = useState<AccountLoadStatus>('loading');
  const [user, setUser] = useState<UserDto | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const refresh = useCallback(() => {
    let cancelled = false;
    void apiFetch<UserDto>('/api/v1/users/me').then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setUser(result.data ?? null);
        setStatus('ready');
      } else if (result.error?.code === 'NETWORK_ERROR') {
        // Keep whatever was already known; only the first load has nothing to show.
        setStatus((prev) => (prev === 'ready' ? prev : 'unavailable'));
      } else {
        setUser(null);
        setStatus('anonymous');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => refresh(), [refresh]);

  /** Re-requests `/users/me` — the Account page's "Try again" after a network failure. */
  const retry = useCallback(() => {
    setStatus((prev) => (prev === 'unavailable' ? 'loading' : prev));
    refresh();
  }, [refresh]);

  async function becomeProvider(): Promise<boolean> {
    setError(null);
    setPending(true);
    const result = await mutateJson('/api/v1/users/me/provider-profile', 'POST');
    setPending(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Couldn't create your provider profile. Try again.");
      return false;
    }
    setUser((prev) => (prev ? { ...prev, hasProviderProfile: true } : prev));
    setAnnouncement('Provider profile created. You can now switch to provider mode.');
    window.dispatchEvent(new Event(ACCOUNT_UPDATED_EVENT));
    return true;
  }

  async function switchMode(mode: ActiveMode): Promise<boolean> {
    if (!user || user.activeMode === mode) return false;
    setError(null);
    setPending(true);
    const result = await mutateJson<UserDto>('/api/v1/users/me/active-mode', 'PATCH', { mode });
    setPending(false);
    if (!result.ok) {
      // Error state (spec 006 §5): inline error, mode indicator does not change until confirmed.
      setError(result.error?.message ?? "Couldn't switch mode. Try again.");
      return false;
    }
    setUser(result.data ?? null);
    setAnnouncement(mode === 'provider' ? 'Switched to provider mode.' : 'Switched to customer mode.');
    window.dispatchEvent(new Event(ACCOUNT_UPDATED_EVENT));
    return true;
  }

  /** Spec 005 §3, `POST /api/v1/auth/logout` — invalidates the current session. Sets local state
   * to anonymous directly on success rather than re-fetching `/users/me` (which would now 401
   * anyway) so the caller reflects the logged-out state immediately. */
  async function logout(): Promise<boolean> {
    setError(null);
    setPending(true);
    const result = await mutateJson('/api/v1/auth/logout', 'POST');
    setPending(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Couldn't log out. Try again.");
      return false;
    }
    setUser(null);
    setStatus('anonymous');
    window.dispatchEvent(new Event(ACCOUNT_UPDATED_EVENT));
    return true;
  }

  return { status, user, pending, error, announcement, switchMode, becomeProvider, logout, retry };
}
