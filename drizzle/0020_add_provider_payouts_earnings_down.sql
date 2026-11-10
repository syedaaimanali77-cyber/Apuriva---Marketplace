-- Down migration for 0020_add_provider_payouts_earnings —
-- docs/specs/2026-08-28-024-provider-payouts-earnings.md §4.3 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0020
-- added and nothing else. It never touches `refunds.reconciliation_state` (a refund reconciled by
-- spec 024 stays reconciled as a fact about the refund) and never detaches spec 003's
-- `payouts_status_transition_trg`.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. A payout the rail has executed cannot be reversed by any
-- schema change, and earnings lines, adjustments and payout items are financial records spec 008
-- requires be retained. This file is safe ONLY before the first payout row exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "payouts")
     OR EXISTS (SELECT 1 FROM "payout_items")
     OR EXISTS (SELECT 1 FROM "provider_earnings_lines")
     OR EXISTS (SELECT 1 FROM "earnings_adjustments")
     OR EXISTS (SELECT 1 FROM "payout_methods") THEN
    RAISE EXCEPTION 'Refusing to roll back 0020: payout financial records exist and must be retained';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "payout_items_adjustment_applied_trg" ON "payout_items";
DROP FUNCTION IF EXISTS enforce_payout_item_adjustment_applied();
DROP TRIGGER IF EXISTS "payout_items_currency_matches_payout_trg" ON "payout_items";
DROP FUNCTION IF EXISTS enforce_payout_item_currency();
DROP TRIGGER IF EXISTS "payout_items_frozen_trg" ON "payout_items";
DROP FUNCTION IF EXISTS enforce_payout_items_frozen();
DROP TRIGGER IF EXISTS "earnings_adjustments_immutable_trg" ON "earnings_adjustments";
DROP FUNCTION IF EXISTS enforce_earnings_adjustment_immutable();
DROP TRIGGER IF EXISTS "provider_earnings_lines_immutable_core_trg" ON "provider_earnings_lines";
DROP FUNCTION IF EXISTS enforce_provider_earnings_line_rules();
DROP TRIGGER IF EXISTS "payouts_status_history_append_only_trg" ON "payouts_status_history";
DROP FUNCTION IF EXISTS enforce_payouts_status_history_append_only();

DELETE FROM "permissions" WHERE "resource" = 'payouts' AND "action" IN ('read', 'retry', 'adjust');

DELETE FROM "payouts_status_transitions"
 WHERE ("from_status", "to_status") IN (
   ('pending', 'eligible'), ('eligible', 'processing'), ('processing', 'paid'),
   ('processing', 'failed'), ('failed', 'eligible')
 );

DROP TABLE IF EXISTS "payout_items";
DROP TABLE IF EXISTS "earnings_adjustments";
DROP TABLE IF EXISTS "provider_earnings_lines";

ALTER TABLE "payouts_status_history" DROP CONSTRAINT IF EXISTS "payouts_status_history_actor_pairing_ck";
ALTER TABLE "payouts_status_history" DROP CONSTRAINT IF EXISTS "payouts_status_history_actor_role_ck";
ALTER TABLE "payouts_status_history" DROP COLUMN IF EXISTS "detail";
ALTER TABLE "payouts_status_history" DROP COLUMN IF EXISTS "actor_role";

DROP INDEX IF EXISTS "payouts_open_batch_uq";
DROP INDEX IF EXISTS "payouts_status_updated_idx";
DROP INDEX IF EXISTS "payouts_provider_status_idx";
DROP INDEX IF EXISTS "payouts_payout_method_id_idx";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_attempts_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_method_required_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_failure_code_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_failure_pairing_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_paid_pairing_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_closed_pairing_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_amount_positive_when_closed_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_payout_currency_format_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_payout_pair_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_status_ck";
ALTER TABLE "payouts" DROP CONSTRAINT IF EXISTS "payouts_payout_method_id_payout_methods_id_fk";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "escalated_at";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "paid_at";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "closed_at";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "failure_reason";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "failure_code";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "provider_name";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "payout_reference";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "attempt_count";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "payout_method_id";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "payout_currency_code";
ALTER TABLE "payouts" DROP COLUMN IF EXISTS "payout_amount_minor_units";

DROP INDEX IF EXISTS "payout_methods_idempotency_uq";
DROP INDEX IF EXISTS "payout_methods_default_uq";
DROP INDEX IF EXISTS "payout_methods_provider_removed_idx";
ALTER TABLE "payout_methods" DROP CONSTRAINT IF EXISTS "payout_methods_revoked_requires_removed_ck";
ALTER TABLE "payout_methods" DROP CONSTRAINT IF EXISTS "payout_methods_masked_detail_ck";
ALTER TABLE "payout_methods" DROP CONSTRAINT IF EXISTS "payout_methods_currency_format_ck";
ALTER TABLE "payout_methods" DROP CONSTRAINT IF EXISTS "payout_methods_verification_state_ck";
ALTER TABLE "payout_methods" DROP CONSTRAINT IF EXISTS "payout_methods_type_ck";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "revoked_at";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "removed_at";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "is_default";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "verification_state";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "provider_name";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "destination_token_encrypted";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "payout_currency_code";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "institution_label";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "masked_detail";
ALTER TABLE "payout_methods" DROP COLUMN IF EXISTS "type";
