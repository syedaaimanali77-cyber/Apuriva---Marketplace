import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PLAYWRIGHT_TMP_DIR } from '../personas';
import { baselineKey, compareScope, describeComparison, scopeOf, validateBaseline, type A11yBaseline } from '../../scripts/a11y-baseline';
import { a11yFixtures, ONBOARDING_SEEN_KEY, resolvePath, stateFor } from './fixtures';
import { VIEWPORTS, type AuditedRoute, type ViewportName } from './routes';

/**
 * Spec 043 — the shared mechanics of the accessibility browser checks. One rule set, used by every
 * `browser/a11y/*.browser.ts` file: how a route is opened (persona, viewport, locale, reduced motion), what
 * is counted, and how counts are held against `browser/a11y/baseline.json`.
 */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** Spec 002's reduced-motion backstop value; anything longer escaped `app/globals.css` (AC-5). */
export const MAX_REDUCED_MOTION_SECONDS = 0.01;
export const MAX_TAB_STOPS = 200;

const BASELINE_PATH = path.join(__dirname, 'baseline.json');
const CAPTURE_PATH = path.join(PLAYWRIGHT_TMP_DIR, 'a11y', 'capture.jsonl');

export function loadBaseline(): A11yBaseline {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Record<string, unknown>;
  const problems = validateBaseline(raw);
  if (problems.length > 0) throw new Error(`browser/a11y/baseline.json is invalid:\n${problems.join('\n')}`);
  return raw as A11yBaseline;
}

/** `A11Y_CAPTURE_BASELINE=1` records counts instead of asserting — never in CI (§3.5: no silent update path). */
export function capturing(): boolean {
  if (process.env.A11Y_CAPTURE_BASELINE !== '1') return false;
  if (process.env.CI) throw new Error('A11Y_CAPTURE_BASELINE is refused in CI: a baseline raise must be a reviewed PR change (spec 043 §3.5).');
  return true;
}

/** Seeds the journey fixtures once, before a file's tests, with room for the real matching path. */
export function setupA11yFixtures(): void {
  // Up to three settled page loads (openRoute reloads on a server error) and up to 200 Tab presses (or a
  // full axe run) per test, on a loaded runner.
  test.describe.configure({ timeout: 300_000 });
  test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(180_000);
    await a11yFixtures(baseURL!);
  });
}

export interface OpenOptions {
  viewport: ViewportName;
  ur?: boolean;
  reducedMotion?: boolean;
}

export async function openRoute(browser: Browser, baseURL: string, route: AuditedRoute, options: OpenOptions): Promise<{ context: BrowserContext; page: Page }> {
  const fixtures = await a11yFixtures(baseURL);
  const context = await browser.newContext({
    baseURL,
    storageState: stateFor(route.persona),
    viewport: VIEWPORTS[options.viewport],
    reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference',
  });
  if (options.ur) {
    await context.addCookies([{ name: 'apuriva_locale', value: 'ur', url: baseURL }]);
  }
  await context.addInitScript(
    ({ key, firstVisit }) => {
      try {
        if (firstVisit) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, '1');
      } catch {
        /* storage unavailable: the page decides */
      }
    },
    { key: ONBOARDING_SEEN_KEY, firstVisit: !!route.firstVisit },
  );
  const page = await context.newPage();
  // A screen whose own API calls failed (a 5xx from an overloaded test server) renders an error state, not
  // the screen: counting it would record server noise as accessibility results. Reload, and fail loudly if
  // the server keeps erroring — never measure it.
  const serverErrors: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  for (let attempt = 1; ; attempt += 1) {
    serverErrors.length = 0;
    const res = attempt === 1 ? await page.goto(resolvePath(route.path, fixtures)) : await page.reload();
    expect(res, `no response for ${route.id}`).not.toBeNull();
    await settle(page);
    if (serverErrors.length === 0) break;
    if (attempt === 3) throw new Error(`${route.id}: the server answered ${serverErrors.join(', ')} on every load — not an accessibility result`);
  }
  return { context, page };
}

