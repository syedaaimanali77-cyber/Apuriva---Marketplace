import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles } from '@/lib/db/schema';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { ApiRouteError, validationError } from '@/lib/api/errors';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { markSessionMfaSatisfied } from '@/lib/auth/session';
import { verifyTotp } from '@/lib/auth/totp';
import { decryptTotpSecret } from '@/lib/auth/totp-secret-crypto';
import { getUserRoles } from '@/lib/auth/roles';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { setSessionCookies } from '@/lib/auth/cookies';
import type { SessionDto } from '@/lib/types/auth';

/** Spec 005 AC-5, `POST /api/v1/auth/mfa/verify` — completes an MFA-pending admin login. */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request, { allowPartial: true });
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (typeof body.code !== 'string') throw validationError([{ field: 'code', message: 'is required' }]);

  const db = getDb();
  const [admin] = await db.select().from(adminProfiles).where(eq(adminProfiles.userId, session.userId));
  if (!admin?.totpSecretEncrypted) {
    throw new ApiRouteError('DOMAIN_RULE_VIOLATION', 'MFA is not enrolled for this account.');
  }

  const secret = decryptTotpSecret(admin.totpSecretEncrypted);
  if (!verifyTotp(secret, body.code)) {
    await recordSecurityEvent({ userId: session.userId, eventType: 'auth.mfa_failed', severity: 'warning' });
    throw new ApiRouteError('UNAUTHENTICATED', 'Invalid MFA code.');
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
