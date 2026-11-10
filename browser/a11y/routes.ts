/**
 * Spec 043 §3.3 — the audited-route manifest: the CLOSED list of what the accessibility gate scans.
 * Pure data (no Playwright import), so `scripts/a11y-changed-routes.ts` can read it outside the browser.
 *
 * - `path` is a template; `{placeholders}` are resolved at run time from the browser test database
 *   (`browser/a11y/fixtures.ts`): published catalog rows from migration 0006, and one real
 *   request → offer → booking seeded through the spec 015–020 test-support path.
 * - `persona` is who is signed in. `customer`/`provider` here are the seeded journey's own customer and
 *   provider (they own the request and booking), not spec 046's generic personas; `admin` is spec 046's.
 * - `sourceDir` is the `app/` path(s) owning the route; a PR touching one re-scans that route (§3.4).
 * - `journey` routes declare `primaryActions` (accessible names) for the report-only 44px goal (§3.6).
 * - `ur: true` for the routes in spec 042 §5.1's scope; `/admin/**` and `/provider/**` stay English only.
 *
 * Adding a route later means adding one entry here.
 */
export type Persona = 'guest' | 'customer' | 'provider' | 'admin';
export type Journey = 'customer' | 'provider';

export interface AuditedRoute {
  id: string;
  path: string;
  persona: Persona;
  sourceDir: string | readonly string[];
  journey?: Journey;
  primaryActions?: readonly string[];
  ur?: boolean;
  /** Scan as a first-time visitor: the spec 007 onboarding overlay is left to open (every other entry pre-marks it seen). */
  firstVisit?: boolean;
}

/** Shared by every admin screen, so a change there re-scans all of them. */
const ADMIN_SHARED = ['app/admin/_components', 'app/admin/admin.module.css'] as const;

