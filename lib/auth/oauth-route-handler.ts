import { eq } from 'drizzle-orm';
import type { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { getOAuthProvider } from './oauth-provider';
import { completeLogin, type LoginMethod } from './login-flow';
import { setSessionCookies } from './cookies';
import { hashRequestIp } from './ip-hash';

/**
 * Shared body for both `/api/v1/auth/oauth/google` and `/api/v1/auth/oauth/apple` (spec 005
 * AC-4) — the two routes differ only in which provider they exchange against.
 */
export async function handleOAuthCallback(
  request: Request,
  correlationId: string,
  providerName: 'google' | 'apple',
): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (typeof body.code !== 'string' || body.code.length === 0) {
    throw validationError([{ field: 'code', message: 'is required' }]);
  }

  const result = await getOAuthProvider(providerName).exchangeCode(body.code);

  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.email, result.email));

  const userId = existing
    ? existing.id
    : (
        await db
          .insert(users)
          .values({ email: result.email, emailVerifiedAt: result.emailVerified ? new Date() : null })
          .returning({ id: users.id })
      )[0]!.id;

  const method: LoginMethod = providerName === 'google' ? 'oauth_google' : 'oauth_apple';
  const { session, dto } = await completeLogin(userId, method, {
    ipHash: hashRequestIp(request),
    deviceLabel: request.headers.get('user-agent'),
  });

  const res = apiSuccess(dto, correlationId);
  setSessionCookies(res, session.id, session.expiresAt);
  return res;
}
