import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { NOT_FOUND_ERROR } from './not-found';
import { revokeSession, type SessionRow } from '@/lib/auth/session';
import type { SessionSummaryDto } from '@/lib/types/privacy';

/** Spec 008 AC-1/AC-2: reasons recorded on `Session.revoked_reason` when this spec revokes one. */
export const REVOKED_REASON_SINGLE_DEVICE = 'user_logout_single_device';
export const REVOKED_REASON_ALL_OTHER_DEVICES = 'user_logout_all_other_devices';

/** A session counts as "active" (AC-1) once it's fully authenticated, not revoked, and not past
 * its expiry — an MFA-pending (partial) session isn't a device the user is "logged in on" yet. */
function activeSessionConditions(userId: string) {
  return and(eq(sessions.userId, userId), isNull(sessions.revokedAt), eq(sessions.mfaSatisfied, true), gt(sessions.expiresAt, new Date()));
}

export async function listActiveSessions(userId: string): Promise<SessionRow[]> {
  return getDb()
    .select()
    .from(sessions)
    .where(activeSessionConditions(userId));
}

export function toSessionSummaryDto(row: SessionRow, currentSessionId: string): SessionSummaryDto {
  return {
    id: row.id,
    deviceLabel: row.deviceLabel,
    // See lib/types/privacy.ts — always null: no geolocation source exists yet, and it must
    // never be derived from the raw IP (never stored) or anything more precise than coarse.
    approxLocation: null,
    lastActiveAt: row.expiresAt.toISOString(),
    isCurrent: row.id === currentSessionId,
  };
}

/**
 * AC-1/§3 `DELETE /users/me/sessions/{id}` — revokes one session, but only if it belongs to
 * `userId`. A nonexistent id or one belonging to another user throws the identical `NOT_FOUND`
 * either way (lib/privacy/not-found.ts) so the response never reveals which case it was.
 */
export async function revokeOwnSession(userId: string, sessionId: string): Promise<void> {
  const [row] = await getDb()
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!row || row.userId !== userId) throw NOT_FOUND_ERROR();

  await revokeSession(sessionId, REVOKED_REASON_SINGLE_DEVICE);
}

/**
 * AC-2 `DELETE /users/me/sessions` — revokes every one of the caller's sessions except
 * `currentSessionId`, which this action never touches (spec 008's resolved "log out all devices"
 * ambiguity: the current session always survives).
 */
export async function revokeAllOtherSessions(userId: string, currentSessionId: string): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: REVOKED_REASON_ALL_OTHER_DEVICES })
    .where(and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId), isNull(sessions.revokedAt)));
}
