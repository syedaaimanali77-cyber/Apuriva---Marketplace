import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aiCacheKey,
  aiCacheSize,
  aiInputFingerprint,
  isCacheableTask,
  normaliseAiInput,
  readAiCache,
  resetAiCache,
  writeAiCache,
} from './cache';

const BASE = { providerName: 'sandbox', model: 'rule-based', promptVersion: 'v1', task: 'search_intent' as const };

/** Spec 033 AC-4 / §3.8 — the deterministic key, and the in-process TTL/LRU store. */
describe('lib/ai/cache (spec 033 AC-4)', () => {
  const originalTtl = process.env.AI_CACHE_TTL_SECONDS;
  const originalMax = process.env.AI_CACHE_MAX_ENTRIES;

  beforeEach(() => resetAiCache());
  afterEach(() => {
    resetAiCache();
    if (originalTtl === undefined) delete process.env.AI_CACHE_TTL_SECONDS;
    else process.env.AI_CACHE_TTL_SECONDS = originalTtl;
    if (originalMax === undefined) delete process.env.AI_CACHE_MAX_ENTRIES;
    else process.env.AI_CACHE_MAX_ENTRIES = originalMax;
  });

  it('search_intent is the only cacheable task', () => {
    expect(isCacheableTask('search_intent')).toBe(true);
    for (const task of ['faq_draft', 'conversation', 'summarization', 'translation'] as const) {
      expect(isCacheableTask(task)).toBe(false);
    }
  });

  it('normalises whitespace and case into one key', () => {
    expect(normaliseAiInput('  Plumber   NEAR  Gulberg ')).toBe('plumber near gulberg');
    expect(aiCacheKey({ ...BASE, input: 'Plumber near Gulberg' })).toBe(
      aiCacheKey({ ...BASE, input: '  plumber   NEAR  gulberg  ' }),
    );
  });

  it('a different provider, model, prompt version, task or input is a different key', () => {
    const base = aiCacheKey({ ...BASE, input: 'plumber' });
    expect(aiCacheKey({ ...BASE, providerName: 'other', input: 'plumber' })).not.toBe(base);
    expect(aiCacheKey({ ...BASE, model: 'other', input: 'plumber' })).not.toBe(base);
    expect(aiCacheKey({ ...BASE, promptVersion: 'v2', input: 'plumber' })).not.toBe(base);
    expect(aiCacheKey({ ...BASE, task: 'translation', input: 'plumber' })).not.toBe(base);
    expect(aiCacheKey({ ...BASE, input: 'electrician' })).not.toBe(base);
  });

  it('the key carries no subject identifier — it is derived from the request alone', () => {
    // There is no subject parameter to pass: a cacheable task is one whose output does not depend
    // on the caller, which is what makes cross-user reuse safe by construction.
    const key = aiCacheKey({ ...BASE, input: 'plumber' });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reuses a cacheable response within TTL and misses after it expires', async () => {
    process.env.AI_CACHE_TTL_SECONDS = '1';
    const key = aiCacheKey({ ...BASE, input: 'plumber' });
    writeAiCache(key, { output: '{"serviceNameRaw":"plumber"}', tokensUsed: 12 });
    expect(readAiCache(key)).toEqual({ output: '{"serviceNameRaw":"plumber"}', tokensUsed: 12 });

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(readAiCache(key)).toBeNull();
    // The expired entry is dropped rather than left to accumulate.
    expect(aiCacheSize()).toBe(0);
  });

  it('a miss on an unwritten key is null, never a fabricated answer', () => {
    expect(readAiCache(aiCacheKey({ ...BASE, input: 'never asked' }))).toBeNull();
  });

  it('evicts the least recently used entry past AI_CACHE_MAX_ENTRIES', () => {
    process.env.AI_CACHE_MAX_ENTRIES = '2';
    const a = aiCacheKey({ ...BASE, input: 'a' });
    const b = aiCacheKey({ ...BASE, input: 'b' });
    const c = aiCacheKey({ ...BASE, input: 'c' });
    writeAiCache(a, { output: 'A', tokensUsed: 1 });
    writeAiCache(b, { output: 'B', tokensUsed: 1 });
    // Touch `a` so `b` becomes the least recently used.
    readAiCache(a);
    writeAiCache(c, { output: 'C', tokensUsed: 1 });

    expect(aiCacheSize()).toBe(2);
    expect(readAiCache(a)?.output).toBe('A');
    expect(readAiCache(c)?.output).toBe('C');
    expect(readAiCache(b)).toBeNull();
  });

  it('the input fingerprint is a stable, keyed, non-reversible digest that is not the cache key', () => {
    const fingerprint = aiInputFingerprint('search_intent', 'Plumber near Gulberg');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Same normalisation as the cache key, so repeats are counted the same way...
    expect(aiInputFingerprint('search_intent', '  plumber   near   GULBERG ')).toBe(fingerprint);
    // ...but keyed with the server secret, so it is not the plain hash the cache key is.
    expect(fingerprint).not.toBe(aiCacheKey({ ...BASE, input: 'Plumber near Gulberg' }));
    expect(aiInputFingerprint('translation', 'Plumber near Gulberg')).not.toBe(fingerprint);
  });
});
