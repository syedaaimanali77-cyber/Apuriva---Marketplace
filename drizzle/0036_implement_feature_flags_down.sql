-- Down migration for 0036_implement_feature_flags —
-- docs/specs/2026-08-28-041-feature-flags-platform-configuration.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0036
-- added — spec 041's permission rows, `feature_flag_environment_values`, and the rows, columns,
-- constraints and index on `feature_flags` (returning it to spec 003's stub). Role assignments and
-- audit_logs are untouched.
--
-- DISCARDS STORED FLAG VALUES. Revert the deploy FIRST; the gates then read their env vars again.

DELETE FROM "permissions" WHERE "resource" = 'feature_flags' AND "action" IN ('read','toggle','read_technical','toggle_technical');

DROP TABLE IF EXISTS "feature_flag_environment_values";

DELETE FROM "feature_flags";

DROP INDEX IF EXISTS "feature_flags_key_uq";
ALTER TABLE "feature_flags" DROP CONSTRAINT IF EXISTS "feature_flags_client_readable_business_ck";
ALTER TABLE "feature_flags" DROP CONSTRAINT IF EXISTS "feature_flags_controlled_by_ck";
ALTER TABLE "feature_flags" DROP CONSTRAINT IF EXISTS "feature_flags_description_ck";
ALTER TABLE "feature_flags" DROP CONSTRAINT IF EXISTS "feature_flags_key_format_ck";

ALTER TABLE "feature_flags"
	DROP COLUMN IF EXISTS "removal_criteria",
	DROP COLUMN IF EXISTS "client_readable",
	DROP COLUMN IF EXISTS "is_kill_switch",
	DROP COLUMN IF EXISTS "controlled_by",
	DROP COLUMN IF EXISTS "description",
	DROP COLUMN IF EXISTS "key";
