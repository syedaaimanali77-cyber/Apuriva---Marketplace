import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { isValidE164 } from '@/lib/auth/phone';
import { createOtpRequest } from '@/lib/auth/otp-store';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import type { RequestOtpRequest } from '@/lib/types/auth';

/** Spec 005 AC-1, `POST /api/v1/auth/otp/request` — rate-limited per phone number and per IP. */
export const POST = withApiRoute(async (request, correlationId) => {
  const body = (await request.json().catch(() => ({}))) as Partial<RequestOtpRequest>;

  if (typeof body.phoneNumber !== 'string' || !isValidE164(body.phoneNumber)) {
    throw validationError([{ field: 'phoneNumber', message: 'must be a valid E.164 phone number' }]);
  }

  const ipHash = hashRequestIp(request) ?? 'unknown';
  const byPhone = checkRateLimit('auth', `otp-request:phone:${body.phoneNumber}`);
  const byIp = checkRateLimit('auth', `otp-request:ip:${ipHash}`);
  if (!byPhone.allowed) throw rateLimitedError(byPhone.retryAfterSeconds);
  if (!byIp.allowed) throw rateLimitedError(byIp.retryAfterSeconds);

  const { requestId, expiresAt } = await createOtpRequest(body.phoneNumber);

  return apiSuccess({ requestId, expiresAt: expiresAt.toISOString() }, correlationId);
});
