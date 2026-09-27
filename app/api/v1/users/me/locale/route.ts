import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiSuccess } from '@/lib/api/response';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { LOCALE_COOKIE_MAX_AGE_SECONDS, LOCALE_COOKIE_NAME } from '@/lib/i18n/config';
import { resolveLocaleForRequest } from '@/lib/i18n/server';
import { saveUserLocale, validateRequestedLocale } from '@/lib/i18n/user-locale';
import type { UserLocaleDto } from '@/lib/types/i18n';

/**
 * Spec 042 §3.11 L2, `PATCH /api/v1/users/me/locale` (AC-7, AC-8) — body `{ locale: string | null }`.
 * Persists `users.locale` (`null` clears it) and, for a chosen locale, sets the `apuriva_locale` cookie
 * (`Path=/`, `SameSite=Lax`, one year, NOT HttpOnly: the guest switcher writes the same cookie client-side,
 * and it holds only a locale tag). Moderated accounts may use it (spec 038 allow-list, like `/users/me`).
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request, { allowModeratedAccount: true });
  requireCsrf(request, session.id);

  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const body = await request.json().catch(() => undefined);
  const locale = await validateRequestedLocale(body);
  await saveUserLocale(session.userId, locale);

  const resolved = await resolveLocaleForRequest(request, session.userId);
  const dto: UserLocaleDto = { locale, resolvedLocale: resolved.locale, direction: resolved.direction };
  const response = apiSuccess(dto, correlationId);
  if (locale !== null) {
    response.cookies.set(LOCALE_COOKIE_NAME, locale, {
      path: '/',
      sameSite: 'lax',
      maxAge: LOCALE_COOKIE_MAX_AGE_SECONDS,
      httpOnly: false,
    });
  }
  return response;
});
