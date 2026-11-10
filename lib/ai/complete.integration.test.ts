import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeAi } from './complete';
import { aiCacheKey, readAiCache, resetAiCache } from './cache';
import { AiProviderConfigurationError, AiRateLimitedError, AiUnavailableError, isAiDegradable } from './errors';
import { createAiUser, isDatabaseReachable, resetAiState, uniqueGuest, usageRowsFor } from './ai-test-support';
import type { AiSubject } from './types';

const dbReachable = await isDatabaseReachable();

/** Spec 033 §3.5 — the fixed step order of `completeAi`, and each step's documented failure mode. */
describe.skipIf(!dbReachable)('completeAi (spec 033 §3.5, integration)', () => {
  const saved = {
    provider: process.env.AI_PROVIDER,
    enabled: process.env.AI_ASSISTANT_ENABLED,
    maxTokens: process.env.AI_MAX_TOKENS_PER_REQUEST,
    nodeEnv: process.env.NODE_ENV,
  };

  /** `NODE_ENV` is typed readonly by @types/node — the same cast every other sandbox-guard suite
   * in this repository already uses (lib/files/scanning/sandbox.test.ts). */
  const setNodeEnv = (value: string | undefined) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = value;
  };

  beforeEach(() => resetAiState());

  afterEach(() => {
    resetAiState();
    for (const [key, value] of [
      ['AI_PROVIDER', saved.provider],
      ['AI_ASSISTANT_ENABLED', saved.enabled],
      ['AI_MAX_TOKENS_PER_REQUEST', saved.maxTokens],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setNodeEnv(saved.nodeEnv);
  });

  it('records a succeeded usage row carrying the provider, model, tokens and latency — and no content', async () => {
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    const result = await completeAi({ task: 'summarization', input: 'a sentence to summarise', subject });

    expect(result.cached).toBe(false);
    expect(result.tokensUsed).toBeGreaterThan(0);
    // The result itself exposes no provider identity — a customer can never learn it.
    expect(result).not.toHaveProperty('provider');
    expect(result).not.toHaveProperty('model');

    const rows = await usageRowsFor(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task: 'summarization',
      subjectKind: 'user',
      providerName: 'sandbox',
      modelName: 'rule-based',
      outcome: 'succeeded',
      cached: false,
      rejectionReason: null,
    });
    expect(rows[0]!.tokensUsed).toBe(result.tokensUsed);
    expect(rows[0]!.latencyMs).not.toBeNull();
    // A fingerprint, not the text: 64 hex characters that are not the input.
    expect(rows[0]!.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain('a sentence to summarise');
  });

  it('attributes a guest to its IP hash and never to a user id', async () => {
    const subject = uniqueGuest();
    await completeAi({ task: 'conversation', input: 'hello', subject });
    const rows = await usageRowsFor(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectKind).toBe('guest');
    expect(rows[0]!.userId).toBeNull();
    expect(rows[0]!.subjectHash).toBe(subject.kind === 'guest' ? subject.ipHash : null);
  });

  it('clamps maxTokens DOWN to AI_MAX_TOKENS_PER_REQUEST and never up', async () => {
    process.env.AI_MAX_TOKENS_PER_REQUEST = '5';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    const asked = await completeAi({
      task: 'summarization',
      input: 'a much longer sentence than five tokens could ever hold',
      subject,
      maxTokens: 10_000,
    });
    expect(asked.tokensUsed).toBeLessThanOrEqual(5);
  });

  it('rate limiting throws AI_RATE_LIMITED with retryAfterSeconds after 20 requests in the window', async () => {
    const subject = uniqueGuest();
    for (let i = 0; i < 20; i += 1) {
      await completeAi({ task: 'conversation', input: `call ${i}`, subject });
    }
    let thrown: unknown;
    try {
      await completeAi({ task: 'conversation', input: 'one too many', subject });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AiRateLimitedError);
    expect((thrown as AiRateLimitedError).code).toBe('AI_RATE_LIMITED');
    expect((thrown as AiRateLimitedError).status).toBe(429);
    expect((thrown as AiRateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    expect(isAiDegradable(thrown)).toBe(true);
  });

  it('records exactly one rejected row per rate-limit window, not one per rejected attempt', async () => {
    const subject = uniqueGuest();
    for (let i = 0; i < 20; i += 1) await completeAi({ task: 'conversation', input: `c${i}`, subject });
    for (let i = 0; i < 5; i += 1) {
      await expect(completeAi({ task: 'conversation', input: 'blocked', subject })).rejects.toBeInstanceOf(
        AiRateLimitedError,
      );
    }
    const rejected = (await usageRowsFor(subject)).filter((row) => row.outcome === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.rejectionReason).toBe('rate_limited');
  });

  it('the ai-assistant kill switch degrades every call, and the consuming workflow can catch it', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'false';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    let thrown: unknown;
    try {
      await completeAi({ task: 'search_intent', input: 'plumber', subject });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AiUnavailableError);
    expect((thrown as AiUnavailableError).status).toBe(503);
    expect(isAiDegradable(thrown)).toBe(true);
    // Disabled means no call happened at all: nothing is accounted, and no cost is implied.
    expect(await usageRowsFor(subject)).toHaveLength(0);
  });

  it('a misconfigured provider is LOUD, not degraded — it is never catchable as a degradation', async () => {
    process.env.AI_PROVIDER = 'not-a-provider';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    let thrown: unknown;
    try {
      await completeAi({ task: 'conversation', input: 'hello', subject });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AiProviderConfigurationError);
    expect(isAiDegradable(thrown)).toBe(false);
  });

  it('a sandbox provider under NODE_ENV=production refuses the call rather than faking a completion', async () => {
    process.env.AI_PROVIDER = 'sandbox';
    setNodeEnv('production');
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await expect(completeAi({ task: 'conversation', input: 'hello', subject })).rejects.toBeInstanceOf(
      AiProviderConfigurationError,
    );
    expect(await usageRowsFor(subject)).toHaveLength(0);
  });

  describe('caching (AC-4)', () => {
    it('a second identical cacheable call is served from cache: no tokens, cached=true', async () => {
      const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
      const first = await completeAi({ task: 'search_intent', input: 'plumber near Gulberg tomorrow', subject });
      const second = await completeAi({ task: 'search_intent', input: '  PLUMBER   near  gulberg tomorrow ', subject });

      expect(first.cached).toBe(false);
      expect(first.tokensUsed).toBeGreaterThan(0);
      expect(second.cached).toBe(true);
      expect(second.tokensUsed).toBe(0);
      expect(second.output).toBe(first.output);

      const rows = await usageRowsFor(subject);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ cached: true, tokensUsed: 0, outcome: 'succeeded' });
    });

    it('a non-cacheable task is never stored, so no personalised output can be reused', async () => {
      const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
      resetAiCache();
      await completeAi({ task: 'conversation', input: 'what did I book last week?', subject });
      const key = aiCacheKey({
        providerName: 'sandbox',
        model: 'rule-based',
        promptVersion: 'v1',
        task: 'conversation',
        input: 'what did I book last week?',
      });
      expect(readAiCache(key)).toBeNull();

      const second = await completeAi({ task: 'conversation', input: 'what did I book last week?', subject });
      expect(second.cached).toBe(false);
      expect(second.tokensUsed).toBeGreaterThan(0);
    });

    it('two different subjects share a cacheable answer, because it depends on nothing but the input', async () => {
      const a: AiSubject = { kind: 'user', userId: await createAiUser() };
      const b: AiSubject = { kind: 'user', userId: await createAiUser() };
      const first = await completeAi({ task: 'search_intent', input: 'electrician tomorrow', subject: a });
      const second = await completeAi({ task: 'search_intent', input: 'electrician tomorrow', subject: b });
      expect(second.cached).toBe(true);
      expect(second.output).toBe(first.output);
      // Each subject is still accounted separately.
      expect(await usageRowsFor(a)).toHaveLength(1);
      expect(await usageRowsFor(b)).toHaveLength(1);
    });
  });
});
