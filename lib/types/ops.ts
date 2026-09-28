/** Spec 046 §3.7 — `GET /api/v1/health/detailed`. */
export type HealthStatus = 'healthy' | 'degraded' | 'down';

export type DependencyStatus = 'up' | 'degraded' | 'down';

export interface HealthDependencyDto {
  name: string;
  status: DependencyStatus;
  latencyMs?: number;
  /** A short code (`stale`, `3_consecutive_failures`, `sandbox_in_production`, …) — never a message, host or credential. */
  detail?: string;
}

export interface DetailedHealthDto {
  status: HealthStatus;
  environment: 'development' | 'staging' | 'production';
  /** package.json version */
  version: string;
  /** VERCEL_GIT_COMMIT_SHA, null locally */
  commit: string | null;
  checkedAt: string;
  dependencies: HealthDependencyDto[];
}
