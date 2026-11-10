-- Down migration for 0008_add_location_address_columns —
-- docs/specs/2026-08-28-012-location-address-services.md (spec 012).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0008_add_location_address_columns added, in reverse order, and nothing else.
--
-- The two SET NOT NULLs are reversed to the baseline's nullable columns.
ALTER TABLE "locations" DROP CONSTRAINT IF EXISTS "locations_longitude_range_ck";
ALTER TABLE "locations" DROP CONSTRAINT IF EXISTS "locations_latitude_range_ck";
ALTER TABLE "locations" DROP CONSTRAINT IF EXISTS "locations_lat_lng_pair_ck";
ALTER TABLE "locations" DROP COLUMN IF EXISTS "geo_hierarchy";
ALTER TABLE "locations" DROP COLUMN IF EXISTS "longitude_micro_degrees";
ALTER TABLE "locations" DROP COLUMN IF EXISTS "latitude_micro_degrees";
ALTER TABLE "addresses" DROP COLUMN IF EXISTS "is_default";
ALTER TABLE "addresses" DROP COLUMN IF EXISTS "structured";
ALTER TABLE "addresses" DROP COLUMN IF EXISTS "label";
ALTER TABLE "addresses" ALTER COLUMN "location_id" DROP NOT NULL;
ALTER TABLE "addresses" ALTER COLUMN "user_id" DROP NOT NULL;
