import { test } from '@playwright/test';
import { baselineKey, expectWithinBaseline, openRoute, reducedMotionOffenders, scopeOf, setupA11yFixtures } from './checks';
import { selectedRoutes, VIEWPORTS, type ViewportName } from './routes';

/**
 * Spec 043 AC-5 — with `prefers-reduced-motion: reduce` emulated, no element (or ::before/::after) may have
 * a computed animation or transition longer than 0.01s, spec 002's `app/globals.css` backstop value. This
 * reuses that backstop: a failure means a rule escaped it, and the fix belongs to that component's owner.
 * Counted under `apuriva-reduced-motion`.
 */
setupA11yFixtures();

for (const route of selectedRoutes()) {
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    test(`reduced motion: ${route.id} @ ${viewport}`, async ({ browser, baseURL }) => {
      const { context, page } = await openRoute(browser, baseURL!, route, { viewport, reducedMotion: true });
      try {
        const offenders = await reducedMotionOffenders(page);
        const scope = scopeOf(route.id, false, viewport);
        const counts = offenders.length ? { [baselineKey(route.id, false, viewport, 'apuriva-reduced-motion')]: offenders.length } : {};
        expectWithinBaseline(scope, counts, 'apuriva-reduced-motion', offenders.slice(0, 10).map((o) => `  ${o}`));
      } finally {
        await context.close();
      }
    });
  }
}
