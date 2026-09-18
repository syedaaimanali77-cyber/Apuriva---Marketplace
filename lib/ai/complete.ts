/**
 * Spec 033 §3.5 — `completeAi()`, the single entry point every AI-consuming module uses. No module
 * outside `lib/ai` ever touches a provider adapter (AC-1); swapping providers is an `AI_PROVIDER`
 * change (AC-2).
 *
 * The seven steps below run in this fixed order, and each step's failure mode is part of the
 * contract. Nothing here writes or logs the prompt or the response.
 */
import { checkRateLimit } from '@/lib/api/rate-limit';
import { aiCacheKey, aiInputFingerprint, isCacheableTask, readAiCache, writeAiCache } from './cache';
import { aiGuestMaxRequestsPerDay, aiGuestMaxTokensPerDay, aiMaxRequestsPerDay, aiMaxTokensPerDay, aiMaxTokensPerRequest, aiRequestTimeoutMs } from './config';
import { AiQuotaExceededError, AiRateLimitedError, AiUnavailableError } from './errors';
import { isAiAssistantEnabled } from './feature-flags';
import { resolveAiProvider } from './provider';
import type { AiCompletionRequest, AiCompletionResult, AiSubject } from './types';
import { subjectKey } from './types';
import { recordAiUsage, rollingUsageSince } from './usage';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A rejected attempt is still recorded (abuse signal S2 reads them), but at most ONCE per subject
 * per rate-limit window: without that bound a caller being rate-limited could still drive one
 * database write per attempt, which is an amplifier rather than a control.
 */
const rejectionRecordedUntil = new Map<string, number>();

function shouldRecordRejection(key: string, windowMs: number): boolean {
  const now = Date.now();
  const until = rejectionRecordedUntil.get(key);
  if (until !== undefined && until > now) return false;
  rejectionRecordedUntil.set(key, now + windowMs);
  return true;
}

/** Test-only: clears the rejection de-duplication windows. */
export function resetAiRejectionDedupe(): void {
  rejectionRecordedUntil.clear();
}

function quotasFor(subject: AiSubject): { requests: number; tokens: number } | null {
  switch (subject.kind) {
    case 'user':
      return { requests: aiMaxRequestsPerDay(), tokens: aiMaxTokensPerDay() };
    case 'guest':
      return { requests: aiGuestMaxRequestsPerDay(), tokens: aiGuestMaxTokensPerDay() };
    case 'system':
      // Not quota-capped (spec 033 §3.7): no end user to protect and no route to drive it through.
      // Still rate-limited, accounted and cost-monitored like any other subject.
      return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`AI provider timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function completeAi(request: AiCompletionRequest): Promise<AiCompletionResult> {
  // 1. Flag — the platform-wide kill switch (master spec §119).
  if (!isAiAssistantEnabled()) throw new AiUnavailableError('AI is disabled.');

  // 2. Provider resolution. An `AiProviderConfigurationError` from here is deliberately NOT caught
  //    anywhere in this function: a misconfigured deployment must be loud, not degraded.
  const provider = resolveAiProvider();
  const key = subjectKey(request.subject);
  const fingerprint = aiInputFingerprint(request.task, request.input);
  const accounting = {
    task: request.task,
    subject: request.subject,
    providerName: provider.name,
    modelName: provider.model,
    inputFingerprint: fingerprint,
  };

  // 3. Rate limit — the existing in-process fixed-window limiter, `ai` domain (20 / 60s).
  const limit = checkRateLimit('ai', key);
  if (!limit.allowed) {
    if (shouldRecordRejection(`rate:${key}`, Math.max(1, limit.retryAfterSeconds) * 1000)) {
      await recordAiUsage({ ...accounting, outcome: 'rejected', rejectionReason: 'rate_limited' });
    }
    throw new AiRateLimitedError(limit.retryAfterSeconds);
  }

  // 4. Quota — rolling 24h requests and real tokens for this subject.
  const quotas = quotasFor(request.subject);
  if (quotas) {
    const used = await rollingUsageSince(request.subject, new Date(Date.now() - DAY_MS));
    if (used.requests >= quotas.requests || used.tokens >= quotas.tokens) {
      if (shouldRecordRejection(`quota:${key}`, 60_000)) {
        await recordAiUsage({ ...accounting, outcome: 'rejected', rejectionReason: 'quota_exceeded' });
      }
      throw new AiQuotaExceededError(
        used.requests >= quotas.requests ? 'Daily AI request quota exceeded.' : 'Daily AI token quota exceeded.',
      );
    }
  }

  // 5. Cache — cacheable tasks only. A hit consumes the rate-limit window and the daily REQUEST
  //    quota (step 4 already counted it) but no tokens, so it costs nothing.
  const cacheable = isCacheableTask(request.task);
  const cacheKey = cacheable
    ? aiCacheKey({
        providerName: provider.name,
        model: provider.model,
        promptVersion: provider.promptVersion,
        task: request.task,
        input: request.input,
      })
    : null;
  if (cacheKey) {
    const hit = readAiCache(cacheKey);
    if (hit) {
      await recordAiUsage({ ...accounting, outcome: 'succeeded', tokensUsed: 0, cached: true, latencyMs: 0 });
      return { output: hit.output, tokensUsed: 0, cached: true };
    }
  }

  // 6. Provider call — `maxTokens` clamped DOWN to the per-request ceiling, under a timeout.
  const maxTokens = Math.max(1, Math.min(request.maxTokens ?? aiMaxTokensPerRequest(), aiMaxTokensPerRequest()));
  const startedAt = Date.now();
  let completion;
  try {
    completion = await withTimeout(
      provider.complete({ task: request.task, input: request.input, maxTokens }),
      aiRequestTimeoutMs(),
    );
  } catch (err) {
    await recordAiUsage({ ...accounting, outcome: 'failed', latencyMs: Date.now() - startedAt });
    // The provider's own error text could quote the prompt back — never propagate or log it.
    console.error(JSON.stringify({ event: 'ai.provider_failed', task: request.task, provider: provider.name }));
    throw new AiUnavailableError();
  }

  // 7. Store and account.
  const tokensUsed = Math.max(0, Math.round(completion.tokensUsed));
  if (cacheKey) writeAiCache(cacheKey, { output: completion.output, tokensUsed });
  await recordAiUsage({
    ...accounting,
    outcome: 'succeeded',
    tokensUsed,
    cached: false,
    latencyMs: Date.now() - startedAt,
  });

  return { output: completion.output, tokensUsed, cached: false };
}
