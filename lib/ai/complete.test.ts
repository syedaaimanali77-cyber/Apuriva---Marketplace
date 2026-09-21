/**
 * Spec 033 §3.5 — `completeAi()`'s SEVEN-STEP ORDER, as a unit test.
 *
 * Every collaborator is mocked, so this file needs no database, no `AUTH_SECRET` and no provider:
 * it asserts the CONTROL FLOW the spec fixes, which is precisely the part an integration test
 * cannot isolate. `lib/ai/complete.integration.test.ts` still covers the same behaviours end to
 * end against real rows; neither file replaces the other.
 *
 * The step order is load-bearing, not incidental. Each step is a control that only works if the
 * ones before it have already run: resolving a provider before the kill switch would reach a
 * vendor while AI is meant to be off; reading the cache before the quota would let a capped
 * subject keep being served; calling the provider before either would spend money nothing
 * authorised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  isAiAssistantEnabled: vi.fn(),
  resolveAiProvider: vi.fn(),
  checkRateLimit: vi.fn(),
  rollingUsageSince: vi.fn(),
  recordAiUsage: vi.fn(),
  isCacheableTask: vi.fn(),
  aiCacheKey: vi.fn(),
  aiInputFingerprint: vi.fn(),
  readAiCache: vi.fn(),
  writeAiCache: vi.fn(),
  providerComplete: vi.fn(),
}));

vi.mock('./feature-flags', () => ({ isAiAssistantEnabled: mocks.isAiAssistantEnabled }));
vi.mock('./provider', () => ({ resolveAiProvider: mocks.resolveAiProvider }));
vi.mock('@/lib/api/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock('./usage', () => ({
  rollingUsageSince: mocks.rollingUsageSince,
  recordAiUsage: mocks.recordAiUsage,
}));
vi.mock('./cache', () => ({
  isCacheableTask: mocks.isCacheableTask,
  aiCacheKey: mocks.aiCacheKey,
  aiInputFingerprint: mocks.aiInputFingerprint,
  readAiCache: mocks.readAiCache,
  writeAiCache: mocks.writeAiCache,
}));

import { completeAi, resetAiRejectionDedupe } from './complete';
import { AiProviderConfigurationError, AiQuotaExceededError, AiRateLimitedError, AiUnavailableError } from './errors';
import type { AiSubject } from './types';

const USER: AiSubject = { kind: 'user', userId: '11111111-1111-4111-8111-111111111111' };
const SYSTEM: AiSubject = { kind: 'system', label: 'search_intent' };

/** The full seven steps, in the order §3.5 fixes them. */
const HAPPY_PATH_ORDER = [
  '1:flag',
  '2:provider',
  '3:rate-limit',
  '4:quota',
  '5:cache-read',
  '6:provider.complete',
  '7:cache-write',
  '7:record',
];

function stubProvider() {
  return {
    name: 'stub',
    model: 'stub-1',
    isSandbox: false,
    promptVersion: 'v1',
    complete: mocks.providerComplete,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  resetAiRejectionDedupe();

  mocks.isAiAssistantEnabled.mockImplementation(() => {
    mocks.order.push('1:flag');
    return true;
  });
  mocks.resolveAiProvider.mockImplementation(() => {
    mocks.order.push('2:provider');
    return stubProvider();
  });
  mocks.checkRateLimit.mockImplementation(() => {
    mocks.order.push('3:rate-limit');
    return { allowed: true, retryAfterSeconds: 0 };
  });
  mocks.rollingUsageSince.mockImplementation(async () => {
    mocks.order.push('4:quota');
    return { requests: 0, tokens: 0 };
  });
  mocks.isCacheableTask.mockReturnValue(true);
  mocks.aiCacheKey.mockReturnValue('cache-key');
  mocks.aiInputFingerprint.mockReturnValue('fingerprint');
  mocks.readAiCache.mockImplementation(() => {
    mocks.order.push('5:cache-read');
    return null;
  });
  mocks.providerComplete.mockImplementation(async () => {
    mocks.order.push('6:provider.complete');
    return { output: '{"area":"gulberg"}', tokensUsed: 12 };
  });
  mocks.writeAiCache.mockImplementation(() => {
    mocks.order.push('7:cache-write');
  });
  mocks.recordAiUsage.mockImplementation(async () => {
    mocks.order.push('7:record');
  });
});

afterEach(() => {
  delete process.env.AI_MAX_TOKENS_PER_REQUEST;
});

