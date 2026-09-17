/**
 * Spec 025 §4 "Retention and privacy" — the historical retention window.
 *
 * Server-side configuration, using exactly the idiom spec 008 established for
 * `DELETION_GRACE_PERIOD_DAYS`. Spec 041 owns feature flags (per-environment booleans), not policy
 * numbers, so this is not a flag. Legal/Product confirm the value before production; changing it is a
 * config change, not a code change.
 */
import { DEFAULT_MESSAGE_RETENTION_DAYS, MIN_MESSAGE_RETENTION_DAYS } from './limits';

export function getMessageRetentionDays(): number {
  const raw = process.env.MESSAGE_RETENTION_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return DEFAULT_MESSAGE_RETENTION_DAYS;
  // A floor, so a misconfiguration cannot destroy a conversation that is still operationally relevant.
  return Math.max(parsed, MIN_MESSAGE_RETENTION_DAYS);
}
