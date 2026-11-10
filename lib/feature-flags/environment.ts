/**
 * Spec 041 §3.2 (AC-6) — which environment this deployment is.
 *
 * `NODE_ENV` cannot tell staging from production, so `APP_ENV` does. Unset, it falls back to
 * `production` under `NODE_ENV=production` and `development` otherwise; a staging deployment must
 * set `APP_ENV=staging`. Any other value is a configuration error, never silently mapped — the
 * repository's "no silent fallback" adapter idiom (spec 021 `PAYMENT_PROVIDER`).
 */
import { FLAG_ENVIRONMENTS, type FlagEnvironment } from '@/lib/types/feature-flags';

export class FeatureFlagEnvironmentError extends Error {
  constructor(value: string) {
    super(`APP_ENV must be one of ${FLAG_ENVIRONMENTS.join(', ')}; got "${value}".`);
    this.name = 'FeatureFlagEnvironmentError';
  }
}

export function isFlagEnvironment(value: unknown): value is FlagEnvironment {
  return typeof value === 'string' && (FLAG_ENVIRONMENTS as readonly string[]).includes(value);
}

export function currentFlagEnvironment(): FlagEnvironment {
  const raw = process.env.APP_ENV;
  if (raw === undefined || raw === '') return process.env.NODE_ENV === 'production' ? 'production' : 'development';
  if (!isFlagEnvironment(raw)) throw new FeatureFlagEnvironmentError(raw);
  return raw;
}

/**
 * DEP-1 (spec 045 §8; approved 2026-11-10 for specs 021, 024, 026, 027 and 033): whether this deployment
 * is PRODUCTION, the one environment where every sandbox adapter must refuse to run.
 *
 * Keyed on `APP_ENV` rather than `NODE_ENV`, because every hosted server — staging and a demo
 * deployment included — runs `NODE_ENV=production`, and only `APP_ENV` tells them apart. It fails
 * closed:
 *   - `APP_ENV` unset under `NODE_ENV=production` resolves to `production` (above), so an existing
 *     production deployment behaves exactly as before;
 *   - an invalid `APP_ENV` counts as production — a mistyped variable must never let a sandbox run.
 */
export function isProductionDeployment(): boolean {
  try {
    return currentFlagEnvironment() === 'production';
  } catch {
    return true;
  }
}
