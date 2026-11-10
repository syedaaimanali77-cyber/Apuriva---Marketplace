/**
 * Spec 042 §3.5 — the English-backed lookup for server `translate()`, notification rendering and tests:
 * `translator-core.ts` with the English source dictionary as the fallback. Client components do NOT
 * import this module (it bundles English); `LocaleProvider` uses the core with the dictionaries the
 * server passed down.
 *
 * Lookup: the locale's string → the English string → never the raw key (AC-6).
 */
import { en, type Dictionary, type MessageKey } from './dictionaries/en';
import { lookup, translateApiErrorFrom, translateFrom, type MessageParams, type Translator } from './translator-core';

export { lookup, reportMissingKey, resetMissingKeyReports, substitute } from './translator-core';
export type { MessageParams, Translator } from './translator-core';

/** Whether `key` exists in the English source dictionary (used for dynamic keys such as `errors.<CODE>`). */
export function hasMessage(key: string): key is MessageKey {
  return lookup(en, key) !== undefined;
}

export function translateWith(locale: string, dictionary: Dictionary | undefined, key: MessageKey, params?: MessageParams): string {
  return translateFrom(locale, locale === 'en' ? en : dictionary, en, key, params);
}

export function createTranslator(locale: string, dictionary?: Dictionary): Translator {
  return (key, params) => translateWith(locale, dictionary, key, params);
}

/** Spec 042 §3.7 — the `errors.<CODE>` key for a known stable code, else `null`. */
export function apiErrorKey(code: string | null | undefined): MessageKey | null {
  if (typeof code !== 'string' || code.length === 0) return null;
  const key = `errors.${code}`;
  return hasMessage(key) ? key : null;
}

/**
 * Spec 042 §3.7 — a known code → the dictionary text; an unknown code → the server's `message`; neither
 * → `fallback` (else the generic line). Client components reach this through `useLocale().errorText`.
 */
export function translateApiErrorWith(
  t: Translator,
  code: string | null | undefined,
  serverMessage: string | null | undefined,
  fallback?: string,
): string {
  return translateApiErrorFrom(t, hasMessage, code, serverMessage, fallback);
}