/**
 * Waits for the page to finish rendering before anything is counted. `networkidle` alone is not enough:
 * on a loaded machine a page can sit idle on the network while its JavaScript is still parsing, so
 * client-rendered screens (which fetch after hydration) were scanned as skeletons and their counts drifted
 * between runs. Settled = network idle; then hydrated (React has attached its props to every focusable
 * element — hydration changes no DOM, yet the design system's focus rings come from `onFocus` handlers and
 * screens fetch their data from hydration effects); then network idle; then the DOM quiet for 500ms and
 * every finite animation or transition finished; then network idle again (each wait bounded; infinite
 * spinners are ignored).
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page
    .waitForFunction(
      () =>
        document.readyState === 'complete' &&
        Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')).every((el) =>
          Object.keys(el).some((k) => k.startsWith('__reactProps$')),
        ),
      undefined,
      { timeout: 15_000, polling: 100 },
    )
    .catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page
    .evaluate(
      ({ quietMs, maxMs }) =>
        new Promise<void>((resolve) => {
          const deadline = setTimeout(done, maxMs);
          let quiet = setTimeout(afterQuiet, quietMs);
          const observer = new MutationObserver(() => {
            clearTimeout(quiet);
            quiet = setTimeout(afterQuiet, quietMs);
          });
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          function afterQuiet() {
            observer.disconnect();
            const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
            void Promise.all(finite.map((a) => a.finished.catch(() => undefined))).then(done);
          }
          function done() {
            clearTimeout(deadline);
            clearTimeout(quiet);
            observer.disconnect();
            resolve();
          }
        }),
      { quietMs: 500, maxMs: 15_000 },
    )
    .catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

/** Lets the focused control's focus-ring transition finish (the design system animates `box-shadow`). */
async function settleFocus(page: Page): Promise<void> {
  await page
    .evaluate(
      (maxMs) =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            const el = document.activeElement;
            const running = el ? document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) : [];
            const timer = setTimeout(resolve, maxMs);
            void Promise.all(running.map((a) => a.finished.catch(() => undefined))).then(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }),
      1_000,
    )
    .catch(() => undefined);
}

export interface AxeResult {
  counts: Record<string, number>;
  details: string[];
}

export async function axeCounts(page: Page, scope: string): Promise<AxeResult> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const counts: Record<string, number> = {};
  const details: string[] = [];
  for (const v of results.violations) {
    counts[`${scope}${v.id}`] = v.nodes.length;
    for (const n of v.nodes.slice(0, 5)) details.push(`  ${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[1]?.trim() ?? ''}`);
  }
  return { counts, details };
}

/** Elements whose computed animation or transition outlasts the reduced-motion backstop (AC-5). */
export async function reducedMotionOffenders(page: Page): Promise<string[]> {
  return page.evaluate((max) => {
    const seconds = (value: string) => value.split(',').map((v) => (v.trim().endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v)));
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const pseudo of [null, '::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        const animated = cs.animationName !== 'none' && seconds(cs.animationDuration).some((s) => s > max);
        const transitioned = seconds(cs.transitionDuration).some((s) => s > max);
        if (animated || transitioned) {
          const id = el.id ? `#${el.id}` : '';
          out.push(`${el.tagName.toLowerCase()}${id}${pseudo ?? ''} animation=${cs.animationDuration} transition=${cs.transitionDuration}`);
        }
      }
    }
    return out;
  }, MAX_REDUCED_MOTION_SECONDS);
}

export interface TabStop {
  label: string;
  visibleIndicator: boolean;
  visible: boolean;
}

/** Presses Tab through the page (at most 200 stops, until focus cycles) recording each stop (AC-8). */
export async function tabStops(page: Page): Promise<TabStop[]> {
  const stops: TabStop[] = [];
  const seen = new Set<string>();
  await page.locator('body').focus().catch(() => undefined);
  for (let i = 0; i < MAX_TAB_STOPS; i += 1) {
    await page.keyboard.press('Tab');
    await settleFocus(page);
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow !== 'none';
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const path: string[] = [];
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) path.unshift(`${n.tagName}:${Array.from(n.parentElement?.children ?? []).indexOf(n)}`);
      return {
        key: path.join('>'),
        label: `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} "${name}"`,
        visibleIndicator: outline || shadow,
        visible: typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.offsetParent !== null,
      };
    });
    if (!stop || seen.has(stop.key)) break;
    seen.add(stop.key);
    stops.push({ label: stop.label, visibleIndicator: stop.visibleIndicator, visible: stop.visible });
  }
  return stops;
}

/**
 * Holds one check's counts for one `route[@ur]|viewport` scope against the baseline, or records them in
 * capture mode. Fails with every new violation (and its nodes) and every stale entry (§3.5).
 */
export function expectWithinBaseline(
  scope: string,
  counts: Record<string, number>,
  owns: 'axe' | 'apuriva-reduced-motion' | 'apuriva-focus-visible',
  details: string[] = [],
): void {
  if (capturing()) {
    mkdirSync(path.dirname(CAPTURE_PATH), { recursive: true });
    // `details` (the counted nodes) is for review only; the merge reads scope/owns/counts.
    appendFileSync(CAPTURE_PATH, `${JSON.stringify({ scope, owns, counts, details })}\n`);
    return;
  }
  const ownsRule = owns === 'axe' ? (rule: string) => rule !== 'apuriva-reduced-motion' && rule !== 'apuriva-focus-visible' : (rule: string) => rule === owns;
  const comparison = compareScope(scope, counts, loadBaseline(), ownsRule);
  const problems = describeComparison(comparison);
  expect(problems, [`${scope}* against browser/a11y/baseline.json:`, ...problems, ...(comparison.newViolations.length ? details : [])].join('\n')).toEqual([]);
}

export { baselineKey, scopeOf };
