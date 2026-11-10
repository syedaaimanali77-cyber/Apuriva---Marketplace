-- Down migration for 0009_add_search_indexes —
-- docs/specs/2026-08-28-013-search-discovery.md (spec 013).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0009_add_search_indexes added, in reverse order, and nothing else.
--
-- The baseline `services` and `provider_profiles` tables survive; only 0009's full-text indexes and the
-- `recent_searches` table it created are removed.
DROP INDEX IF EXISTS "provider_profiles_business_name_fts_idx";
DROP INDEX IF EXISTS "services_name_fts_idx";
DROP INDEX IF EXISTS "recent_searches_category_id_idx";
DROP INDEX IF EXISTS "recent_searches_service_id_idx";
DROP INDEX IF EXISTS "recent_searches_user_id_idx";
DROP TABLE IF EXISTS "recent_searches";
