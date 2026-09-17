import { and, eq, lte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { customerProfiles, providerAvailabilityNotificationRequests, providerProfiles, requests, users } from '@/lib/db/schema';
import { hasActiveBooking } from './booking-lifecycle-adapter';
import { activeBookingBlocksDeletionError, deletionAlreadyPendingError, deletionNotPendingError } from './errors';
import { removePayoutMethodsForDeletedUser } from '@/lib/payouts/privacy';

const DEFAULT_GRACE_PERIOD_DAYS = 14;

/** Spec 015 §4: the sentinel a deleted account's request descriptions are redacted to. */
export const REDACTED_DESCRIPTION = '[redacted]';

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
 *
 * Spec 015 §4 "Retention and privacy" joins the same rule rather than adding a second mechanism:
 * a `Request` row is retained (it is the parent of offers/bookings/payments and every FK is
 * `restrict`, so deleting it is impossible anyway) and its only free-text PII column,
 * `description`, is redacted in place. Status/urgency/timestamps stay, so the request's role in
 * any retained financial or dispute record remains intelligible.
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
    // Spec 024 §4.4: remove and un-default this user's payout methods so a closed account can never be
    // paid. Database-only — the payout sweep revokes the destinations at the rail afterwards. Earnings
    // lines, payouts, items and adjustments are retained (every FK is RESTRICT); nothing owed is forfeited.
    await removePayoutMethodsForDeletedUser(id, db);
    // Spec 017 §4 "Retention and privacy": `request_provider_matches` rows need no sweep of their
    // own — they carry no PII once `provider_profiles.business_name` is nulled above, and every
    // FK on that table is `restrict`, so the rows are retained keyed to the now-anonymized user
    // exactly like every other provider-owned row in this schema.
    //
    // Spec 018 §4 "Retention and privacy": offers are retained (every FK is `restrict`, and an accepted
    // offer is the parent of spec 020's booking); only the provider's free-text message is redacted,
    // with the same sentinel spec 015 uses for request descriptions. Price, currency, included items
    // and timestamps stay as the commercial record.
    await db.execute(sql`
      UPDATE offers SET provider_message = ${REDACTED_DESCRIPTION}, updated_at = clock_timestamp()
       WHERE provider_message IS NOT NULL
         AND provider_profile_id IN (SELECT id FROM provider_profiles WHERE user_id = ${id})
    `);

    // Spec 019 §4 "Retention and privacy": pre-selection thread rows are retained (every FK is
    // `restrict`); only the bodies THIS user authored are redacted. Proposed prices, kinds, timestamps,
    // every offer_revisions row and the counterparty's own messages stay.
    await db.execute(sql`
      UPDATE offer_messages SET body = ${REDACTED_DESCRIPTION}, updated_at = clock_timestamp()
       WHERE sender_user_id = ${id} AND body <> ${REDACTED_DESCRIPTION}
    `);

    // Spec 025 §4 "Retention and privacy" (AC-10): post-booking conversation rows are retained (every FK
    // is `restrict`); only the bodies THIS user authored become the sentinel — the one body write
    // `messages_append_only_trg` permits. The counterparty's messages, the conversation, its participant
    // rows, every id and every timestamp survive.
    await db.execute(sql`
      UPDATE messages SET body = ${REDACTED_DESCRIPTION}, redacted_by_retention = true,
                          updated_at = clock_timestamp(), version = version + 1
       WHERE sender_user_id = ${id} AND body <> ${REDACTED_DESCRIPTION}
    `);

    // Spec 015 §4: redact the request's free-text PII, keeping the row itself. `not null` on the
    // column means a sentinel rather than NULL; every read path treats it as ordinary text, so a
    // redacted description can never break the status view.
    const [customerProfile] = await db
      .select({ id: customerProfiles.id })
      .from(customerProfiles)
      .where(eq(customerProfiles.userId, id));
    if (customerProfile) {
      await db
        .update(requests)
        .set({ description: REDACTED_DESCRIPTION, updatedAt: new Date() })
        .where(eq(requests.customerProfileId, customerProfile.id));

      // Spec 016 §4 "Retention and privacy" (AC-6): cancel any still-pending availability
      // notification this customer asked for, so spec 026 can never later send one to a deleted
      // account. Cancelled rather than deleted — every FK in this schema is `restrict`, and the
      // row carries no PII of its own once the user is anonymized.
      await db
        .update(providerAvailabilityNotificationRequests)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(providerAvailabilityNotificationRequests.customerProfileId, customerProfile.id),
            eq(providerAvailabilityNotificationRequests.status, 'pending'),
          ),
        );
    }
  }

  return { processed: due.length };
}
