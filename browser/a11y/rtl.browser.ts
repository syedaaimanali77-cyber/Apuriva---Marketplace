import { expect, test } from '@playwright/test';
import {
  axeCounts,
  baselineKey,
  expectWithinBaseline,
  openRoute,
  reducedMotionOffenders,
  scopeOf,
  tabStops,
  setupA11yFixtures,
} from './checks';
import { selectedRoutes, VIEWPORTS, type ViewportName } from './routes';

/**
 * Spec 043 AC-6 (§3.9) — ACCESSIBILITY PARITY under Urdu, for the manifest routes in spec 042 §5.1's scope
 * (`ur: true`). `urdu-locale` is on in the browser database (fixtures.ts) and `ur` is selected through the
 * `apuriva_locale` cookie. Localization correctness itself stays spec 042's (coverage, icon mirroring and
 * first-paint lang/dir have their own tests there).
 *
 * Checked: `<html lang="ur" dir="rtl">`; no horizontal overflow at 375px; and the axe, reduced-motion and
 * focus checks, each against its own `@ur` baseline keys.
 */
setupA11yFixtures();

for (const route of selectedRoutes().filter((r) => r.ur)) {
  for (const viewport of Object.keys(VIEWPORTS) as ViewportName[]) {
    const scope = scopeOf(route.id, true, viewport);

    test(`ur: ${route.id} @ ${viewport} — lang/dir${viewport === 'mobile' ? ', no overflow' : ''}, axe`, async ({ browser, baseURL }) => {
      const { context, page } = await openRoute(browser, baseURL!, route, { viewport, ur: true });
      try {
        await expect(page.locator('html')).toHaveAttribute('lang', 'ur');
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        if (viewport === 'mobile') {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, 'horizontal overflow at 375px (px)').toBeLessThanOrEqual(0);
        }
        const { counts, details } = await axeCounts(page, scope);
        expectWithinBaseline(scope, counts, 'axe', details);
      } finally {
        await context.close();
      }
    });

    test(`ur: ${route.id} @ ${viewport} — reduced motion`, async ({ browser, baseURL }) => {
      const { context, page } = await openRoute(browser, baseURL!, route, { viewport, ur: true, reducedMotion: true });
      try {
        const offenders = await reducedMotionOffenders(page);
        const counts = offenders.length ? { [baselineKey(route.id, true, viewport, 'apuriva-reduced-motion')]: offenders.length } : {};
        expectWithinBaseline(scope, counts, 'apuriva-reduced-motion', offenders.slice(0, 10).map((o) => `  ${o}`));
      } finally {
        await context.close();
      }
    });

    test(`ur: ${route.id} @ ${viewport} — focus visible`, async ({ browser, baseURL }) => {
      const { context, page } = await openRoute(browser, baseURL!, route, { viewport, ur: true });
      try {
        const bad = (await tabStops(page)).filter((s) => !s.visibleIndicator || !s.visible);
        const counts = bad.length ? { [baselineKey(route.id, true, viewport, 'apuriva-focus-visible')]: bad.length } : {};
        expectWithinBaseline(scope, counts, 'apuriva-focus-visible', bad.map((s) => `  ${s.label}`));
      } finally {
        await context.close();
      }
    });
  }
}
