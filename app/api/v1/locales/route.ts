import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiSuccess } from '@/lib/api/response';
import { getOptionalSession } from '@/lib/auth/require-session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { platformCurrencyCode } from '@/lib/config/currency';
import { SUPPORTED_LOCALES } from '@/lib/i18n/config';
import { loadLocaleAvailability, resolveLocaleForRequest } from '@/lib/i18n/server';
import type { LocalesDto } from '@/lib/types/i18n';

/**
 * Spec 042 §3.11 L1, `GET /api/v1/locales` — guest or signed-in. Only AVAILABLE locales, in config order
 * (`ur` is absent while `urdu-locale` is off, AC-8), the caller's current resolution, and the §3.9 market
 * default currency the request form uses. `no-store`, so a flag change is seen on the next call.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await getOptionalSession(request);
  const identifier = session?.userId ?? hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('default', identifier);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const [isAvailable, resolved] = await Promise.all([loadLocaleAvailability(), resolveLocaleForRequest(request, session?.userId ?? null)]);
  const body: LocalesDto = {
    locales: SUPPORTED_LOCALES.filter((l) => isAvailable(l.code)).map(({ code, label, nativeLabel, direction }) => ({
      code,
      label,
      nativeLabel,
      direction,
    })),
    resolvedLocale: resolved.locale,
    platformCurrencyCode: platformCurrencyCode(),
  };
  const response = apiSuccess(body, correlationId);
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
