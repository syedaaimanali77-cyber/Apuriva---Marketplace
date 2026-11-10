import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeAi } from './complete';
import { AiQuotaExceededError, isAiDegradable } from './errors';
import { createAiUser, isDatabaseReachable, resetAiState, seedUsage, uniqueGuest, usageRowsFor } from './ai-test-support';
import type { AiSubject } from './types';

const dbReachable = await isDatabaseReachable();
const HOUR_MS = 60 * 60 * 1000;

/** Spec 033 AC-3 — the rolling-24h request and token quotas, per user and per guest. */
describe.skipIf(!dbReachable)('AI quotas (spec 033 AC-3, integration)', () => {
  const KEYS = [
    'AI_MAX_REQUESTS_PER_DAY',
    'AI_MAX_TOKENS_PER_DAY',
    'AI_GUEST_MAX_REQUESTS_PER_DAY',
    'AI_GUEST_MAX_TOKENS_PER_DAY',
  ] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => resetAiState());

  afterEach(() => {
    resetAiState();
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects past the rolling 24h REQUEST quota with AI_QUOTA_EXCEEDED', async () => {
    process.env.AI_MAX_REQUESTS_PER_DAY = '3';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 3, tokensUsed: 1 });

    let thrown: unknown;
    try {
      await completeAi({ task: 'conversation', input: 'over quota', subject });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AiQuotaExceededError);
    expect((thrown as AiQuotaExceededError).code).toBe('AI_QUOTA_EXCEEDED');
    expect((thrown as AiQuotaExceededError).status).toBe(429);
    expect((thrown as AiQuotaExceededError).message).toMatch(/request quota/);
    expect(isAiDegradable(thrown)).toBe(true);
  });

  it('rejects past the rolling 24h TOKEN quota', async () => {
    process.env.AI_MAX_TOKENS_PER_DAY = '50';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 1, tokensUsed: 50 });

    await expect(completeAi({ task: 'conversation', input: 'over tokens', subject })).rejects.toThrow(/token quota/);
  });

  it('records the rejection so abuse signal S2 can see it, with the right reason', async () => {
    process.env.AI_MAX_REQUESTS_PER_DAY = '1';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 1, tokensUsed: 1 });
    await expect(completeAi({ task: 'conversation', input: 'nope', subject })).rejects.toBeInstanceOf(
      AiQuotaExceededError,
    );

    const rejected = (await usageRowsFor(subject)).filter((row) => row.outcome === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.rejectionReason).toBe('quota_exceeded');
    expect(rejected[0]!.tokensUsed).toBe(0);
  });

  it('the window ROLLS: usage older than 24h no longer counts against the subject', async () => {
    process.env.AI_MAX_REQUESTS_PER_DAY = '2';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 5, tokensUsed: 10, createdAt: new Date(Date.now() - 25 * HOUR_MS) });

    const result = await completeAi({ task: 'conversation', input: 'fresh window', subject });
    expect(result.cached).toBe(false);
  });

  it('a guest gets its own, tighter quota, counted per IP hash', async () => {
    process.env.AI_GUEST_MAX_REQUESTS_PER_DAY = '2';
    const guest = uniqueGuest();
    const other = uniqueGuest();
    await seedUsage(guest, { count: 2, tokensUsed: 1 });

    await expect(completeAi({ task: 'conversation', input: 'blocked', subject: guest })).rejects.toBeInstanceOf(
      AiQuotaExceededError,
    );
    // A different guest is unaffected — the window is per subject, not global.
    await expect(completeAi({ task: 'conversation', input: 'fine', subject: other })).resolves.toMatchObject({
      cached: false,
    });
  });

  it('a system subject is rate-limited and accounted but not quota-capped', async () => {
    process.env.AI_MAX_REQUESTS_PER_DAY = '1';
    process.env.AI_GUEST_MAX_REQUESTS_PER_DAY = '1';
    const subject: AiSubject = { kind: 'system', label: `test-${Date.now()}` };
    // Well past any user/guest quota; a system caller has no end user to protect.
    for (let i = 0; i < 5; i += 1) {
      await expect(completeAi({ task: 'summarization', input: `system ${i}`, subject })).resolves.toBeTruthy();
    }
  });

  it('a cached hit costs a request but no tokens, so it cannot exhaust the token quota', async () => {
    process.env.AI_MAX_TOKENS_PER_DAY = '10000';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    const first = await completeAi({ task: 'search_intent', input: 'plumber tomorrow', subject });
    const second = await completeAi({ task: 'search_intent', input: 'plumber tomorrow', subject });
    expect(second.cached).toBe(true);

    const rows = await usageRowsFor(subject);
    expect(rows.map((row) => row.tokensUsed)).toEqual([first.tokensUsed, 0]);
  });
});
