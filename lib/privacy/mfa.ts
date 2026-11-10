import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles } from '@/lib/db/schema';
import { isAdminUser } from '@/lib/auth/session';
import { mfaDisableNotAllowedError, mfaEnrollmentRequiredError } from './errors';

/**
 * Spec 008 D/AC-5 `PATCH /users/me/mfa` — the Security Center's on/off control.
 *
 * KNOWN DEPENDENCY LIMITATION (not a bug, and not to be worked around here): spec 005 currently
 * only implements MFA enrollment for admin accounts (`AdminProfile.totp_secret_encrypted`,
 * mandatory per spec 005 AC-5) — it defines no self-service TOTP enrollment for a non-admin
 * account. Spec 008 must reuse whatever spec 005 already owns and must never stand up a second
 * MFA/TOTP mechanism or its own enrollment store (spec 008 §7 Out of scope), so this module reads
 * and writes ONLY `AdminProfile.totp_secret_encrypted`/`mfa_enrolled_at`. The practical
 * consequence, by design: enabling MFA for a non-admin account cannot succeed today — it fails
 * honestly with `MFA_ENROLLMENT_REQUIRED` (see ./errors.ts) rather than silently no-op'ing or
 * reporting a fake `mfaEnabled: true`. Once spec 005 adds non-admin enrollment, this module keeps
 * working unchanged — it already generically reads/writes "whatever spec 005's enrollment state
 * is," not an admin-only special case.
 */
export async function getMfaEnabled(userId: string): Promise<boolean> {
  const [admin] = await getDb()
    .select({ totpSecretEncrypted: adminProfiles.totpSecretEncrypted })
    .from(adminProfiles)
    .where(eq(adminProfiles.userId, userId));
  return Boolean(admin?.totpSecretEncrypted);
}

/**
 * Idempotent no-op when `enabled` already matches the current state. Otherwise:
 *  - turning MFA on for an account with nothing enrolled in spec 005 is rejected
 *    (`mfaEnrollmentRequiredError` — enrollment isn't this endpoint's job, see spec 008 §7 Out of
 *    scope);
 *  - turning MFA off for an admin account is rejected (spec 005 AC-5: mandatory, not optional).
 */
export async function setMfaEnabled(userId: string, enabled: boolean): Promise<{ mfaEnabled: boolean }> {
  const current = await getMfaEnabled(userId);
  if (enabled === current) return { mfaEnabled: current };

  if (enabled) throw mfaEnrollmentRequiredError();

  if (await isAdminUser(userId)) throw mfaDisableNotAllowedError();

  await getDb()
    .update(adminProfiles)
    .set({ totpSecretEncrypted: null, mfaEnrolledAt: null })
    .where(eq(adminProfiles.userId, userId));
  return { mfaEnabled: false };
}
