import { afterEach, describe, expect, it } from 'vitest';
import { PAYOUT_PROVIDER_ENV_VAR, PayoutProviderUnavailable, resolvePayoutProvider } from './payout-factory';

const originalProvider = process.env[PAYOUT_PROVIDER_ENV_VAR];
const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/** Spec 024 §3.2 — payout-rail selection mirrors spec 021's payment factory exactly. */
describe('payout rail factory (spec 024 §3.2)', () => {
  afterEach(() => {
    if (originalProvider === undefined) delete process.env[PAYOUT_PROVIDER_ENV_VAR];
    else process.env[PAYOUT_PROVIDER_ENV_VAR] = originalProvider;
    setNodeEnv(originalNodeEnv);
  });

  it('resolves the sandbox rail when configured', () => {
    process.env[PAYOUT_PROVIDER_ENV_VAR] = 'sandbox';
    setNodeEnv('test');
    expect(resolvePayoutProvider().name).toBe('sandbox');
  });

  it('refuses a sandbox rail under NODE_ENV=production', () => {
    process.env[PAYOUT_PROVIDER_ENV_VAR] = 'sandbox';
    setNodeEnv('production');
    expect(() => resolvePayoutProvider()).toThrow(PayoutProviderUnavailable);
    expect(() => resolvePayoutProvider()).toThrow(/sandbox and must never run in production/);
  });

  it('refuses an unknown rail name rather than falling back', () => {
    process.env[PAYOUT_PROVIDER_ENV_VAR] = 'a-rail-we-have-no-credentials-for';
    setNodeEnv('test');
    expect(() => resolvePayoutProvider()).toThrow(/not a known payout rail/);
  });

  it('refuses an absent rail name', () => {
    delete process.env[PAYOUT_PROVIDER_ENV_VAR];
    setNodeEnv('test');
    expect(() => resolvePayoutProvider()).toThrow(/is not set/);
  });

  it('re-reads configuration on every call rather than memoizing', () => {
    process.env[PAYOUT_PROVIDER_ENV_VAR] = 'sandbox';
    setNodeEnv('test');
    expect(resolvePayoutProvider().name).toBe('sandbox');
    setNodeEnv('production');
    expect(() => resolvePayoutProvider()).toThrow(PayoutProviderUnavailable);
  });
});
