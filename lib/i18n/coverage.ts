/**
 * Spec 042 §3.5 / §9 — translation coverage: which English keys a locale's dictionary lacks, and any
 * keys it has that English does not (impossible under the type, checked again at runtime). It drives
 * the §9 checklist: `urdu-locale` is turned on only once `missingKeys('ur')` is empty and the §5.1
 * route review is signed off.
 */
import type { Locale } from './config';
import { dictionaryFor } from './dictionaries';
import { en, type Dictionary } from './dictionaries/en';

export function leafKeys(dictionary: Dictionary | Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(dictionary)) {
    const key = `${prefix}${name}`;
    if (typeof value === 'string') keys.push(key);
    else if (value && typeof value === 'object') keys.push(...leafKeys(value as Record<string, unknown>, `${key}.`));
  }
  return keys;
}

const EN_KEYS = leafKeys(en);

export function missingKeys(locale: Locale): string[] {
  const own = new Set(leafKeys(dictionaryFor(locale)));
  return EN_KEYS.filter((key) => !own.has(key));
}

export function unknownKeys(locale: Locale): string[] {
  const known = new Set(EN_KEYS);
  return leafKeys(dictionaryFor(locale)).filter((key) => !known.has(key));
}

export function coverageReport(locale: Locale): { locale: Locale; total: number; translated: number; missing: string[] } {
  const missing = missingKeys(locale);
  return { locale, total: EN_KEYS.length, translated: EN_KEYS.length - missing.length, missing };
}
