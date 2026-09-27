import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

/**
 * Spec 041 X-2, X-3, X-5 — the migrated gate sites honour the STORED value (X-1 and X-4 are covered
 * by kill-switch.integration.test.ts). Worker runs as `production` with `search-nl-interpretation`,
 * `home-personalization-v1` and `ai-fraud-signals` (no other spec 041 file changes those pairs).
 *
 * The home feed is `curated_popular` whenever personalization is skipped, so X-3 is proven by
 * whether the personalization read (recent searches) happens at all — a spy that passes through.
 */
const recent = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/search/recent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/search/recent')>();
  return {
    ...actual,
    listRecentSearches: async (...args: Parameters<typeof actual.listRecentSearches>) => {
      recent.calls += 1;
      return actual.listRecentSearches(...args);
    },
  };
});

const { POST: INTERPRET } = await import('@/app/api/v1/search/interpret/route');
const { recordFraudSignal, AiFraudSignalsDisabledError } = await import('@/lib/moderation/fraud-signals');
const { getHomeFeed } = await import('@/lib/home/feed');
const { registerAndLogin } = await import('@/app/api/v1/users/me/privacy-test-support');
const { getOptionalSession } = await import('@/lib/auth/require-session');
const { SESSION_COOKIE_NAME } = await import('@/lib/auth/session');
const { isDatabaseReachable, restoreStoredFlags, setStoredFlag, useFlagEnvironment } = await import('./feature-flags-test-support');

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('gate sites read the flag registry (spec 041 X-2, X-3, X-5)', { timeout: 120_000 }, () => {
  useFlagEnvironment('production');
  restoreStoredFlags([
    ['search-nl-interpretation', 'production'],
    ['home-personalization-v1', 'production'],
    ['ai-fraud-signals', 'production'],
  ]);

  it('X-2: search-nl-interpretation off → /search/interpret answers 422 INTERPRETATION_LOW_CONFIDENCE', async () => {
    await setStoredFlag('search-nl-interpretation', 'production', false);
    const res = await INTERPRET(
      new Request('http://localhost/api/v1/search/interpret', { method: 'POST', body: JSON.stringify({ text: 'plumber near Gulberg tomorrow' }) }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('INTERPRETATION_LOW_CONFIDENCE');
  });

  it('X-3: home-personalization-v1 off skips personalization entirely; on consults it', async () => {
    const user = await registerAndLogin();
    const session = await getOptionalSession(new Request('http://localhost/', { headers: { cookie: `${SESSION_COOKIE_NAME}=${user.sessionId}` } }));
    expect(session).not.toBeNull();

    await setStoredFlag('home-personalization-v1', 'production', false);
    recent.calls = 0;
    const off = await getHomeFeed(session);
    expect(recent.calls).toBe(0);
    expect(off.sections.map((s) => s.type)).toEqual(['curated_popular']);

    await setStoredFlag('home-personalization-v1', 'production', true);
    recent.calls = 0;
    await getHomeFeed(session);
    expect(recent.calls).toBe(1);
  });

  it('X-5: ai-fraud-signals off refuses an ai_assisted signal; on, the gate lets it through', async () => {
    const input = (target: string) => ({ targetUserId: target, source: 'ai_assisted' as const, ruleKey: `ai-${randomUUID().slice(0, 8)}`, observedCount: 1, threshold: 1, windowDays: 1 });
    await setStoredFlag('ai-fraud-signals', 'production', false);
    await expect(recordFraudSignal(input(randomUUID()))).rejects.toBeInstanceOf(AiFraudSignalsDisabledError);

    await setStoredFlag('ai-fraud-signals', 'production', true);
    // A non-existent target: the gate passes, and the insert then fails on its FK — so nothing is
    // left behind in the shared database, and the failure is provably not the flag's.
    const outcome = await recordFraudSignal(input(randomUUID())).catch((err: unknown) => err);
    expect(outcome).not.toBeInstanceOf(AiFraudSignalsDisabledError);
  });
});
