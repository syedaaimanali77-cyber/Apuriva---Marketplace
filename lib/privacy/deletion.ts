import { and, eq, lte } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerProfiles, users } from '@/lib/db/schema';
import { hasActiveBooking } from './booking-lifecycle-adapter';
import { activeBookingBlocksDeletionError, deletionAlreadyPendingError, deletionNotPendingError } from './errors';

const DEFAULT_GRACE_PERIOD_DAYS = 14;

/**
 * Spec 008 §8 risk #1: 14 days is the implementation default, explicitly pending Legal/Product
 * confirmation before production — server-side configurable via env, not hardcoded logic a
 * developer would otherwise have to invent.
 */
export function getGracePeriodDays(): number {
  const raw = process.env.DELETION_GRACE_PERIOD_DAYS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GRACE_PERIOD_DAYS;
}

export interface DeletionStatus {
  lifecycleStatus: string;
  deletionGraceEndsAt: string | null;
}

/** Read side of the same resource `POST /users/me/deletion` and `.../deletion/cancel` act on —
 * lets the UI show "Deletion Pending until <date>" after a reload without re-deriving it from
 * the one-shot POST response. Not a sensitive action; no step-up needed to merely read it. */
export async function getDeletionStatus(userId: string): Promise<DeletionStatus> {
  const [user] = await getDb()
    .select({ lifecycleStatus: users.lifecycleStatus, deletionGraceEndsAt: users.deletionGraceEndsAt })
    .from(users)
    .where(eq(users.id, userId));
  return {
    lifecycleStatus: user?.lifecycleStatus ?? 'active',
    deletionGraceEndsAt: user?.deletionGraceEndsAt ? user.deletionGraceEndsAt.toISOString() : null,
  };
}

/**
 * `POST /users/me/deletion` (AC-4). Deterministic: an active booking blocks deletion outright —
 * no pending-deletion state is entered — rather than the account model's previously-ambiguous
 * "resolved or flagged". A repeat request while already pending is `409
 * DELETION_ALREADY_PENDING`, never a second workflow.
 */
export async function requestDeletion(userId: string): Promise<{ gracePeriodEndsAt: Date }> {
  const db = getDb();
  const [user] = await db.select({ lifecycleStatus: users.lifecycleStatus }).from(users).where(eq(users.id, userId));
  if (user?.lifecycleStatus === 'deletion_pending') throw deletionAlreadyPendingError();

  if (await hasActiveBooking(userId)) throw activeBookingBlocksDeletionError();

  const now = new Date();
  const gracePeriodEndsAt = new Date(now.getTime() + getGracePeriodDays() * 24 * 60 * 60 * 1000);
  await db
    .update(users)
    .set({ lifecycleStatus: 'deletion_pending', deletionRequestedAt: now, deletionGraceEndsAt: gracePeriodEndsAt })
    .where(eq(users.id, userId));
  return { gracePeriodEndsAt };
}

/**
 * `POST /users/me/deletion/cancel` — only the caller's own request, only while still
 * `deletion_pending` (i.e. within the grace period and before the sweep has anonymized anything).
 * Once the sweep moves the account to `deleted`, this always throws — deletion cannot be undone.
 */
export async function cancelDeletion(userId: string): Promise<void> {
  const db = getDb();
  const [user] = await db.select({ lifecycleStatus: users.lifecycleStatus }).from(users).where(eq(users.id, userId));
  if (user?.lifecycleStatus !== 'deletion_pending') throw deletionNotPendingError();

  await db
    .update(users)
    .set({ lifecycleStatus: 'active', deletionRequestedAt: null, deletionGraceEndsAt: null })
    .where(and(eq(users.id, userId), eq(users.lifecycleStatus, 'deletion_pending')));
}

/**
 * Scheduled sweep (`app/api/v1/cron/account-deletion-sweep`) — server-side only, never
 * client-triggered. Idempotent/retry-safe/pause-resume-safe by construction: it only selects
 * accounts still `deletion_pending` past their grace end, and each row's own update re-checks
 * that same predicate, so re-running (including a re-run after a crash mid-sweep) can only ever
 * affect a row once. Anonymizes identifying fields on `User`/`ProviderProfile` (`CustomerProfile`
 * carries no PII columns yet beyond its `user_id` FK); `Payment`/`Payout`/`Refund`/`AuditLog`
 * rows are never touched here — retained keyed to the now-anonymized user, per spec 008 §4.
 */
export async function sweepDeletions(now: Date = new Date()): Promise<{ processed: number }> {
  const db = getDb();
  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.lifecycleStatus, 'deletion_pending'), lte(users.deletionGraceEndsAt, now)));

  for (const { id } of due) {
    await db
      .update(users)
      .set({
        lifecycleStatus: 'deleted',
        email: null,
        phoneNumber: null,
        passwordHash: null,
        phoneVerifiedAt: null,
        emailVerifiedAt: null,
      })
      .where(and(eq(users.id, id), eq(users.lifecycleStatus, 'deletion_pending')));

    await db.update(providerProfiles).set({ businessName: null }).where(eq(providerProfiles.userId, id));
  }

  return { processed: due.length };
}
