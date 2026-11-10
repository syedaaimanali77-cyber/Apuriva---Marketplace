/** Spec 041 §3.10 — feature-flag request/response types. */
import type { FLAG_CONTROL_VALUES, FLAG_ENVIRONMENT_VALUES } from '@/lib/db/schema';

export const FLAG_ENVIRONMENTS = ['development', 'staging', 'production'] as const satisfies typeof FLAG_ENVIRONMENT_VALUES;
export type FlagEnvironment = (typeof FLAG_ENVIRONMENT_VALUES)[number];
export type FlagControl = (typeof FLAG_CONTROL_VALUES)[number];

export interface FeatureFlagDto {
  key: string;
  description: string;
  controlledBy: FlagControl;
  isKillSwitch: boolean;
  clientReadable: boolean;
  removalCriteria: string | null;
  /** The running deployment's environment; the only one this deployment reads or writes (§3.2). */
  environment: FlagEnvironment;
  /** The stored value for `environment`. */
  enabled: boolean;
  /** What `isFeatureEnabled()` returns now (after any env override). */
  effective: boolean;
  /** The env var pinning `effective`, or null. */
  overriddenBy: string | null;
  /** Optimistic-concurrency version of the (flag, environment) row. */
  version: number;
  updatedAt: string;
}

export interface UpdateFeatureFlagRequest {
  environment: FlagEnvironment;
  enabled: boolean;
  expectedVersion: number;
  reason: string;
}

/** F3 — client-readable flags only (never a developer flag). */
export interface EffectiveFeatureFlagsDto {
  flags: Record<string, boolean>;
}
