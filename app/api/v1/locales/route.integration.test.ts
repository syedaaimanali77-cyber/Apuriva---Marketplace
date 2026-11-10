import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { isDatabaseReachable, useUrduLocaleFlag } from '@/lib/i18n/i18n-test-support';
import type { LocalesDto } from '@/lib/types/i18n';
import { GET } from './route';

const dbReachable = await isDatabaseReachable();
const URL = 'http://localhost/api/v1/locales';

function guestRequest(headers: Record<string, string> = {}): Request {
  return new Request(URL, { headers: { 'x-forwarded-for': '203.0.113.42', ...headers } });
}

describe('GET /locales in OpenAPI (spec 042 §3.11, X-16)', () => {
  it('registers L1 and L2', () => {
    const entries = OPENAPI_ROUTES.filter((r) => r.path === '/locales' || r.path === '/users/me/locale');
    expect(entries.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /locales', 'PATCH /users/me/locale']);
  });
});

describe.skipIf(!dbReachable)('GET /api/v1/locales (spec 042 §3.11 L1, AC-8, integration)', () => {
  const { setUrduLocale } = useUrduLocaleFlag();

  beforeEach(() => {
    resetRateLimitState();
  });

  async function read(request: Request): Promise<{ res: Response; data: LocalesDto }> {
    const res = await GET(request);
    const body = await res.json();
    return { res, data: body.data as LocalesDto };
  }

  it('flag off: a guest gets only en, in config order, resolved en even when asking for ur; no-store', async () => {
    await setUrduLocale(false);
    const { res, data } = await read(guestRequest({ 'accept-language': 'ur-PK,ur;q=0.9', cookie: 'apuriva_locale=ur' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(data.locales).toEqual([{ code: 'en', label: 'English', nativeLabel: 'English', direction: 'ltr' }]);
    expect(data.resolvedLocale).toBe('en');
    expect(data.platformCurrencyCode).toBe(process.env.PLATFORM_CURRENCY_CODE?.trim() || 'PKR');
  });

  it('flag on: ur is offered, and a guest resolves from the cookie, then Accept-Language', async () => {
    await setUrduLocale(true);
    const offered = await read(guestRequest());
    expect(offered.data.locales.map((l) => l.code)).toEqual(['en', 'ur']);
    expect(offered.data.locales[1]).toEqual({ code: 'ur', label: 'Urdu', nativeLabel: 'اردو', direction: 'rtl' });
    expect(offered.data.resolvedLocale).toBe('en');

    expect((await read(guestRequest({ cookie: 'apuriva_locale=ur' }))).data.resolvedLocale).toBe('ur');
    expect((await read(guestRequest({ 'accept-language': 'fr;q=0.9, ur-PK;q=0.8' }))).data.resolvedLocale).toBe('ur');
    // The cookie wins over Accept-Language.
    expect((await read(guestRequest({ cookie: 'apuriva_locale=en', 'accept-language': 'ur' }))).data.resolvedLocale).toBe('en');
  });

  it("signed in: the saved users.locale wins over the cookie; unusable once the flag is off (AC-7, AC-8)", async () => {
    const user = await registerAndLogin();
    await getDb().update(users).set({ locale: 'ur' }).where(eq(users.id, user.userId));
    const request = () => new Request(URL, { headers: { cookie: `${SESSION_COOKIE_NAME}=${user.sessionId}; apuriva_locale=en` } });

    await setUrduLocale(true);
    expect((await read(request())).data.resolvedLocale).toBe('ur');

    await setUrduLocale(false);
    const off = await read(request());
    expect(off.data.resolvedLocale).toBe('en');
    expect(off.data.locales.map((l) => l.code)).toEqual(['en']);
  });

  it('is rate limited on the default bucket, keyed by the hashed IP for a guest (429)', async () => {
    const request = guestRequest();
    const identifier = hashRequestIp(request) ?? 'unknown';
    while (checkRateLimit('default', identifier).allowed) {
      // exhaust the bucket
    }
    const res = await GET(guestRequest());
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
  });
});
