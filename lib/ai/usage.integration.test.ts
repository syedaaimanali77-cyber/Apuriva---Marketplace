import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAiUsageSummary, sweepAiUsageRetention } from './usage';
import { createAiUser, isDatabaseReachable, resetAiState, seedUsage, uniqueGuest, usageRowsFor } from './ai-test-support';
import type { AiSubject } from './types';

const dbReachable = await isDatabaseReachable();
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Spec 033 §3.11/§4 — the admin aggregate and the retention sweep.
 *
 * `getAiUsageSummary` is a WHOLE-TABLE aggregate over a time range, and integration files run in
 * parallel worker threads against one shared `*_test` database. Truncating the table would delete
 * rows another suite is mid-way through asserting on, so each summary test instead anchors its
 * fixtures in a FUTURE window of its own: nothing else writes there, and the retention sweep only
 * ever deletes rows in the past, so the window is genuinely private to this test.
 */
describe.skipIf(!dbReachable)('AI usage accounting (spec 033, integration)', () => {
  const savedRate = process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS;
  const savedRetention = process.env.AI_USAGE_RETENTION_DAYS;

  /** A private, far-future window. The offsets are days, so no two tests can overlap. */
  function window(daysAhead: number): { at: Date; from: Date; to: Date } {
    const at = new Date(Date.now() + daysAhead * DAY_MS);
    return { at, from: new Date(at.getTime() - DAY_MS / 2), to: new Date(at.getTime() + DAY_MS / 2) };
  }

  beforeEach(() => resetAiState());

  afterEach(() => {
    if (savedRate === undefined) delete process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS;
    else process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = savedRate;
    if (savedRetention === undefined) delete process.env.AI_USAGE_RETENTION_DAYS;
    else process.env.AI_USAGE_RETENTION_DAYS = savedRetention;
  });

  it('aggregates by outcome, task and provider, and derives cost from the configured rate', async () => {
    process.env.AI_COST_PER_1K_TOKENS_MINOR_UNITS = '100';
    const { at, from, to } = window(400);
    const user: AiSubject = { kind: 'user', userId: await createAiUser() };
    const guest = uniqueGuest();

    await seedUsage(user, { task: 'search_intent', count: 2, tokensUsed: 500, createdAt: at });
    await seedUsage(user, { task: 'search_intent', count: 1, cached: true, createdAt: at });
    await seedUsage(guest, { task: 'conversation', count: 1, tokensUsed: 1_000, providerName: 'other-vendor', createdAt: at });
    await seedUsage(guest, { task: 'conversation', count: 1, outcome: 'rejected', rejectionReason: 'rate_limited', createdAt: at });
    await seedUsage(guest, { task: 'conversation', count: 1, outcome: 'failed', createdAt: at });

    const summary = await getAiUsageSummary({ from, to });

    expect(summary.totalRequests).toBe(6);
    expect(summary.succeededRequests).toBe(4);
    expect(summary.rejectedRequests).toBe(1);
    expect(summary.failedRequests).toBe(1);
    expect(summary.cachedRequests).toBe(1);
    expect(summary.totalTokens).toBe(2_000);
    expect(summary.estimatedCostMinorUnits).toBe(200);
    expect(summary.currencyCode).toBe('PKR');
    // `byTask` is TOTAL over the closed AiTask union (spec 033 §3.11): the three untrafficked
    // tasks report an honest zero rather than being absent, so spec 040 can reuse this DTO
    // without handling a missing key.
    expect(summary.byTask).toEqual({
      search_intent: { requests: 3, tokens: 1_000 },
      conversation: { requests: 3, tokens: 1_000 },
      faq_draft: { requests: 0, tokens: 0 },
      summarization: { requests: 0, tokens: 0 },
      translation: { requests: 0, tokens: 0 },
    });
    // Five sandbox rows (two billed search_intent, one cached, one rejected, one failed) and the
    // single `other-vendor` row — a rejected or failed attempt is still attributed to the provider
    // it was routed to.
    expect(summary.byProvider).toEqual({
      sandbox: { requests: 5, tokens: 1_000 },
      'other-vendor': { requests: 1, tokens: 1_000 },
    });
    expect(summary.costAlertThresholds).toEqual({
      dailyMinorUnits: 500_000,
      monthlyMinorUnits: 10_000_000,
      dailyTokens: 500_000,
    });
  });

  it('exposes no user identifier, guest hash, fingerprint, prompt or response (AC-6)', async () => {
    const { at, from, to } = window(402);
    const user: AiSubject = { kind: 'user', userId: await createAiUser() };
    const guest = uniqueGuest();
    await seedUsage(user, { tokensUsed: 10, inputFingerprint: 'f'.repeat(64), createdAt: at });
    await seedUsage(guest, { tokensUsed: 10, inputFingerprint: 'e'.repeat(64), createdAt: at });

    const summary = await getAiUsageSummary({ from, to });
    const serialised = JSON.stringify(summary);

    expect(summary.totalRequests).toBe(2);
    expect(serialised).not.toContain(user.kind === 'user' ? user.userId : 'unreachable');
    expect(serialised).not.toContain(guest.kind === 'guest' ? guest.ipHash : 'unreachable');
    expect(serialised).not.toContain('f'.repeat(64));
    expect(serialised).not.toMatch(/prompt|response|inputFingerprint|subjectHash|userId/i);
  });

  it('honours the requested range: `from` inclusive, `to` exclusive', async () => {
    const { at, from, to } = window(404);
    const user: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(user, { tokensUsed: 5, createdAt: new Date(from.getTime() - 1000) }); // just before `from`
    await seedUsage(user, { tokensUsed: 7, createdAt: from }); // exactly `from` — inclusive
    await seedUsage(user, { tokensUsed: 9, createdAt: to }); // exactly `to` — exclusive
    await seedUsage(user, { tokensUsed: 11, createdAt: at });

    const summary = await getAiUsageSummary({ from, to });
    expect(summary.totalRequests).toBe(2);
    expect(summary.totalTokens).toBe(18);
  });

  it('an empty range is an honest zero, never a fabricated figure', async () => {
    const { from, to } = window(406);
    const summary = await getAiUsageSummary({ from, to });
    expect(summary.totalRequests).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.estimatedCostMinorUnits).toBe(0);
    // Every task key is still present, each an honest zero — an empty period is reported, not
    // omitted. `byProvider` stays open-ended, so a provider with no traffic is simply absent.
    expect(summary.byTask).toEqual({
      search_intent: { requests: 0, tokens: 0 },
      faq_draft: { requests: 0, tokens: 0 },
      conversation: { requests: 0, tokens: 0 },
      summarization: { requests: 0, tokens: 0 },
      translation: { requests: 0, tokens: 0 },
    });
    expect(summary.byProvider).toEqual({});
  });

  it('the retention sweep deletes only rows past the window, and is idempotent', async () => {
    process.env.AI_USAGE_RETENTION_DAYS = '90';
    const user: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(user, { count: 3, tokensUsed: 1, createdAt: new Date(Date.now() - 100 * DAY_MS) });
    await seedUsage(user, { count: 2, tokensUsed: 1 });

    // Other suites may have their own expired rows, so assert on this subject's rows rather than a
    // global count: its three expired rows go, its two recent ones stay.
    const firstPass = await sweepAiUsageRetention();
    expect(firstPass.deleted).toBeGreaterThanOrEqual(3);
    expect(await usageRowsFor(user)).toHaveLength(2);

    // A second pass finds nothing of this subject's left to do.
    await sweepAiUsageRetention();
    expect(await usageRowsFor(user)).toHaveLength(2);
  });
});
