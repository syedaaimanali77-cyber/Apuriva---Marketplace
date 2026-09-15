-- Down migration for 0018_add_refunds —
-- docs/specs/2026-08-28-022-refunds.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0018
-- added, and nothing else — it touches no table other than `refunds`, `refund_lines`,
-- `refunds_status_history`, `refunds_status_transitions`, `payments_status_transitions`,
-- `bookings_status_transitions` and `permissions`.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. A refund the provider has already executed CANNOT be
-- reversed by any code or schema change. This file deletes refund rows and is safe ONLY before the
-- first refund ships, which is why 0018 is gated on empty tables. Once real refunds exist, applying
-- this would destroy financial records spec 008 requires be retained — the correct response to a
-- defect at that point is a forward fix, never this file.

DROP TRIGGER IF EXISTS "refunds_completed_immutable_trg" ON "refunds";
DROP FUNCTION IF EXISTS enforce_refund_completed_immutable();
DROP TRIGGER IF EXISTS "refunds_status_history_append_only_trg" ON "refunds_status_history";
DROP FUNCTION IF EXISTS enforce_refunds_status_history_append_only();
DROP TRIGGER IF EXISTS "refund_lines_append_only_trg" ON "refund_lines";
DROP FUNCTION IF EXISTS enforce_refund_lines_append_only();
-- Detaches spec 003's shared function from `refunds`. The FUNCTION itself is spec 003's and stays.
DROP TRIGGER IF EXISTS "refunds_status_transition_trg" ON "refunds";

DELETE FROM "permissions" WHERE "resource" = 'refunds' AND "action" IN ('read', 'override');

DELETE FROM "bookings_status_transitions"
 WHERE ("from_status", "to_status") IN (
   ('completed', 'refunded'), ('protected', 'refunded'), ('settled', 'refunded'), ('cancelled', 'refunded')
 );

DELETE FROM "payments_status_transitions"
 WHERE ("from_status", "to_status") IN (
   ('captured', 'refunded'), ('captured', 'partially_refunded'), ('partially_refunded', 'refunded')
 );

DROP TABLE IF EXISTS "refunds_status_transitions";
DROP TABLE IF EXISTS "refunds_status_history";

-- Children before parents.
DELETE FROM "refund_lines";
DELETE FROM "refunds";

ALTER TABLE "refund_lines" DROP CONSTRAINT IF EXISTS "refund_lines_currency_format_ck";
ALTER TABLE "refund_lines" DROP CONSTRAINT IF EXISTS "refund_lines_amount_positive_ck";
ALTER TABLE "refund_lines" DROP CONSTRAINT IF EXISTS "refund_lines_amount_pair_ck";
ALTER TABLE "refund_lines" DROP COLUMN IF EXISTS "reason";
ALTER TABLE "refund_lines" DROP COLUMN IF EXISTS "line_currency_code";
ALTER TABLE "refund_lines" DROP COLUMN IF EXISTS "line_amount_minor_units";

DROP INDEX IF EXISTS "refunds_payment_idempotency_key_uq";
DROP INDEX IF EXISTS "refunds_reconciliation_idx";
DROP INDEX IF EXISTS "refunds_admin_action_id_idx";
DROP INDEX IF EXISTS "refunds_initiated_by_user_id_idx";
DROP INDEX IF EXISTS "refunds_status_idx";
DROP INDEX IF EXISTS "refunds_booking_id_idx";

ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_failure_pairing_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_reconciled_pairing_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_completed_pairing_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_override_pairing_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_total_positive_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_total_currency_format_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_total_pair_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_reconciliation_state_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_source_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_status_ck";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_admin_action_id_admin_actions_id_fk";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_initiated_by_user_id_users_id_fk";
ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_booking_id_bookings_id_fk";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "completed_at";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "reconciled_at";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "reconciliation_state";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "failure_reason";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "failure_code";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "refund_reference";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "provider_reference";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "eligibility_decision_ref";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "admin_action_id";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "initiated_by_user_id";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "is_override";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "source";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "total_currency_code";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "total_amount_minor_units";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "status";
ALTER TABLE "refunds" DROP COLUMN IF EXISTS "booking_id";
