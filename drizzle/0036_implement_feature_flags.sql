-- Spec 041 — Feature Flags & Platform Configuration (docs/specs/2026-08-28-041-feature-flags-platform-configuration.md §4).
--
-- Completes spec 003's `feature_flags` STUB — ALTERED, never re-created (`0001_baseline` is
-- checksum-locked; spec 003's schema-lint requires baseColumns()). Nothing has ever written the
-- table, so the NOT NULL columns are added to an EMPTY table; unexpected rows fail this loudly.
--
-- Adds `feature_flag_environment_values`: one value per (flag, environment). A deployment reads and
-- writes only its own APP_ENV row (§3.2), so a staging toggle never reaches production (AC-6).
--
-- Seeds exactly the six §3.3 registry flags, their 18 environment values and the four §3.5
-- permissions. Every seed is ON CONFLICT DO NOTHING: a re-run never overwrites an admin's change.

ALTER TABLE "feature_flags"
	ADD COLUMN "key" text NOT NULL,
	ADD COLUMN "description" text NOT NULL,
	ADD COLUMN "controlled_by" text NOT NULL,
	ADD COLUMN "is_kill_switch" boolean DEFAULT false NOT NULL,
	ADD COLUMN "client_readable" boolean DEFAULT false NOT NULL,
	ADD COLUMN "removal_criteria" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "feature_flags_key_uq" ON "feature_flags" USING btree ("key");--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_key_format_ck" CHECK ("key" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length("key") <= 64);--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_description_ck" CHECK (char_length("description") between 1 and 500);--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_controlled_by_ck" CHECK ("controlled_by" in ('business','developer'));--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_client_readable_business_ck" CHECK (not "client_readable" or "controlled_by" = 'business');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "feature_flag_environment_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"feature_flag_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by_admin_id" uuid,
	CONSTRAINT "feature_flag_environment_values_environment_ck" CHECK ("environment" in ('development','staging','production'))
);--> statement-breakpoint

ALTER TABLE "feature_flag_environment_values" ADD CONSTRAINT "feature_flag_environment_values_feature_flag_id_feature_flags_id_fk" FOREIGN KEY ("feature_flag_id") REFERENCES "public"."feature_flags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_environment_values" ADD CONSTRAINT "feature_flag_environment_values_updated_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feature_flag_environment_values_flag_environment_uq" ON "feature_flag_environment_values" USING btree ("feature_flag_id","environment");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_flag_environment_values_updated_by_admin_id_idx" ON "feature_flag_environment_values" USING btree ("updated_by_admin_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The §3.3 registry — mirrored exactly by lib/feature-flags/registry.ts (registry.test.ts asserts it).
-- Defaults are the owning specs' documented ones; the same default in every environment.
-- ---------------------------------------------------------------------------
INSERT INTO "feature_flags" ("key", "description", "controlled_by", "is_kill_switch", "client_readable")
VALUES
	('onboarding-intro-v1', 'Shows the first-run introduction to new visitors; off hides it without a redeploy (spec 007).', 'business', false, true),
	('search-nl-interpretation', 'AI interpretation of natural-language search; off falls back to keyword-only search (spec 013).', 'business', false, false),
	('home-personalization-v1', 'Personalized home feed; off falls back to the static curated feed for everyone (spec 014).', 'business', false, false),
	('ai-conversational-assistant', 'Ask Apuriva conversations and actions; off refuses new conversations, turns and confirmations (spec 034).', 'business', false, false),
	('ai-assistant', 'Platform-wide AI kill switch; off makes every AI call unavailable and every AI feature degrade (spec 033).', 'developer', true, false),
	('ai-fraud-signals', 'Allows AI-assisted fraud signals to be recorded as review items; never enforces anything (spec 038).', 'developer', false, false)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "feature_flag_environment_values" ("feature_flag_id", "environment", "enabled")
SELECT f."id", e.environment, d.enabled
FROM (VALUES
	('onboarding-intro-v1', true),
	('search-nl-interpretation', true),
	('home-personalization-v1', true),
	('ai-conversational-assistant', true),
	('ai-assistant', true),
	('ai-fraud-signals', false)
) AS d(key, enabled)
JOIN "feature_flags" f ON f."key" = d.key
CROSS JOIN (VALUES ('development'), ('staging'), ('production')) AS e(environment)
ON CONFLICT ("feature_flag_id", "environment") DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permissions — §3.5: the seven existing roles only. No developer role (spec 037 D-1); Super Admin
-- holds the developer-controlled flags (D-1). Toggles are medium tier (D-5).
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('feature_flags', 'read', 'low'),
	('feature_flags', 'toggle', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('content_admin', 'operations_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;--> statement-breakpoint

INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('feature_flags', 'read_technical', 'low'),
	('feature_flags', 'toggle_technical', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
