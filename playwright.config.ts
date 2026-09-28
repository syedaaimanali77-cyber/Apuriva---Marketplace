import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { config as loadEnvFile } from 'dotenv';
import { PLAYWRIGHT_TMP_DIR } from './browser/personas';
import { toBrowserDatabaseUrl } from './test/browser-database';

/**
 * Spec 046 §3.6 — the shared browser-test runner. Spec 046 owns this foundation (config, browser
 * database, personas, smoke test); specs 043/044 own the tests they add under `browser/`.
 *
 * - Tests are `browser/**∕*.browser.ts`. That suffix never matches Vitest's `include`, and
 *   `browser/**` is also in Vitest's `exclude`; `e2e/*.spec.ts` stays Vitest's route-level suite.
 * - The app under test is the production build (`next start`) against `<name>_browser_test`, which
 *   `browser/prepare-database.ts` resets and migrates before the server starts (Playwright starts the
 *   web server before `globalSetup`). Run `npm run build` first.
 * - Output goes to the OS temp directory, never into the repository.
 */
for (const file of ['.env.test.local', '.env.test', '.env.local', '.env']) {
  loadEnvFile({ path: path.resolve(__dirname, file), override: false, quiet: true });
}
if (!process.env.DATABASE_URL) throw new Error('playwright.config.ts: DATABASE_URL is required (see .env.example).');

const DATABASE_URL = toBrowserDatabaseUrl(process.env.DATABASE_URL);
// globalSetup runs in this process and writes personas directly; point it at the browser database too.
process.env.DATABASE_URL = DATABASE_URL;

const PORT = 3100;
// `localhost` (not 127.0.0.1): the session cookies are `Secure`, and browsers treat localhost as a secure context.
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'browser',
  testMatch: '**/*.browser.ts',
  outputDir: path.join(PLAYWRIGHT_TMP_DIR, 'test-results'),
  reporter: [['list'], ['html', { outputFolder: path.join(PLAYWRIGHT_TMP_DIR, 'report'), open: 'never' }]],
  globalSetup: './browser/global-setup.ts',
  forbidOnly: !!process.env.CI,
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npx tsx browser/prepare-database.ts && npx next start --port ${PORT}`,
    url: `${BASE_URL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { DATABASE_URL, PORT: String(PORT) },
  },
});
