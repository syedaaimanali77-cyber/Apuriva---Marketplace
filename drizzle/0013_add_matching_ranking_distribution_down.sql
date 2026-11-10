-- Down migration for 0013_add_matching_ranking_distribution —
-- docs/specs/2026-08-28-017-provider-matching-ranking-distribution.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what
-- 0013 added and nothing else — the spec 003 baseline `request_provider_matches` table itself
-- survives, since spec 017 only extended it.
--
-- Deliberately absent: anything touching `bookings`, `offers`, or any spec 016 table. Spec 017
-- adds no column to any of them (§4, §7).

-- Constraints first: dropping a column a CHECK references would otherwise fail.
ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "services_matching_pool_size_ck";
ALTER TABLE "request_provider_matches" DROP CONSTRAINT IF EXISTS "request_provider_matches_provider_response_ck";
ALTER TABLE "request_provider_matches" DROP CONSTRAINT IF EXISTS "request_provider_matches_exclusion_reason_ck";
ALTER TABLE "request_provider_matches" DROP CONSTRAINT IF EXISTS "request_provider_matches_score_range_ck";
ALTER TABLE "request_provider_matches" DROP CONSTRAINT IF EXISTS "request_provider_matches_response_pairing_ck";
ALTER TABLE "request_provider_matches" DROP CONSTRAINT IF EXISTS "request_provider_matches_excluded_unranked_ck";
ALTER TABLE "request_provider_matches" DROP CONSTRAINT IF EXISTS "request_provider_matches_exclusion_pairing_ck";

DROP INDEX IF EXISTS "request_provider_matches_accepted_uq";
DROP INDEX IF EXISTS "request_provider_matches_provider_notified_idx";
DROP INDEX IF EXISTS "request_provider_matches_request_rank_idx";

ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "responded_at";
ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "provider_response";
ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "notified_at";
ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "exploration_boosted";
ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "score_breakdown";
ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "score_micros";
ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "rank";
ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "exclusion_reason";
ALTER TABLE "request_provider_matches" DROP COLUMN IF EXISTS "eligible";

ALTER TABLE "services" DROP COLUMN IF EXISTS "matching_pool_size";
ALTER TABLE "services" DROP COLUMN IF EXISTS "matching_weights";

DROP TABLE IF EXISTS "matching_suggestions" CASCADE;

-- The transition this migration seeded. Spec 015's own four transitions (seeded by 0011) are
-- deliberately left alone.
DELETE FROM "requests_status_transitions" WHERE "from_status" = 'submitted' AND "to_status" = 'matching';

-- The Permission rows this migration seeded for operations_admin/super_admin. Spec 010's
-- `catalog.*` grants (0006/0007) are deliberately left alone.
DELETE FROM "permissions" WHERE "resource" = 'matching.config';
