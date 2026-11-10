/**
 * Spec 042 §3.5 — the dictionary lookup itself, with NO dictionary imported. The client `LocaleProvider`
 * builds on this alone, so the browser receives only the dictionaries the server passes down, never a
 * bundled copy of English. `translator.ts` wraps it with the English source dictionary for server code.
 *
 * Lookup: the locale's own string → the English fallback string → never the raw key (AC-6).
 */
import type { Dictionary, MessageKey } from './dictionaries/en';

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

/** `own` is the locale's dictionary; `fallback` holds the English text for keys `own` may lack. */
export function translateFrom(
  locale: string,
  own: Dictionary | undefined,
  fallback: Dictionary | undefined,
  key: MessageKey,
  params?: MessageParams,
): string {
  const text = lookup(own, key);
  if (text !== undefined) return substitute(text, params);
  reportMissingKey(locale, key);
  const english = lookup(fallback, key);
  // Never the raw key: an unknown key (possible only through an unchecked cast) renders empty.
  return english === undefined ? '' : substitute(english, params);
}

/**
 * Spec 042 §3.7 — a known code → the dictionary text; an unknown code → the server's `message`; neither
 * → `fallback` (else the generic line). `isKnownKey` says whether `errors.<CODE>` is a dictionary key.
 */
export function translateApiErrorFrom(
  t: Translator,
  isKnownKey: (key: string) => key is MessageKey,
  code: string | null | undefined,
  serverMessage: string | null | undefined,
  fallback?: string,
): string {
  const key = typeof code === 'string' && code.length > 0 ? `errors.${code}` : null;
  if (key !== null && isKnownKey(key)) return t(key);
  if (typeof serverMessage === 'string' && serverMessage.length > 0) return serverMessage;
  return fallback ?? t('common.somethingWentWrong');
}
