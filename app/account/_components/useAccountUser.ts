'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ActiveMode, UserDto } from '@/lib/types/users';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

/** Mirrors the CSRF-cookie-echo pattern used across app/(auth) and other account pages — the
 * CSRF cookie (spec 005 §3) is deliberately not httpOnly. */
function readCsrfCookie(): string | undefined {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1];
}

async function getJson<T>(url: string): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin' });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

async function mutateJson<T>(url: string, method: 'POST' | 'PATCH', body?: unknown): Promise<ApiResult<T>> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() ?? '' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

export type AccountLoadStatus = 'loading' | 'anonymous' | 'ready';

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
    getJson<UserDto>('/api/v1/users/me').then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setUser(result.data ?? null);
        setStatus('ready');
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

  return { status, user, pending, error, announcement, switchMode, becomeProvider, logout };
}
