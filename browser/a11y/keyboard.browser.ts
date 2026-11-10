import { expect, test, type Page } from '@playwright/test';
import { MAX_TAB_STOPS, openRoute, setupA11yFixtures } from './checks';
import { selectedRoutes } from './routes';

/**
 * Spec 043 §3.7 / AC-2, AC-3 (automated part) — keyboard operation of the critical journeys.
 *
 * For every journey route, at desktop size:
 * - every dialog or menu trigger (`aria-haspopup`, or a button controlling a collapsed region) opens with
 *   Enter, moves focus inside what it opened, closes on Escape and returns focus to the trigger;
 * - every declared primary action is reachable with Tab alone.
 * The screen-reader half of AC-2/AC-3 is manual: docs/accessibility/*-journey-signoff.md.
 */
setupA11yFixtures();

const POPUP = '[role="dialog"]:visible, [role="alertdialog"]:visible, [role="menu"]:visible, dialog[open]';

async function reachableByTab(page: Page, name: string): Promise<boolean> {
  const target = page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name, exact: true })).first();
  // A declared primary action must exist; wait for a client-rendered one rather than failing on a skeleton.
  if (!(await target.waitFor({ state: 'attached', timeout: 15_000 }).then(() => true, () => false))) return false;
  await page.locator('body').focus().catch(() => undefined);
  for (let i = 0; i < MAX_TAB_STOPS; i += 1) {
    await page.keyboard.press('Tab');
    // Re-resolved on every stop (not one ElementHandle taken up front): a client screen that re-renders
    // under load replaces the node, and a stale handle would never match the live, focused control.
    if (await target.evaluate((el) => document.activeElement === el, undefined, { timeout: 5_000 }).catch(() => false)) return true;
  }
  return false;
}

for (const route of selectedRoutes().filter((r) => r.journey)) {
  test(`keyboard: ${route.id}`, async ({ browser, baseURL }) => {
    const { context, page } = await openRoute(browser, baseURL!, route, { viewport: 'desktop' });
    try {
      for (const action of route.primaryActions ?? []) {
        expect(await reachableByTab(page, action), `primary action "${action}" is reachable with Tab`).toBe(true);
      }

      const triggers = page.locator('[aria-haspopup]:not([aria-haspopup="false"]):visible, button[aria-controls][aria-expanded="false"]:visible');
      const count = await triggers.count();
      for (let i = 0; i < count; i += 1) {
        const trigger = triggers.nth(i);
        const label = (await trigger.getAttribute('aria-label')) ?? (await trigger.innerText()).trim().slice(0, 40);
        await trigger.focus();
        await page.keyboard.press('Enter');
        const popup = page.locator(POPUP).last();
        const opened = (await popup.count()) > 0 || (await trigger.getAttribute('aria-expanded')) === 'true';
        expect(opened, `"${label}" opens with Enter`).toBe(true);
        if ((await popup.count()) > 0) {
          const focusInside = await popup.evaluate((el) => el.contains(document.activeElement));
          expect(focusInside, `focus moves inside what "${label}" opened`).toBe(true);
        }
        await page.keyboard.press('Escape');
        await expect(page.locator(POPUP), `Escape closes what "${label}" opened`).toHaveCount(0);
        const focusReturned = await trigger.evaluate((el) => el === document.activeElement);
        expect(focusReturned, `focus returns to "${label}" after Escape`).toBe(true);
      }
    } finally {
      await context.close();
    }
  });
}
