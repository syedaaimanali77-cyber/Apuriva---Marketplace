/**
 * Spec 016 AC-6 — the customer's availability-notification opt-in (master spec §42).
 *
 * This spec records the opt-in only. Delivery — channel, template, send path — is spec 026's
 * (spec 016 §7), which is why nothing here writes a `notifications` row.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { customerProfiles, providerAvailabilityNotificationRequests } from '@/lib/db/schema';
import { availabilityNotifyNotApplicableError, providerNotFoundError } from './errors';
import { getAvailabilitySummary } from './summary';
import type { AvailabilityNotifyDto, AvailabilityNotifyStatus } from '@/lib/types/availability';

export interface NotifyResult {
  dto: AvailabilityNotifyDto;
  /** false when an existing `pending` row was returned instead — the route answers `200`, not `201`. */
  created: boolean;
}

/**
 * AC-6 — creates a `pending` opt-in for (customer, provider).
 *
 * Idempotent by design: a second call while one is still `pending` returns the SAME row with
 * `created: false`, never a duplicate and never an error. The partial unique index
 * `provider_availability_notification_requests_pending_uq` is the database's independent
 * guarantee of that, so a concurrent double-submit cannot slip two rows past the pre-check.
 *
 * A provider already resolved `available` has nothing to notify about → `422`.
 */
export async function requestAvailabilityNotification(
  userId: string,
  providerProfileId: string,
): Promise<NotifyResult> {
  const db = getDb();

  const [customer] = await db
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId));
  if (!customer) throw providerNotFoundError();

  // Throws 404 for an unknown provider before anything is written.
  const summary = await getAvailabilitySummary(providerProfileId);
  if (summary.state === 'available') throw availabilityNotifyNotApplicableError();

  const existing = await findPending(customer.id, providerProfileId);
  if (existing) return { dto: existing, created: false };

  const inserted = await db
    .insert(providerAvailabilityNotificationRequests)
    .values({ customerProfileId: customer.id, providerProfileId, status: 'pending' })
    .onConflictDoNothing()
    .returning({
      id: providerAvailabilityNotificationRequests.id,
      status: providerAvailabilityNotificationRequests.status,
      createdAt: providerAvailabilityNotificationRequests.createdAt,
    });

  if (inserted.length === 0) {
    // Lost a race against a concurrent opt-in — the unique index did its job; return that row.
    const raced = await findPending(customer.id, providerProfileId);
    if (raced) return { dto: raced, created: false };
    throw providerNotFoundError();
  }

  const row = inserted[0]!;
  return {
    dto: { id: row.id, status: row.status as AvailabilityNotifyStatus, createdAt: row.createdAt.toISOString() },
    created: true,
  };
}

async function findPending(customerProfileId: string, providerProfileId: string): Promise<AvailabilityNotifyDto | undefined> {
  const [row] = await getDb()
    .select({
      id: providerAvailabilityNotificationRequests.id,
      status: providerAvailabilityNotificationRequests.status,
      createdAt: providerAvailabilityNotificationRequests.createdAt,
    })
    .from(providerAvailabilityNotificationRequests)
    .where(
      and(
        eq(providerAvailabilityNotificationRequests.customerProfileId, customerProfileId),
        eq(providerAvailabilityNotificationRequests.providerProfileId, providerProfileId),
        eq(providerAvailabilityNotificationRequests.status, 'pending'),
      ),
    );
  return row
    ? { id: row.id, status: row.status as AvailabilityNotifyStatus, createdAt: row.createdAt.toISOString() }
    : undefined;
}
