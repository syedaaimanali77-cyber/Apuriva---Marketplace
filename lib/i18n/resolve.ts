/**
 * Spec 042 §3.3 (AC-7, AC-8, D-6) — locale resolution. Pure: no I/O, never throws.
 *
 * The first USABLE candidate wins:
 *   1. the saved `users.locale` (signed-in only);
 *   2. the `apuriva_locale` cookie;
 *   3. `Accept-Language`, in quality order, each reduced to its primary subtag;
 *   4. `en`.
 * Usable = supported (`isSupportedLocale`) AND available (`isAvailable`). An invalid, unsupported or
 * unavailable value is treated as UNSET and resolution moves on — so `ur` is never picked while
 * `urdu-locale` is off (AC-8), whichever source carries it.
 */
import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from './config';

export interface ResolveLocaleInput {
  userLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguage?: string | null;
  /** Whether a SUPPORTED locale may be selected right now (its availability flag). */
  isAvailable: (locale: Locale) => boolean;
}

/** `Accept-Language` primary subtags, highest quality first; `q=0` and malformed entries dropped. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (typeof header !== 'string' || header.trim() === '') return [];
  const entries: { tag: string; q: number; order: number }[] = [];
  header.split(',').forEach((part, order) => {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag?.trim().toLowerCase() ?? '';
    if (!tag || tag === '*') return;
    let q = 1;
    for (const param of params) {
      const [name, value] = param.trim().split('=');
      if (name?.trim() === 'q') {
        const parsed = Number(value);
        q = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    if (q <= 0) return;
    entries.push({ tag: tag.split('-')[0]!, q, order });
  });
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  return entries.map((e) => e.tag);
}

export function resolveLocale(input: ResolveLocaleInput): Locale {
  const usable = (value: unknown): value is Locale => {
    if (!isSupportedLocale(value)) return false;
    try {
      return value === DEFAULT_LOCALE || input.isAvailable(value);
    } catch {
      return false;
    }
  };
  if (usable(input.userLocale)) return input.userLocale;
  if (usable(input.cookieLocale)) return input.cookieLocale;
  for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
    if (usable(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}
