import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { requestProviderMatches } from '@/lib/db/schema';

/**
 * Spec 015 §3 "Provider-notification hook" / AC-4. Master spec §38 requires that providers who were
 * notified about a request are informed when the customer cancels it.
 *
 * Within this spec's implemented scope that set is always empty: distribution to a provider pool is
 * spec 017's (it populates `request_provider_matches`) and notification *delivery* is spec 026's.
 * Rather than fake either, this reads the real table — so the moment spec 017 starts populating it,
 * this returns real provider ids — and hands them to a delivery step that spec 026 owns. The
 * obligation is therefore unmet until 017 and 026 land, which AC-4 states explicitly.
 */
export async function notifyProvidersOfCancellation(requestId: string): Promise<{ notifiedProviderProfileIds: string[] }> {
  const rows = await getDb()
    .select({ providerProfileId: requestProviderMatches.providerProfileId })
    .from(requestProviderMatches)
    .where(eq(requestProviderMatches.requestId, requestId));

  // No delivery here: spec 026 owns the channel/template/preference logic, and inventing a
  // stand-in would be a fake integration (master spec §132.21).
  return { notifiedProviderProfileIds: rows.map((row) => row.providerProfileId) };
}