describe('spec 033 §3.5 — completeAi step order', () => {
  it('runs all seven steps in the fixed order, and accounts the call only after it succeeded', async () => {
    const result = await completeAi({ task: 'search_intent', input: 'plumber in gulberg', subject: USER });

    expect(mocks.order).toEqual(HAPPY_PATH_ORDER);
    expect(result).toEqual({ output: '{"area":"gulberg"}', tokensUsed: 12, cached: false });
    expect(mocks.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded', tokensUsed: 12, cached: false }),
    );
  });

  it('stops at step 1 when the kill switch is off — no provider is ever resolved', async () => {
    mocks.isAiAssistantEnabled.mockImplementation(() => {
      mocks.order.push('1:flag');
      return false;
    });

    await expect(completeAi({ task: 'conversation', input: 'hi', subject: USER })).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    // Disabled means no call happened at all: nothing resolved, nothing accounted, no cost implied.
    expect(mocks.order).toEqual(['1:flag']);
    expect(mocks.resolveAiProvider).not.toHaveBeenCalled();
    expect(mocks.recordAiUsage).not.toHaveBeenCalled();
  });

  it('stops at step 2 on a misconfigured provider, before the caller is even rate-limited', async () => {
    mocks.resolveAiProvider.mockImplementation(() => {
      mocks.order.push('2:provider');
      throw new AiProviderConfigurationError('AI_PROVIDER="nope" is not a known AI provider.');
    });

    await expect(completeAi({ task: 'conversation', input: 'hi', subject: USER })).rejects.toBeInstanceOf(
      AiProviderConfigurationError,
    );
    expect(mocks.order).toEqual(['1:flag', '2:provider']);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.recordAiUsage).not.toHaveBeenCalled();
  });

  it('stops at step 3 when rate-limited — the quota is never read and the provider is never called', async () => {
    mocks.checkRateLimit.mockImplementation(() => {
      mocks.order.push('3:rate-limit');
      return { allowed: false, retryAfterSeconds: 7 };
    });

    await expect(completeAi({ task: 'search_intent', input: 'plumber', subject: USER })).rejects.toBeInstanceOf(
      AiRateLimitedError,
    );
    expect(mocks.order).toEqual(['1:flag', '2:provider', '3:rate-limit', '7:record']);
    expect(mocks.rollingUsageSince).not.toHaveBeenCalled();
    expect(mocks.providerComplete).not.toHaveBeenCalled();
    expect(mocks.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'rejected', rejectionReason: 'rate_limited' }),
    );
  });

  it('records at most one rejected row per subject per window, however many attempts are made', async () => {
    mocks.checkRateLimit.mockReturnValue({ allowed: false, retryAfterSeconds: 60 });

    for (let i = 0; i < 5; i += 1) {
      await expect(completeAi({ task: 'search_intent', input: 'plumber', subject: USER })).rejects.toBeInstanceOf(
        AiRateLimitedError,
      );
    }
    // Without this bound a rate-limited caller could still drive one database write per attempt.
    expect(mocks.recordAiUsage).toHaveBeenCalledTimes(1);
  });

  it('stops at step 4 when over quota — the cache is never read and the provider is never called', async () => {
    mocks.rollingUsageSince.mockImplementation(async () => {
      mocks.order.push('4:quota');
      return { requests: 10_000, tokens: 0 };
    });

    await expect(completeAi({ task: 'search_intent', input: 'plumber', subject: USER })).rejects.toBeInstanceOf(
      AiQuotaExceededError,
    );
    expect(mocks.order).toEqual(['1:flag', '2:provider', '3:rate-limit', '4:quota', '7:record']);
    expect(mocks.readAiCache).not.toHaveBeenCalled();
    expect(mocks.providerComplete).not.toHaveBeenCalled();
  });

  it('skips step 4 entirely for a system subject, which is rate-limited but not quota-capped', async () => {
    await completeAi({ task: 'search_intent', input: 'plumber', subject: SYSTEM });

    expect(mocks.rollingUsageSince).not.toHaveBeenCalled();
    expect(mocks.order).toEqual([
      '1:flag',
      '2:provider',
      '3:rate-limit',
      '5:cache-read',
      '6:provider.complete',
      '7:cache-write',
      '7:record',
    ]);
  });

  it('stops at step 5 on a cache hit — the provider is never called, and the hit costs no tokens', async () => {
    mocks.readAiCache.mockImplementation(() => {
      mocks.order.push('5:cache-read');
      return { output: 'cached output', tokensUsed: 99 };
    });

    const result = await completeAi({ task: 'search_intent', input: 'plumber', subject: USER });

    expect(mocks.order).toEqual(['1:flag', '2:provider', '3:rate-limit', '4:quota', '5:cache-read', '7:record']);
    expect(result).toEqual({ output: 'cached output', tokensUsed: 0, cached: true });
    expect(mocks.providerComplete).not.toHaveBeenCalled();
    expect(mocks.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded', cached: true, tokensUsed: 0 }),
    );
  });

  it('never looks a non-cacheable task up or stores it, but still runs every other step', async () => {
    mocks.isCacheableTask.mockReturnValue(false);

    await completeAi({ task: 'conversation', input: 'hello', subject: USER });

    expect(mocks.aiCacheKey).not.toHaveBeenCalled();
    expect(mocks.readAiCache).not.toHaveBeenCalled();
    expect(mocks.writeAiCache).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(['1:flag', '2:provider', '3:rate-limit', '4:quota', '6:provider.complete', '7:record']);
  });

  it('records a failed attempt when the provider throws, and degrades rather than leaking its error', async () => {
    mocks.providerComplete.mockImplementation(async () => {
      mocks.order.push('6:provider.complete');
      throw new Error('vendor said: your prompt was "plumber in gulberg"');
    });

    const thrown = await completeAi({ task: 'search_intent', input: 'plumber', subject: USER }).catch((err) => err);

    expect(thrown).toBeInstanceOf(AiUnavailableError);
    // The provider's own message could quote the prompt back — it must never reach the caller.
    expect(String(thrown)).not.toContain('plumber');
    expect(mocks.writeAiCache).not.toHaveBeenCalled();
    expect(mocks.recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });

  it('clamps maxTokens DOWN to AI_MAX_TOKENS_PER_REQUEST and never up', async () => {
    process.env.AI_MAX_TOKENS_PER_REQUEST = '50';

    await completeAi({ task: 'search_intent', input: 'plumber', subject: USER, maxTokens: 5_000 });
    expect(mocks.providerComplete).toHaveBeenLastCalledWith(expect.objectContaining({ maxTokens: 50 }));

    await completeAi({ task: 'search_intent', input: 'plumber', subject: USER, maxTokens: 10 });
    expect(mocks.providerComplete).toHaveBeenLastCalledWith(expect.objectContaining({ maxTokens: 10 }));
  });
});

