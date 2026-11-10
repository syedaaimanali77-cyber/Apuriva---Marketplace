import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { A11Y_ROUTES, selectedRoutes, sourceDirsOf } from '../browser/a11y/routes';
import { owns, run, selectRoutes } from './a11y-changed-routes';

const ROOT = join(__dirname, '..');
const ALL = A11Y_ROUTES.map((r) => r.id);

describe('the audited-route manifest (spec 043 §3.3)', () => {
  it('has unique ids and every sourceDir exists in the repository', () => {
    expect(new Set(ALL).size).toBe(ALL.length);
    const missing = A11Y_ROUTES.flatMap((r) => sourceDirsOf(r).filter((d) => !existsSync(join(ROOT, d))).map((d) => `${r.id}: ${d}`));
    expect(missing).toEqual([]);
  });

  it('checks Urdu parity only where spec 042 §5.1 applies — never on /admin or /provider', () => {
    const wrong = A11Y_ROUTES.filter((r) => r.ur && (r.path.startsWith('/admin') || r.path.startsWith('/provider') || r.persona === 'provider'));
    expect(wrong.map((r) => r.id)).toEqual([]);
  });

  it('covers every journey step of §3.8 that has a route today', () => {
    const paths = new Set(A11Y_ROUTES.map((r) => `${r.persona}:${r.path}`));
    for (const p of [
      'guest:/', 'guest:/search?q=cleaning', 'guest:/explore/{categoryId}/{serviceId}', 'customer:/requests/new/{serviceId}',
      'customer:/requests/{requestId}', 'customer:/requests/{requestId}/compare', 'customer:/bookings/{bookingId}',
      'customer:/bookings/{bookingId}/payment', 'customer:/bookings/{bookingId}/review',
      'guest:/register', 'provider:/account', 'provider:/provider/schedule', 'provider:/provider/requests',
      'provider:/provider/schedule/bookings/{bookingId}', 'provider:/provider/earnings',
    ]) expect(paths.has(p), p).toBe(true);
  });

  it('A11Y_ROUTES narrows the scan to named ids, and rejects an unknown id', () => {
    expect(selectedRoutes(undefined)).toHaveLength(A11Y_ROUTES.length);
    expect(selectedRoutes(' explore , login ').map((r) => r.id)).toEqual(['explore', 'login']);
    expect(() => selectedRoutes('explore,nope')).toThrow(/nope/);
  });
});

describe('changed-route selection (spec 043 §3.4)', () => {
  it('skips a docs-only change, with a logged reason', () => {
    expect(selectRoutes(['docs/specs/x.md', 'README.md'])).toMatchObject({ mode: 'skip', routes: [] });
  });

  it.each([
    'components/Button.tsx', 'ui/components/Badge.jsx', 'lib/i18n/format.ts', 'app/layout.tsx', 'app/globals.css',
    'app/styles/apuriva-tokens.css', 'app/components/AppHeader.tsx', 'app/_components/OfflineBanner.tsx', 'app/not-found.tsx',
    'app/error.tsx', 'app/loading.tsx', 'app/global-error.tsx', 'browser/a11y/routes.ts', 'package.json', 'package-lock.json', 'next.config.ts',
  ])('scans the full manifest when a shared file changes: %s', (file) => {
    expect(selectRoutes([file])).toMatchObject({ mode: 'full', routes: ALL });
  });

  it('scans only the routes that own a route-local change, including their _components and CSS modules', () => {
    expect(selectRoutes(['app/bookings/[id]/payment/page.tsx']).routes).toEqual(['bookings.payment']);
    expect(selectRoutes(['app/requests/[id]/negotiation.module.css']).routes).toEqual(['requests.detail']);
    expect(selectRoutes(['app/admin/_components/AdminTable.tsx']).routes.every((id) => id.startsWith('admin.'))).toBe(true);
    expect(selectRoutes(['app/account/_components/AccountMenu.tsx']).routes).toEqual(['account.customer', 'account.provider']);
    expect(selectRoutes(['app/bookings/_components/BookingConversation.tsx']).routes).toEqual(['bookings.detail.error', 'bookings.list', 'bookings.detail']);
  });

  it('matches on a path boundary, and skips an app/ change no audited route owns', () => {
    expect(owns(A11Y_ROUTES.find((r) => r.id === 'requests.new')!, 'app/requests/newer/page.tsx')).toBe(false);
    expect(selectRoutes(['app/api/v1/health/route.ts'])).toMatchObject({ mode: 'skip', routes: [] });
  });

  it('always scans everything on a push to main', () => {
    expect(selectRoutes(['docs/x.md'], { push: true })).toMatchObject({ mode: 'full', routes: ALL });
  });

  it('prints GITHUB_OUTPUT lines; with no usable base it scans everything', () => {
    const out: string[] = [];
    run(['--base', 'origin/main'], { changedFiles: () => [{ status: 'M', path: 'app/search/page.tsx' }] }, (l) => out.push(l));
    expect(out).toEqual(['mode=routes', 'routes=search', 'reason=1 route(s) own a changed file']);
    const none: string[] = [];
    run([], { changedFiles: () => [] }, (l) => none.push(l));
    expect(none[0]).toBe('mode=full');
    const pushed: string[] = [];
    run(['--push'], { changedFiles: () => [] }, (l) => pushed.push(l));
    expect(pushed[0]).toBe('mode=full');
  });
});
