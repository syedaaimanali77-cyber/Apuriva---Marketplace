/**
 * Spec 045 hosted-demo verification — the two server configurations and the demo browser database.
 *
 * Shared by playwright.demo.config.ts, the database preparation and the tests, so all three agree.
 */
export const DEMO_PORT = 3200;
export const PRODUCTION_PORT = 3201;
// `localhost` (not 127.0.0.1): the session cookies are `Secure`, and browsers treat localhost as a secure context.
export const DEMO_BASE_URL = `http://localhost:${DEMO_PORT}`;
export const PRODUCTION_BASE_URL = `http://localhost:${PRODUCTION_PORT}`;

/** `<name>_browser_demo` — ends in `_demo`, the §3.1 condition 3 guard; never the developer's own database. */
export function toDemoBrowserDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) throw new Error('DATABASE_URL names no database.');
  const base = name.replace(/_(test|browser_test|browser_demo|demo)$/, '');
  url.pathname = `/${base}_browser_demo`;
  return url.toString();
}

/**
 * The environment of a hosted demo deployment (spec 045 §3.1), or of production when `appEnv` is `production`.
 * `NODE_ENV=production` as on every hosted server — set explicitly so the test runner's own value never leaks in.
 */
export function demoServerEnv(databaseUrl: string, appEnv: 'staging' | 'production', port: number): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    PORT: String(port),
    SITE_URL: `http://localhost:${port}`,
    APP_ENV: appEnv,
    DEMO_MODE_ENABLED: 'true',
    PAYMENT_PROVIDER: 'sandbox',
    PAYOUT_PROVIDER: 'sandbox',
    NOTIFICATION_CHANNEL_PROVIDER: 'sandbox',
    AI_PROVIDER: 'sandbox',
    FILE_STORAGE_PROVIDER: 'local',
    FILE_SCANNER: 'sandbox',
  };
}
