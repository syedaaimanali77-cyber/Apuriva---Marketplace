'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { HEADERLESS_ROUTES } from './AppHeader';
import { BottomTabBar } from './BottomTabBar';
import { SideNav } from './SideNav';
import { ADMIN_NAV_ITEMS, CUSTOMER_NAV_ITEMS, PROVIDER_NAV_ITEMS, type NavItem } from './nav-items';
import { ACCOUNT_UPDATED_EVENT } from '@/app/account/_components/useAccountUser';
import type { UserDto } from '@/lib/types/users';
import styles from './nav-shell.module.css';

function computeActiveId(items: NavItem[], pathname: string): string | undefined {
  let best: NavItem | undefined;
  for (const item of items) {
    const matches = pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
    if (matches && (!best || item.href.length > best.href.length)) best = item;
  }
  return best?.id;
}

/**
 * Spec 014 §5 — the persona/mode-aware primary navigation shell, persistent and always reachable
 * across every screen (never a route-group `layout.tsx`, the same `usePathname()`-in-a-global-
 * client-component pattern `AppHeader` already established — there's no other precedent for
 * route-group layouts in this app). Composes with the existing `AppHeader` (logo + `AccountMenu`)
 * rather than duplicating either, per CLAUDE.md's single-brand-placement rule.
 *
 * `pathname.startsWith('/admin')` selects the admin item set; the current session's
 * `activeMode` (spec 006, never re-derived here) otherwise selects customer vs. provider. A
 * guest (401 from `/users/me`) gets the customer set, same as an authenticated customer — nothing
 * in it requires a session to view (the individual destination pages/API calls enforce their own
 * auth). Refetches on every navigation, on window focus, and on `ACCOUNT_UPDATED_EVENT` (dispatched
 * by `useAccountUser` after a confirmed mode switch or provider-profile creation) rather than
 * holding a shared context/store (no such mechanism exists elsewhere in this app yet) — a same-page
 * mode switch via `AccountMenu` or the `/account` page is reflected here immediately.
 */
export function NavShell() {
  const pathname = usePathname();
  const [user, setUser] = useState<UserDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetch('/api/v1/users/me', { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (!cancelled) setUser(json?.data ?? null);
        })
        .catch(() => {
          if (!cancelled) setUser(null);
        });
    }
    load();
    window.addEventListener('focus', load);
    window.addEventListener(ACCOUNT_UPDATED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
      window.removeEventListener(ACCOUNT_UPDATED_EVENT, load);
    };
  }, [pathname]);

  if (HEADERLESS_ROUTES.includes(pathname)) return null;

  const isAdmin = pathname.startsWith('/admin');
  const items: NavItem[] = isAdmin
    ? ADMIN_NAV_ITEMS
    : user?.activeMode === 'provider'
      ? PROVIDER_NAV_ITEMS
      : CUSTOMER_NAV_ITEMS;

  const activeId = computeActiveId(items, pathname);

  return (
    <>
      <div className={styles.bottomOnly}>
        <BottomTabBar items={items} activeId={activeId} />
      </div>
      <div className={styles.sideOnly}>
        {/* The DS admin console uses navy side-nav chrome; customer/provider keep the light nav. */}
        <SideNav items={items} activeId={activeId} tone={isAdmin ? 'dark' : 'light'} />
      </div>
    </>
  );
}
