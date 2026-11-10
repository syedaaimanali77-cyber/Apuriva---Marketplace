-- Down migration for 0016_add_booking_creation_state_machine —
-- docs/specs/2026-08-28-020-booking-creation-state-machine.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0016
-- added, and nothing else — it touches no table other than `bookings`, `bookings_status_history`,
-- `bookings_status_transitions` and `requests_status_transitions`.
--
-- Like 0014's and 0015's downs, rollback DISCARDS the data those columns held: every `bookings` and
-- `bookings_status_history` row is deleted, because without their feature columns the rows are
-- meaningless. Before this spec ships, both tables are empty, so an immediate rollback loses
-- nothing; once real bookings exist this is destructive — the standard caveat on every down
-- migration in this repository.

DROP TRIGGER IF EXISTS "bookings_status_history_append_only_trg" ON "bookings_status_history";
DROP FUNCTION IF EXISTS enforce_bookings_status_history_append_only();
DROP TRIGGER IF EXISTS "bookings_terms_immutable_trg" ON "bookings";
DROP FUNCTION IF EXISTS enforce_booking_terms_immutable();

DELETE FROM "requests_status_transitions"
  WHERE ("from_status", "to_status") IN (('provider_selected', 'booking_created'));

DELETE FROM "bookings_status_transitions"
  WHERE ("from_status", "to_status") IN (
    ('pending', 'confirmed'),
    ('confirmed', 'provider_en_route'),
    ('confirmed', 'arrived'),
    ('provider_en_route', 'arrived'),
    ('arrived', 'in_progress'),
    ('in_progress', 'completed')
  );

DELETE FROM "bookings_status_history";
DELETE FROM "bookings";

ALTER TABLE "bookings_status_history" DROP CONSTRAINT IF EXISTS "bookings_status_history_actor_pairing_ck";
ALTER TABLE "bookings_status_history" DROP CONSTRAINT IF EXISTS "bookings_status_history_actor_role_ck";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_status_ck";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_duration_positive_ck";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_price_positive_ck";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_price_currency_format_ck";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_price_pair_ck";

DROP INDEX IF EXISTS "bookings_customer_scheduled_at_idx";
DROP INDEX IF EXISTS "bookings_status_idx";
DROP INDEX IF EXISTS "bookings_provider_scheduled_at_idx";
DROP INDEX IF EXISTS "bookings_address_id_idx";
DROP INDEX IF EXISTS "bookings_provider_profile_id_idx";
DROP INDEX IF EXISTS "bookings_customer_profile_id_idx";
DROP INDEX IF EXISTS "bookings_service_id_idx";
DROP INDEX IF EXISTS "bookings_request_id_idx";
DROP INDEX IF EXISTS "bookings_customer_idempotency_key_uq";
DROP INDEX IF EXISTS "bookings_offer_id_uq";

-- Restore the spec 003 baseline's non-unique index on offer_id.
CREATE INDEX IF NOT EXISTS "bookings_offer_id_idx" ON "bookings" USING btree ("offer_id");

ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_address_id_addresses_id_fk";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_provider_profile_id_provider_profiles_id_fk";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_customer_profile_id_customer_profiles_id_fk";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_service_id_services_id_fk";
ALTER TABLE "bookings" DROP CONSTRAINT IF EXISTS "bookings_request_id_requests_id_fk";

ALTER TABLE "bookings_status_history" DROP COLUMN IF EXISTS "actor_role";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "price_currency_code";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "price_amount_minor_units";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "duration_minutes";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "scheduled_timezone";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "scheduled_at";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "address_id";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "provider_profile_id";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "customer_profile_id";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "service_id";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "request_id";
