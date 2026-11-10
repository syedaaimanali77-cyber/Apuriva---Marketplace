/**
 * Spec 046 §3.6 — run by playwright.config.ts's `webServer` command BEFORE `next start`, because
 * Playwright starts the web server before `globalSetup`. Resets and migrates the isolated
 * `<name>_browser_test` database named by DATABASE_URL (the config has already pointed it there).
 */
import { resetBrowserDatabase } from '../test/browser-database';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('browser/prepare-database: DATABASE_URL is not set.');
  process.exit(1);
}

resetBrowserDatabase(url).then(
  () => console.log('browser/prepare-database: browser test database reset and migrated.'),
  (err: unknown) => {
    console.error(`browser/prepare-database: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
