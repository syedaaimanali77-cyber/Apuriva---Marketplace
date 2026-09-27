import { eq } from 'drizzle-orm';
import type { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { getOAuthProvider, OAuthProviderUnavailable, type OAuthProvider } from './oauth-provider';
import { completeLogin, type LoginMethod } from './login-flow';
import { setSessionCookies } from './cookies';
import { hashRequestIp } from './ip-hash';
import { oauthProviderUnavailableError } from './errors';
import { recordSecurityEvent } from './security-event';

/**
 * Shared body for both `/api/v1/auth/oauth/google` and `/api/v1/auth/oauth/apple` (spec 005
 * AC-4) — the two routes differ only in which provider they exchange against.
 *
 * Real Google/Apple sign-in is NOT implemented: only the sandbox adapter exists. The order below is
 * what keeps that sandbox from being a login-as-anyone endpoint:
 *   1. the adapter resolves first, so production fails closed (`503`) before the body is even read;
 *   2. the spec 005 `auth` rate-limit bucket, per IP, as `/auth/login` uses it;
 *   3. a sandbox may create a new OAuth-only account, or re-enter one, but never an existing account
 *      that carries another credential (a password or a phone number). The sandbox lets its caller
 *      choose the email it returns, so an email alone proves nothing about who is signing in.
 */
export async function handleOAuthCallback(
  request: Request,
  correlationId: string,
  providerName: 'google' | 'apple',
): Promise<NextResponse> {
  let provider: OAuthProvider;
  try {
    provider = getOAuthProvider(providerName);
  } catch (err) {
    if (err instanceof OAuthProviderUnavailable) throw oauthProviderUnavailableError();
    throw err;
  }

  const ipHash = hashRequestIp(request);
  const byIp = checkRateLimit('auth', `oauth:${providerName}:ip:${ipHash ?? 'unknown'}`);
  if (!byIp.allowed) throw rateLimitedError(byIp.retryAfterSeconds);

  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (typeof body.code !== 'string' || body.code.length === 0) {
    throw validationError([{ field: 'code', message: 'is required' }]);
  }

  const result = await provider.exchangeCode(body.code);
  const method: LoginMethod = providerName === 'google' ? 'oauth_google' : 'oauth_apple';

  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.email, result.email));

  if (existing && provider.isSandbox && (existing.passwordHash !== null || existing.phoneNumber !== null)) {
    await recordSecurityEvent({
      userId: existing.id,
      eventType: 'auth.login_failed',
      severity: 'warning',
      metadata: { method, reason: 'sandbox_oauth_existing_credentialed_account' },
    });
    throw new ApiRouteError('UNAUTHENTICATED', 'Sign-in with this provider could not be completed.');
  }

  const userId = existing
    ? existing.id
    : (
        await db
          .insert(users)
          .values({ email: result.email, emailVerifiedAt: result.emailVerified ? new Date() : null })
          .returning({ id: users.id })
      )[0]!.id;

  const { session, dto } = await completeLogin(userId, method, {
    ipHash,
    deviceLabel: request.headers.get('user-agent'),
  });

  const res = apiSuccess(dto, correlationId);
  setSessionCookies(res, session.id, session.expiresAt);
  return res;
}
