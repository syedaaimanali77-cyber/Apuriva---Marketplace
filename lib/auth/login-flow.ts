import type { SessionDto } from '@/lib/types/auth';
import { createSession, isAdminUser, type SessionRow } from './session';
import { getUserRoles } from './roles';
import { recordSecurityEvent } from './security-event';
import { ensureCustomerProfile } from './profiles';

export type LoginMethod = 'otp' | 'password' | 'oauth_google' | 'oauth_apple';

export interface CompleteLoginResult {
  session: SessionRow;
  dto: SessionDto;
}

/**
 * Single choke point every login-completing endpoint (otp/verify, login, oauth/google,
 * oauth/apple) funnels through, so AC-5 (admin MFA mandatory) is enforced identically regardless
 * of which primary factor got the user here: an admin account always gets a partial
 * (`mfaSatisfied: false`) session first, requiring `/api/v1/auth/mfa/verify` before it's usable
 * for anything else — see `lib/auth/require-session.ts`.
 *
 * Also the choke point spec 006 §1/§4 hooks into to guarantee every user has a `CustomerProfile`
 * (a new session always starts in `customer` mode — spec 006 §4 — so that profile must exist).
 */
export async function completeLogin(
  userId: string,
  method: LoginMethod,
  context: { ipHash?: string | null; deviceLabel?: string | null } = {},
): Promise<CompleteLoginResult> {
  const isAdmin = await isAdminUser(userId);

  await ensureCustomerProfile(userId);

  const session = await createSession({
    userId,
    mfaSatisfied: !isAdmin,
    ipHash: context.ipHash,
    deviceLabel: context.deviceLabel,
  });

  const roles = await getUserRoles(userId);

  await recordSecurityEvent({
    userId,
    eventType: 'auth.login_succeeded',
    severity: 'info',
    metadata: { method, mfaPending: isAdmin },
  });

  const dto: SessionDto = {
    userId,
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
    mfaRequired: !session.mfaSatisfied,
    roles,
  };

  return { session, dto };
}
