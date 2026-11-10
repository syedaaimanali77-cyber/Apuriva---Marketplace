import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  intlLocaleFor,
  isLocaleTagShape,
  isSupportedLocale,
  localeDefinition,
  localeDirection,
} from './config';
import { DICTIONARIES } from './dictionaries';

/** Spec 042 §3.2 (AC-5) — SUPPORTED_LOCALES is the only list of locales. */
describe('locale config (spec 042 §3.2, AC-5)', () => {
  it('is exactly en and ur, with the approved labels, directions and availability flags', () => {
    expect(SUPPORTED_LOCALES.map(({ code, label, nativeLabel, direction, intlLocale, availabilityFlag }) => ({
      code,
      label,
      nativeLabel,
      direction,
      intlLocale,
      availabilityFlag,
    }))).toEqual([
      { code: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr', intlLocale: 'en', availabilityFlag: null },
      { code: 'ur', label: 'Urdu', nativeLabel: 'اردو', direction: 'rtl', intlLocale: 'ur', availabilityFlag: 'urdu-locale' },
    ]);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  it('Roman Urdu is not a locale (master §5.1)', () => {
    expect(isSupportedLocale('ur-Latn')).toBe(false);
    expect(SUPPORTED_LOCALES.some((l) => l.code.includes('Latn'))).toBe(false);
  });

  it('isLocaleTagShape accepts BCP-47-shaped tags and rejects everything else', () => {
    for (const ok of ['en', 'ur', 'pt-BR', 'zh-Hant-TW', 'fil', 'ur-Latn']) expect(isLocaleTagShape(ok), ok).toBe(true);
    for (const bad of ['EN', 'xx_1', '', 'e', 'english', 'en-', 'en-B', '12', null, undefined, 42, {}, `en-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(8)}`]) {
      expect(isLocaleTagShape(bad), String(bad)).toBe(false);
    }
  });

  it('isSupportedLocale is membership only', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('ur')).toBe(true);
    expect(isSupportedLocale('pt-BR')).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });

  it('exposes direction and the Intl tag per locale', () => {
    expect(localeDirection('en')).toBe('ltr');
    expect(localeDirection('ur')).toBe('rtl');
    expect(intlLocaleFor('ur')).toBe('ur');
    expect(localeDefinition('ur').availabilityFlag).toBe('urdu-locale');
  });

  it('AC-5: every configured locale has a dictionary — adding one needs only config + a dictionary (+ an optional flag)', () => {
    expect(Object.keys(DICTIONARIES).sort()).toEqual(SUPPORTED_LOCALES.map((l) => l.code).sort());
  });
});
