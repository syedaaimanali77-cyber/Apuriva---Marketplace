import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles, users } from '@/lib/db/schema';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { issueMfaEnrollment } from '@/lib/auth/mfa-enrollment';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import type { MfaEnrollmentDto } from '@/lib/types/auth';

/**
 * Spec 005 AC-5, `POST /api/v1/auth/mfa/enrollment` — starts first-login TOTP enrolment for an admin
 * who has never enrolled, inside the MFA-pending session their password created. Returns a fresh secret
 * (manual key + `otpauth://` URL) and an enrolment token; NOTHING is stored until `POST /auth/mfa/verify`
 * confirms a code from it (see lib/auth/mfa-enrollment.ts). An admin who is already enrolled is refused:
 * an existing authenticator is never replaced from a password-only session.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request, { allowPartial: true });
  requireCsrf(request, session.id);

  const limit = checkRateLimit('auth', `mfa-enrollment:user:${session.userId}`);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const db = getDb();
  const [admin] = await db
    .select({ totpSecretEncrypted: adminProfiles.totpSecretEncrypted })
    .from(adminProfiles)
    .where(eq(adminProfiles.userId, session.userId));
  if (!admin) throw forbiddenError('Two-factor enrolment is for admin accounts.');
  if (admin.totpSecretEncrypted) throw new ApiRouteError('CONFLICT', 'Two-factor authentication is already enrolled for this account.');

  const [user] = await db.select({ email: users.email, phoneNumber: users.phoneNumber }).from(users).where(eq(users.id, session.userId));
  const enrollment = issueMfaEnrollment(session.id, user?.email ?? user?.phoneNumber ?? session.userId);

  await recordSecurityEvent({ userId: session.userId, eventType: 'auth.mfa_enrollment_started', severity: 'info' });

  const dto: MfaEnrollmentDto = enrollment;
  return apiSuccess(dto, correlationId);
});
