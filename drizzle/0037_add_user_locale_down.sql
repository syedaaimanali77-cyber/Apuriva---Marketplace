-- Down migration for 0037_add_user_locale —
-- docs/specs/2026-08-28-042-internationalization-localization.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0037 added:
-- the `urdu-locale` flag's three environment values and its row, then the CHECK and the column.
--
-- DISCARDS SAVED LOCALE PREFERENCES. Turning `urdu-locale` off is the no-deploy rollback; this is optional.

DELETE FROM "feature_flag_environment_values"
 WHERE "feature_flag_id" IN (SELECT "id" FROM "feature_flags" WHERE "key" = 'urdu-locale');

DELETE FROM "feature_flags" WHERE "key" = 'urdu-locale';

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_locale_shape_ck";

ALTER TABLE "users" DROP COLUMN IF EXISTS "locale";
