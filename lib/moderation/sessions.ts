/**
 * Spec 038 §3.4 — a `suspension` or `ban` becoming active revokes every unrevoked session of the
 * user, through spec 005's own exported `revokeSession()` — no parallel session mechanism and no
 * change to spec 005.
 *
 * Called AFTER the lifecycle transaction commits. It is defence in depth, not the enforcement: from
 * the commit onward spec 005's `requireSession` (X-1) already refuses the account everywhere except
 * the §3.5 allow-list.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { revokeSession } from '@/lib/auth/session';

export async function revokeAllSessionsForModeration(userId: string, reason: 'moderation_suspension' | 'moderation_ban'): Promise<number> {
  const open = await getDb()
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  for (const session of open) await revokeSession(session.id, reason);
  return open.length;
}
