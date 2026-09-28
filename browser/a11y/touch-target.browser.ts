import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { openRoute, setupA11yFixtures } from './checks';
import { selectedRoutes } from './routes';

/**
 * Spec 043 AC-7 (§3.6) — the APURIVA design-system GOAL of 44×44 CSS px (`--touch-target-min`) for each
 * journey route's declared primary actions, measured as the element's bounding rect at 375×812.
 *
 * REPORT-ONLY: this never fails the build and never enters the baseline. The WCAG gate is axe `target-size`
 * (24×24 with its exceptions) in scan.browser.ts; 32px/40px controls pass that gate. Results go to
 * browser/a11y/touch-target-44.report.json (a CI artefact) and the job summary.
 */
setupA11yFixtures();

const GOAL_PX = 44;
const REPORT = path.join(__dirname, 'touch-target-44.report.json');

interface Measurement {
  route: string;
  action: string;
  found: boolean;
  width?: number;
  height?: number;
  meetsGoal?: boolean;
}

const journeyRoutes = selectedRoutes().filter((r) => r.journey && r.primaryActions?.length);
const measurements: Measurement[] = [];

test.describe.configure({ mode: 'serial' });

for (const route of journeyRoutes) {
  test(`44px goal (report only): ${route.id}`, async ({ browser, baseURL }) => {
    const { context, page } = await openRoute(browser, baseURL!, route, { viewport: 'mobile' });
    try {
      for (const action of route.primaryActions!) {
        const target = page.getByRole('button', { name: action, exact: true }).or(page.getByRole('link', { name: action, exact: true })).first();
        const box = (await target.count()) > 0 ? await target.boundingBox() : null;
        measurements.push(
          box
            ? { route: route.id, action, found: true, width: Math.round(box.width), height: Math.round(box.height), meetsGoal: box.width >= GOAL_PX && box.height >= GOAL_PX }
            : { route: route.id, action, found: false },
        );
      }
    } finally {
      await context.close();
    }
  });
}

test.afterAll(() => {
  if (measurements.length === 0) return;
  writeFileSync(REPORT, `${JSON.stringify({ goalPx: GOAL_PX, gate: false, measurements }, null, 2)}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const rows = measurements.map((m) => `| ${m.route} | ${m.action} | ${m.found ? `${m.width}×${m.height}` : 'not found'} | ${m.found ? (m.meetsGoal ? 'yes' : 'no') : '—'} |`);
    appendFileSync(summary, ['### 44×44 design-system goal (report only — not a WCAG gate)', '', '| Route | Primary action | Size (CSS px) | ≥ 44×44 |', '|---|---|---|---|', ...rows, ''].join('\n'));
  }
});
