/**
 * Spec 033 §3.5/§4 — usage accounting, the rolling-window quota reads, the admin aggregate and the
 * retention sweep.
 *
 * Every row records WHAT KIND of call happened, never what was said: this module writes no prompt
 * and no response, and logs neither (`lib/ai/boundary.test.ts` enforces it).
 */
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { AI_TASKS, aiUsageEvents } from '@/lib/db/schema';
import type { AiUsageSummaryDto, AiUsageTotals } from '@/lib/types/ai';
import { AI_USAGE_RETENTION_BATCH_LIMIT, aiUsageRetentionDays } from './config';
import { estimateAiCostMinorUnits, aiCostAlertThresholds } from './cost';
import { aiCostCurrencyCode } from './config';
import type { AiSubject, AiTask } from './types';

export interface RecordAiUsageInput {
  task: AiTask;
  subject: AiSubject;
  providerName: string;
  modelName: string;
  outcome: 'succeeded' | 'rejected' | 'failed';
  rejectionReason?: 'rate_limited' | 'quota_exceeded';
  tokensUsed?: number;
  cached?: boolean;
  latencyMs?: number;
  inputFingerprint?: string | null;
}

function subjectColumns(subject: AiSubject): { subjectKind: 'user' | 'guest' | 'system'; userId: string | null; subjectHash: string | null } {
  switch (subject.kind) {
    case 'user':
      return { subjectKind: 'user', userId: subject.userId, subjectHash: null };
    case 'guest':
      return { subjectKind: 'guest', userId: null, subjectHash: subject.ipHash };
    case 'system':
      return { subjectKind: 'system', userId: null, subjectHash: null };
  }
}

/**
 * Best-effort by design (spec 033 §3.9): accounting is observability, not the transaction. If the
 * database is unreachable, the AI call it describes must still succeed and the workflow above it
 * must still complete — master spec §94's "do not break critical transactional workflows because
 * of an AI limit" applies just as much to the bookkeeping as to the limit itself. The failure is
 * logged so it is never silent.
 */
export async function recordAiUsage(event: RecordAiUsageInput): Promise<void> {
  try {
    await getDb()
      .insert(aiUsageEvents)
      .values({
        task: event.task,
        ...subjectColumns(event.subject),
        providerName: event.providerName,
        modelName: event.modelName,
        outcome: event.outcome,
        rejectionReason: event.rejectionReason ?? null,
        tokensUsed: event.tokensUsed ?? 0,
        cached: event.cached ?? false,
        latencyMs: event.latencyMs ?? null,
        inputFingerprint: event.inputFingerprint ?? null,
      });
  } catch (err) {
    console.error(JSON.stringify({ event: 'ai.usage_record_failed', task: event.task, error: String(err) }));
  }
}

/** A subject's `WHERE` fragment. `system` rows carry no reference, so they are matched by kind. */
function subjectPredicate(subject: AiSubject) {
  switch (subject.kind) {
    case 'user':
      return eq(aiUsageEvents.userId, subject.userId);
    case 'guest':
      return and(eq(aiUsageEvents.subjectKind, 'guest'), eq(aiUsageEvents.subjectHash, subject.ipHash));
    case 'system':
      return eq(aiUsageEvents.subjectKind, 'system');
  }
}

export interface RollingUsage {
  requests: number;
  tokens: number;
}

/**
 * The subject's accounted requests and real tokens since `since`. Cached hits count as requests
 * and contribute zero tokens (the DB CHECK guarantees `tokens_used = 0` when `cached`), which is
 * exactly the accounting spec 033 §3.8 specifies.
 *
 * THROWS on a database error rather than reporting zero usage. A quota that cannot be read is not
 * a quota with room left, and `completeAi` step 4 turns that throw into `AI_QUOTA_EXCEEDED` —
 * spec 033 §3.5's fail-closed policy. Reporting zeros here would silently suspend the daily
 * request and token ceilings for exactly as long as the database was unreachable.
 */
