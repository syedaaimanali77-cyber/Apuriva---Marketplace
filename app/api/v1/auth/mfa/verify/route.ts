import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles } from '@/lib/db/schema';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, validationError } from '@/lib/api/errors';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { markSessionMfaSatisfied } from '@/lib/auth/session';
import { verifyTotp } from '@/lib/auth/totp';
import { decryptTotpSecret, encryptTotpSecret } from '@/lib/auth/totp-secret-crypto';
import { readMfaEnrollmentToken } from '@/lib/auth/mfa-enrollment';
import { getUserRoles } from '@/lib/auth/roles';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { setSessionCookies } from '@/lib/auth/cookies';
import type { SessionDto } from '@/lib/types/auth';

/**
 * Spec 005 AC-5, `POST /api/v1/auth/mfa/verify` — completes an MFA-pending admin login.
 *
 * For an admin who has never enrolled, the first code is also the enrolment confirmation: the body then
 * carries the `enrollmentToken` from `POST /auth/mfa/enrollment`, and the secret is stored only once a code
 * from it verifies (lib/auth/mfa-enrollment.ts). MFA stays mandatory either way.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request, { allowPartial: true });
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as { code?: unknown; enrollmentToken?: unknown };
  if (typeof body.code !== 'string') throw validationError([{ field: 'code', message: 'is required' }]);

  const db = getDb();
  const [admin] = await db.select().from(adminProfiles).where(eq(adminProfiles.userId, session.userId));
  if (!admin) throw new ApiRouteError('DOMAIN_RULE_VIOLATION', 'MFA is not enrolled for this account.');

  // First-login enrolment: no stored secret yet, so the code must come from the secret the enrolment token carries.
  const enrolling = !admin.totpSecretEncrypted;
  let secret: string;
  if (enrolling) {
    const fromToken = typeof body.enrollmentToken === 'string' ? readMfaEnrollmentToken(body.enrollmentToken, session.id) : null;
    if (!fromToken) throw new ApiRouteError('DOMAIN_RULE_VIOLATION', 'MFA is not enrolled for this account. Start enrolment first.');
    secret = fromToken;
  } else {
    secret = decryptTotpSecret(admin.totpSecretEncrypted!);
  }

  if (!verifyTotp(secret, body.code)) {
    await recordSecurityEvent({ userId: session.userId, eventType: 'auth.mfa_failed', severity: 'warning' });
    throw new ApiRouteError('UNAUTHENTICATED', 'Invalid MFA code.');
  }

  if (enrolling) {
    // Stored only now, and only if no authenticator was enrolled meanwhile (a concurrent enrolment loses).
    const stored = await db
      .update(adminProfiles)
      .set({ totpSecretEncrypted: encryptTotpSecret(secret), mfaEnrolledAt: new Date() })
      .where(and(eq(adminProfiles.userId, session.userId), isNull(adminProfiles.totpSecretEncrypted)))
      .returning({ id: adminProfiles.id });
    if (stored.length === 0) throw new ApiRouteError('CONFLICT', 'Two-factor authentication was enrolled by another request. Sign in again.');
    await recordSecurityEvent({ userId: session.userId, eventType: 'auth.mfa_enrolled', severity: 'info' });
  }

  const updated = (await markSessionMfaSatisfied(session.id)) ?? session;
  await recordSecurityEvent({ userId: session.userId, eventType: 'auth.mfa_succeeded', severity: 'info' });

  const dto: SessionDto = {
    userId: updated.userId,
    sessionId: updated.id,
    expiresAt: updated.expiresAt.toISOString(),
    mfaRequired: false,
    roles: await getUserRoles(updated.userId),
  };

  const res = apiSuccess(dto, correlationId);
  setSessionCookies(res, updated.id, updated.expiresAt);
  return res;
});
