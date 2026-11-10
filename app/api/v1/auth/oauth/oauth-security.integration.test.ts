import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { securityEvents, sessions, users } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { POST as register } from '@/app/api/v1/auth/register/route';
import { POST as oauthGoogle } from '@/app/api/v1/auth/oauth/google/route';
import { POST as oauthApple } from '@/app/api/v1/auth/oauth/apple/route';
import { isDatabaseReachable, uniqueEmail, uniquePhoneNumber } from '@/app/api/v1/auth/test-support';

/**
 * Spec 005 AC-4 — security regression for the sandbox OAuth endpoints.
 *
 * Only the sandbox adapter exists (no real Google/Apple sign-in), and it lets its caller choose the
 * email it returns. These tests pin the three things that keep that from becoming a login-as-anyone
 * endpoint: it fails closed in production, it can never enter an existing account that has another
 * credential, and it is rate-limited like `/auth/login`.
 */
const dbReachable = await isDatabaseReachable();

const originalNodeEnv = process.env.NODE_ENV;
function setNodeEnv(value: string | undefined): void {
  // `NODE_ENV` is typed as a readonly union in Next's ambient types; tests legitimately flip it.
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

const ROUTES = [
  ['google', oauthGoogle],
  ['apple', oauthApple],
] as const;

function oauthRequest(provider: 'google' | 'apple', body: unknown, ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`): Request {
  return new Request(`http://localhost/api/v1/auth/oauth/${provider}`, {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

/** The attack payload: a sandbox "code" that simply names the victim's email. */
function impersonationCode(email: string): string {
  return JSON.stringify({ email, providerUserId: `attacker-${randomUUID()}` });
}

async function sessionCount(userId: string): Promise<number> {
  return (await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
}

describe.skipIf(!dbReachable)('sandbox OAuth security (spec 005 AC-4)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
  });

  describe.each(ROUTES)('%s', (provider, route) => {
    it('fails closed in production: 503 OAUTH_PROVIDER_UNAVAILABLE, no session, no account', async () => {
      const email = uniqueEmail();
      setNodeEnv('production');

      const res = await route(oauthRequest(provider, { code: impersonationCode(email) }));

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.code).toBe('OAUTH_PROVIDER_UNAVAILABLE');
      expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();

      setNodeEnv(originalNodeEnv);
      expect(await getDb().select({ id: users.id }).from(users).where(eq(users.email, email))).toHaveLength(0);
    });

    it('fails closed in production even for an existing account', async () => {
      const email = uniqueEmail();
      const reg = await register(
        new Request('http://localhost/api/v1/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password: 'correct horse battery staple' }),
        }),
      );
      expect(reg.status).toBe(201);
      const [victim] = await getDb().select().from(users).where(eq(users.email, email));
      const before = await sessionCount(victim!.id);

      setNodeEnv('production');
      const res = await route(oauthRequest(provider, { code: impersonationCode(email) }));
      setNodeEnv(originalNodeEnv);

      expect(res.status).toBe(503);
      expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
      expect(await sessionCount(victim!.id)).toBe(before);
    });

    it('SECURITY REGRESSION: a code naming an existing password account cannot create a session for it', async () => {
      const email = uniqueEmail();
      const reg = await register(
        new Request('http://localhost/api/v1/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password: 'correct horse battery staple' }),
        }),
      );
      expect(reg.status).toBe(201);
      const [victim] = await getDb().select().from(users).where(eq(users.email, email));
      const before = await sessionCount(victim!.id);

      // POST /api/v1/auth/oauth/<provider> { "code": "{\"email\":\"<existing user>\"}" }
      const res = await route(oauthRequest(provider, { code: JSON.stringify({ email }) }));

      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('UNAUTHENTICATED');
      expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
      expect(await sessionCount(victim!.id)).toBe(before);

      // Recorded as a failed login against the targeted account.
      const failures = await getDb()
        .select({ id: securityEvents.id })
        .from(securityEvents)
        .where(and(eq(securityEvents.userId, victim!.id), eq(securityEvents.eventType, 'auth.login_failed')));
      expect(failures.length).toBeGreaterThanOrEqual(1);
    });

    it('SECURITY REGRESSION: a code naming an existing phone account cannot create a session for it', async () => {
      const email = uniqueEmail();
      const [victim] = await getDb()
        .insert(users)
        .values({ email, phoneNumber: uniquePhoneNumber(), phoneVerifiedAt: new Date() })
        .returning({ id: users.id });

      const res = await route(oauthRequest(provider, { code: impersonationCode(email) }));

      expect(res.status).toBe(401);
      expect(res.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
      expect(await sessionCount(victim!.id)).toBe(0);
    });

    it('deterministic sandbox behaviour still works outside production: new identity, then the same account again', async () => {
      const email = uniqueEmail();
      const code = JSON.stringify({ email, providerUserId: `${provider}-dev-user` });

      const first = await route(oauthRequest(provider, { code }));
      expect(first.status).toBe(200);
      expect(first.cookies.get(SESSION_COOKIE_NAME)?.value).toBeTruthy();
      const { data } = await first.json();

      const again = await route(oauthRequest(provider, { code }));
      expect(again.status).toBe(200);
      expect((await again.json()).data.userId).toBe(data.userId);

      // A non-JSON code still maps to a stable, reserved-domain sandbox identity.
      const opaque = `opaque-${randomUUID()}`;
      const a = await route(oauthRequest(provider, { code: opaque }));
      const b = await route(oauthRequest(provider, { code: opaque }));
      expect(a.status).toBe(200);
      expect((await b.json()).data.userId).toBe((await a.json()).data.userId);
    });

    it("is rate-limited per IP with spec 005's auth bucket (10/min), answering 429 RATE_LIMITED", async () => {
      const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
      // An empty body is rejected (400) after the rate-limit check, so these writes nothing.
      for (let i = 0; i < 10; i += 1) {
        expect((await route(oauthRequest(provider, {}, ip))).status).toBe(400);
      }
      const limited = await route(oauthRequest(provider, {}, ip));
      expect(limited.status).toBe(429);
      expect((await limited.json()).code).toBe('RATE_LIMITED');
    });
  });
});
