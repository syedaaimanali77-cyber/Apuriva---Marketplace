-- Down migration for 0012_add_provider_availability_service_areas —
-- docs/specs/2026-08-28-016-provider-availability-service-areas.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what
-- 0012 added and nothing else — the spec 003 baseline tables themselves survive, since spec 016
-- only extended them.
--
-- Deliberately absent: anything touching `bookings`. Spec 016 adds no booking column (§4,
-- §7) — booking scheduling is approved spec 020's to own.

-- Constraints first: dropping a column that a CHECK references would otherwise fail.
ALTER TABLE "provider_services" DROP CONSTRAINT IF EXISTS "provider_services_buffers_non_negative_ck";
ALTER TABLE "provider_services" DROP CONSTRAINT IF EXISTS "provider_services_duration_positive_ck";
ALTER TABLE "provider_service_areas" DROP CONSTRAINT IF EXISTS "provider_service_areas_remote_shape_ck";
ALTER TABLE "provider_service_areas" DROP CONSTRAINT IF EXISTS "provider_service_areas_cities_shape_ck";
ALTER TABLE "provider_service_areas" DROP CONSTRAINT IF EXISTS "provider_service_areas_radius_shape_ck";
ALTER TABLE "provider_service_areas" DROP CONSTRAINT IF EXISTS "provider_service_areas_mode_ck";
ALTER TABLE "provider_availability_overrides" DROP CONSTRAINT IF EXISTS "provider_availability_overrides_range_ck";
ALTER TABLE "provider_availability_overrides" DROP CONSTRAINT IF EXISTS "provider_availability_overrides_end_pairing_ck";
ALTER TABLE "provider_availability_overrides" DROP CONSTRAINT IF EXISTS "provider_availability_overrides_start_pairing_ck";
ALTER TABLE "provider_availabilities" DROP CONSTRAINT IF EXISTS "provider_availabilities_range_ck";
ALTER TABLE "provider_availabilities" DROP CONSTRAINT IF EXISTS "provider_availabilities_end_minute_ck";
ALTER TABLE "provider_availabilities" DROP CONSTRAINT IF EXISTS "provider_availabilities_start_minute_ck";
ALTER TABLE "provider_availabilities" DROP CONSTRAINT IF EXISTS "provider_availabilities_day_of_week_ck";

DROP INDEX IF EXISTS "provider_service_areas_provider_global_uq";
DROP INDEX IF EXISTS "provider_service_areas_provider_service_uq";
DROP INDEX IF EXISTS "provider_service_areas_center_address_id_idx";
DROP INDEX IF EXISTS "provider_service_areas_service_id_idx";
DROP INDEX IF EXISTS "provider_availability_overrides_provider_date_uq";
DROP INDEX IF EXISTS "provider_availabilities_provider_day_idx";

ALTER TABLE "provider_service_areas" DROP CONSTRAINT IF EXISTS "provider_service_areas_center_address_id_addresses_id_fk";
ALTER TABLE "provider_service_areas" DROP CONSTRAINT IF EXISTS "provider_service_areas_service_id_services_id_fk";

ALTER TABLE "provider_service_areas" DROP COLUMN IF EXISTS "cities";
ALTER TABLE "provider_service_areas" DROP COLUMN IF EXISTS "center_address_id";
ALTER TABLE "provider_service_areas" DROP COLUMN IF EXISTS "radius_meters";
ALTER TABLE "provider_service_areas" DROP COLUMN IF EXISTS "mode";
ALTER TABLE "provider_service_areas" DROP COLUMN IF EXISTS "service_id";

ALTER TABLE "provider_availability_overrides" DROP COLUMN IF EXISTS "end_minute";
ALTER TABLE "provider_availability_overrides" DROP COLUMN IF EXISTS "start_minute";
ALTER TABLE "provider_availability_overrides" DROP COLUMN IF EXISTS "is_available";
ALTER TABLE "provider_availability_overrides" DROP COLUMN IF EXISTS "date";

ALTER TABLE "provider_availabilities" DROP COLUMN IF EXISTS "end_minute";
ALTER TABLE "provider_availabilities" DROP COLUMN IF EXISTS "start_minute";
ALTER TABLE "provider_availabilities" DROP COLUMN IF EXISTS "day_of_week";

ALTER TABLE "provider_services" DROP COLUMN IF EXISTS "buffer_after_minutes";
ALTER TABLE "provider_services" DROP COLUMN IF EXISTS "buffer_before_minutes";
ALTER TABLE "provider_services" DROP COLUMN IF EXISTS "duration_minutes";

ALTER TABLE "provider_profiles" DROP COLUMN IF EXISTS "scheduling_timezone";

DROP TABLE IF EXISTS "provider_availability_notification_requests" CASCADE;
