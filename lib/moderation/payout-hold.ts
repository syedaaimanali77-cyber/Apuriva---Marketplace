/**
 * Spec 038 §3.7 (AC-7) — the real `PayoutHoldGate` for spec 024's port.
 *
 * `held` is true exactly while an `active` `payout_freeze` exists for the provider profile. Spec 024
 * consults the gate at Pass C (batch close) and in the earnings summary; that is the whole MVP
 * freeze. Payouts already `eligible`/`processing`, and `reopenFailedPayout()` retries, are normatively
 * OUTSIDE it (§3.7) — covering them would be a spec 024 change, not made here. No payout column or
 * state is written by this spec.
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { PayoutHoldGate } from '@/lib/payouts/ports';

export const moderationPayoutHoldGate: PayoutHoldGate = async (tx: Executor, providerProfileId: string) => {
  const [row] = await queryRows<{ held: boolean }>(
    tx,
    sql`SELECT EXISTS (
          SELECT 1 FROM moderation_actions
           WHERE action_type = 'payout_freeze' AND provider_profile_id = ${providerProfileId} AND status = 'active'
        ) AS held`,
  );
  return { held: row?.held === true };
};
