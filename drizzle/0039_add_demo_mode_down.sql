-- Down migration for 0039_add_demo_mode — docs/specs/2026-08-28-045-demo-mode-seed-data.md §4 "Migration"
-- / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0039 added:
-- the `demo-mode` flag's three environment values and its row, then the index, the CHECK and the two columns.
--
-- Optional. Turning `demo-mode` off is the no-deploy rollback; demo data is disposable (run the reseed).

DELETE FROM "feature_flag_environment_values"
 WHERE "feature_flag_id" IN (SELECT "id" FROM "feature_flags" WHERE "key" = 'demo-mode');

DELETE FROM "feature_flags" WHERE "key" = 'demo-mode';

DROP INDEX IF EXISTS "users_demo_set_idx";

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_demo_set_ck";

ALTER TABLE "users" DROP COLUMN IF EXISTS "demo_set_id";

ALTER TABLE "users" DROP COLUMN IF EXISTS "is_demo";
