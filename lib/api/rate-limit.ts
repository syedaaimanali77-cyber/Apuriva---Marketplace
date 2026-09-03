/**
 * Rate limiting — spec 004 AC-5, §8 risk #1. Master spec §100 requires different limits per
 * domain and admin-configurable thresholds; the exact thresholds are explicitly Open (§8 #1).
 * These are sane fixed defaults for now — an in-memory fixed-window counter, single-process only
 * (fine for this stage; a shared store is a scaling concern for later, not a spec 004 decision).
 * `docs/specs/2026-08-28-041-feature-flags-platform-configuration.md` is where these become
 * runtime-configurable instead of hardcoded here.
 */
export type RateLimitDomain = 'auth' | 'search' | 'messaging' | 'ai' | 'mcp' | 'payment' | 'security' | 'default';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export const RATE_LIMIT_DEFAULTS: Record<RateLimitDomain, RateLimitRule> = {
  auth: { limit: 10, windowMs: 60_000 },
  search: { limit: 60, windowMs: 60_000 },
  messaging: { limit: 30, windowMs: 60_000 },
  ai: { limit: 20, windowMs: 60_000 },
  mcp: { limit: 30, windowMs: 60_000 },
  payment: { limit: 10, windowMs: 60_000 },
  security: { limit: 5, windowMs: 60_000 },
  default: { limit: 100, windowMs: 60_000 },
};

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/**
 * Fixed-window check for `identifier` (e.g. a user ID or IP) within `domain`. Not exported
 * per-route as middleware, because Next.js Route Handlers are plain functions — callers wrap
 * their handler body with this check directly (see `withRateLimit` below).
 */
export function checkRateLimit(
  domain: RateLimitDomain,
  identifier: string,
  rule: RateLimitRule = RATE_LIMIT_DEFAULTS[domain],
): RateLimitResult {
  const key = `${domain}:${identifier}`;
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, limit: rule.limit, remaining: rule.limit - 1, retryAfterSeconds: 0 };
  }

  if (existing.count >= rule.limit) {
    return {
      allowed: false,
      limit: rule.limit,
      remaining: 0,
      retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000),
    };
  }

  existing.count += 1;
  return { allowed: true, limit: rule.limit, remaining: rule.limit - existing.count, retryAfterSeconds: 0 };
}

/** Test-only: clears all in-memory windows so suites don't leak state into each other. */
export function resetRateLimitState(): void {
  windows.clear();
}
