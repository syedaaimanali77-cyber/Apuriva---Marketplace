/**
 * Spec 042 §3.2 (AC-5) — THE list of UI locales. Adding a locale is one entry here, a dictionary
 * file under `./dictionaries/`, and (optionally) a Spec 041 availability flag. Nothing else: the
 * `users.locale` CHECK validates only the tag's shape, never this list.
 *
 * Roman Urdu is NOT a locale (master §5.1). It is free-text INPUT and never passes through here (§3.10).
 *
 * Pure and dependency-free, so client components may import it.
 */
import type { LocaleDirection } from '@/lib/types/i18n';

export interface LocaleDefinition {
  code: string;
  label: string;
  nativeLabel: string;
  direction: LocaleDirection;
  /** The tag handed to `Intl.*`. */
  intlLocale: string;
  /** The Spec 041 flag that makes this locale selectable, or `null` for always available. */
  availabilityFlag: 'urdu-locale' | null;
}

export const SUPPORTED_LOCALES = [
  { code: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr', intlLocale: 'en', availabilityFlag: null },
  { code: 'ur', label: 'Urdu', nativeLabel: 'اردو', direction: 'rtl', intlLocale: 'ur', availabilityFlag: 'urdu-locale' },
] as const satisfies readonly LocaleDefinition[];

export type Locale = (typeof SUPPORTED_LOCALES)[number]['code'];

/** The fallback locale: always available, and the source-of-truth dictionary. */
export const DEFAULT_LOCALE: Locale = 'en';

/** The cookie that carries a guest's (or a signed-in user's last) locale. Holds only a locale tag. */
export const LOCALE_COOKIE_NAME = 'apuriva_locale';

/** One year, the §3.11 L2 cookie lifetime. */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const TAG_SHAPE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** A BCP-47-SHAPED tag (the same rule as the `users_locale_shape_ck` CHECK). */
export function isLocaleTagShape(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 35 && TAG_SHAPE.test(value);
}

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALES.some((l) => l.code === value);
}

export function localeDefinition(locale: Locale): LocaleDefinition {
  return SUPPORTED_LOCALES.find((l) => l.code === locale)!;
}

export function localeDirection(locale: Locale): LocaleDirection {
  return localeDefinition(locale).direction;
}

export function intlLocaleFor(locale: Locale): string {
  return localeDefinition(locale).intlLocale;
}
