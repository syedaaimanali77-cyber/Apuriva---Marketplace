import { describe, expect, it } from 'vitest';
import type { Locale } from './config';
import { parseAcceptLanguage, resolveLocale } from './resolve';

const urduOn = (_l: Locale) => true;
const urduOff = (l: Locale) => l !== 'ur';

/** Spec 042 §3.3 (AC-7, AC-8, D-6) — saved locale → cookie → Accept-Language → en; unusable = unset. */
describe('resolveLocale (spec 042 §3.3)', () => {
  it('precedence: saved user locale, then cookie, then Accept-Language, then en', () => {
    expect(resolveLocale({ userLocale: 'ur', cookieLocale: 'en', acceptLanguage: 'en', isAvailable: urduOn })).toBe('ur');
    expect(resolveLocale({ userLocale: 'en', cookieLocale: 'ur', acceptLanguage: 'ur', isAvailable: urduOn })).toBe('en');
    expect(resolveLocale({ userLocale: null, cookieLocale: 'ur', acceptLanguage: 'en', isAvailable: urduOn })).toBe('ur');
    expect(resolveLocale({ userLocale: null, cookieLocale: null, acceptLanguage: 'ur-PK,en;q=0.5', isAvailable: urduOn })).toBe('ur');
    expect(resolveLocale({ isAvailable: urduOn })).toBe('en');
  });

  it('AC-8: ur is never selected while urdu-locale is off, from any source', () => {
    expect(resolveLocale({ userLocale: 'ur', cookieLocale: 'ur', acceptLanguage: 'ur', isAvailable: urduOff })).toBe('en');
    expect(resolveLocale({ userLocale: 'ur', isAvailable: urduOff })).toBe('en');
    expect(resolveLocale({ cookieLocale: 'ur', isAvailable: urduOff })).toBe('en');
    expect(resolveLocale({ acceptLanguage: 'ur', isAvailable: urduOff })).toBe('en');
  });

  it('an unusable value is treated as UNSET and resolution moves on', () => {
    // unavailable saved locale → falls through to the (usable) cookie
    expect(resolveLocale({ userLocale: 'ur', cookieLocale: 'en', isAvailable: urduOff })).toBe('en');
    // unsupported / malformed values are skipped
    expect(resolveLocale({ userLocale: 'pt-BR', cookieLocale: 'ur', isAvailable: urduOn })).toBe('ur');
    expect(resolveLocale({ userLocale: 'EN', cookieLocale: 'xx_1', acceptLanguage: 'ur', isAvailable: urduOn })).toBe('ur');
    expect(resolveLocale({ userLocale: '', cookieLocale: '', acceptLanguage: '', isAvailable: urduOn })).toBe('en');
  });

  it('en is always available even if the predicate says otherwise, and a throwing predicate never throws', () => {
    expect(resolveLocale({ userLocale: 'en', isAvailable: () => false })).toBe('en');
    expect(
      resolveLocale({
        userLocale: 'ur',
        isAvailable: () => {
          throw new Error('flag store down');
        },
      }),
    ).toBe('en');
  });

  it('honours Accept-Language quality order and primary subtags', () => {
    expect(resolveLocale({ acceptLanguage: 'fr;q=0.9, ur;q=0.8, en;q=0.1', isAvailable: urduOn })).toBe('ur');
    expect(resolveLocale({ acceptLanguage: 'en;q=0.4, ur-PK;q=0.9', isAvailable: urduOn })).toBe('ur');
    expect(resolveLocale({ acceptLanguage: 'ur;q=0, en;q=0.5', isAvailable: urduOn })).toBe('en');
  });
});

describe('parseAcceptLanguage (spec 042 §3.3)', () => {
  it('orders by q (then header order), reduces to primary subtags and drops q=0, * and junk', () => {
    expect(parseAcceptLanguage('ur-PK,en-US;q=0.8,fr;q=0.9')).toEqual(['ur', 'fr', 'en']);
    expect(parseAcceptLanguage('*, de;q=0, en')).toEqual(['en']);
    expect(parseAcceptLanguage('en;q=abc, ur')).toEqual(['ur']);
    expect(parseAcceptLanguage('  ,  ')).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
  });
});
