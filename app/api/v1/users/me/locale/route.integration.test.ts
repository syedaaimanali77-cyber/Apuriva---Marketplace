import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { authenticatedRequest, registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
import { isDatabaseReachable, useUrduLocaleFlag } from '@/lib/i18n/i18n-test-support';
import type { UserLocaleDto } from '@/lib/types/i18n';
import { GET as GET_ME } from '../route';
import { PATCH } from './route';

const dbReachable = await isDatabaseReachable();
const URL = 'http://localhost/api/v1/users/me/locale';

async function savedLocale(userId: string): Promise<string | null> {
  const [row] = await getDb().select({ locale: users.locale }).from(users).where(eq(users.id, userId));
  return row!.locale;
}

function patch(user: TestSession, body: unknown): Promise<Response> {
  return PATCH(authenticatedRequest(URL, user.sessionId, user.csrfToken, { method: 'PATCH', body }));
}

describe('PATCH /users/me/locale in OpenAPI (spec 042 §3.11, X-16)', () => {
  it('is registered', () => {
    expect(OPENAPI_ROUTES.some((r) => r.method === 'PATCH' && r.path === '/users/me/locale')).toBe(true);
  });
});

describe.skipIf(!dbReachable)('PATCH /api/v1/users/me/locale (spec 042 §3.11 L2, AC-7, AC-8, integration)', () => {
  const { setUrduLocale } = useUrduLocaleFlag();
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetRateLimitState();
    log = vi.spyOn(console, 'log');
  });
  afterEach(() => log.mockRestore());

  const localeChangedLines = () =>
    log.mock.calls
      .map((call: unknown[]) => {
        try {
          return JSON.parse(String(call[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((line: Record<string, unknown> | null) => line?.event === 'i18n.locale_changed');

  it('401 without a session', async () => {
    const res = await PATCH(new Request(URL, { method: 'PATCH', body: JSON.stringify({ locale: 'en' }) }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
  });

  it('403 without a CSRF token (the spec 005 refusal)', async () => {
    const user = await registerAndLogin();
    const res = await PATCH(
      new Request(URL, {
        method: 'PATCH',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${user.sessionId}`, 'content-type': 'application/json' },
        body: JSON.stringify({ locale: 'en' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await savedLocale(user.userId)).toBeNull();
  });

  it('400 VALIDATION_ERROR for a non-string/non-null value or a bad tag shape', async () => {
    const user = await registerAndLogin();
    for (const body of [{ locale: 5 }, {}, { locale: 'EN' }, { locale: 'xx_1' }, { locale: 'a'.repeat(40) }]) {
      const res = await patch(user, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_ERROR');
    }
    expect(await savedLocale(user.userId)).toBeNull();
  });

  it('422 LOCALE_NOT_SUPPORTED for a well-formed tag that is not a supported locale', async () => {
    const user = await registerAndLogin();
    const res = await patch(user, { locale: 'pt-BR' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('LOCALE_NOT_SUPPORTED');
  });

  it('409 LOCALE_UNAVAILABLE for ur while urdu-locale is off (AC-8)', async () => {
    await setUrduLocale(false);
    const user = await registerAndLogin();
    const res = await patch(user, { locale: 'ur' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('LOCALE_UNAVAILABLE');
    expect(await savedLocale(user.userId)).toBeNull();
  });

  it('saves ur (flag on): persists, sets the cookie, logs without a user id, and /users/me returns it (AC-7)', async () => {
    await setUrduLocale(true);
    const user = await registerAndLogin();
    const res = await patch(user, { locale: 'ur' });
    expect(res.status).toBe(200);
    expect((await res.json()).data as UserLocaleDto).toEqual({ locale: 'ur', resolvedLocale: 'ur', direction: 'rtl' });
    expect(await savedLocale(user.userId)).toBe('ur');

    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/apuriva_locale=ur/);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=31536000/i);
    expect(cookie).not.toMatch(/HttpOnly/i);

    const lines = localeChangedLines();
    expect(lines).toEqual([{ event: 'i18n.locale_changed', from: null, to: 'ur', source: 'account' }]);
    expect(JSON.stringify(lines)).not.toContain(user.userId);

    const me = await GET_ME(authenticatedRequest('http://localhost/api/v1/users/me', user.sessionId, user.csrfToken, { method: 'GET' }));
    expect((await me.json()).data.locale).toBe('ur');
  });

  it('a repeated identical request is a no-op success (nothing written or logged)', async () => {
    const user = await registerAndLogin();
    expect((await patch(user, { locale: 'en' })).status).toBe(200);
    const [before] = await getDb().select({ updatedAt: users.updatedAt }).from(users).where(eq(users.id, user.userId));
    log.mockClear();
    const again = await patch(user, { locale: 'en' });
    expect(again.status).toBe(200);
    expect((await again.json()).data).toEqual({ locale: 'en', resolvedLocale: 'en', direction: 'ltr' });
    const [after] = await getDb().select({ updatedAt: users.updatedAt }).from(users).where(eq(users.id, user.userId));
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(localeChangedLines()).toEqual([]);
  });

  it('null clears the preference: resolution returns to cookie → Accept-Language → en (AC-7)', async () => {
    await setUrduLocale(true);
    const user = await registerAndLogin();
    await patch(user, { locale: 'ur' });
    const clearRequest = authenticatedRequest(URL, user.sessionId, user.csrfToken, { method: 'PATCH', body: { locale: null } });
    const headers = new Headers(clearRequest.headers);
    headers.set('cookie', `${headers.get('cookie')}; apuriva_locale=en`);
    headers.set('accept-language', 'ur');
    const res = await PATCH(new Request(clearRequest, { headers }));
    expect(res.status).toBe(200);
    // The cookie (en) now wins over Accept-Language (ur).
    expect((await res.json()).data).toEqual({ locale: null, resolvedLocale: 'en', direction: 'ltr' });
    expect(await savedLocale(user.userId)).toBeNull();

    const me = await GET_ME(authenticatedRequest('http://localhost/api/v1/users/me', user.sessionId, user.csrfToken, { method: 'GET' }));
    expect((await me.json()).data.locale).toBeNull();
  });

  it('429 once the default bucket is exhausted', async () => {
    const user = await registerAndLogin();
    while (checkRateLimit('default', user.userId).allowed) {
      // exhaust the bucket
    }
    const res = await patch(user, { locale: 'en' });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
  });
});
