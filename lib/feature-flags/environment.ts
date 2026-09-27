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
