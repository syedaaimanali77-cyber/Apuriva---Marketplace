import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Spec 044 §3.7 (AC-4, D-3) — INP ≤ 200 ms, the half of the performance budget a Lighthouse navigation run
 * cannot measure. In Chromium, per budget route and per run:
 *
 * - 4× CPU slowdown (CDP `Emulation.setCPUThrottlingRate`) and Slow 4G (Lighthouse's DevTools values:
 *   562.5 ms RTT, 1474.56 Kbps down, 675 Kbps up);
 * - the fixed scripted interaction set of §3.7;
 * - the browser's native Event Timing entries (`PerformanceObserver` type `event`, `durationThreshold: 16`).
 *   With fewer than 50 interactions, INP is the longest interaction's duration.
 *
 * The median of 3 runs must be ≤ 200 ms. A breach fails the job; there is no baseline or exception.
 */
const INP_BUDGET_MS = 200;
const RUNS = 3;
const KBPS = 1024 / 8; // bytes per second in one kilobit per second

interface Ids {
  categoryId: string;
  serviceId: string;
}

async function catalogIds(request: APIRequestContext): Promise<Ids> {
  const categories = (await (await request.get('/api/v1/categories')).json()).data as Array<{ id: string }>;
  for (const category of categories) {
    const page = (await (await request.get(`/api/v1/categories/${category.id}/page`)).json()).data as { popularServices: Array<{ id: string }> };
    if (page.popularServices[0]) return { categoryId: category.id, serviceId: page.popularServices[0].id };
  }
  throw new Error('no published category with a published service (migration 0006 seeds them)');
}

const ROUTES: Array<{ name: string; path: (ids: Ids) => string; interact: (page: Page, ids: Ids) => Promise<void> }> = [
  { name: '/', path: () => '/', interact: (page) => page.locator('main a[href^="/explore/"]').first().click() },
  { name: '/explore', path: () => '/explore', interact: (page) => page.locator('main a[href^="/explore/"]').first().click() },
  {
    name: '/explore/{categoryId}',
    path: (ids) => `/explore/${ids.categoryId}`,
    interact: (page, ids) => page.locator(`main a[href^="/explore/${ids.categoryId}/"]`).first().click(),
  },
  {
    name: '/explore/{categoryId}/{serviceId}',
    path: (ids) => `/explore/${ids.categoryId}/${ids.serviceId}`,
    interact: (page) => page.getByRole('button', { name: 'Request service' }).first().click(),
  },
  {
    name: '/search?q=cleaning',
    path: () => '/search?q=cleaning',
    interact: async (page) => {
      const input = page.locator('main input[type="search"], main input').first();
      await input.click();
      await page.keyboard.type('plumb', { delay: 50 });
    },
  },
  {
    name: '/login',
    path: () => '/login',
    interact: async (page) => {
      const emailTab = page.getByRole('tab', { name: /email/i });
      if (await emailTab.count()) await emailTab.first().click();
      await page.locator('#email').click();
      await page.keyboard.type('someone@example.com', { delay: 20 });
      await page.keyboard.press('Tab');
    },
  },
];

/** Records every interaction's longest Event Timing entry from the start of the page's life. */
const OBSERVE = () => {
  const w = window as unknown as { __inp: Map<number, number> };
  w.__inp = new Map();
  new PerformanceObserver((list) => {
    // `interactionId` (Event Timing Level 1) is missing from this TypeScript DOM lib.
    for (const entry of list.getEntries() as Array<PerformanceEventTiming & { interactionId?: number }>) {
      if (!entry.interactionId) continue;
      w.__inp.set(entry.interactionId, Math.max(w.__inp.get(entry.interactionId) ?? 0, entry.duration));
    }
  }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
};

async function measureOnce(page: Page, path: string, interact: () => Promise<void>): Promise<{ inp: number; interactions: number }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 562.5, downloadThroughput: 1474.56 * KBPS, uploadThroughput: 675 * KBPS });
  await page.addInitScript(OBSERVE);
  await page.goto(path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await interact();
  await page.waitForTimeout(1500); // let the interactions' next paints land and their entries flush
  const values = await page.evaluate(() => [...(window as unknown as { __inp: Map<number, number> }).__inp.values()]);
  await cdp.detach();
  return { inp: values.length ? Math.max(...values) : 0, interactions: values.length };
}

for (const route of ROUTES) {
  test(`INP ≤ ${INP_BUDGET_MS} ms: ${route.name} (median of ${RUNS})`, async ({ browser, request, baseURL }, testInfo) => {
    test.setTimeout(240_000);
    const ids = await catalogIds(request);
    const runs: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const context = await browser.newContext({ baseURL, viewport: { width: 412, height: 823 }, isMobile: true, hasTouch: true });
      try {
        const page = await context.newPage();
        const { inp, interactions } = await measureOnce(page, route.path(ids), () => route.interact(page, ids));
        runs.push(inp);
        testInfo.annotations.push({ type: 'inp', description: `run ${i + 1}: ${Math.round(inp)} ms over ${interactions} interaction(s)` });
      } finally {
        await context.close();
      }
    }
    const median = [...runs].sort((a, b) => a - b)[Math.floor(RUNS / 2)]!;
    console.log(`INP ${route.name}: runs ${runs.map((r) => Math.round(r)).join(', ')} ms → median ${Math.round(median)} ms`);
    expect(median, `INP median for ${route.name}`).toBeLessThanOrEqual(INP_BUDGET_MS);
  });
}
