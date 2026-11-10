/**
 * Spec 014 §2 AC-4/AC-5/AC-6 — the three persona primary-navigation item sets (master spec
 * §59-61), exactly as named there. No "AI"/"Assistant" item exists in any of them (AC-8): the
 * assistant is reachable contextually elsewhere, never a mandatory permanent tab, and specs
 * 033-036 own building that contextual entry point itself.
 */
import type { MessageKey } from '@/lib/i18n/dictionaries/en';

export interface NavItem {
  id: string;
  /** English label — shown as-is where no `labelKey` exists (the English-only admin console). */
  label: string;
  /** Spec 042 X-12: the translated label for the customer/provider sets. */
  labelKey?: MessageKey;
  icon: string;
  href: string;
}

export const CUSTOMER_NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', labelKey: 'chrome.nav.home', icon: 'house', href: '/' },
  { id: 'explore', label: 'Explore', labelKey: 'chrome.nav.explore', icon: 'compass', href: '/explore' },
  { id: 'requests', label: 'Requests', labelKey: 'chrome.nav.requests', icon: 'file-text', href: '/requests' },
  { id: 'bookings', label: 'Bookings', labelKey: 'chrome.nav.bookings', icon: 'calendar', href: '/bookings' },
  { id: 'account', label: 'Account', labelKey: 'chrome.nav.account', icon: 'user', href: '/account' },
];

export const PROVIDER_NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', labelKey: 'chrome.nav.dashboard', icon: 'layout-dashboard', href: '/provider/dashboard' },
  { id: 'requests', label: 'Requests', labelKey: 'chrome.nav.requests', icon: 'file-text', href: '/provider/requests' },
  { id: 'schedule', label: 'Schedule', labelKey: 'chrome.nav.schedule', icon: 'calendar', href: '/provider/schedule' },
  { id: 'earnings', label: 'Earnings', labelKey: 'chrome.nav.earnings', icon: 'wallet', href: '/provider/earnings' },
  { id: 'account', label: 'Account', labelKey: 'chrome.nav.account', icon: 'user', href: '/account' },
];

/** "Marketplace" links straight to the one page that already exists under it
 * (`/admin/marketplace/catalog`, spec 010) — see §8 risk 6 for why `operations`/`users`/`settings`
 * are new minimal index pages that link out to already-existing spec-009 routes rather than
 * moving those routes' files. */
export const ADMIN_NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard', href: '/admin' },
  { id: 'operations', label: 'Operations', icon: 'shield-check', href: '/admin/operations' },
  { id: 'users', label: 'Users', icon: 'users', href: '/admin/users' },
  { id: 'marketplace', label: 'Marketplace', icon: 'briefcase', href: '/admin/marketplace/catalog' },
  { id: 'analytics', label: 'Analytics', icon: 'chart-column', href: '/admin/analytics' },
  { id: 'settings', label: 'Settings', icon: 'settings', href: '/admin/settings' },
];