export const A11Y_ROUTES: readonly AuditedRoute[] = [
  // Shared chrome states.
  { id: 'home', path: '/', persona: 'guest', sourceDir: ['app/page.tsx', 'app/home.module.css'], journey: 'customer', primaryActions: ['Search'], ur: true },
  { id: 'home.first-visit', path: '/', persona: 'guest', sourceDir: 'app/_components/OnboardingOverlay.tsx', firstVisit: true, ur: true },
  { id: 'not-found', path: '/this-page-does-not-exist', persona: 'guest', sourceDir: 'app/not-found.tsx', ur: true },
  // A forced error state: a well-formed id that does not exist renders the booking screen's ErrorState.
  { id: 'bookings.detail.error', path: '/bookings/{missingId}', persona: 'customer', sourceDir: ['app/bookings/[id]/page.tsx', 'app/bookings/_components'], ur: true },

  // Customer journey: guest → search → request → offer → booking → payment → completion → review.
  { id: 'explore', path: '/explore', persona: 'guest', sourceDir: 'app/explore/page.tsx', ur: true },
  { id: 'explore.category', path: '/explore/{categoryId}', persona: 'guest', sourceDir: 'app/explore/[category]/page.tsx', ur: true },
  { id: 'explore.service', path: '/explore/{categoryId}/{serviceId}', persona: 'guest', sourceDir: 'app/explore/[category]/[service]', journey: 'customer', primaryActions: ['Request service'], ur: true },
  { id: 'search', path: '/search?q=cleaning', persona: 'guest', sourceDir: 'app/search', journey: 'customer', primaryActions: ['Search'], ur: true },
  { id: 'login', path: '/login', persona: 'guest', sourceDir: ['app/(auth)/login', 'app/(auth)/_components'], primaryActions: ['Log in'], ur: true },
  { id: 'requests.new', path: '/requests/new/{serviceId}', persona: 'customer', sourceDir: 'app/requests/new', journey: 'customer', primaryActions: ['Send request'], ur: true },
  { id: 'requests.list', path: '/requests', persona: 'customer', sourceDir: ['app/requests/page.tsx', 'app/requests/requests.module.css', 'app/requests/api-client.ts'], ur: true },
  { id: 'requests.detail', path: '/requests/{requestId}', persona: 'customer', sourceDir: ['app/requests/[id]/page.tsx', 'app/requests/[id]/OffersPanel.tsx', 'app/requests/[id]/MessageThread.tsx', 'app/requests/[id]/negotiation.module.css', 'app/requests/api-client.ts'], journey: 'customer', ur: true },
  { id: 'requests.compare', path: '/requests/{requestId}/compare', persona: 'customer', sourceDir: 'app/requests/[id]/compare', journey: 'customer', ur: true },
  { id: 'bookings.list', path: '/bookings', persona: 'customer', sourceDir: ['app/bookings/page.tsx', 'app/bookings/_components'], ur: true },
  { id: 'bookings.detail', path: '/bookings/{bookingId}', persona: 'customer', sourceDir: ['app/bookings/[id]/page.tsx', 'app/bookings/_components'], journey: 'customer', primaryActions: ['Send message'], ur: true },
  { id: 'bookings.payment', path: '/bookings/{bookingId}/payment', persona: 'customer', sourceDir: 'app/bookings/[id]/payment', journey: 'customer', ur: true },
  { id: 'bookings.review', path: '/bookings/{bookingId}/review', persona: 'customer', sourceDir: 'app/bookings/[id]/review', journey: 'customer', ur: true },
  { id: 'account.customer', path: '/account', persona: 'customer', sourceDir: ['app/account/page.tsx', 'app/account/_components', 'app/account/account.module.css'], ur: true },

  // Provider journey (the steps that have a route today; profile and services are not built — §3.8).
  { id: 'register', path: '/register', persona: 'guest', sourceDir: ['app/(auth)/register', 'app/(auth)/_components'], journey: 'provider', primaryActions: ['Create account'], ur: true },
  { id: 'account.provider', path: '/account', persona: 'provider', sourceDir: ['app/account/page.tsx', 'app/account/_components', 'app/account/account.module.css'], journey: 'provider' },
  { id: 'provider.dashboard', path: '/provider/dashboard', persona: 'provider', sourceDir: 'app/provider/dashboard' },
  { id: 'provider.schedule', path: '/provider/schedule', persona: 'provider', sourceDir: ['app/provider/schedule/page.tsx', 'app/provider/schedule/_components', 'app/provider/schedule/schedule.module.css'], journey: 'provider', primaryActions: ['Save working hours'] },
  { id: 'provider.requests', path: '/provider/requests', persona: 'provider', sourceDir: 'app/provider/requests', journey: 'provider' },
  { id: 'provider.booking', path: '/provider/schedule/bookings/{bookingId}', persona: 'provider', sourceDir: 'app/provider/schedule/bookings', journey: 'provider' },
  { id: 'provider.earnings', path: '/provider/earnings', persona: 'provider', sourceDir: ['app/provider/earnings/page.tsx', 'app/provider/earnings/earnings-client.ts', 'app/provider/earnings/earnings.module.css'], journey: 'provider' },

  // Admin (English only, persona admin — spec 046's MFA-complete Super Admin).
  { id: 'admin.overview', path: '/admin', persona: 'admin', sourceDir: ['app/admin/page.tsx', ...ADMIN_SHARED] },
  { id: 'admin.approvals', path: '/admin/approvals', persona: 'admin', sourceDir: ['app/admin/approvals', ...ADMIN_SHARED] },
  { id: 'admin.catalog', path: '/admin/marketplace/catalog', persona: 'admin', sourceDir: ['app/admin/marketplace/catalog', ...ADMIN_SHARED] },
  { id: 'admin.marketplace-config', path: '/admin/marketplace/config', persona: 'admin', sourceDir: ['app/admin/marketplace/config', ...ADMIN_SHARED] },
  { id: 'admin.matching', path: '/admin/marketplace/matching', persona: 'admin', sourceDir: ['app/admin/marketplace/matching', ...ADMIN_SHARED] },
  { id: 'admin.operations', path: '/admin/operations', persona: 'admin', sourceDir: ['app/admin/operations/page.tsx', ...ADMIN_SHARED] },
  { id: 'admin.disputes', path: '/admin/operations/disputes', persona: 'admin', sourceDir: ['app/admin/operations/disputes/page.tsx', ...ADMIN_SHARED] },
  { id: 'admin.fraud', path: '/admin/operations/fraud', persona: 'admin', sourceDir: ['app/admin/operations/fraud', ...ADMIN_SHARED] },
  { id: 'admin.moderation-appeals', path: '/admin/operations/moderation-appeals', persona: 'admin', sourceDir: ['app/admin/operations/moderation-appeals', ...ADMIN_SHARED] },
  { id: 'admin.payouts', path: '/admin/operations/payouts', persona: 'admin', sourceDir: ['app/admin/operations/payouts', ...ADMIN_SHARED] },
  { id: 'admin.refunds', path: '/admin/operations/refunds', persona: 'admin', sourceDir: ['app/admin/operations/refunds', ...ADMIN_SHARED] },
  { id: 'admin.safety', path: '/admin/operations/safety', persona: 'admin', sourceDir: ['app/admin/operations/safety', ...ADMIN_SHARED] },
  { id: 'admin.support', path: '/admin/operations/support', persona: 'admin', sourceDir: ['app/admin/operations/support/page.tsx', ...ADMIN_SHARED] },
  { id: 'admin.no-show-reports', path: '/admin/actions/no-show-reports', persona: 'admin', sourceDir: ['app/admin/actions/no-show-reports', ...ADMIN_SHARED] },
  { id: 'admin.review-actions', path: '/admin/actions/review', persona: 'admin', sourceDir: ['app/admin/actions/review/page.tsx', ...ADMIN_SHARED] },
  { id: 'admin.review-moderation', path: '/admin/actions/review-moderation', persona: 'admin', sourceDir: ['app/admin/actions/review-moderation', ...ADMIN_SHARED] },
  { id: 'admin.analytics', path: '/admin/analytics', persona: 'admin', sourceDir: ['app/admin/analytics', ...ADMIN_SHARED] },
  { id: 'admin.roles', path: '/admin/roles', persona: 'admin', sourceDir: ['app/admin/roles', ...ADMIN_SHARED] },
  { id: 'admin.users', path: '/admin/users', persona: 'admin', sourceDir: ['app/admin/users/page.tsx', ...ADMIN_SHARED] },
  { id: 'admin.user-moderation', path: '/admin/users/{customerUserId}/moderation', persona: 'admin', sourceDir: ['app/admin/users/[id]', ...ADMIN_SHARED] },
  { id: 'admin.settings', path: '/admin/settings', persona: 'admin', sourceDir: ['app/admin/settings/page.tsx', ...ADMIN_SHARED] },
  { id: 'admin.ai-usage', path: '/admin/settings/ai-usage', persona: 'admin', sourceDir: ['app/admin/settings/ai-usage', ...ADMIN_SHARED] },
  { id: 'admin.audit-log', path: '/admin/settings/audit-log', persona: 'admin', sourceDir: ['app/admin/settings/audit-log', ...ADMIN_SHARED] },
  { id: 'admin.feature-flags', path: '/admin/settings/feature-flags', persona: 'admin', sourceDir: ['app/admin/settings/feature-flags', ...ADMIN_SHARED] },
  { id: 'admin.mcp-tools', path: '/admin/settings/mcp-tools', persona: 'admin', sourceDir: ['app/admin/settings/mcp-tools', ...ADMIN_SHARED] },
];

export const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  desktop: { width: 1280, height: 800 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export function sourceDirsOf(route: AuditedRoute): readonly string[] {
  return typeof route.sourceDir === 'string' ? [route.sourceDir] : route.sourceDir;
}

/** `A11Y_ROUTES` env (comma-separated ids, from scripts/a11y-changed-routes.ts) narrows the scan; unset = full manifest. */
export function selectedRoutes(env: string | undefined = process.env.A11Y_ROUTES): readonly AuditedRoute[] {
  if (!env || env.trim() === '') return A11Y_ROUTES;
  const ids = new Set(env.split(',').map((s) => s.trim()).filter(Boolean));
  const unknown = [...ids].filter((id) => !A11Y_ROUTES.some((r) => r.id === id));
  if (unknown.length > 0) throw new Error(`A11Y_ROUTES names unknown route ids: ${unknown.join(', ')}`);
  return A11Y_ROUTES.filter((r) => ids.has(r.id));
}
