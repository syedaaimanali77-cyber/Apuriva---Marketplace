'use client';

import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components';
import type { ActiveMode } from '@/lib/types/users';
import { ModeIndicator } from './ModeIndicator';
import { useAccountUser } from './useAccountUser';
import styles from './account-menu.module.css';

/**
 * Spec 006 §5 — the account-menu mode switch: "Become a Provider", switching between
 * customer/provider mode, and the persistent mode indicator. Reachable via account menu (not
 * primary nav clutter, per master spec §9.3); fully keyboard operable; announces mode changes to
 * screen readers via the live region below. Mounted globally in app/components/AppHeader.tsx.
 * Identity/mode state and its mutations live in `useAccountUser` (shared with `/account`'s own
 * page) — this component owns only the dropdown's open/closed and keyboard-navigation behavior.
 *
 * Renders nothing for a signed-out visitor (a 401 from `/users/me` is the expected, silent case)
 * — spec 006 only covers the identity/mode model for an authenticated user. A guest's Login/Create
 * account entry point lives on the `/account` page itself, not in this header widget.
 */
export function AccountMenu() {
  const { status, user, pending, error, announcement, switchMode, becomeProvider } = useAccountUser();
  const [open, setOpen] = useState(false);

  // IconButton isn't built with forwardRef, so the trigger button is reached via this wrapping
  // span (for "click outside" detection and to restore focus after the menu closes) rather than
  // a ref placed directly on IconButton.
  const triggerWrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function focusTrigger() {
    triggerWrapRef.current?.querySelector('button')?.focus();
  }

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

  async function handleSwitchMode(mode: ActiveMode) {
    const switched = await switchMode(mode);
    if (switched) {
      setOpen(false);
      focusTrigger();
    }
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
              <button type="button" role="menuitem" className={styles.item} disabled={pending} onClick={() => becomeProvider()}>
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
