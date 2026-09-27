/**
 * Spec 042 §3.6 (AC-3, D-9) — THE locale-aware formatters. Every in-scope money, number and date
 * display goes through here; admin screens call the same functions with `'en'`.
 *
 * Money is integer minor units in, and never float arithmetic (master §132 rule 5): the minor-unit
 * integer is turned into an exact decimal STRING using the currency's real fraction digits (JPY 0,
 * PKR/USD 2, KWD 3), and that string is what `Intl.NumberFormat` formats.
 *
 * NOT replaced (and exempt in `boundary.test.ts`): the fixed `'en-US'` parsing locale used for time-zone
 * VALIDATION and ARITHMETIC in `lib/requests/create.ts` and `lib/availability/timezone.ts`.
 */
import { DEFAULT_LOCALE, intlLocaleFor, isSupportedLocale, type Locale } from './config';

function intl(locale: Locale | string): string {
  return intlLocaleFor(isSupportedLocale(locale) ? locale : DEFAULT_LOCALE);
}

/** The exact decimal string for `amountMinorUnits` at `fractionDigits` — integer maths only. */
export function minorUnitsToDecimalString(amountMinorUnits: number, fractionDigits: number): string {
  if (!Number.isSafeInteger(amountMinorUnits)) {
    throw new TypeError(`formatMoney(): amountMinorUnits must be an integer, got ${amountMinorUnits}`);
  }
  const negative = amountMinorUnits < 0;
  const digits = String(Math.abs(amountMinorUnits));
  if (fractionDigits === 0) return `${negative ? '-' : ''}${digits}`;
  const padded = digits.padStart(fractionDigits + 1, '0');
  const whole = padded.slice(0, padded.length - fractionDigits);
  const fraction = padded.slice(padded.length - fractionDigits);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** `Intl` accepts an exact decimal string at runtime (Intl.NumberFormat v3); the lib typings lag behind. */
function formatDecimal(format: Intl.NumberFormat, decimal: string): string {
  return format.format(decimal as unknown as number);
}

/**
 * `amountMinorUnits` of `currencyCode`, for `locale`. Uses the value's OWN currency and that
 * currency's real fraction digits. An invalid code falls back to `<CODE> <amount>`.
 */
export function formatMoney(amountMinorUnits: number, currencyCode: string, locale: Locale | string): string {
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(intl(locale), { style: 'currency', currency: currencyCode });
  } catch {
    return `${currencyCode} ${minorUnitsToDecimalString(amountMinorUnits, 2)}`;
  }
  const fractionDigits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return formatDecimal(format, minorUnitsToDecimalString(amountMinorUnits, fractionDigits));
}

/** The currency's real minor-unit exponent (JPY 0, PKR 2, KWD 3); 2 for an invalid code. */
export function currencyFractionDigits(currencyCode: string): number {
  try {
    return new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: currencyCode }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatNumber(value: number, locale: Locale | string, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(intl(locale), options).format(value);
}

type Instant = Date | string | number;

function toDate(instant: Instant): Date {
  return instant instanceof Date ? instant : new Date(instant);
}

/**
 * `Intl.DateTimeFormat#format` THROWS on an invalid date, where the `toLocale*String()` calls these replace
 * returned `"Invalid Date"`. A bad instant must never crash a render, so that behaviour is kept exactly.
 */
function formatInstant(locale: Locale | string, options: Intl.DateTimeFormatOptions, instant: Instant): string {
  const date = toDate(instant);
  if (Number.isNaN(date.getTime())) return String(date);
  return new Intl.DateTimeFormat(intl(locale), options).format(date);
}

/** Options accept an IANA `timeZone`, like `Intl.DateTimeFormat`'s own. */
export function formatDate(instant: Instant, locale: Locale | string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  return formatInstant(locale, options, instant);
}

export function formatTime(instant: Instant, locale: Locale | string, options: Intl.DateTimeFormatOptions = { timeStyle: 'short' }): string {
  return formatInstant(locale, options, instant);
}

export function formatDateTime(
  instant: Instant,
  locale: Locale | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return formatInstant(locale, options, instant);
}
