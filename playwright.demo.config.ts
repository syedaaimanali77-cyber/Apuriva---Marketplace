import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { config as loadEnvFile } from 'dotenv';
import { PLAYWRIGHT_TMP_DIR } from './browser/personas';
import { DEMO_BASE_URL, DEMO_PORT, PRODUCTION_BASE_URL, PRODUCTION_PORT, demoServerEnv, toDemoBrowserDatabaseUrl } from './browser/demo/demo-environment';

/**
 * Spec 045 — the hosted-demo verification: the PRODUCTION build served as a deployment serves it (the standalone
 * `server.js` with `NODE_ENV=production`, exactly as the Dockerfile and every hosted server run it) configured as a demo deployment (§3.1) against its own `_demo` database, driven by a
 * real browser. A second server from the same build runs with `APP_ENV=production` to prove the refusals (AC-7)
 * and that production still refuses every sandbox adapter (DEP-1).
 *
 * Run `npm run build` first, then `npx playwright test -c playwright.demo.config.ts`.
 * The database is `<name>_browser_demo`, recreated by the real operator script (scripts/demo-reseed.ts).
 */
for (const file of ['.env.test.local', '.env.test', '.env.local', '.env']) {
  loadEnvFile({ path: path.resolve(__dirname, file), override: false, quiet: true });
}
if (!process.env.DATABASE_URL) throw new Error('playwright.demo.config.ts: DATABASE_URL is required (see .env.example).');

const DATABASE_URL = toDemoBrowserDatabaseUrl(process.env.DATABASE_URL);
process.env.DEMO_BROWSER_DATABASE_URL = DATABASE_URL;

export default defineConfig({
  testDir: 'browser/demo',
  // Not `*.browser.ts`: the regular browser runner (playwright.config.ts) must never pick these up.
  testMatch: '**/*.hosted-demo.ts',
  outputDir: path.join(PLAYWRIGHT_TMP_DIR, 'demo-results'),
  reporter: [['list']],
  workers: 1,
  timeout: 120_000,
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], baseURL: DEMO_BASE_URL } }],
  webServer: [
    {
      command: 'npx tsx browser/demo/prepare-demo-database.ts && npx tsx browser/demo/serve-standalone.ts --copy-assets',
      url: `${DEMO_BASE_URL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: demoServerEnv(DATABASE_URL, 'staging', DEMO_PORT),
    },
    {
      // Starts only once the demo server (and so the reseeded database) is up: see wait-for-demo-server.ts.
      command: 'npx tsx browser/demo/wait-for-demo-server.ts && npx tsx browser/demo/serve-standalone.ts',
      url: `${PRODUCTION_BASE_URL}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: demoServerEnv(DATABASE_URL, 'production', PRODUCTION_PORT),
    },
  ],
});
