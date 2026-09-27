/**
 * Spec 042 §3.9 (AC-3, decision 9) — the platform's market-default currency, as CONFIGURATION.
 *
 * `PLATFORM_CURRENCY_CODE` defaults to `PKR`: the explicit, documented Pakistan-first default
 * (master §5.2), never a literal buried in business logic (master §132 rule 19). It is used only
 * where a value has no currency of its own yet (an empty ledger, a new request's budget, an admin
 * filter's initial value). Every stored money value keeps its own `currency_code`.
 *
 * A value that is not ISO-4217-shaped is a CONFIGURATION ERROR and throws — there is no silent fallback.
 */
export const DEFAULT_PLATFORM_CURRENCY_CODE = 'PKR';

const ISO_4217_SHAPE = /^[A-Z]{3}$/;

export class PlatformCurrencyConfigError extends Error {
  constructor(value: string) {
    super(`PLATFORM_CURRENCY_CODE must be a three-letter ISO-4217 code (e.g. PKR, USD); got "${value}".`);
    this.name = 'PlatformCurrencyConfigError';
  }
}

export function platformCurrencyCode(): string {
  const raw = process.env.PLATFORM_CURRENCY_CODE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PLATFORM_CURRENCY_CODE;
  const value = raw.trim();
  if (!ISO_4217_SHAPE.test(value)) throw new PlatformCurrencyConfigError(value);
  return value;
}
