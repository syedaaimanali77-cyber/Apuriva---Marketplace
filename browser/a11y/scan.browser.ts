import { test } from '@playwright/test';
import { axeCounts, expectWithinBaseline, openRoute, scopeOf, setupA11yFixtures } from './checks';
import { selectedRoutes, VIEWPORTS, type ViewportName } from './routes';

/**
 * Spec 043 AC-1, AC-4, AC-7 — axe-core (WCAG 2.0–2.2 A/AA tags) on every selected manifest route at both
 * viewports, held against browser/a11y/baseline.json.
 *
 * - AC-4 (`color-contrast`) is verified only when it reports ZERO on every route with no `color-contrast`
 *   key left in the baseline. Baseline entries for it are open failures (the five spec 002 token pairs,
 *   DEP-3), recorded only so a NEW contrast regression is still caught — never accepted debt.
 * - AC-7's only touch-target GATE is axe `target-size` (WCAG 2.2 SC 2.5.8, 24×24 CSS px with its
 *   exceptions); the 44px design-system goal is report-only (touch-target.browser.ts).
 */
setupA11yFixtures();

for (const route of selectedRoutes()) {
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    test(`axe: ${route.id} @ ${viewport}`, async ({ browser, baseURL }) => {
      const { context, page } = await openRoute(browser, baseURL!, route, { viewport });
      try {
        const scope = scopeOf(route.id, false, viewport);
        const { counts, details } = await axeCounts(page, scope);
        expectWithinBaseline(scope, counts, 'axe', details);
      } finally {
        await context.close();
      }
    });
  }
}
