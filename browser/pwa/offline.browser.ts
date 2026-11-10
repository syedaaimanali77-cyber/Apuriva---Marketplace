import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { personaStatePath } from '../personas';

/**
 * Spec 044 §3.2–§3.5 (AC-1, AC-2, AC-3) in the production build, offline emulated by Playwright
 * (`navigator.onLine` false, every request — the service worker's too — fails at the network):
 *
 * - installed app offline shows /offline, rendered with its own cached static assets;
 * - Cache Storage holds no /api/ response and no HTML but the guest-rendered /offline;
 * - never claims success without server confirmation: the critical write control is disabled, a write
 *   forced through anyway fails, and nothing is queued or replayed on reconnect;
 * - reconnecting clears the notice.
 */
const OFFLINE_HEADING = 'You are offline';
const NETWORK_ERROR = 'We could not reach the server.';

/** Waits until the page is controlled by the active worker (install includes precaching /offline). */
async function controlledBy(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
}

async function publishedServiceId(request: APIRequestContext): Promise<string> {
  const categories = (await (await request.get('/api/v1/categories')).json()).data as Array<{ id: string }>;
  for (const category of categories) {
    const page = (await (await request.get(`/api/v1/categories/${category.id}/page`)).json()).data as { popularServices: Array<{ id: string }> };
    if (page.popularServices.length > 0) return page.popularServices[0]!.id;
  }
  throw new Error('the browser database has no published service (migration 0006 seeds them)');
}

test('installed app offline: a navigation shows the cached /offline page with its static assets', async ({ page, context }) => {
  // A first load, the worker's install (precaching the offline page's assets) and an offline navigation.
  test.setTimeout(120_000);
  await page.goto('/');
  await controlledBy(page);

  await context.setOffline(true);
  await page.goto('/explore');
  await expect(page.getByRole('heading', { name: OFFLINE_HEADING })).toBeVisible();
  // Rendered with its stylesheet (cached at install), not as unstyled markup: the design tokens resolve.
  const teal = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--teal-600').trim());
  expect(teal.toLowerCase()).toBe('#0a918c');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await context.setOffline(false);
});

test.describe('signed-in customer', () => {
  test.use({ storageState: personaStatePath('customer') });

  test('Cache Storage holds no /api/ entry and no HTML but /offline after browsing signed in', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/');
    await controlledBy(page);
    for (const path of ['/', '/explore', '/account', '/bookings', '/requests', '/search?q=cleaning']) {
      // `load`, not `networkidle`: screens that poll (bookings, notifications) never go network-idle, and every
      // request the worker could cache has been made by the time the document and its assets have loaded.
      await page.goto(path, { waitUntil: 'load' });
    }
    const entries = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) out.push(`${name} ${new URL(request.url).pathname}`);
      }
      return out;
    });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const [cacheName, path] = entry.split(' ') as [string, string];
      expect(path, entry).not.toMatch(/^\/api\//);
      expect(cacheName, entry).toMatch(/^apuriva-(static|images|offline)-v\d+$/);
      if (cacheName.startsWith('apuriva-static')) expect(path, entry).toMatch(/^\/_next\/static\//);
      if (cacheName.startsWith('apuriva-images')) expect(path, entry).toMatch(/^\/images\//);
      if (cacheName.startsWith('apuriva-offline')) expect(path, entry).toMatch(/^\/offline$|^\/icons\//);
    }
  });

  test('offline: the notice shows, the request-submit control is disabled, a forced write fails, nothing is queued or replayed', async ({ page, context, request }) => {
    const serviceId = await publishedServiceId(request);
    // Counted through the test's own signed-in request client, which the page's offline emulation does not touch.
    const count = async () => ((await (await request.get('/api/v1/requests')).json()).data as unknown[]).length;
    const before = await count();

    await page.goto(`/requests/new/${serviceId}`);
    await controlledBy(page);
    const submit = page.getByRole('button', { name: 'Send request' });
    await expect(submit).toBeVisible();

    await context.setOffline(true);
    await expect(page.getByRole('status').filter({ hasText: NETWORK_ERROR }).first()).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAccessibleDescription(NETWORK_ERROR);
    // Content already rendered stays visible.
    await expect(page.locator('main')).toBeVisible();

    // A write forced past the UI goes straight to the network (the worker never intercepts non-GET) and fails.
    const forced = await page.evaluate(async (id) => {
      try {
        const res = await fetch('/api/v1/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceId: id }) });
        return `status ${res.status}`;
      } catch {
        return 'network error';
      }
    }, serviceId);
    expect(forced).toBe('network error');
    await expect(page.getByText(/request (sent|created)/i)).toHaveCount(0);

    await context.setOffline(false);
    await expect(page.getByRole('status').filter({ hasText: NETWORK_ERROR })).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    // Nothing was queued and replayed on reconnect.
    expect(await count()).toBe(before);
  });
});
