import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Spec 044 §3.2/§3.6 (AC-1) — installability: the manifest is served and complete, and the service worker
 * registers with scope "/". The app icons are design-supplied artwork (DEP-2): while they are absent from
 * public/icons/ the icon check is SKIPPED with that reason, and AC-1 is reported open — never faked.
 */
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
const iconsDelivered = ICONS.every((icon) => existsSync(path.join(__dirname, '..', '..', 'public', 'icons', icon)));

test('the web app manifest is served with the installability fields', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await res.json();
  expect(manifest).toMatchObject({ name: 'APURIVA', short_name: 'APURIVA', start_url: '/', display: 'standalone' });
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  expect(manifest.icons.map((i: { src: string; sizes: string; purpose: string }) => `${i.src} ${i.sizes} ${i.purpose}`)).toEqual([
    '/icons/icon-192.png 192x192 any',
    '/icons/icon-512.png 512x512 any',
    '/icons/icon-maskable-512.png 512x512 maskable',
  ]);
});

test('every page links the manifest', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
});

test('the service worker registers with scope / in the production build', async ({ page }) => {
  await page.goto('/');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe('/');
  const script = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(new URL(script!).pathname).toBe('/sw.js');
});

test('the three design-supplied icons are served as PNGs of their declared size', async ({ request }) => {
  test.skip(!iconsDelivered, 'DEP-2: the 192px, 512px and maskable 512px icon artwork has not been delivered to public/icons/ — AC-1 is open.');
  for (const [icon, px] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]] as const) {
    const res = await request.get(`/icons/${icon}`);
    expect(res.status(), icon).toBe(200);
    expect(res.headers()['content-type'], icon).toBe('image/png');
    const png = await res.body();
    // PNG IHDR: width and height are big-endian uint32 at byte offsets 16 and 20.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)], icon).toEqual([px, px]);
  }
});
