/**
 * Spec 042 §3.3 / §3.4 — SERVER-ONLY locale resolution against the real request, session store and
 * `urdu-locale` flag. Never imported by a client component (it reaches the database).
 *
 *   - `getRequestLocale()`   — the root layout: `next/headers` cookie + `Accept-Language` + session user.
 *   - `resolveLocaleForRequest(request, userId?)` — route handlers (L1, L2, the notification inbox).
 *   - `resolveLocaleForUser(userId)` — no request context (channel dispatch, MCP): saved `users.locale`, else `en`.
 *
 * Every path degrades to `en` rather than failing a render: a flag read that throws counts as
 * "unavailable", a failed user lookup as "no saved locale".
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { isFeatureEnabled } from '@/lib/feature-flags';
import type { LocaleDirection } from '@/lib/types/i18n';
import { getSessionIdFromRequest, readCookie } from '@/lib/auth/cookies';
import { SESSION_COOKIE_NAME, validateAndRefreshSession } from '@/lib/auth/session';
import { LOCALE_COOKIE_NAME, SUPPORTED_LOCALES, localeDirection, type Locale } from './config';
import { resolveLocale } from './resolve';

export interface RequestLocale {
  locale: Locale;
  direction: LocaleDirection;
}

/** Which supported locales are selectable right now. `en` always; a flagged locale while its flag is on. */
export async function loadLocaleAvailability(): Promise<(locale: Locale) => boolean> {
  const available = new Set<Locale>();
  for (const definition of SUPPORTED_LOCALES) {
    if (definition.availabilityFlag === null) {
      available.add(definition.code);
      continue;
    }
    try {
      if (await isFeatureEnabled(definition.availabilityFlag)) available.add(definition.code);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'i18n.availability_unreadable', locale: definition.code, error: err instanceof Error ? err.name : 'error' }));
    }
  }
  return (locale) => available.has(locale);
}

/** The saved `users.locale` (possibly `null`). */
export async function readSavedUserLocale(userId: string): Promise<string | null> {
  try {
    const [row] = await getDb().select({ locale: users.locale }).from(users).where(eq(users.id, userId));
    return row?.locale ?? null;
  } catch {
    return null;
  }
}

function withDirection(locale: Locale): RequestLocale {
  return { locale, direction: localeDirection(locale) };
}

/** No request context: the recipient's saved locale if usable, else `en` (§3.8 channel dispatch). */
export async function resolveLocaleForUser(userId: string | null | undefined): Promise<Locale> {
  const [isAvailable, userLocale] = await Promise.all([loadLocaleAvailability(), userId ? readSavedUserLocale(userId) : null]);
  return resolveLocale({ userLocale, isAvailable });
}

async function sessionUserId(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const result = await validateAndRefreshSession(sessionId);
    return result.valid ? result.session.userId : null;
  } catch {
    return null;
  }
}

/**
 * Route handlers. `userId` is the caller's already-validated session user, when the route has one;
 * otherwise the session cookie is looked up here (a guest simply has none).
 */
export async function resolveLocaleForRequest(request: Request, userId?: string | null): Promise<RequestLocale> {
  const id = userId === undefined ? await sessionUserId(getSessionIdFromRequest(request)) : userId;
  const [isAvailable, userLocale] = await Promise.all([loadLocaleAvailability(), id ? readSavedUserLocale(id) : null]);
  return withDirection(
    resolveLocale({
      userLocale,
      cookieLocale: readCookie(request, LOCALE_COOKIE_NAME) ?? null,
      acceptLanguage: request.headers.get('accept-language'),
      isAvailable,
    }),
  );
}

/**
 * The root layout (§3.4): reads the incoming cookies and `Accept-Language` through `next/headers`, and the
 * signed-in user's saved locale through the existing session cookie and store. Makes every route dynamic
 * (accepted, R-1).
 */
export async function getRequestLocale(): Promise<RequestLocale> {
  // Deliberately NOT wrapped in try/catch: `cookies()`/`headers()` signal dynamic rendering by throwing a
  // Next-internal error that must propagate. Every lookup below already degrades to `en` on its own.
  const { cookies, headers } = await import('next/headers');
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const userId = await sessionUserId(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  const [isAvailable, userLocale] = await Promise.all([loadLocaleAvailability(), userId ? readSavedUserLocale(userId) : null]);
  return withDirection(
    resolveLocale({
      userLocale,
      cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value ?? null,
      acceptLanguage: headerStore.get('accept-language'),
      isAvailable,
    }),
  );
}
