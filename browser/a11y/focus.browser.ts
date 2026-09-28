import { test } from '@playwright/test';
import { baselineKey, expectWithinBaseline, openRoute, scopeOf, tabStops, setupA11yFixtures } from './checks';
import { selectedRoutes, VIEWPORTS, type ViewportName } from './routes';

/**
 * Spec 043 AC-8 — Tab through every selected route (at most 200 stops): each element that receives focus
 * must show a visible indicator (a computed non-`none` outline, or a box-shadow — the design system's
 * `--ring-focus` is one), and focus must never land on a hidden element. Counted under
 * `apuriva-focus-visible`.
 */
setupA11yFixtures();

for (const route of selectedRoutes()) {
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    test(`focus visible: ${route.id} @ ${viewport}`, async ({ browser, baseURL }) => {
      const { context, page } = await openRoute(browser, baseURL!, route, { viewport });
      try {
        const bad = (await tabStops(page)).filter((s) => !s.visibleIndicator || !s.visible);
        const scope = scopeOf(route.id, false, viewport);
        const counts = bad.length ? { [baselineKey(route.id, false, viewport, 'apuriva-focus-visible')]: bad.length } : {};
        expectWithinBaseline(scope, counts, 'apuriva-focus-visible', bad.map((s) => `  ${s.label}${s.visible ? '' : ' (hidden)'}${s.visibleIndicator ? '' : ' (no indicator)'}`));
      } finally {
        await context.close();
      }
    });
  }
}
