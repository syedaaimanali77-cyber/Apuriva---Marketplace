/**
 * Spec 024 §4.4 "Retention, privacy and audit" — this spec's joins into spec 008's existing export
 * and deletion mechanisms. No new retention mechanism, sweep or policy.
 *
 * EXPORT: the exporting user's OWN provider ledger, by explicit column allowlist. Never selected:
 * `destination_token_encrypted`, `payout_reference`, `provider_name`, `failure_reason`,
 * `idempotency_key`, `idempotency_fingerprint`, `admin_action_id`, `source_refund_id`, or any
 * unapplied adjustment.
 *
 * DELETION: database-only, with NO rail call inside spec 008's sweep. The user's payout methods are
 * removed and un-defaulted; the payout sweep's revocation retry revokes them at the rail later.
 * Financial rows are retained (every FK is RESTRICT) and money owed is never forfeited.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';

export interface ExportedProviderEarnings {
  lines: Array<{
    bookingId: string;
    state: string;
    grossAmountMinorUnits: number;
    platformFeeBps: number;
    feeAmountMinorUnits: number;
    refundedAmountMinorUnits: number;
    netAmountMinorUnits: number;
    currencyCode: string;
    eligibleAt: string | null;
    paidAt: string | null;
  }>;
  payouts: Array<{
    id: string;
    status: string;
    amountMinorUnits: number;
    currencyCode: string;
    paidAt: string | null;
    items: Array<{ kind: string; bookingId: string | null; itemAmountMinorUnits: number }>;
  }>;
  adjustments: Array<{
    kind: string;
    adjustmentAmountMinorUnits: number;
    currencyCode: string;
    reason: string;
    appliedAt: string;
  }>;
  payoutMethods: Array<{
    type: string;
    maskedDetail: string;
    institutionLabel: string;
    verificationState: string;
    isDefault: boolean;
    createdAt: string;
    removedAt: string | null;
  }>;
}

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

export async function exportProviderEarnings(userId: string, db: Executor = getDb()): Promise<ExportedProviderEarnings | null> {
  const [profile] = await queryRows<{ id: string }>(db, sql`SELECT id FROM provider_profiles WHERE user_id = ${userId}`);
  if (!profile) return null;

  const lines = await queryRows<{
    booking_id: string;
    state: string;
    gross_amount_minor_units: number;
    platform_fee_bps: number;
    fee_amount_minor_units: number;
    refunded_amount_minor_units: number;
    net_amount_minor_units: number;
    gross_currency_code: string;
    eligible_at: Date | null;
    paid_at: Date | null;
  }>(
    db,
    sql`SELECT booking_id, state, gross_amount_minor_units, platform_fee_bps, fee_amount_minor_units,
               refunded_amount_minor_units, net_amount_minor_units, gross_currency_code, eligible_at, paid_at
          FROM provider_earnings_lines WHERE provider_profile_id = ${profile.id} ORDER BY created_at ASC`,
  );
  const payouts = await queryRows<{ id: string; status: string; payout_amount_minor_units: number; payout_currency_code: string; paid_at: Date | null }>(
    db,
    sql`SELECT id, status, payout_amount_minor_units, payout_currency_code, paid_at
          FROM payouts WHERE provider_profile_id = ${profile.id} ORDER BY created_at ASC`,
  );
  const items = await queryRows<{ payout_id: string; kind: string; booking_id: string | null; item_amount_minor_units: number }>(
    db,
    sql`SELECT i.payout_id, i.kind, l.booking_id, i.item_amount_minor_units
          FROM payout_items i JOIN payouts p ON p.id = i.payout_id
          LEFT JOIN provider_earnings_lines l ON l.id = i.earnings_line_id
         WHERE p.provider_profile_id = ${profile.id} ORDER BY i.created_at ASC`,
  );
  const adjustments = await queryRows<{ kind: string; adjustment_amount_minor_units: number; adjustment_currency_code: string; reason: string; applied_at: Date }>(
    db,
    sql`SELECT kind, adjustment_amount_minor_units, adjustment_currency_code, reason, applied_at
          FROM earnings_adjustments WHERE provider_profile_id = ${profile.id} AND applied_at IS NOT NULL ORDER BY applied_at ASC`,
  );
  const methods = await queryRows<{ type: string; masked_detail: string; institution_label: string; verification_state: string; is_default: boolean; created_at: Date; removed_at: Date | null }>(
    db,
    sql`SELECT type, masked_detail, institution_label, verification_state, is_default, created_at, removed_at
          FROM payout_methods WHERE provider_profile_id = ${profile.id} ORDER BY created_at ASC`,
  );

  return {
    lines: lines.map((row) => ({
      bookingId: row.booking_id,
      state: row.state,
      grossAmountMinorUnits: row.gross_amount_minor_units,
      platformFeeBps: row.platform_fee_bps,
      feeAmountMinorUnits: row.fee_amount_minor_units,
      refundedAmountMinorUnits: row.refunded_amount_minor_units,
      netAmountMinorUnits: row.net_amount_minor_units,
      currencyCode: row.gross_currency_code,
      eligibleAt: iso(row.eligible_at),
      paidAt: iso(row.paid_at),
    })),
    payouts: payouts.map((row) => ({
      id: row.id,
      status: row.status,
      amountMinorUnits: row.payout_amount_minor_units,
      currencyCode: row.payout_currency_code,
      paidAt: iso(row.paid_at),
      items: items
        .filter((item) => item.payout_id === row.id)
        .map((item) => ({ kind: item.kind, bookingId: item.booking_id, itemAmountMinorUnits: item.item_amount_minor_units })),
    })),
    adjustments: adjustments.map((row) => ({
      kind: row.kind,
      adjustmentAmountMinorUnits: row.adjustment_amount_minor_units,
      currencyCode: row.adjustment_currency_code,
      reason: row.reason,
      appliedAt: new Date(row.applied_at).toISOString(),
    })),
    payoutMethods: methods.map((row) => ({
      type: row.type,
      maskedDetail: row.masked_detail,
      institutionLabel: row.institution_label,
      verificationState: row.verification_state,
      isDefault: row.is_default,
      createdAt: new Date(row.created_at).toISOString(),
      removedAt: iso(row.removed_at),
    })),
  };
}

/** Spec 008 deletion join — database-only; revocation happens later in the payout sweep. */
export async function removePayoutMethodsForDeletedUser(userId: string, db: Executor = getDb()): Promise<void> {
  await db.execute(sql`
    UPDATE payout_methods
       SET removed_at = COALESCE(removed_at, clock_timestamp()), is_default = false,
           updated_at = clock_timestamp(), version = version + 1
     WHERE provider_profile_id IN (SELECT id FROM provider_profiles WHERE user_id = ${userId})
       AND (removed_at IS NULL OR is_default)
  `);
}
