-- Down migration for 0003_add_profiles_and_session_mode —
-- docs/specs/2026-08-28-006-user-identity-role-switching.md (spec 006).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0003_add_profiles_and_session_mode added, in reverse order, and nothing else.

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_active_mode_ck";
ALTER TABLE "provider_profiles" DROP CONSTRAINT IF EXISTS "provider_profiles_lifecycle_status_ck";
ALTER TABLE "sessions" DROP COLUMN IF EXISTS "active_mode";
ALTER TABLE "provider_profiles" DROP COLUMN IF EXISTS "lifecycle_status";
ALTER TABLE "provider_profiles" DROP COLUMN IF EXISTS "business_name";
ALTER TABLE "customer_profiles" DROP COLUMN IF EXISTS "display_name";
