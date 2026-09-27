-- Spec 042 — Internationalization & Localization (docs/specs/2026-08-28-042-internationalization-localization.md §4).
--
-- Adds `users.locale`: the explicitly chosen UI locale, NULL = never chosen (no backfill). The CHECK is
-- SHAPE-ONLY (a BCP-47-shaped tag, at most 35 characters) and deliberately lists no locales, so adding one
-- is a config + dictionary change with no schema change (AC-5). Nullable, so no downtime.
--
-- Seeds the `urdu-locale` flag (spec 041 §3.3: one registry entry + a migration seeding its three
-- environment rows), OFF everywhere (decision 7). ON CONFLICT DO NOTHING: a re-run never overwrites an
-- admin's change.

ALTER TABLE "users" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_shape_ck" CHECK ("locale" is null or ("locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' and char_length("locale") <= 35));--> statement-breakpoint

INSERT INTO "feature_flags" ("key", "description", "controlled_by", "is_kill_switch", "client_readable")
VALUES
	('urdu-locale', 'Offers the Urdu UI locale; turn on only after the translation coverage checklist is complete (spec 042).', 'business', false, true)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "feature_flag_environment_values" ("feature_flag_id", "environment", "enabled")
SELECT f."id", e.environment, false
FROM "feature_flags" f
CROSS JOIN (VALUES ('development'), ('staging'), ('production')) AS e(environment)
WHERE f."key" = 'urdu-locale'
ON CONFLICT ("feature_flag_id", "environment") DO NOTHING;
