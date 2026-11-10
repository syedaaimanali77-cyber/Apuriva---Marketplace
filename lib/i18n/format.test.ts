import { describe, expect, it } from 'vitest';
import { currencyFractionDigits, formatDate, formatDateTime, formatMoney, formatNumber, formatTime, minorUnitsToDecimalString } from './format';

/** Spec 042 §3.6 (AC-3, D-9). */
describe('formatMoney (spec 042 §3.6, AC-3)', () => {
  it('uses each currency’s REAL fraction digits: PKR/USD 2, JPY 0, KWD 3', () => {
    // Intl separates a currency CODE from the amount with a no-break space (U+00A0).
    expect(formatMoney(150_000, 'PKR', 'en')).toBe('PKR\u00a01,500.00');
    expect(formatMoney(12_345, 'USD', 'en')).toBe('$123.45');
    expect(formatMoney(1_500, 'JPY', 'en')).toBe('¥1,500');
    expect(formatMoney(12_345, 'KWD', 'en')).toBe('KWD\u00a012.345');
    expect(currencyFractionDigits('JPY')).toBe(0);
    expect(currencyFractionDigits('KWD')).toBe(3);
    expect(currencyFractionDigits('PKR')).toBe(2);
  });

  it('always uses the value’s own currency code, whatever the locale', () => {
    expect(formatMoney(12_345, 'USD', 'ur')).toContain('123.45');
    expect(formatMoney(150_000, 'PKR', 'ur')).toContain('1,500.00');
    expect(formatMoney(150_000, 'PKR', 'ur')).not.toBe(formatMoney(150_000, 'PKR', 'en'));
  });

  it('is integer-only: no float arithmetic, and a non-integer is refused', () => {
    expect(minorUnitsToDecimalString(5, 2)).toBe('0.05');
    expect(minorUnitsToDecimalString(-5, 2)).toBe('-0.05');
    expect(minorUnitsToDecimalString(123_456_789_012_345, 2)).toBe('1234567890123.45');
    expect(minorUnitsToDecimalString(7, 0)).toBe('7');
    expect(minorUnitsToDecimalString(1, 3)).toBe('0.001');
    expect(() => formatMoney(12.5, 'USD', 'en')).toThrow(TypeError);
    expect(() => minorUnitsToDecimalString(Number.NaN, 2)).toThrow(TypeError);
    // 0.1 + 0.2 style drift is impossible: the digits come from the integer's own string.
    expect(formatMoney(30, 'USD', 'en')).toBe('$0.30');
  });

  it('an invalid code falls back to "<CODE> <amount>"', () => {
    expect(formatMoney(12_345, 'NOT-A-CODE', 'en')).toBe('NOT-A-CODE 123.45');
    expect(currencyFractionDigits('NOT-A-CODE')).toBe(2);
  });

  it('an unsupported locale formats as English', () => {
    expect(formatMoney(150_000, 'PKR', 'xx')).toBe('PKR\u00a01,500.00');
  });
});

describe('number and date formatting (spec 042 §3.6)', () => {
  const instant = '2026-09-27T10:05:00.000Z';

  it('formats numbers per locale', () => {
    expect(formatNumber(1_234_567, 'en')).toBe('1,234,567');
    expect(formatNumber(1.25, 'en', { maximumFractionDigits: 1 })).toBe('1.3');
    expect(typeof formatNumber(1_234_567, 'ur')).toBe('string');
  });

  it('formats dates, times and date-times per locale, with an optional IANA timeZone', () => {
    expect(formatDate(instant, 'en', { dateStyle: 'long', timeZone: 'UTC' })).toBe('September 27, 2026');
    expect(formatDate(instant, 'ur', { dateStyle: 'long', timeZone: 'UTC' })).toContain('2026');
    expect(formatDate(instant, 'ur', { dateStyle: 'long', timeZone: 'UTC' })).not.toBe('September 27, 2026');
    expect(formatTime(instant, 'en', { timeStyle: 'short', timeZone: 'UTC' })).toBe('10:05 AM');
    expect(formatTime(new Date(instant), 'en', { timeStyle: 'short', timeZone: 'Asia/Karachi' })).toBe('3:05 PM');
    expect(formatDateTime(Date.parse(instant), 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })).toBe(
      'Sep 27, 2026, 10:05 AM',
    );
  });

  it('has sensible defaults', () => {
    expect(formatDate(instant, 'en')).toMatch(/2026/);
    expect(formatTime(instant, 'en')).toMatch(/\d/);
    expect(formatDateTime(instant, 'en')).toMatch(/2026/);
  });

  it('an invalid instant never throws: it reads "Invalid Date", as the replaced toLocale*String() did', () => {
    for (const bad of ['not a date', Number.NaN, new Date(Number.NaN)]) {
      expect(formatDate(bad, 'en')).toBe('Invalid Date');
      expect(formatTime(bad, 'ur')).toBe('Invalid Date');
      expect(formatDateTime(bad, 'en')).toBe('Invalid Date');
    }
  });
});
