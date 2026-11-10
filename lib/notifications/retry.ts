/**
 * Spec 026 §3 "Delivery, retry and escalation" (AC-6) — the pure retry policy. No I/O here: the
 * dispatcher applies what this decides.
 *
 * | outcome     | critical category                                  | non-critical category        |
 * |-------------|----------------------------------------------------|------------------------------|
 * | delivered   | `delivered` (terminal)                             | same                         |
 * | failed      | `retrying`, backoff 2^attempts min, up to MAX; then `failed` + escalate + fall back | one retry, then `failed` quietly |
 * | unknown     | `retrying`, attempt counted — NEVER delivered or failed on a guess; at the ceiling it stops being auto-claimed and is escalated | same, without escalation |
 */
import { isCriticalCategory, OUTBOUND_CHANNELS, type NotificationCategory, type OutboundChannel } from '@/lib/types/notifications';
import type { ChannelOutcome } from './channels/types';
import { NON_CRITICAL_MAX_ATTEMPTS, notificationMaxAttempts } from './config';

export function maxAttemptsFor(category: NotificationCategory): number {
  return isCriticalCategory(category) ? notificationMaxAttempts() : NON_CRITICAL_MAX_ATTEMPTS;
}

/** Minutes to wait after the `attempts`-th attempt: 2, 4, 8, 16, … */
export function backoffMinutes(attempts: number): number {
  return 2 ** Math.max(1, attempts);
}

export type RetryDecision =
  | { status: 'delivered' }
  | { status: 'retrying'; retryInMinutes: number }
  /** `unknown` at the ceiling: stays `retrying` (never a guessed terminal), no longer auto-claimed. */
  | { status: 'retrying'; retryInMinutes: null; exhausted: true; escalate: boolean; fallback: boolean }
  | { status: 'failed'; exhausted: true; escalate: boolean; fallback: boolean };

/** `attempts` is the count INCLUDING the attempt that just produced `outcome`. */
export function decideAfterAttempt(category: NotificationCategory, outcome: ChannelOutcome, attempts: number): RetryDecision {
  if (outcome === 'delivered') return { status: 'delivered' };
  const critical = isCriticalCategory(category);
  const exhausted = attempts >= maxAttemptsFor(category);
  if (!exhausted) return { status: 'retrying', retryInMinutes: backoffMinutes(attempts) };
  if (outcome === 'unknown') {
    return { status: 'retrying', retryInMinutes: null, exhausted: true, escalate: critical, fallback: critical };
  }
  return { status: 'failed', exhausted: true, escalate: critical, fallback: critical };
}

/** The channels after `from` in the FIXED order push → email → sms. */
export function fallbackCandidates(from: OutboundChannel): OutboundChannel[] {
  return OUTBOUND_CHANNELS.slice(OUTBOUND_CHANNELS.indexOf(from) + 1);
}
