/**
 * Spec 016 AC-6 × spec 026 — delivers the customer's availability-notification opt-in.
 *
 * Spec 016 records the opt-in (`lib/availability/notify.ts`) and left delivery to spec 026. This pass is
 * run by `/api/v1/cron/notification-dispatch-sweep`: for each still-`pending` opt-in whose provider now
 * resolves `available` (spec 016's own summary — the availability decision stays spec 016's), it hands one
 * `provider_available` event to `notify()` and then marks the opt-in `sent`.
 *
 * Crash-safe and idempotent: `notify()` dedups on `provider_available:{optInId}` (spec 026 AC-7), so a run
 * that dies between the two steps re-notifies nothing on the next run and simply completes the mark.
 * Opt-ins for deleted accounts are already `cancelled` by spec 008's deletion sweep.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { customerProfiles, providerAvailabilityNotificationRequests } from '@/lib/db/schema';
import { notify } from '@/lib/notifications/create';
import { getAvailabilitySummary } from './summary';

export const AVAILABILITY_DISPATCH_BATCH_LIMIT = 200;

export async function dispatchAvailabilityNotifications(now = new Date()): Promise<{ sent: number; checked: number }> {
  const db = getDb();
  const pending = await db
    .select({
      id: providerAvailabilityNotificationRequests.id,
      providerProfileId: providerAvailabilityNotificationRequests.providerProfileId,
      customerUserId: customerProfiles.userId,
    })
    .from(providerAvailabilityNotificationRequests)
    .innerJoin(customerProfiles, eq(customerProfiles.id, providerAvailabilityNotificationRequests.customerProfileId))
    .where(eq(providerAvailabilityNotificationRequests.status, 'pending'))
    .orderBy(asc(providerAvailabilityNotificationRequests.createdAt), asc(providerAvailabilityNotificationRequests.id))
    .limit(AVAILABILITY_DISPATCH_BATCH_LIMIT);

  const availability = new Map<string, boolean>();
  let sent = 0;
  for (const optIn of pending) {
    try {
      if (!availability.has(optIn.providerProfileId)) {
        const summary = await getAvailabilitySummary(optIn.providerProfileId, now);
        availability.set(optIn.providerProfileId, summary.state === 'available');
      }
      if (!availability.get(optIn.providerProfileId)) continue;

      await notify({
        recipientUserId: optIn.customerUserId,
        type: 'provider_available',
        eventKey: `provider_available:${optIn.id}`,
        params: { providerProfileId: optIn.providerProfileId },
      });
      const marked = await db
        .update(providerAvailabilityNotificationRequests)
        .set({ status: 'sent', notifiedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(providerAvailabilityNotificationRequests.id, optIn.id),
            eq(providerAvailabilityNotificationRequests.status, 'pending'),
          ),
        )
        .returning({ id: providerAvailabilityNotificationRequests.id });
      sent += marked.length;
    } catch (err) {
      console.error(
        JSON.stringify({ event: 'availability.notify_dispatch_failed', optInId: optIn.id, error: err instanceof Error ? err.name : 'error' }),
      );
    }
  }
  return { sent, checked: pending.length };
}