describe('spec 033 §3.5 — the quota read FAILS CLOSED', () => {
  it('rejects with AI_QUOTA_EXCEEDED when the rolling-quota read throws', async () => {
    mocks.rollingUsageSince.mockImplementation(async () => {
      mocks.order.push('4:quota');
      throw new Error('connection terminated unexpectedly');
    });

    const thrown = await completeAi({ task: 'search_intent', input: 'plumber', subject: USER }).catch((err) => err);

    // A quota that cannot be READ is not a quota with room left. Reporting zero usage here would
    // suspend the daily request and token ceilings for as long as the database was unreachable.
    expect(thrown).toBeInstanceOf(AiQuotaExceededError);
    expect(thrown.code).toBe('AI_QUOTA_EXCEEDED');
    expect(thrown.status).toBe(429);
    expect(mocks.order).toEqual(['1:flag', '2:provider', '3:rate-limit', '4:quota', '7:record']);
  });

  it('never reaches the cache or the provider when the quota cannot be verified', async () => {
    mocks.rollingUsageSince.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(completeAi({ task: 'search_intent', input: 'plumber', subject: USER })).rejects.toBeInstanceOf(
      AiQuotaExceededError,
    );
    expect(mocks.readAiCache).not.toHaveBeenCalled();
    expect(mocks.providerComplete).not.toHaveBeenCalled();
    expect(mocks.writeAiCache).not.toHaveBeenCalled();
  });

  it('records the fail-closed rejection as quota_exceeded, so abuse signal S2 can see it', async () => {
    mocks.rollingUsageSince.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(completeAi({ task: 'search_intent', input: 'plumber', subject: USER })).rejects.toBeInstanceOf(
      AiQuotaExceededError,
    );
    expect(mocks.recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'rejected', rejectionReason: 'quota_exceeded' }),
    );
  });

  it('remains degradable, so a consumer still falls back to its non-AI path', async () => {
    mocks.rollingUsageSince.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const thrown = await completeAi({ task: 'search_intent', input: 'plumber', subject: USER }).catch((err) => err);
    const { isAiDegradable } = await import('./errors');

    expect(isAiDegradable(thrown)).toBe(true);
  });

  it('degrades a system subject too — it is not quota-capped, so no read happens to fail', async () => {
    mocks.rollingUsageSince.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(completeAi({ task: 'search_intent', input: 'plumber', subject: SYSTEM })).resolves.toEqual(
      expect.objectContaining({ cached: false }),
    );
    expect(mocks.rollingUsageSince).not.toHaveBeenCalled();
  });
});
