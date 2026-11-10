/**
 * Spec 042 §3.11 L2 (AC-7, AC-8) — saving a signed-in user's locale. SERVER-ONLY.
 *
 * Checks, in order:
 *   1. not a string or null, or a bad tag shape → 400 VALIDATION_ERROR;
 *   2. not in SUPPORTED_LOCALES              → 422 LOCALE_NOT_SUPPORTED;
 *   3. supported but its flag is off          → 409 LOCALE_UNAVAILABLE.
 * `null` clears the saved preference. A repeated identical request is a no-op success (nothing written,
 * nothing logged). `i18n.locale_changed` carries from/to/source and NO user id (§4 "Logs").
 */
import { eq } from 'drizzle-orm';
import { ApiRouteError, validationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { isLocaleTagShape, isSupportedLocale, type Locale } from './config';
import { loadLocaleAvailability, readSavedUserLocale } from './server';

export function localeNotSupportedError(): ApiRouteError {
  return new ApiRouteError('LOCALE_NOT_SUPPORTED', 'That language is not supported.', { status: 422 });
}

export function localeUnavailableError(): ApiRouteError {
  return new ApiRouteError('LOCALE_UNAVAILABLE', 'That language is not available yet.', { status: 409 });
}

/** Validates an L2 body's `locale` per the §3.11 order. Returns the locale to save (or `null`). */
export async function validateRequestedLocale(body: unknown): Promise<Locale | null> {
  const value = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).locale : undefined;
  if (value === null) return null;
  if (!isLocaleTagShape(value)) {
    throw validationError([{ field: 'locale', message: 'must be a locale tag such as "en", or null' }]);
  }
  if (!isSupportedLocale(value)) throw localeNotSupportedError();
  const isAvailable = await loadLocaleAvailability();
  if (!isAvailable(value)) throw localeUnavailableError();
  return value;
}

/** Persists `locale` for `userId`. Returns whether anything changed. */
export async function saveUserLocale(userId: string, locale: Locale | null): Promise<{ changed: boolean; previous: string | null }> {
  const previous = await readSavedUserLocale(userId);
  if (previous === locale) return { changed: false, previous };
  await getDb().update(users).set({ locale, updatedAt: new Date() }).where(eq(users.id, userId));
  console.log(JSON.stringify({ event: 'i18n.locale_changed', from: previous, to: locale, source: 'account' }));
  return { changed: true, previous };
}
