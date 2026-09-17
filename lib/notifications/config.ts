/**
 * Spec 026 §9 "Environment" — the operational knobs, kept in parity with `.env.example` by
 * `npm run check:env`. Server-side configuration, not feature flags (spec 041 owns those).
 *
 * Read fresh on every call so a test (or an operator) changing a value is honoured immediately. An
 * unset or invalid value falls back to the documented default rather than failing a notification.
 */

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** AC-6: attempts a CRITICAL delivery gets before it becomes `failed` (default 5). */
export function notificationMaxAttempts(): number {
  return positiveInt(process.env.NOTIFICATION_MAX_ATTEMPTS, 5);
}

/** AC-6: a non-critical delivery is retried at most once — one attempt plus one retry. */
export const NON_CRITICAL_MAX_ATTEMPTS = 2;

/** AC-5: promotional notifications allowed per rolling window (default 3). */
export function marketingMaxPerWindow(): number {
  return positiveInt(process.env.MARKETING_MAX_PER_WINDOW, 3);
}

/** AC-5: the rolling window, in days (default 7). */
export function marketingWindowDays(): number {
  return positiveInt(process.env.MARKETING_WINDOW_DAYS, 7);
}

/** §4 "Retention": READ notifications older than this are deleted (default 180). Unread never are. */
export function notificationRetentionDays(): number {
  return positiveInt(process.env.NOTIFICATION_RETENTION_DAYS, 180);
}

/** Rows one dispatch-sweep invocation claims; the next run is the continuation. */
export const DISPATCH_SWEEP_BATCH_LIMIT = 200;
/** Rows one retention pass deletes; the next run is the continuation. */
export const RETENTION_SWEEP_BATCH_LIMIT = 500;