export async function rollingUsageSince(subject: AiSubject, since: Date): Promise<RollingUsage> {
  const [row] = await getDb()
    .select({
      requests: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${aiUsageEvents.tokensUsed}), 0)::int`,
    })
    .from(aiUsageEvents)
    .where(and(subjectPredicate(subject), gte(aiUsageEvents.createdAt, since)));
  return { requests: row?.requests ?? 0, tokens: row?.tokens ?? 0 };
}

/** Rejected attempts by this subject since `since` — abuse signal S2's input. */
export async function rejectionsSince(subject: AiSubject, since: Date): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(aiUsageEvents)
    .where(and(subjectPredicate(subject), eq(aiUsageEvents.outcome, 'rejected'), gte(aiUsageEvents.createdAt, since)));
  return row?.count ?? 0;
}

/** The largest number of events sharing one fingerprint for this subject since `since` — S3's input. */
export async function maxIdenticalInputsSince(subject: AiSubject, since: Date): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(aiUsageEvents)
    .where(
      and(subjectPredicate(subject), isNotNull(aiUsageEvents.inputFingerprint), gte(aiUsageEvents.createdAt, since)),
    )
    .groupBy(aiUsageEvents.inputFingerprint)
    .orderBy(sql`count(*) desc`)
    .limit(1);
  return rows[0]?.count ?? 0;
}

/** Every distinct subject with at least one event since `since` — the abuse evaluator's work list. */
export async function distinctSubjectsSince(since: Date): Promise<AiSubject[]> {
  const rows = await getDb()
    .selectDistinct({
      subjectKind: aiUsageEvents.subjectKind,
      userId: aiUsageEvents.userId,
      subjectHash: aiUsageEvents.subjectHash,
    })
    .from(aiUsageEvents)
    .where(gte(aiUsageEvents.createdAt, since));

  const subjects: AiSubject[] = [];
  for (const row of rows) {
    if (row.subjectKind === 'user' && row.userId) subjects.push({ kind: 'user', userId: row.userId });
    else if (row.subjectKind === 'guest' && row.subjectHash) subjects.push({ kind: 'guest', ipHash: row.subjectHash });
  }
  // A `system` subject has no per-caller identity to flag and is not quota-capped, so it is not an
  // abuse-review candidate; its cost is watched by the cost alerts instead.
  return subjects;
}

const EMPTY_TOTALS = (): AiUsageTotals => ({ requests: 0, tokens: 0 });

/**
 * Spec 033 §3.11/AC-6 — the admin aggregate. Returns counts, token totals, derived cost and
 * per-task/per-provider breakdowns ONLY: no `userId`, no `subject_hash`, no `input_fingerprint`,
 * no prompt and no response. Identifying a specific abusive subject is spec 038's job, done from
 * the `ai.abuse_signal` events in `security_events`.
 */
export async function getAiUsageSummary(range: { from: Date; to: Date }): Promise<AiUsageSummaryDto> {
  const rows = await getDb()
    .select({
      task: aiUsageEvents.task,
      providerName: aiUsageEvents.providerName,
      outcome: aiUsageEvents.outcome,
      cached: aiUsageEvents.cached,
      requests: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${aiUsageEvents.tokensUsed}), 0)::int`,
    })
    .from(aiUsageEvents)
    .where(and(gte(aiUsageEvents.createdAt, range.from), lt(aiUsageEvents.createdAt, range.to)))
    .groupBy(aiUsageEvents.task, aiUsageEvents.providerName, aiUsageEvents.outcome, aiUsageEvents.cached);

  // Spec 033 §3.11 — `byTask` is TOTAL over the closed `AiTask` union: every key is seeded, so a
  // task with no traffic in the range reports an honest zero instead of vanishing from the DTO.
  const byTask = Object.fromEntries(AI_TASKS.map((task) => [task, EMPTY_TOTALS()])) as Record<AiTask, AiUsageTotals>;
  const byProvider: Record<string, AiUsageTotals> = {};
  let totalRequests = 0;
  let succeededRequests = 0;
  let rejectedRequests = 0;
  let failedRequests = 0;
  let cachedRequests = 0;
  let totalTokens = 0;

  for (const row of rows) {
    totalRequests += row.requests;
    totalTokens += row.tokens;
    if (row.outcome === 'succeeded') succeededRequests += row.requests;
    else if (row.outcome === 'rejected') rejectedRequests += row.requests;
    else failedRequests += row.requests;
    if (row.cached) cachedRequests += row.requests;

    const task = byTask[row.task];
    task.requests += row.requests;
    task.tokens += row.tokens;

    const provider = (byProvider[row.providerName] ??= EMPTY_TOTALS());
    provider.requests += row.requests;
    provider.tokens += row.tokens;
  }

  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    totalRequests,
    succeededRequests,
    rejectedRequests,
    failedRequests,
    cachedRequests,
    totalTokens,
    estimatedCostMinorUnits: estimateAiCostMinorUnits(totalTokens),
    currencyCode: aiCostCurrencyCode(),
    byTask,
    byProvider,
    costAlertThresholds: aiCostAlertThresholds(),
  };
}

/**
 * Spec 033 §4 "Retention and privacy" — deletes rows past `AI_USAGE_RETENTION_DAYS`. Batched, so
 * one invocation is bounded and the next run is the continuation; idempotent and retry-safe.
 */
export async function sweepAiUsageRetention(now = new Date()): Promise<{ deleted: number }> {
  const cutoff = new Date(now.getTime() - aiUsageRetentionDays() * 24 * 60 * 60 * 1000);
  const deleted = await getDb()
    .delete(aiUsageEvents)
    .where(
      sql`${aiUsageEvents.id} in (select id from ${aiUsageEvents} where created_at < ${cutoff} limit ${AI_USAGE_RETENTION_BATCH_LIMIT})`,
    )
    .returning({ id: aiUsageEvents.id });
  return { deleted: deleted.length };
}
