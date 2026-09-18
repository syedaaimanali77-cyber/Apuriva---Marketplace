/**
 * Spec 033 §8 "Abuse signals" / AC-5 — the deterministic MVP signal set.
 *
 * Every signal is a plain count against a configured threshold over `ai_usage_events`, so any flag
 * is reproducible from the table alone; NO MODEL IS INVOLVED in deciding it. A flag is an input to
 * a human review and nothing else: it never blocks, throttles, suspends, bans or otherwise changes
 * the subject's access or limits (master spec §132.11, §132.17). Spec 038 later reads these rows
 * into its moderation queue; until it exists they live in `security_events`, the same interim
 * store `lib/admin-rbac/audit.ts` already uses.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { securityEvents } from '@/lib/db/schema';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import {
  AI_ABUSE_TOKEN_BURN_FRACTION,
  aiAbuseIdenticalInputsPerHour,
  aiAbuseRejectionsPerDay,
  aiAbuseRequestsPerHour,
  aiGuestMaxTokensPerDay,
  aiMaxTokensPerDay,
} from './config';
import type { AiSubject } from './types';
import { subjectKey } from './types';
import { distinctSubjectsSince, maxIdenticalInputsSince, rejectionsSince, rollingUsageSince } from './usage';

export const AI_ABUSE_EVENT_TYPE = 'ai.abuse_signal';

export type AiAbuseSignal = 'volume' | 'rejection_pressure' | 'repetition' | 'token_burn';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function dailyTokenQuota(subject: AiSubject): number {
  return subject.kind === 'guest' ? aiGuestMaxTokensPerDay() : aiMaxTokensPerDay();
}

/** The UTC day a flag is deduplicated within. */
function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function alreadyFlagged(subject: AiSubject, signal: AiAbuseSignal, dayKey: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: securityEvents.id })
    .from(securityEvents)
    .where(
      sql`${securityEvents.eventType} = ${AI_ABUSE_EVENT_TYPE}
          and ${securityEvents.metadata}->>'signal' = ${signal}
          and ${securityEvents.metadata}->>'subject' = ${subjectKey(subject)}
          and ${securityEvents.metadata}->>'utcDay' = ${dayKey}`,
    )
    .limit(1);
  return row !== undefined;
}

/**
 * One `security_events` row per (subject, signal, UTC day). Metadata carries the signal name,
 * subject kind, subject reference, window bounds, observed value and threshold — no prompt, no
 * response, no fingerprint (spec 033 §4 "Retention and privacy").
 */
async function flag(
  subject: AiSubject,
  signal: AiAbuseSignal,
  observed: number,
  threshold: number,
  window: { start: Date; end: Date },
  now: Date,
): Promise<boolean> {
  const dayKey = utcDayKey(now);
  if (await alreadyFlagged(subject, signal, dayKey)) return false;
  await recordSecurityEvent({
    userId: subject.kind === 'user' ? subject.userId : null,
    eventType: AI_ABUSE_EVENT_TYPE,
    severity: 'warning',
    metadata: {
      signal,
      subjectKind: subject.kind,
      subject: subjectKey(subject),
      utcDay: dayKey,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      observed,
      threshold,
      // Stated on the record itself so nobody downstream mistakes a signal for a decision.
      enforcement: 'none',
    },
  });
  return true;
}

/** Evaluates all four signals for one subject. Returns the signals newly flagged by this run. */
export async function evaluateAiAbuseForSubject(subject: AiSubject, now = new Date()): Promise<AiAbuseSignal[]> {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const flagged: AiAbuseSignal[] = [];

  // S1 volume — more than N events in the last hour.
  const lastHour = await rollingUsageSince(subject, hourAgo);
  const s1 = aiAbuseRequestsPerHour();
  if (lastHour.requests > s1 && (await flag(subject, 'volume', lastHour.requests, s1, { start: hourAgo, end: now }, now))) {
    flagged.push('volume');
  }

  // S2 rejection pressure — at least N rejected attempts in the last 24h.
  const rejections = await rejectionsSince(subject, dayAgo);
  const s2 = aiAbuseRejectionsPerDay();
  if (rejections >= s2 && (await flag(subject, 'rejection_pressure', rejections, s2, { start: dayAgo, end: now }, now))) {
    flagged.push('rejection_pressure');
  }

  // S3 repetition — at least N events sharing one input fingerprint in the last hour.
  const repeats = await maxIdenticalInputsSince(subject, hourAgo);
  const s3 = aiAbuseIdenticalInputsPerHour();
  if (repeats >= s3 && (await flag(subject, 'repetition', repeats, s3, { start: hourAgo, end: now }, now))) {
    flagged.push('repetition');
  }

  // S4 token burn — more than 80% of the DAILY token quota consumed within ONE hour.
  const burnThreshold = Math.floor(dailyTokenQuota(subject) * AI_ABUSE_TOKEN_BURN_FRACTION);
  if (
    lastHour.tokens > burnThreshold &&
    (await flag(subject, 'token_burn', lastHour.tokens, burnThreshold, { start: hourAgo, end: now }, now))
  ) {
    flagged.push('token_burn');
  }

  return flagged;
}

/**
 * The hourly pass: every subject with activity in the last 24 hours (S2's widest window) is
 * evaluated. `system` subjects are excluded by `distinctSubjectsSince` — they have no per-caller
 * identity to flag and are watched by the cost alerts instead.
 */
export async function evaluateAiAbuseSignals(now = new Date()): Promise<{ evaluated: number; flagged: number }> {
  const subjects = await distinctSubjectsSince(new Date(now.getTime() - DAY_MS));
  let flagged = 0;
  for (const subject of subjects) {
    flagged += (await evaluateAiAbuseForSubject(subject, now)).length;
  }
  return { evaluated: subjects.length, flagged };
}
