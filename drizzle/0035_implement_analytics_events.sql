-- Spec 040 — Analytics & Reporting (docs/specs/2026-08-28-040-analytics-reporting.md §4).
--
-- Completes spec 003's `analytics_events` STUB. The table is ALTERED, never re-created: `0001_baseline`
-- is checksum-locked, and spec 003's schema-lint requires every table to keep `baseColumns()`.
-- `actor_user_id` (FK -> users, RESTRICT, indexed) already exists and IS the event's user reference.
--
-- Nothing has ever written to `analytics_events`, so the NOT NULL columns are added to an EMPTY table;
-- unexpected rows make this fail loudly instead of inventing values. No backfill: events accumulate
-- from this deployment forward.

ALTER TABLE "analytics_events"
	ADD COLUMN "event_type" text NOT NULL,
	ADD COLUMN "occurred_at" timestamp with time zone NOT NULL,
	ADD COLUMN "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_event_type_ck" CHECK ("event_type" in ('search_performed','request_submitted','offer_accepted','booking_completed','review_submitted','ai_conversation_started'));--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_properties_object_ck" CHECK (jsonb_typeof("properties") = 'object');--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "analytics_events_type_occurred_idx" ON "analytics_events" USING btree ("event_type", "occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_occurred_idx" ON "analytics_events" USING btree ("occurred_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permissions — §3.7: the seven existing roles only, holders per master §69 and the spec's own
-- endpoint table. AI usage stays behind spec 033's existing `ai/read_usage`.
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('analytics', 'read', 'low')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('analytics_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;--> statement-breakpoint

INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('analytics', 'read_revenue', 'low')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('analytics_admin', 'finance_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;--> statement-breakpoint

INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('analytics', 'read_provider_performance', 'low')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('analytics_admin', 'operations_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
