/**
 * Spec 045 §3.1 / §3.6 (AC-7) — the demo-environment checks every `/api/v1/demo/*` handler, the demo
 * banner, the entry page and both operator scripts run, server-side, on every call:
 *
 *   1. `APP_ENV` is not `production` (spec 041's `currentFlagEnvironment()`);
 *   2. the `demo-mode` flag is on (`isFeatureEnabled('demo-mode')`);
 *   3. the database name in `DATABASE_URL` ends in `_demo` — the same structural idiom as the
 *      repository's `_test` rule (test/db-reset.ts), so a real staging or production database cannot
 *      match it by accident.
 *
 * They run in that order and read no domain data: the flag read touches only `feature_flags`, and a
 * `DEMO_MODE_ENABLED` override skips even that. The flag is read before the database name so a normal
 * deployment with the flag off never logs `demo.misconfigured`; only "flag on, wrong database" does.
 *
 * DEP-1 is NOT handled here and is not worked around: the sandbox payment, payout, notification and AI
 * adapters keep refusing under `NODE_ENV=production`, so on a hosted server provisioning fails with those
 * adapters' own documented refusal.
 */
import { ApiRouteError } from '@/lib/api/errors';
import { currentFlagEnvironment } from '@/lib/feature-flags/environment';
import { isFeatureEnabled } from '@/lib/feature-flags/resolve';

/** The suffix a demo database name must end with (§3.1 condition 3). */
export const DEMO_DATABASE_SUFFIX = '_demo';

export type DemoUnavailableReason = 'production' | 'flag_off' | 'wrong_database';

export type DemoAvailability = { available: true } | { available: false; reason: DemoUnavailableReason };

/**
 * Reads the database name the application is connected to. An object rather than a bare function so a test
 * can stub it (`vi.spyOn(databaseNameReader, 'read')`) — spec 045 §6: integration tests run on the `*_test`
 * database and never rename or create one.
 */
export const databaseNameReader = {
  read(): string {
    const url = process.env.DATABASE_URL;
    if (!url) return '';
    try {
      return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    } catch {
      return '';
    }
  },
};

/** True only for a non-empty name ending in `_demo` with something before the suffix. */
export function isDemoDatabaseName(name: string): boolean {
  return name.length > DEMO_DATABASE_SUFFIX.length && name.endsWith(DEMO_DATABASE_SUFFIX);
}

/** §3.1 conditions 1–3, in order. Throws only if `APP_ENV` itself is misconfigured (spec 041). */
export async function demoAvailability(): Promise<DemoAvailability> {
  if (currentFlagEnvironment() === 'production') return { available: false, reason: 'production' };
  if (!(await isFeatureEnabled('demo-mode'))) return { available: false, reason: 'flag_off' };
  if (!isDemoDatabaseName(databaseNameReader.read())) {
    console.log(JSON.stringify({ event: 'demo.misconfigured', reason: 'database_name' }));
    return { available: false, reason: 'wrong_database' };
  }
  return { available: true };
}

/**
 * The same checks for a renderer (the banner, the entry page): never throws. A misconfigured `APP_ENV`
 * or an unreachable flag store means "not available" — the safe answer.
 */
export async function isDemoAvailable(): Promise<boolean> {
  try {
    return (await demoAvailability()).available;
  } catch {
    return false;
  }
}

/**
 * §5 / AC-3 — whether the root layout renders the `DemoModeBanner`: the `demo-mode` flag is on AND `APP_ENV` is
 * not `production`, read server-side on every render. Fails closed: any error means no banner. The flag is
 * read only outside production, so a production render never queries it.
 */
export async function shouldShowDemoBanner(): Promise<boolean> {
  try {
    if (currentFlagEnvironment() === 'production') return false;
    return await isFeatureEnabled('demo-mode');
  } catch {
    return false;
  }
}

/** §3.6 — the refusal each unavailable reason maps to. */
export function demoUnavailableError(reason: DemoUnavailableReason): ApiRouteError {
  if (reason === 'production') {
    return new ApiRouteError('DEMO_NOT_AVAILABLE_IN_PRODUCTION', 'Demo mode is not available in production.', {
      status: 403,
    });
  }
  return new ApiRouteError('DEMO_MODE_DISABLED', 'Demo mode is not enabled in this environment.', { status: 403 });
}

/** For route handlers: refuses with §3.6's code before any domain read or write. */
export async function assertDemoAvailable(): Promise<void> {
  const availability = await demoAvailability();
  if (!availability.available) throw demoUnavailableError(availability.reason);
}
