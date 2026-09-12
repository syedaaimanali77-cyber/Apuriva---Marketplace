import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, validationError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { isValidEmail, isValidPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/email';
import { hashPassword } from '@/lib/auth/password';
import { completeLogin } from '@/lib/auth/login-flow';
import { setSessionCookies } from '@/lib/auth/cookies';
import { hashRequestIp } from '@/lib/auth/ip-hash';

/** Spec 005 §3, `POST /api/v1/auth/register` — email+password. */
export const POST = withApiRoute(async (request, correlationId) => {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };

  const errors: { field: string; message: string }[] = [];
  if (typeof body.email !== 'string' || !isValidEmail(body.email)) {
    errors.push({ field: 'email', message: 'must be a valid email address' });
  }
  if (typeof body.password !== 'string' || !isValidPassword(body.password)) {
    errors.push({ field: 'password', message: `must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (errors.length > 0) throw validationError(errors);

  const email = body.email as string;
  const password = body.password as string;

  const ipHash = hashRequestIp(request) ?? 'unknown';
  const limit = checkRateLimit('auth', `register:ip:${ipHash}`);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const db = getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) throw new ApiRouteError('CONFLICT', 'An account with this email already exists.');

  const [{ id: userId }] = await db
    .insert(users)
    .values({ email, passwordHash: hashPassword(password) })
    .returning({ id: users.id });

  const { session, dto } = await completeLogin(userId!, 'password', {
    ipHash: hashRequestIp(request),
    deviceLabel: request.headers.get('user-agent'),
  });

  const res = apiSuccess(dto, correlationId, { status: 201 });
  setSessionCookies(res, session.id, session.expiresAt);
  return res;
});
