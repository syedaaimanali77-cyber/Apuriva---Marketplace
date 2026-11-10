/**
 * Spec 033 §3.6 — this spec's additions to spec 004's error taxonomy, following the same
 * SCREAMING_SNAKE_CASE + stability rule. They are not in the baseline `API_ERROR_CODES` map, so
 * each passes `status` explicitly.
 */
import { ApiRouteError } from '@/lib/api/errors';

/** 429 — the `ai` rate-limit window is exhausted for this subject. */
export class AiRateLimitedError extends ApiRouteError {
  constructor(retryAfterSeconds: number) {
    super('AI_RATE_LIMITED', 'AI rate limit exceeded.', { retryAfterSeconds, status: 429 });
    this.name = 'AiRateLimitedError';
  }
}

/** 429 — the rolling-24h request or token quota is exhausted for this subject. */
export class AiQuotaExceededError extends ApiRouteError {
  constructor(message = 'AI usage quota exceeded.') {
    super('AI_QUOTA_EXCEEDED', message, { status: 429 });
    this.name = 'AiQuotaExceededError';
  }
}

/** 503 — the `ai-assistant` flag is off, or the provider failed/timed out. */
export class AiUnavailableError extends ApiRouteError {
  constructor(message = 'The AI service is temporarily unavailable.') {
    super('AI_PROVIDER_UNAVAILABLE', message, { status: 503 });
    this.name = 'AiUnavailableError';
  }
}

/**
 * Deliberately NOT an `ApiRouteError`: an unregistered `AI_PROVIDER` name, or a sandbox adapter
 * under `NODE_ENV=production`, means the DEPLOYMENT is wrong. It surfaces as spec 004's generic
 * `INTERNAL_ERROR` 500 plus a stderr log rather than as a graceful degradation, because silently
 * carrying on is exactly the failure master spec §132.21 forbids (spec 033 §3.5 step 2).
 */
export class AiProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiProviderConfigurationError';
  }
}

/**
 * Spec 033 §3.9 — the graceful-degradation predicate. A consumer catches on exactly these three
 * and falls back to its documented non-AI path; nothing else is swallowed, so a misconfiguration
 * or a programming error still surfaces.
 */
export function isAiDegradable(error: unknown): boolean {
  return (
    error instanceof AiRateLimitedError || error instanceof AiQuotaExceededError || error instanceof AiUnavailableError
  );
}
