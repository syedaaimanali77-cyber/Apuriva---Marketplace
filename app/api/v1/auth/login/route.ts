import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, validationError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { verifyPassword } from '@/lib/auth/password';
import { completeLogin } from '@/lib/auth/login-flow';
import { setSessionCookies } from '@/lib/auth/cookies';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { recordSecurityEvent } from '@/lib/auth/security-event';

/**
 * Spec 005 AC-3, `POST /api/v1/auth/login` — email+password. Never reveals whether the email is
 * registered: a missing account and a wrong password return the identical `401 UNAUTHENTICATED`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };

  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    const errors: { field: string; message: string }[] = [];
    if (typeof body.email !== 'string') errors.push({ field: 'email', message: 'is required' });
    if (typeof body.password !== 'string') errors.push({ field: 'password', message: 'is required' });
    throw validationError(errors);
  }
  const email = body.email;
  const password = body.password;

  const ipHash = hashRequestIp(request) ?? 'unknown';
  const byEmail = checkRateLimit('auth', `login:email:${email}`);
  const byIp = checkRateLimit('auth', `login:ip:${ipHash}`);
  if (!byEmail.allowed) throw rateLimitedError(byEmail.retryAfterSeconds);
  if (!byIp.allowed) throw rateLimitedError(byIp.retryAfterSeconds);

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email));

  if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    await recordSecurityEvent({
      userId: user?.id ?? null,
      eventType: 'auth.login_failed',
      severity: 'warning',
      metadata: { method: 'password' },
    });
    throw new ApiRouteError('UNAUTHENTICATED', 'Invalid email or password.');
  }

  const { session, dto } = await completeLogin(user.id, 'password', {
    ipHash: hashRequestIp(request),
    deviceLabel: request.headers.get('user-agent'),
  });

  const res = apiSuccess(dto, correlationId);
  setSessionCookies(res, session.id, session.expiresAt);
  return res;
});
