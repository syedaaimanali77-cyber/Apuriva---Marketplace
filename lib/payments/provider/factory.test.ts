import { afterEach, describe, expect, it } from 'vitest';
import { PAYMENT_PROVIDER_ENV_VAR, PaymentProviderUnavailable, resolvePaymentProvider } from './index';

const originalProvider = process.env[PAYMENT_PROVIDER_ENV_VAR];
const originalNodeEnv = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  // `NODE_ENV` is typed as a readonly union in Next's ambient types; tests legitimately flip it.
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

/** Spec 021 §3 "Payment-provider architecture" — selection, and AC-10's production guard. */
describe('payment provider factory (spec 021 AC-10)', () => {
  afterEach(() => {
    if (originalProvider === undefined) delete process.env[PAYMENT_PROVIDER_ENV_VAR];
    else process.env[PAYMENT_PROVIDER_ENV_VAR] = originalProvider;
    setNodeEnv(originalNodeEnv);
  });

  it('resolves the sandbox adapter when configured', () => {
    process.env[PAYMENT_PROVIDER_ENV_VAR] = 'sandbox';
    setNodeEnv('test');
    const provider = resolvePaymentProvider();
    expect(provider.name).toBe('sandbox');
    expect(provider.isSandbox).toBe(true);
  });

  /**
   * AC-10. THE guard that makes shipping a sandbox safe: a production deployment without a real
   * adapter refuses to take payments rather than reporting a payment nobody made
   * (master spec §132.21, §132.22, §133.5).
   */
  it('refuses a sandbox adapter under NODE_ENV=production', () => {
    process.env[PAYMENT_PROVIDER_ENV_VAR] = 'sandbox';
    setNodeEnv('production');
    expect(() => resolvePaymentProvider()).toThrow(PaymentProviderUnavailable);
    expect(() => resolvePaymentProvider()).toThrow(/sandbox and must never run in production/);
  });

  /** No silent fallback: a mistyped variable must fail loudly, not quietly select the sandbox. */
  it('refuses an unknown adapter name rather than falling back', () => {
    process.env[PAYMENT_PROVIDER_ENV_VAR] = 'some-vendor-we-have-no-credentials-for';
    setNodeEnv('test');
    expect(() => resolvePaymentProvider()).toThrow(PaymentProviderUnavailable);
    expect(() => resolvePaymentProvider()).toThrow(/not a known payment adapter/);
  });

  it('refuses an absent adapter name', () => {
    delete process.env[PAYMENT_PROVIDER_ENV_VAR];
    setNodeEnv('test');
    expect(() => resolvePaymentProvider()).toThrow(PaymentProviderUnavailable);
    expect(() => resolvePaymentProvider()).toThrow(/is not set/);
  });

  /** Read fresh every call: a cached provider would let whichever request warmed it bypass AC-10. */
  it('re-reads configuration on every call rather than memoizing', () => {
    process.env[PAYMENT_PROVIDER_ENV_VAR] = 'sandbox';
    setNodeEnv('test');
    expect(resolvePaymentProvider().name).toBe('sandbox');

    setNodeEnv('production');
    expect(() => resolvePaymentProvider()).toThrow(PaymentProviderUnavailable);
  });
});
