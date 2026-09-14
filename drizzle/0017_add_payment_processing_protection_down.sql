-- Down migration for 0017_add_payment_processing_protection —
-- docs/specs/2026-08-28-021-payment-processing-protection.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0017
-- added, and nothing else — it touches no table other than `payments`, `payment_attempts`,
-- `payment_authorizations`, `payments_status_history`, `payments_status_transitions`,
-- `bookings_status_transitions` and `price_adjustments`.
--
-- Like 0014's, 0015's and 0016's downs, rollback DISCARDS the data those columns held: every
-- payment row is deleted, because without its feature columns the row is meaningless. Before this
-- spec ships those tables are empty, so an immediate rollback loses nothing; once real payments
-- exist this is destructive — the standard caveat on every down migration in this repository, and
-- the reason 0017 is gated on empty tables.

DROP TRIGGER IF EXISTS "payments_status_history_append_only_trg" ON "payments_status_history";
DROP FUNCTION IF EXISTS enforce_payments_status_history_append_only();
DROP TRIGGER IF EXISTS "payment_attempts_append_only_trg" ON "payment_attempts";
DROP FUNCTION IF EXISTS enforce_payment_attempts_append_only();

DELETE FROM "bookings_status_transitions"
 WHERE ("from_status", "to_status") IN (('pending', 'failed'), ('completed', 'protected'), ('protected', 'settled'));

DELETE FROM "payments_status_transitions"
 WHERE ("from_status", "to_status") IN (
   ('created', 'requires_action'), ('created', 'authorized'), ('created', 'captured'), ('created', 'failed'),
   ('requires_action', 'authorized'), ('requires_action', 'captured'), ('requires_action', 'failed'),
   ('authorized', 'captured'), ('authorized', 'failed')
 );

DROP TABLE IF EXISTS "price_adjustments";

-- Children before parents: both reference `payments`.
DELETE FROM "payment_authorizations";
DELETE FROM "payment_attempts";
DELETE FROM "payments_status_history";
DELETE FROM "payments";

ALTER TABLE "payments_status_history" DROP CONSTRAINT IF EXISTS "payments_status_history_actor_pairing_ck";
ALTER TABLE "payments_status_history" DROP CONSTRAINT IF EXISTS "payments_status_history_actor_role_ck";
ALTER TABLE "payments_status_history" DROP COLUMN IF EXISTS "actor_role";

ALTER TABLE "payment_authorizations" DROP CONSTRAINT IF EXISTS "payment_authorizations_capture_not_over_ck";
ALTER TABLE "payment_authorizations" DROP CONSTRAINT IF EXISTS "payment_authorizations_captured_pair_ck";
ALTER TABLE "payment_authorizations" DROP CONSTRAINT IF EXISTS "payment_authorizations_authorized_positive_ck";
ALTER TABLE "payment_authorizations" DROP CONSTRAINT IF EXISTS "payment_authorizations_authorized_pair_ck";
ALTER TABLE "payment_authorizations" DROP COLUMN IF EXISTS "provider_reference";
ALTER TABLE "payment_authorizations" DROP COLUMN IF EXISTS "captured_at";
ALTER TABLE "payment_authorizations" DROP COLUMN IF EXISTS "captured_currency_code";
ALTER TABLE "payment_authorizations" DROP COLUMN IF EXISTS "captured_amount_minor_units";
ALTER TABLE "payment_authorizations" DROP COLUMN IF EXISTS "authorized_at";
ALTER TABLE "payment_authorizations" DROP COLUMN IF EXISTS "authorized_currency_code";
ALTER TABLE "payment_authorizations" DROP COLUMN IF EXISTS "authorized_amount_minor_units";

DROP INDEX IF EXISTS "payment_attempts_payment_attempted_at_idx";
ALTER TABLE "payment_attempts" DROP CONSTRAINT IF EXISTS "payment_attempts_status_ck";
ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "attempted_at";
ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "provider_reference";
ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "failure_reason";
ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "failure_code";
ALTER TABLE "payment_attempts" DROP COLUMN IF EXISTS "status";

DROP INDEX IF EXISTS "payments_protection_sweep_idx";
DROP INDEX IF EXISTS "payments_booking_idempotency_key_uq";
DROP INDEX IF EXISTS "payments_booking_id_uq";
-- Restores the baseline's non-unique index that 0017 replaced.
CREATE INDEX IF NOT EXISTS "payments_booking_id_idx" ON "payments" USING btree ("booking_id");

ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_protection_window_hours_ck";
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_protection_requires_capture_ck";
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_protection_state_ck";
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_protection_pairing_ck";
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_charge_positive_ck";
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_charge_currency_format_ck";
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_charge_pair_ck";
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_status_ck";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "provider_reference";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "provider_name";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "protection_window_hours";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "protection_window_started_at";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "protection_state";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "charge_currency_code";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "charge_amount_minor_units";
