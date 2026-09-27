import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Executor } from '@/lib/offers/db';
import { FEATURE_FLAG_REGISTRY } from './registry';
import { isFeatureEnabled, resolveClientFlags } from './resolve';

/**
 * Spec 041 §3.4 — the resolution order, with a fake executor: env override → stored value →
 * registry default (logged). A failed read throws. No database is touched.
 */
function executor(rows: unknown[] | Error): Executor & { calls: number } {
  const fake = {
    calls: 0,
    execute: async () => {
      fake.calls += 1;
      if (rows instanceof Error) throw rows;
      return { rows } as never;
    },
  };
  return fake as unknown as Executor & { calls: number };
}

const saved = { ...process.env };
const OVERRIDE_VARS = FEATURE_FLAG_REGISTRY.flatMap((f) => (f.overrideVar ? [f.overrideVar] : []));
let warnings: string[] = [];

beforeEach(() => {
  process.env.APP_ENV = 'staging';
  for (const name of OVERRIDE_VARS) delete process.env[name];
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
    warnings.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ['APP_ENV', ...OVERRIDE_VARS]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('isFeatureEnabled (spec 041 §3.4)', () => {
  it('an override of exactly "true"/"false" wins and never reads the database', async () => {
    const db = executor([{ enabled: true }]);
    process.env.AI_ASSISTANT_ENABLED = 'false';
    expect(await isFeatureEnabled('ai-assistant', db)).toBe(false);
    process.env.AI_FRAUD_SIGNALS_ENABLED = 'true';
    expect(await isFeatureEnabled('ai-fraud-signals', executor([{ enabled: false }]))).toBe(true);
    expect(db.calls).toBe(0);
  });

  it('any other override value is ignored: the stored value decides', async () => {
    process.env.AI_ASSISTANT_ENABLED = '';
    expect(await isFeatureEnabled('ai-assistant', executor([{ enabled: false }]))).toBe(false);
    process.env.AI_ASSISTANT_ENABLED = 'FALSE';
    expect(await isFeatureEnabled('ai-assistant', executor([{ enabled: true }]))).toBe(true);
  });

  it('a missing row falls back to the registry default for the environment, and is logged', async () => {
    expect(await isFeatureEnabled('ai-fraud-signals', executor([]))).toBe(false);
    expect(await isFeatureEnabled('home-personalization-v1', executor([]))).toBe(true);
    expect(warnings.map((w) => JSON.parse(w) as { event: string; key: string; environment: string })).toEqual([
      expect.objectContaining({ event: 'feature_flags.value_missing', key: 'ai-fraud-signals', environment: 'staging' }),
      expect.objectContaining({ event: 'feature_flags.value_missing', key: 'home-personalization-v1', environment: 'staging' }),
    ]);
  });

  it('a failed read THROWS — never silently the default (a switched-off kill switch stays off)', async () => {
    await expect(isFeatureEnabled('ai-assistant', executor(new Error('db down')))).rejects.toThrow('db down');
  });

  it('a bad APP_ENV is a configuration error', async () => {
    process.env.APP_ENV = 'qa';
    await expect(isFeatureEnabled('ai-assistant', executor([{ enabled: true }]))).rejects.toThrow(/APP_ENV/);
  });
});

describe('resolveClientFlags (spec 041 §3.6 F3)', () => {
  it('returns only client-readable flags, stored value first', async () => {
    expect(await resolveClientFlags(executor([{ key: 'onboarding-intro-v1', enabled: false }]))).toEqual({ 'onboarding-intro-v1': false });
  });

  it('falls back to the default for a missing row and never includes a developer flag even if a row claims one', async () => {
    const flags = await resolveClientFlags(executor([{ key: 'ai-assistant', enabled: false }]));
    expect(flags).toEqual({ 'onboarding-intro-v1': true });
    expect(warnings.some((w) => w.includes('feature_flags.value_missing'))).toBe(true);
  });
});
