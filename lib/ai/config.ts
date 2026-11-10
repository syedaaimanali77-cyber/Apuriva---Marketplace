/**
 * Spec 033 §3.7 "Configuration" — the operational knobs, kept in parity with `.env.example` by
 * `npm run check:env`. Server-side configuration, not feature flags (spec 041 owns those).
 *
 * Read fresh on every call so a test (or an operator) changing a value is honoured immediately. An
 * unset or malformed numeric value falls back to the documented default rather than failing an AI
 * request — the same posture as `lib/notifications/config.ts`. `AI_PROVIDER` is the one exception
 * and lives in `lib/ai/provider/index.ts`: a WRONG name throws, because silently serving a
 * different provider than the operator configured is what master spec §132.21 forbids.
 */

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** Master spec §94 "time limits" — the ceiling on one provider call. */
export function aiRequestTimeoutMs(): number {
  return positiveInt(process.env.AI_REQUEST_TIMEOUT_MS, 15_000);
}

/** Per-call token ceiling; a caller's `maxTokens` is clamped DOWN to it, never up. */
export function aiMaxTokensPerRequest(): number {
  return positiveInt(process.env.AI_MAX_TOKENS_PER_REQUEST, 2_000);
}

/** Rolling 24h request quota for an authenticated user. */
export function aiMaxRequestsPerDay(): number {
  return positiveInt(process.env.AI_MAX_REQUESTS_PER_DAY, 200);
}

/** Rolling 24h token quota for an authenticated user. A cache hit consumes none. */
export function aiMaxTokensPerDay(): number {
  return positiveInt(process.env.AI_MAX_TOKENS_PER_DAY, 100_000);
}

/** Rolling 24h request quota for one guest IP hash. */
export function aiGuestMaxRequestsPerDay(): number {
  return positiveInt(process.env.AI_GUEST_MAX_REQUESTS_PER_DAY, 40);
}

/** Rolling 24h token quota for one guest IP hash. */
export function aiGuestMaxTokensPerDay(): number {
  return positiveInt(process.env.AI_GUEST_MAX_TOKENS_PER_DAY, 20_000);
}

export function aiCacheTtlSeconds(): number {
  return positiveInt(process.env.AI_CACHE_TTL_SECONDS, 3_600);
}

export function aiCacheMaxEntries(): number {
  return positiveInt(process.env.AI_CACHE_MAX_ENTRIES, 1_000);
}

/** `0` until a real provider and its price are known — cost then reads 0 rather than a guess. */
export function aiCostPer1kTokensMinorUnits(): number {
  return nonNegativeInt(process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS, 0);
}

export function aiCostCurrencyCode(): string {
  const raw = (process.env.AI_COST_CURRENCY_CODE ?? '').trim();
  return /^[A-Z]{3}$/.test(raw) ? raw : 'PKR';
}

/** Rs. 5,000 per UTC day. */
export function aiDailyCostAlertMinorUnits(): number {
  return positiveInt(process.env.AI_DAILY_COST_ALERT_MINOR_UNITS, 500_000);
}

/** Rs. 100,000 per calendar month. */
export function aiMonthlyCostAlertMinorUnits(): number {
  return positiveInt(process.env.AI_MONTHLY_COST_ALERT_MINOR_UNITS, 10_000_000);
}

/** Token-volume alert — the meaningful one while the cost rate is still `0`. */
export function aiDailyTokenAlert(): number {
  return positiveInt(process.env.AI_DAILY_TOKEN_ALERT, 500_000);
}

/** Abuse signal S1 threshold. */
export function aiAbuseRequestsPerHour(): number {
  return positiveInt(process.env.AI_ABUSE_REQUESTS_PER_HOUR, 120);
}

/** Abuse signal S2 threshold. */
export function aiAbuseRejectionsPerDay(): number {
  return positiveInt(process.env.AI_ABUSE_REJECTIONS_PER_DAY, 20);
}

/** Abuse signal S3 threshold. */
export function aiAbuseIdenticalInputsPerHour(): number {
  return positiveInt(process.env.AI_ABUSE_IDENTICAL_INPUTS_PER_HOUR, 50);
}

/** Abuse signal S4: the fraction of a subject's DAILY token quota burned within ONE hour. */
export const AI_ABUSE_TOKEN_BURN_FRACTION = 0.8;

/** Days an `ai_usage_events` row is kept. This window, not spec 008's anonymisation, is what
 * removes the user linkage — the table holds no exportable personal content (spec 033 §4). */
export function aiUsageRetentionDays(): number {
  return positiveInt(process.env.AI_USAGE_RETENTION_DAYS, 90);
}

/** Rows one retention pass deletes; the next run is the continuation. */
export const AI_USAGE_RETENTION_BATCH_LIMIT = 500;
