-- Spec 045 — Demo Mode & Seed Data (docs/specs/2026-08-28-045-demo-mode-seed-data.md §4).
--
-- Adds the row-level demo marker to `users`: `is_demo` (every existing user gets `false`, so no backfill)
-- and `demo_set_id`, which groups the users of one provisioned demo set. There is no FK and no new table:
-- a set has no attributes of its own. The CHECK keeps a set id off every non-demo user, and the partial
-- index finds a set's users. The database boundary (a `_demo` database, §3.1) is the isolation
-- guarantee; these columns are the second marker the reset and reseed guards read (§3.5).
--
-- Seeds the `demo-mode` flag (spec 041 §3.3: one registry entry + a migration seeding its three
-- environment rows), OFF everywhere. ON CONFLICT DO NOTHING: a re-run never overwrites an admin's change.
--
-- Seeds NO demo data. Demo sets are created only at run time by POST /api/v1/demo/login and /reset, so
-- no production database ever receives a demo row from a migration.

ALTER TABLE "users" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "demo_set_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_demo_set_ck" CHECK ("demo_set_id" is null or "is_demo");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_demo_set_idx" ON "users" USING btree ("demo_set_id") WHERE "demo_set_id" is not null;--> statement-breakpoint

INSERT INTO "feature_flags" ("key", "description", "controlled_by", "is_kill_switch", "client_readable")
VALUES
	('demo-mode', 'Enables one-click demo logins and the demo banner. Only effective outside production on a `_demo` database (spec 045).', 'developer', false, false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "feature_flag_environment_values" ("feature_flag_id", "environment", "enabled")
SELECT f."id", e.environment, false
FROM "feature_flags" f
CROSS JOIN (VALUES ('development'), ('staging'), ('production')) AS e(environment)
WHERE f."key" = 'demo-mode'
ON CONFLICT ("feature_flag_id", "environment") DO NOTHING;
