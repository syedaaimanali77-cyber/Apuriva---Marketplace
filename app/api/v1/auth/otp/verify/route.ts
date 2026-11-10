import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError, ApiRouteError } from '@/lib/api/errors';
import { otpAlreadyUsedError, otpExpiredError } from '@/lib/auth/errors';
import { consumeOtpRequest } from '@/lib/auth/otp-store';
import { completeLogin } from '@/lib/auth/login-flow';
import { setSessionCookies } from '@/lib/auth/cookies';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import type { VerifyOtpRequest } from '@/lib/types/auth';

/**
 * Spec 005 AC-1/AC-2, `POST /api/v1/auth/otp/verify` — idempotent on `requestId`. Creates the
 * account on first successful verification of a new phone number, otherwise logs the existing
 * user in.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const body = (await request.json().catch(() => ({}))) as Partial<VerifyOtpRequest>;

  if (typeof body.requestId !== 'string' || typeof body.code !== 'string') {
    const errors: { field: string; message: string }[] = [];
    if (typeof body.requestId !== 'string') errors.push({ field: 'requestId', message: 'is required' });
    if (typeof body.code !== 'string') errors.push({ field: 'code', message: 'is required' });
    throw validationError(errors);
  }

  const result = consumeOtpRequest(body.requestId, body.code);

  if (!result.ok) {
    if (result.reason === 'already_used') throw otpAlreadyUsedError();
    if (result.reason === 'expired') throw otpExpiredError();

    if (result.reason === 'rate_limited' || result.justLocked) {
      await recordSecurityEvent({
        eventType: 'auth.otp_rate_limited',
        severity: 'warning',
        metadata: { requestId: body.requestId },
      });
    }
    if (result.reason === 'rate_limited') {
      throw new ApiRouteError('RATE_LIMITED', 'Too many incorrect attempts for this OTP request.', {
        retryAfterSeconds: 60,
      });
    }
    throw new ApiRouteError('UNAUTHENTICATED', 'Incorrect code.');
  }

  const db = getDb();
  const [existing] = await db.select().from(users).where(eq(users.phoneNumber, result.phoneNumber));

  const userId = existing
    ? existing.id
    : (
        await db
          .insert(users)
          .values({ phoneNumber: result.phoneNumber, phoneVerifiedAt: new Date() })
          .returning({ id: users.id })
      )[0]!.id;

  if (existing && !existing.phoneVerifiedAt) {
    await db.update(users).set({ phoneVerifiedAt: new Date() }).where(eq(users.id, userId));
  }

  const { session, dto } = await completeLogin(userId, 'otp', {
    ipHash: hashRequestIp(request),
    deviceLabel: request.headers.get('user-agent'),
  });

  const res = apiSuccess(dto, correlationId);
  setSessionCookies(res, session.id, session.expiresAt);
  return res;
});
