/**
 * Spec 014 §2 AC-4/AC-5/AC-6 — the three persona primary-navigation item sets (master spec
 * §59-61), exactly as named there. No "AI"/"Assistant" item exists in any of them (AC-8): the
 * assistant is reachable contextually elsewhere, never a mandatory permanent tab, and specs
 * 033-036 own building that contextual entry point itself.
 */
export interface NavItem {
  id: string;
  label: string;
  icon: string;
  href: string;
}

export const CUSTOMER_NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'house', href: '/' },
  { id: 'explore', label: 'Explore', icon: 'compass', href: '/explore' },
  { id: 'requests', label: 'Requests', icon: 'file-text', href: '/requests' },
  { id: 'bookings', label: 'Bookings', icon: 'calendar', href: '/bookings' },
  { id: 'account', label: 'Account', icon: 'user', href: '/account' },
];

export const PROVIDER_NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', href: '/provider/dashboard' },
  { id: 'requests', label: 'Requests', icon: 'file-text', href: '/provider/requests' },
  { id: 'schedule', label: 'Schedule', icon: 'calendar', href: '/provider/schedule' },
  { id: 'earnings', label: 'Earnings', icon: 'wallet', href: '/provider/earnings' },
  { id: 'account', label: 'Account', icon: 'user', href: '/account' },
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
