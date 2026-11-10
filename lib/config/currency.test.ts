import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLATFORM_CURRENCY_CODE, PlatformCurrencyConfigError, platformCurrencyCode } from './currency';

const saved = process.env.PLATFORM_CURRENCY_CODE;
afterEach(() => {
  if (saved === undefined) delete process.env.PLATFORM_CURRENCY_CODE;
  else process.env.PLATFORM_CURRENCY_CODE = saved;
});

/** Spec 042 §3.9 (AC-3, D-9) — the market default is configuration, never a literal in business logic. */
describe('platformCurrencyCode (spec 042 §3.9)', () => {
  it('defaults to the documented Pakistan-first PKR when unset or blank', () => {
    delete process.env.PLATFORM_CURRENCY_CODE;
    expect(platformCurrencyCode()).toBe('PKR');
    expect(DEFAULT_PLATFORM_CURRENCY_CODE).toBe('PKR');
    process.env.PLATFORM_CURRENCY_CODE = '   ';
    expect(platformCurrencyCode()).toBe('PKR');
  });

  it('returns a configured ISO-4217 code', () => {
    process.env.PLATFORM_CURRENCY_CODE = 'USD';
    expect(platformCurrencyCode()).toBe('USD');
    process.env.PLATFORM_CURRENCY_CODE = ' AED ';
    expect(platformCurrencyCode()).toBe('AED');
  });

  it('a malformed value is a configuration error, never a silent fallback', () => {
    for (const bad of ['usd', 'US', 'USDX', 'U$D', '123']) {
      process.env.PLATFORM_CURRENCY_CODE = bad;
      expect(() => platformCurrencyCode(), bad).toThrow(PlatformCurrencyConfigError);
    }
    process.env.PLATFORM_CURRENCY_CODE = 'usd';
    expect(() => platformCurrencyCode()).toThrow(/ISO-4217/);
  });
});
