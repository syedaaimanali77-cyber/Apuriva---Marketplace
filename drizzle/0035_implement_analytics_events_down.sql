-- Down migration for 0035_implement_analytics_events —
-- docs/specs/2026-08-28-040-analytics-reporting.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0035
-- added — the three columns, their constraints and indexes (returning `analytics_events` to spec 003's
-- stub) and spec 040's own permission rows. Role assignments are untouched.
--
-- Dropping the columns DISCARDS RECORDED EVENTS. Revert the deploy FIRST, so nothing still emits.

DELETE FROM "permissions" WHERE "resource" = 'analytics' AND "action" IN ('read','read_revenue','read_provider_performance');

DROP INDEX IF EXISTS "analytics_events_occurred_idx";
DROP INDEX IF EXISTS "analytics_events_type_occurred_idx";

ALTER TABLE "analytics_events" DROP CONSTRAINT IF EXISTS "analytics_events_properties_object_ck";
ALTER TABLE "analytics_events" DROP CONSTRAINT IF EXISTS "analytics_events_event_type_ck";

ALTER TABLE "analytics_events"
	DROP COLUMN IF EXISTS "properties",
	DROP COLUMN IF EXISTS "occurred_at",
	DROP COLUMN IF EXISTS "event_type";
