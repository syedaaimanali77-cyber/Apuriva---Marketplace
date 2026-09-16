/**
 * Spec 023 §3 — the booking-scoped policy read (AC-1), and the provider's option write (AC-4).
 *
 * The booking-scoped read is what AC-1's "sees the policy before paying" actually rests on: it
 * returns the SNAPSHOT, not a re-resolution of current configuration, so what a customer is shown on
 * the payment screen is exactly what will be enforced if they later cancel.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { requireBookingParticipant } from '@/lib/bookings/read';
import { queryRows } from '@/lib/offers/db';
import type { CancellationPolicyDto } from '@/lib/types/cancellation';
import { policyOptionNotAllowedError } from './errors';
import { ensurePolicyAcceptance, resolveEffectivePolicy } from './resolution';

/** `GET /bookings/{id}/cancellation-policy` — the version snapshotted for THIS booking. */
export async function readBookingCancellationPolicy(userId: string, bookingId: string): Promise<CancellationPolicyDto> {
  await requireBookingParticipant(userId, bookingId);

  return getDb().transaction(async (tx) => {
    const [row] = await queryRows<{
      service_id: string;
      created_at: Date;
      customer_user_id: string;
      provider_option_key: string | null;
    }>(
      tx,
      sql`SELECT b.service_id, b.created_at, cp.user_id AS customer_user_id,
                 ps.cancellation_policy_option AS provider_option_key
            FROM bookings b
            JOIN customer_profiles cp ON cp.id = b.customer_profile_id
            LEFT JOIN provider_services ps
                   ON ps.provider_profile_id = b.provider_profile_id AND ps.service_id = b.service_id
           WHERE b.id = ${bookingId}
           FOR UPDATE OF b`,
    );
    if (!row) {
      const { bookingNotFoundError } = await import('@/lib/bookings/errors');
      throw bookingNotFoundError();
    }

    const resolved = await ensurePolicyAcceptance(tx, {
      bookingId,
      serviceId: row.service_id,
      customerUserId: row.customer_user_id,
      bookingCreatedAt: new Date(row.created_at),
      providerOptionKey: row.provider_option_key,
    });

    return {
      policyVersionId: resolved.policyVersionId,
      source: resolved.source,
      providerOptionKey: resolved.providerOptionKey,
      tiers: resolved.tiers,
      snapshotAsOf: new Date(row.created_at).toISOString(),
    } satisfies CancellationPolicyDto;
  });
}

/**
 * `PUT /providers/me/services/{id}/cancellation-option` — AC-4's constraint, at the one place a
 * provider can influence policy at all.
 *
 * A provider selects a KEY the effective version publishes; they never supply a percentage, and no
 * column anywhere could store one if they tried. An unknown key is refused
 * `422 POLICY_OPTION_NOT_ALLOWED` naming what IS allowed, so the failure is actionable rather than
 * mysterious. `null` clears the selection and falls back to the version's own tiers.
 */
export async function setProviderCancellationOption(
  providerProfileId: string,
  serviceId: string,
  optionKey: string | null,
): Promise<{ optionKey: string | null }> {
  const db = getDb();

  if (optionKey !== null) {
    const resolved = await resolveEffectivePolicy(db, serviceId, new Date());
    const allowed = resolved.config.allowedOptions.map((option) => option.key);
    if (!allowed.includes(optionKey)) throw policyOptionNotAllowedError(optionKey, allowed);
  }

  const updated = await queryRows<{ cancellation_policy_option: string | null }>(
    db,
    sql`UPDATE provider_services
           SET cancellation_policy_option = ${optionKey}, updated_at = clock_timestamp()
         WHERE provider_profile_id = ${providerProfileId} AND service_id = ${serviceId}
         RETURNING cancellation_policy_option`,
  );
  if (updated.length === 0) {
    const { bookingNotFoundError } = await import('@/lib/bookings/errors');
    throw bookingNotFoundError();
  }

  return { optionKey: updated[0]!.cancellation_policy_option };
}
