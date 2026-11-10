/**
 * Spec 033 §3.8 "Caching" — deterministic key derivation and the in-process TTL/LRU store.
 *
 * Nothing here is written to the database or to disk, so NO AI OUTPUT EXISTS AT REST. Entries
 * expire, are evicted by the LRU bound, or die with the process; there is no explicit
 * invalidation API and none is needed.
 */
import { createHash, createHmac } from 'node:crypto';
import { deriveKey } from '@/lib/auth/secret';
import { aiCacheMaxEntries, aiCacheTtlSeconds } from './config';
import type { AiTask } from './types';

/**
 * Exactly one cacheable task for MVP. `search_intent` is a pure function of public,
 * non-personalised free text, it is the highest-volume AI path in the product, and its output
 * contains nothing user-specific.
 *
 * `faq_draft` and `conversation` are admin-/user-scoped and personalised; `summarization` and
 * `translation` have no MVP consumer to tune a cache for. A task joins this set only once its
 * output is proven to depend on nothing but `input` — which is also why the cache key below
 * carries no subject identifier, and why one user can never be served another's output.
 */
const CACHEABLE_TASKS: ReadonlySet<AiTask> = new Set<AiTask>(['search_intent']);

export function isCacheableTask(task: AiTask): boolean {
  return CACHEABLE_TASKS.has(task);
}

/** Unicode NFKC, trim, collapse internal whitespace runs to one space, lowercase. */
export function normaliseAiInput(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const UNIT_SEPARATOR = '\x1f';

/**
 * `sha256(provider ∥ model ∥ promptVersion ∥ task ∥ normalise(input))`, hex.
 *
 * Provider, model and prompt version are in the key, so changing any of them strands the previous
 * entries instead of reusing them across a boundary where they are no longer valid.
 */
export function aiCacheKey(parts: {
  providerName: string;
  model: string;
  promptVersion: string;
  task: AiTask;
  input: string;
}): string {
  return createHash('sha256')
    .update(
      [parts.providerName, parts.model, parts.promptVersion, parts.task, normaliseAiInput(parts.input)].join(
        UNIT_SEPARATOR,
      ),
    )
    .digest('hex');
}

/**
 * Spec 033 §4 "Retention and privacy" — the value stored in `ai_usage_events.input_fingerprint`.
 * KEYED with the application's server secret rather than plainly hashed, so a short input cannot
 * be recovered by dictionary attack. Never returned by any endpoint, never exported, never shown
 * to an admin; it exists only so abuse signal S3 can count identical repeated inputs.
 */
export function aiInputFingerprint(task: AiTask, input: string): string {
  return createHmac('sha256', deriveKey('ai-input-fingerprint'))
    .update([task, normaliseAiInput(input)].join(UNIT_SEPARATOR))
    .digest('hex');
}

interface CacheEntry {
  output: string;
  tokensUsed: number;
  expiresAt: number;
}

/** Insertion-ordered, so the oldest key is the first one `Map` iteration yields — that plus
 * delete-then-set on read gives LRU eviction without a second data structure. */
const entries = new Map<string, CacheEntry>();

export function readAiCache(key: string): { output: string; tokensUsed: number } | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return null;
  }
  // Refresh recency without changing the expiry: TTL is time-since-WRITE, not time-since-read.
  entries.delete(key);
  entries.set(key, entry);
  return { output: entry.output, tokensUsed: entry.tokensUsed };
}

export function writeAiCache(key: string, value: { output: string; tokensUsed: number }): void {
  const max = aiCacheMaxEntries();
  entries.delete(key);
  entries.set(key, { ...value, expiresAt: Date.now() + aiCacheTtlSeconds() * 1000 });
  while (entries.size > max) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/** Test-only: clears the store so suites don't leak cached completions into each other. */
export function resetAiCache(): void {
  entries.clear();
}

/** Test/diagnostic only. */
export function aiCacheSize(): number {
  return entries.size;
}
