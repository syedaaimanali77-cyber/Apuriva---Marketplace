/**
 * Spec 033 — shared fixtures for this domain's suites. Writes only to the isolated `*_test`
 * database Vitest points `DATABASE_URL` at (test/db-reset.ts); never the developer's own.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { aiUsageEvents, securityEvents, users } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetAiCache } from './cache';
import { resetAiRejectionDedupe } from './complete';
import type { AiSubject, AiTask } from './types';

export { isDatabaseReachable } from '@/lib/db/test-support';

/** Clears every in-process control surface so suites don't leak state into each other. */
export function resetAiState(): void {
  resetRateLimitState();
  resetAiCache();
  resetAiRejectionDedupe();
}

export async function createAiUser(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ email: `ai-${randomUUID()}@example.test` })
    .returning({ id: users.id });
  return row!.id;
}

/** A guest subject with an IP hash unique to the calling test, so its rolling window is isolated. */
export function uniqueGuest(): AiSubject {
  return { kind: 'guest', ipHash: randomUUID().replace(/-/g, '') };
}

export interface SeedUsageOptions {
  task?: AiTask;
  outcome?: 'succeeded' | 'rejected' | 'failed';
  rejectionReason?: 'rate_limited' | 'quota_exceeded';
  tokensUsed?: number;
  cached?: boolean;
  inputFingerprint?: string | null;
  createdAt?: Date;
  count?: number;
  providerName?: string;
  modelName?: string;
}

/**
 * Writes usage rows directly, bypassing `completeAi`, so a test can put a subject at an arbitrary
 * point in its rolling window without making that many real calls. Test-only: production code
 * never fabricates a usage row (spec 033 §4).
 */
export async function seedUsage(subject: AiSubject, options: SeedUsageOptions = {}): Promise<void> {
  const count = options.count ?? 1;
  const outcome = options.outcome ?? 'succeeded';
  const values = Array.from({ length: count }, () => ({
    task: options.task ?? ('search_intent' as AiTask),
    subjectKind: subject.kind,
    userId: subject.kind === 'user' ? subject.userId : null,
    subjectHash: subject.kind === 'guest' ? subject.ipHash : null,
    providerName: options.providerName ?? 'sandbox',
    modelName: options.modelName ?? 'rule-based',
    outcome,
    rejectionReason: outcome === 'rejected' ? (options.rejectionReason ?? 'rate_limited') : null,
    tokensUsed: options.cached ? 0 : (options.tokensUsed ?? 0),
    cached: options.cached ?? false,
    inputFingerprint: options.inputFingerprint ?? null,
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  }));
  await getDb().insert(aiUsageEvents).values(values);
}

export interface UsageRow {
  task: string;
  subjectKind: string;
  userId: string | null;
  subjectHash: string | null;
  providerName: string;
  modelName: string;
  outcome: string;
  rejectionReason: string | null;
  tokensUsed: number;
  cached: boolean;
  latencyMs: number | null;
  inputFingerprint: string | null;
}

export async function usageRowsFor(subject: AiSubject): Promise<UsageRow[]> {
  const where =
    subject.kind === 'user'
      ? eq(aiUsageEvents.userId, subject.userId)
      : subject.kind === 'guest'
        ? and(eq(aiUsageEvents.subjectKind, 'guest'), eq(aiUsageEvents.subjectHash, subject.ipHash))
        : eq(aiUsageEvents.subjectKind, 'system');
  return getDb()
    .select({
      task: aiUsageEvents.task,
      subjectKind: aiUsageEvents.subjectKind,
      userId: aiUsageEvents.userId,
      subjectHash: aiUsageEvents.subjectHash,
      providerName: aiUsageEvents.providerName,
      modelName: aiUsageEvents.modelName,
      outcome: aiUsageEvents.outcome,
      rejectionReason: aiUsageEvents.rejectionReason,
      tokensUsed: aiUsageEvents.tokensUsed,
      cached: aiUsageEvents.cached,
      latencyMs: aiUsageEvents.latencyMs,
      inputFingerprint: aiUsageEvents.inputFingerprint,
    })
    .from(aiUsageEvents)
    .where(where)
    .orderBy(aiUsageEvents.createdAt) as unknown as Promise<UsageRow[]>;
}

/** Security events of one type written since `since` — how an abuse/cost flag is observed. */
export async function securityEventsOfType(
  eventType: string,
  since: Date,
): Promise<{ severity: string; metadata: Record<string, unknown> }[]> {
  const rows = await getDb()
    .select({ severity: securityEvents.severity, metadata: securityEvents.metadata })
    .from(securityEvents)
    .where(and(eq(securityEvents.eventType, eventType), gte(securityEvents.createdAt, since)));
  return rows.map((row) => ({ severity: row.severity as string, metadata: (row.metadata ?? {}) as Record<string, unknown> }));
}

