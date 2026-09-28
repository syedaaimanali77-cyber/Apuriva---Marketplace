import { expect, test } from '@playwright/test';
import { personaStatePath } from './personas';

/**
 * Spec 046 §3.6 — proves the browser runner works end to end: the production build serves pages,
 * and a persona created by global-setup is really signed in. Accessibility (spec 043) and PWA/
 * performance (spec 044) tests are those specs' own and are not written here.
 */
test('guest: / renders', async ({ page }) => {
  const res = await page.goto('/');
  expect(res?.status()).toBe(200);
  await expect(page.locator('main').first()).toBeVisible();
});

test('guest: /explore renders', async ({ page }) => {
  const res = await page.goto('/explore');
  expect(res?.status()).toBe(200);
  await expect(page.locator('main').first()).toBeVisible();
});

test.describe('signed-in customer', () => {
  test.use({ storageState: personaStatePath('customer') });

  test('/account shows the signed-in account, not the guest screen', async ({ page }) => {
    await page.goto('/account');
    await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Log in' })).toHaveCount(0);
  });
});
