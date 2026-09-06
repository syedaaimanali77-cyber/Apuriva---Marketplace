'use client';

import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components';
import type { ActiveMode, UserDto } from '@/lib/types/users';
import { ModeIndicator } from './ModeIndicator';
import styles from './account-menu.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

/** Mirrors the CSRF-cookie-echo pattern already used in app/(auth)/login/page.tsx and
 * app/(auth)/register/page.tsx — the CSRF cookie (spec 005 §3) is deliberately not httpOnly. */
function readCsrfCookie(): string | undefined {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1];
}

async function getJson(url: string): Promise<{ ok: boolean; data?: any; error?: ApiErrorBody }> {
  const res = await fetch(url, { credentials: 'same-origin' });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data } : { ok: false, error: json as ApiErrorBody };
}

async function mutateJson(
  url: string,
  method: 'POST' | 'PATCH',
  body?: unknown,
): Promise<{ ok: boolean; data?: any; error?: ApiErrorBody }> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() ?? '' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data } : { ok: false, error: json as ApiErrorBody };
}

type LoadStatus = 'loading' | 'anonymous' | 'ready';

/**
 * Spec 006 §5 — the account-menu mode switch: "Become a Provider", switching between
 * customer/provider mode, and the persistent mode indicator. Reachable via account menu (not
 * primary nav clutter, per master spec §9.3); fully keyboard operable; announces mode changes to
 * screen readers via the live region below. Mounted globally in app/components/AppHeader.tsx.
 *
 * Renders nothing for a signed-out visitor (a 401 from `/users/me` is the expected, silent case)
 * — spec 006 only covers the identity/mode model for an authenticated user.
 */
export function AccountMenu() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [user, setUser] = useState<UserDto | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // IconButton isn't built with forwardRef, so the trigger button is reached via this wrapping
  // span (for "click outside" detection and to restore focus after the menu closes) rather than
  // a ref placed directly on IconButton.
  const triggerWrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function focusTrigger() {
    triggerWrapRef.current?.querySelector('button')?.focus();
  }

  useEffect(() => {
    let cancelled = false;
    getJson('/api/v1/users/me').then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setUser(result.data as UserDto);
        setStatus('ready');
      } else {
        setStatus('anonymous');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node) && !triggerWrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        focusTrigger();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        if (items.length === 0) return;
        const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex =
          e.key === 'ArrowDown' ? (currentIndex + 1) % items.length : (currentIndex - 1 + items.length) % items.length;
        items[nextIndex]?.focus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function handleBecomeProvider() {
    setError(null);
    setPending(true);
    const result = await mutateJson('/api/v1/users/me/provider-profile', 'POST');
    setPending(false);
    if (!result.ok) {
      setError(result.error?.message ?? "Couldn't create your provider profile. Try again.");
      return;
    }
    setUser((prev) => (prev ? { ...prev, hasProviderProfile: true } : prev));
    setAnnouncement('Provider profile created. You can now switch to provider mode.');
  }

  async function handleSwitchMode(mode: ActiveMode) {
    if (!user || user.activeMode === mode) return;
    setError(null);
    setPending(true);
    const result = await mutateJson('/api/v1/users/me/active-mode', 'PATCH', { mode });
    setPending(false);
    if (!result.ok) {
      // Error state (spec 006 §5): inline error, mode indicator does not change until confirmed.
      setError(result.error?.message ?? "Couldn't switch mode. Try again.");
      return;
    }
    setUser(result.data as UserDto);
    setAnnouncement(mode === 'provider' ? 'Switched to provider mode.' : 'Switched to customer mode.');
    setOpen(false);
    focusTrigger();
  }

  if (status === 'anonymous') return null;

  if (status === 'loading' || !user) {
    return (
      <span
        role="status"
        aria-label="Loading account"
        style={{ display: 'inline-block', width: 40, height: 40, borderRadius: 'var(--radius-circle)', background: 'var(--gray-100)' }}
      />
    );
  }

  return (
    <div className={styles.wrapper}>
      <span ref={triggerWrapRef} style={{ display: 'inline-flex' }}>
        <IconButton
          icon="user"
          label="Account menu"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        />
      </span>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      {open ? (
        <div ref={panelRef} role="menu" aria-label="Account" className={styles.panel}>
          <div className={styles.panelHeader}>
            <ModeIndicator mode={user.activeMode} />
          </div>

          <div className={styles.items}>
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${user.activeMode === 'customer' ? styles.itemCurrent : ''}`}
              disabled={pending || user.activeMode === 'customer'}
              onClick={() => handleSwitchMode('customer')}
            >
              {user.activeMode === 'customer' ? 'Currently in customer mode' : 'Switch to customer mode'}
            </button>

            {user.hasProviderProfile ? (
              <button
                type="button"
                role="menuitem"
                className={`${styles.item} ${user.activeMode === 'provider' ? styles.itemCurrent : ''}`}
                disabled={pending || user.activeMode === 'provider'}
                onClick={() => handleSwitchMode('provider')}
              >
                {user.activeMode === 'provider' ? 'Currently in provider mode' : 'Switch to provider mode'}
              </button>
            ) : (
              <button type="button" role="menuitem" className={styles.item} disabled={pending} onClick={handleBecomeProvider}>
                Become a Provider
              </button>
            )}
          </div>

          {error ? (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
