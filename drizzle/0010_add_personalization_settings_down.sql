-- Down migration for 0010_add_personalization_settings —
-- docs/specs/2026-08-28-014-home-personalization-navigation.md (spec 014).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0010_add_personalization_settings added, in reverse order, and nothing else.

ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "personalization_enabled";
