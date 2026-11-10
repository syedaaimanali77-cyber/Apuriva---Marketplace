/**
 * Spec 042 §3.5 (AC-6) — `translate(locale, key, params?)` for server components, route handlers and
 * notification rendering. Client components use `useLocale().t` (`app/_components/LocaleProvider.tsx`).
 *
 * The locale's string → the English string → never the raw key; `{name}` placeholders substituted; one
 * `i18n.missing_key` structured line per (locale, key) per process.
 */
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from './config';
import { dictionaryFor } from './dictionaries';
import type { MessageKey } from './dictionaries/en';
import { translateWith, type MessageParams } from './translator';

export type { MessageKey } from './dictionaries/en';
export type { MessageParams, Translator } from './translator';

export function translate(locale: Locale | string, key: MessageKey, params?: MessageParams): string {
  const resolved: Locale = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  return translateWith(resolved, dictionaryFor(resolved), key, params);
}
