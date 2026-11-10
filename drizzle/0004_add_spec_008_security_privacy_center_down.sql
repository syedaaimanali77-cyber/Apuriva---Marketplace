-- Down migration for 0004_add_spec_008_security_privacy_center —
-- docs/specs/2026-08-28-008-security-sessions-privacy-center.md (spec 008).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0004_add_spec_008_security_privacy_center added, in reverse order, and nothing else.

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_data_export_status_ck";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_lifecycle_status_ck";
DROP INDEX IF EXISTS "users_data_export_request_id_uq";
DROP INDEX IF EXISTS "users_data_export_file_asset_id_idx";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_data_export_file_asset_id_file_assets_id_fk";
ALTER TABLE "users" DROP COLUMN IF EXISTS "data_export_file_asset_id";
ALTER TABLE "users" DROP COLUMN IF EXISTS "data_export_status";
ALTER TABLE "users" DROP COLUMN IF EXISTS "data_export_request_id";
ALTER TABLE "users" DROP COLUMN IF EXISTS "deletion_grace_ends_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "deletion_requested_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "lifecycle_status";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "revoked_reason";
