import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AI_ABUSE_EVENT_TYPE, evaluateAiAbuseForSubject, evaluateAiAbuseSignals } from './abuse';
import {
  createAiUser,
  isDatabaseReachable,
  resetAiState,
  securityEventsOfType,
  seedUsage,
  uniqueGuest,
  usageRowsFor,
} from './ai-test-support';
import type { AiSubject } from './types';
import { subjectKey } from './types';

const dbReachable = await isDatabaseReachable();
const MINUTE_MS = 60 * 1000;

/** Spec 033 AC-5 / §8 "Abuse signals" — the four deterministic signals, and what a flag is NOT. */
describe.skipIf(!dbReachable)('AI abuse signals (spec 033 AC-5, integration)', () => {
  const KEYS = [
    'AI_ABUSE_REQUESTS_PER_HOUR',
    'AI_ABUSE_REJECTIONS_PER_DAY',
    'AI_ABUSE_IDENTICAL_INPUTS_PER_HOUR',
    'AI_MAX_TOKENS_PER_DAY',
  ] as const;
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => resetAiState());

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** Only this subject's flags, so concurrent suites can't be mistaken for it. */
  async function flagsFor(subject: AiSubject, since: Date) {
    const events = await securityEventsOfType(AI_ABUSE_EVENT_TYPE, since);
    return events.filter((event) => event.metadata.subject === subjectKey(subject));
  }

  it('flags S1 volume: more than the configured requests per hour', async () => {
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '5';
    const since = new Date();
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 6, tokensUsed: 1 });

    expect(await evaluateAiAbuseForSubject(subject)).toContain('volume');
    const flags = await flagsFor(subject, since);
    const volume = flags.find((flag) => flag.metadata.signal === 'volume')!;
    expect(volume).toBeDefined();
    expect(volume.severity).toBe('warning');
    expect(volume.metadata).toMatchObject({ observed: 6, threshold: 5, subjectKind: 'user', enforcement: 'none' });
    expect(volume.metadata.windowStart).toBeTruthy();
    expect(volume.metadata.windowEnd).toBeTruthy();
  });

  it('does not flag S1 at exactly the threshold — only strictly above it', async () => {
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '5';
    const since = new Date();
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 5, tokensUsed: 1 });

    expect(await evaluateAiAbuseForSubject(subject)).not.toContain('volume');
    expect((await flagsFor(subject, since)).filter((f) => f.metadata.signal === 'volume')).toHaveLength(0);
  });

  it('flags S2 rejection pressure over the rolling 24h', async () => {
    process.env.AI_ABUSE_REJECTIONS_PER_DAY = '4';
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '1000';
    const since = new Date();
    const subject = uniqueGuest();
    await seedUsage(subject, { count: 4, outcome: 'rejected', rejectionReason: 'quota_exceeded' });

    expect(await evaluateAiAbuseForSubject(subject)).toContain('rejection_pressure');
    const flag = (await flagsFor(subject, since)).find((f) => f.metadata.signal === 'rejection_pressure')!;
    expect(flag.metadata).toMatchObject({ observed: 4, threshold: 4, subjectKind: 'guest' });
  });

  it('flags S3 repetition: the same input fingerprint repeated within the hour', async () => {
    process.env.AI_ABUSE_IDENTICAL_INPUTS_PER_HOUR = '3';
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '1000';
    const since = new Date();
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    const fingerprint = 'a'.repeat(64);
    await seedUsage(subject, { count: 3, tokensUsed: 1, inputFingerprint: fingerprint });
    // Two other distinct inputs must not add to the repeat count.
    await seedUsage(subject, { count: 2, tokensUsed: 1, inputFingerprint: 'b'.repeat(64) });

    expect(await evaluateAiAbuseForSubject(subject)).toContain('repetition');
    const flag = (await flagsFor(subject, since)).find((f) => f.metadata.signal === 'repetition')!;
    expect(flag.metadata).toMatchObject({ observed: 3, threshold: 3 });
    // The fingerprint itself is never written into the flag.
    expect(JSON.stringify(flag.metadata)).not.toContain(fingerprint);
  });

  it('flags S4 token burn: over 80% of the daily token quota inside one hour', async () => {
    process.env.AI_MAX_TOKENS_PER_DAY = '1000';
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '1000';
    const since = new Date();
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 1, tokensUsed: 801 });

    expect(await evaluateAiAbuseForSubject(subject)).toContain('token_burn');
    const flag = (await flagsFor(subject, since)).find((f) => f.metadata.signal === 'token_burn')!;
    expect(flag.metadata).toMatchObject({ observed: 801, threshold: 800 });
  });

  it('emits at most one row per subject, signal and UTC day', async () => {
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '2';
    const since = new Date();
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 3, tokensUsed: 1 });

    expect(await evaluateAiAbuseForSubject(subject)).toContain('volume');
    // Three more hourly passes over the same window must not add rows.
    for (let i = 0; i < 3; i += 1) {
      expect(await evaluateAiAbuseForSubject(subject)).not.toContain('volume');
    }
    expect((await flagsFor(subject, since)).filter((f) => f.metadata.signal === 'volume')).toHaveLength(1);
  });

  it('ignores activity outside the window: an hour-old burst is not a current volume signal', async () => {
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '2';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 10, tokensUsed: 1, createdAt: new Date(Date.now() - 90 * MINUTE_MS) });

    expect(await evaluateAiAbuseForSubject(subject)).toEqual([]);
  });

  it('changes NOTHING about the subject: a flag is a review input, not an enforcement decision', async () => {
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '1';
    const subject: AiSubject = { kind: 'user', userId: await createAiUser() };
    await seedUsage(subject, { count: 5, tokensUsed: 1 });
    const before = await usageRowsFor(subject);

    await evaluateAiAbuseForSubject(subject);

    // No usage row is altered, nothing is deleted, and the subject's own rows are untouched —
    // there is no throttle, block, suspension or ban anywhere in this path (master spec §132.11).
    expect(await usageRowsFor(subject)).toEqual(before);
  });

  it('the hourly pass evaluates every recently active user and guest, and no system subject', async () => {
    process.env.AI_ABUSE_REQUESTS_PER_HOUR = '1';
    const user: AiSubject = { kind: 'user', userId: await createAiUser() };
    const guest = uniqueGuest();
    const system: AiSubject = { kind: 'system', label: `sweep-${Date.now()}` };
    await seedUsage(user, { count: 2, tokensUsed: 1 });
    await seedUsage(guest, { count: 2, tokensUsed: 1 });
    await seedUsage(system, { count: 50, tokensUsed: 1 });
    const since = new Date();

    const result = await evaluateAiAbuseSignals();
    expect(result.evaluated).toBeGreaterThanOrEqual(2);

    const events = await securityEventsOfType(AI_ABUSE_EVENT_TYPE, since);
    const subjects = new Set(events.map((event) => event.metadata.subject));
    expect(subjects.has(subjectKey(user))).toBe(true);
    expect(subjects.has(subjectKey(guest))).toBe(true);
    // A system caller has no per-caller identity to flag; the cost alerts watch it instead.
    expect(subjects.has(subjectKey(system))).toBe(false);
  });
});
