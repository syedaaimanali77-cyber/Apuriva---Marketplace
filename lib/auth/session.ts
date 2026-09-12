import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { adminProfiles, sessions } from '@/lib/db/schema';

/**
 * Session lifecycle — spec 005 §8 risk #3 (Decided): 15-minute session lifetime, silently
 * refreshed on any authenticated request, up to a 30-day sliding inactivity window; an absolute
 * 90-day cap from `issued_at` forces re-authentication regardless of activity.
 *
 * `sessions.id` (a `gen_random_uuid()` v4 UUID, 122 bits of randomness — spec 003 baseline) is
 * used directly as the opaque bearer token in the session cookie; no separate token/hash column
 * was added, keeping this spec's data model exactly what was approved in §4.
 */
export const SESSION_LIFETIME_MS = 15 * 60 * 1000;
const SLIDING_INACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ABSOLUTE_SESSION_CAP_MS = 90 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = 'apuriva_session';

export type SessionRow = typeof sessions.$inferSelect;

export interface CreateSessionInput {
  userId: string;
  mfaSatisfied: boolean;
  deviceLabel?: string | null;
  ipHash?: string | null;
}

export async function createSession(input: CreateSessionInput): Promise<SessionRow> {
  const now = new Date();
  const [row] = await getDb()
    .insert(sessions)
    .values({
      userId: input.userId,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
      mfaSatisfied: input.mfaSatisfied,
      deviceLabel: input.deviceLabel ?? null,
      ipHash: input.ipHash ?? null,
    })
    .returning();
  return row!;
}

/** True whether `userId` has an `AdminProfile` row — admin accounts require MFA (AC-5). */
export async function isAdminUser(userId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: adminProfiles.id }).from(adminProfiles).where(eq(adminProfiles.userId, userId));
  return row !== undefined;
}

export type SessionValidationResult =
  | { valid: true; session: SessionRow }
  | { valid: false; reason: 'not_found' | 'revoked' | 'expired' };

/**
 * Validates a session by ID. A full (`mfaSatisfied`) session is silently refreshed forward
 * (§8 risk #3) as long as it's within both the sliding inactivity window and the absolute cap.
 * A partial (MFA-pending) session is checked but never refreshed — it must complete MFA within
 * its original window or the caller starts over.
 */
export async function validateAndRefreshSession(sessionId: string): Promise<SessionValidationResult> {
  const db = getDb();
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!session) return { valid: false, reason: 'not_found' };
  if (session.revokedAt) return { valid: false, reason: 'revoked' };

  const now = Date.now();

  if (!session.mfaSatisfied) {
    if (now > session.expiresAt.getTime()) return { valid: false, reason: 'expired' };
    return { valid: true, session };
  }

  const lastActivityAt = session.expiresAt.getTime() - SESSION_LIFETIME_MS;
  if (now > session.issuedAt.getTime() + ABSOLUTE_SESSION_CAP_MS) return { valid: false, reason: 'expired' };
  if (now > lastActivityAt + SLIDING_INACTIVITY_WINDOW_MS) return { valid: false, reason: 'expired' };

  const [refreshed] = await db
    .update(sessions)
    .set({ expiresAt: new Date(now + SESSION_LIFETIME_MS), version: session.version + 1 })
    .where(and(eq(sessions.id, sessionId), eq(sessions.version, session.version)))
    .returning();

  // Lost an optimistic-concurrency race against a concurrent refresh/revoke of the same session —
  // treat as still valid on the pre-refresh row rather than failing the request over it.
  return { valid: true, session: refreshed ?? session };
}

/** Marks the MFA-pending session as fully satisfied after a successful second factor. */
export async function markSessionMfaSatisfied(sessionId: string): Promise<SessionRow | undefined> {
  const now = new Date();
  const [row] = await getDb()
    .update(sessions)
    .set({ mfaSatisfied: true, expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS) })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning();
  return row;
}

/** `reason` (spec 008 §4/AC-1/AC-2, e.g. `user_logout_single_device`/`user_logout_all_devices`)
 * is optional — spec 005's own logout endpoint doesn't need one. */
export async function revokeSession(sessionId: string, reason?: string): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ revokedAt: new Date(), revokedReason: reason ?? null })
    .where(eq(sessions.id, sessionId));
}
