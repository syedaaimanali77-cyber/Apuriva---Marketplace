import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { providerProfiles, requestProviderMatches } from '@/lib/db/schema';
import { notify } from '@/lib/notifications/create';

/**
 * Spec 015 §3 "Provider-notification hook" / AC-4. Master spec §38 requires that providers who were
 * notified about a request are informed when the customer cancels it.
 *
 * This reads the real table — spec 017 populates `request_provider_matches` — and, since spec 026,
 * hands each provider who was actually DISTRIBUTED the request (`notified_at` set) to `notify()`.
 * Spec 026 owns the channel/template/preference logic; this decides only who was affected. Called
 * after the cancellation commits, and a notification failure never fails the cancellation.
 */
export async function notifyProvidersOfCancellation(requestId: string): Promise<{ notifiedProviderProfileIds: string[] }> {
  const rows = await getDb()
    .select({
      providerProfileId: requestProviderMatches.providerProfileId,
      notifiedAt: requestProviderMatches.notifiedAt,
      providerUserId: providerProfiles.userId,
    })
    .from(requestProviderMatches)
    .innerJoin(providerProfiles, eq(providerProfiles.id, requestProviderMatches.providerProfileId))
    .where(eq(requestProviderMatches.requestId, requestId));

  for (const row of rows) {
    if (!row.notifiedAt) continue; // Never told about the request, so nothing to un-tell.
    try {
      await notify({
        recipientUserId: row.providerUserId,
        type: 'request_cancelled',
        eventKey: `request_cancelled:${requestId}`,
        params: { requestId },
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'request.cancellation_notification_failed',
          requestId,
          providerProfileId: row.providerProfileId,
          error: err instanceof Error ? err.name : 'error',
        }),
      );
    }
  }

  return { notifiedProviderProfileIds: rows.map((row) => row.providerProfileId) };
}
