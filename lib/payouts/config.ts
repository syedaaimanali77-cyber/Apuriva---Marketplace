/**
 * Spec 024 §9 "Environment" — the operational knobs, each an environment variable with a documented
 * default, handled exactly like spec 022's `REFUND_AMBIGUITY_ESCALATION_MINUTES`. Not a feature-flag
 * system (spec 041 owns that). Read fresh on every call so tests can vary them.
 *
 * `PLATFORM_FEE_BPS` and `PAYOUT_PROVIDER` are deliberately NOT here: both refuse a default
 * (`lib/payouts/fees.ts`, `lib/payments/provider/payout-factory.ts`).
 */

function nonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveInt(name: string, fallback: number): number {
  const value = nonNegativeInt(name, fallback);
  return value > 0 ? value : fallback;
}

export const DEFAULT_PAYOUT_MINIMUM_MINOR_UNITS = 0;
export const DEFAULT_PAYOUT_BATCH_CLOSE_INTERVAL_HOURS = 24;
export const DEFAULT_PAYOUT_AMBIGUITY_ESCALATION_MINUTES = 60;
export const DEFAULT_PAYOUT_MAX_AUTOMATIC_ATTEMPTS = 3;
export const DEFAULT_PAYOUT_RETRY_BACKOFF_MINUTES = 30;
export const DEFAULT_PAYOUT_ATTEMPT_GRACE_MINUTES = 15;
export const DEFAULT_PAYOUT_STALE_PENDING_HOURS = 168;
export const DEFAULT_PAYOUT_NEGATIVE_BALANCE_ALERT_DAYS = 30;
export const DEFAULT_STATEMENT_MAX_RANGE_DAYS = 366;
export const DEFAULT_STATEMENT_MAX_ROWS = 5000;

/** Batches process at most this many rows per pass, so one cron invocation stays bounded. */
export const PAYOUT_SWEEP_BATCH_LIMIT = 200;

export function payoutMinimumMinorUnits(): number {
  return nonNegativeInt('PAYOUT_MINIMUM_MINOR_UNITS', DEFAULT_PAYOUT_MINIMUM_MINOR_UNITS);
}

export function payoutBatchCloseIntervalHours(): number {
  return nonNegativeInt('PAYOUT_BATCH_CLOSE_INTERVAL_HOURS', DEFAULT_PAYOUT_BATCH_CLOSE_INTERVAL_HOURS);
}

export function payoutAmbiguityEscalationMinutes(): number {
  return positiveInt('PAYOUT_AMBIGUITY_ESCALATION_MINUTES', DEFAULT_PAYOUT_AMBIGUITY_ESCALATION_MINUTES);
}

export function payoutMaxAutomaticAttempts(): number {
  return positiveInt('PAYOUT_MAX_AUTOMATIC_ATTEMPTS', DEFAULT_PAYOUT_MAX_AUTOMATIC_ATTEMPTS);
}

export function payoutRetryBackoffMinutes(): number {
  return nonNegativeInt('PAYOUT_RETRY_BACKOFF_MINUTES', DEFAULT_PAYOUT_RETRY_BACKOFF_MINUTES);
}

/**
 * How long an attempt must have been `processing` before its outcome may be resolved by an
 * idempotency-key lookup. A live worker may still be inside its rail call before this; a key lookup
 * then would wrongly report `transfer_not_received` for a transfer that is about to happen (§3.8).
 */
export function payoutAttemptGraceMinutes(): number {
  return nonNegativeInt('PAYOUT_ATTEMPT_GRACE_MINUTES', DEFAULT_PAYOUT_ATTEMPT_GRACE_MINUTES);
}

export function payoutStalePendingHours(): number {
  return positiveInt('PAYOUT_STALE_PENDING_HOURS', DEFAULT_PAYOUT_STALE_PENDING_HOURS);
}

export function payoutNegativeBalanceAlertDays(): number {
  return positiveInt('PAYOUT_NEGATIVE_BALANCE_ALERT_DAYS', DEFAULT_PAYOUT_NEGATIVE_BALANCE_ALERT_DAYS);
}

export function statementMaxRangeDays(): number {
  return positiveInt('STATEMENT_MAX_RANGE_DAYS', DEFAULT_STATEMENT_MAX_RANGE_DAYS);
}

export function statementMaxRows(): number {
  return positiveInt('STATEMENT_MAX_ROWS', DEFAULT_STATEMENT_MAX_ROWS);
}

/** The two failure codes the sweep retries on its own, because the rail authoritatively holds no transfer. */
export const AUTOMATICALLY_RETRYABLE_FAILURE_CODES = ['rail_temporarily_unavailable', 'transfer_not_received'] as const;

/** Retried automatically only once the provider has set a different usable default method. */
export const DESTINATION_FAILURE_CODES = ['destination_invalid', 'destination_unavailable'] as const;
