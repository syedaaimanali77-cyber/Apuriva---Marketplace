import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from './dictionaries/en';
import { ur } from './dictionaries/ur';
import { translate } from './translate';
import { createTranslator, lookup, resetMissingKeyReports, substitute, translateWith } from './translator';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetMissingKeyReports();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

const missingKeyLines = () =>
  warn.mock.calls
    .map((call: unknown[]) => JSON.parse(String(call[0])) as { event: string; key: string; locale: string })
    .filter((line: { event: string }) => line.event === 'i18n.missing_key');

/** Spec 042 §3.5 (AC-6). */
describe('translate (spec 042 §3.5, AC-6)', () => {
  it('returns the locale string, and English for en', () => {
    expect(translate('en', 'common.tryAgain')).toBe('Try again');
    expect(translate('ur', 'common.tryAgain')).toBe(ur.common.tryAgain);
    expect(translate('ur', 'common.tryAgain')).not.toBe('Try again');
  });

  it('substitutes {name} placeholders, leaving an unknown placeholder visible', () => {
    expect(translate('en', 'auth.login.attemptsLeft', { count: 3 })).toBe('You have 3 attempts left.');
    expect(substitute('Hi {name} {missing}', { name: 'Ada' })).toBe('Hi Ada {missing}');
    expect(substitute('No params {x}')).toBe('No params {x}');
  });

  it('a key missing from the active dictionary renders ENGLISH, never the raw key, and logs once per key and locale', () => {
    const partial = {}; // a dictionary with nothing in it
    const first = translateWith('ur', partial, 'common.tryAgain');
    const second = translateWith('ur', partial, 'common.tryAgain');
    expect(first).toBe('Try again');
    expect(second).toBe('Try again');
    expect(first).not.toContain('common.');
    expect(missingKeyLines()).toEqual([expect.objectContaining({ event: 'i18n.missing_key', key: 'common.tryAgain', locale: 'ur' })]);
    // a different key is its own line
    translateWith('ur', partial, 'common.cancel');
    expect(missingKeyLines()).toHaveLength(2);
  });

  it('an unknown key (possible only through an unchecked cast) renders empty, never the raw key', () => {
    const result = translateWith('en', undefined, 'does.not.exist' as never);
    expect(result).toBe('');
  });

  it('an unsupported locale falls back to English', () => {
    expect(translate('pt-BR', 'common.cancel')).toBe('Cancel');
  });

  it('createTranslator binds a locale and dictionary', () => {
    const t = createTranslator('ur', ur);
    expect(t('common.cancel')).toBe(ur.common.cancel);
    expect(createTranslator('en')('common.cancel')).toBe(en.common.cancel);
  });

  it('lookup walks dotted paths and never returns a non-string', () => {
    expect(lookup(en, 'common.cancel')).toBe('Cancel');
    expect(lookup(en, 'common')).toBeUndefined();
    expect(lookup(en, 'common.cancel.deeper')).toBeUndefined();
    expect(lookup(undefined, 'common.cancel')).toBeUndefined();
  });
});
