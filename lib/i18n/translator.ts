/**
 * Spec 042 §3.5 — the dictionary lookup shared by server `translate()` and the client `LocaleProvider`.
 * It imports ONLY the English source dictionary (the fallback), so a client bundle carries English plus
 * whichever single dictionary the server passed down — never every locale.
 *
 * Lookup: the locale's string → the English string → never the raw key (AC-6).
 */
import { en, type Dictionary, type MessageKey } from './dictionaries/en';

export type MessageParams = Record<string, string | number>;
export type Translator = (key: MessageKey, params?: MessageParams) => string;

export function lookup(dictionary: Dictionary | undefined, key: string): string | undefined {
  let node: unknown = dictionary;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Whether `key` exists in the English source dictionary (used for dynamic keys such as `errors.<CODE>`). */
export function hasMessage(key: string): key is MessageKey {
  return lookup(en, key) !== undefined;
}

export function substitute(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

const reported = new Set<string>();

/** One `i18n.missing_key` structured line per (locale, key) per process (AC-6). */
export function reportMissingKey(locale: string, key: string): void {
  const id = `${locale}\u0000${key}`;
  if (reported.has(id)) return;
  reported.add(id);
  console.warn(JSON.stringify({ event: 'i18n.missing_key', key, locale }));
}

/** Test-only: forget which missing keys were already reported. */
export function resetMissingKeyReports(): void {
  reported.clear();
}

export function translateWith(locale: string, dictionary: Dictionary | undefined, key: MessageKey, params?: MessageParams): string {
  const own = locale === 'en' ? lookup(en, key) : lookup(dictionary, key);
  if (own !== undefined) return substitute(own, params);
  reportMissingKey(locale, key);
  const fallback = lookup(en, key);
  // Never the raw key: an unknown key (possible only through an unchecked cast) renders empty.
  return fallback === undefined ? '' : substitute(fallback, params);
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
  const key = apiErrorKey(code);
  if (key) return t(key);
  if (typeof serverMessage === 'string' && serverMessage.length > 0) return serverMessage;
  return fallback ?? t('common.somethingWentWrong');
}
