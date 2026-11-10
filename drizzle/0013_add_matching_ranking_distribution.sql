CREATE TABLE "matching_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"service_id" uuid,
	"suggested_weights" jsonb NOT NULL,
	"rationale" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	CONSTRAINT "matching_suggestions_status_ck" CHECK ("matching_suggestions"."status" in ('pending_review','approved','rejected'))
);
--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "eligible" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "exclusion_reason" text;--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "rank" integer;--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "score_micros" integer;--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "score_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "exploration_boosted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "provider_response" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD COLUMN "responded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "matching_weights" jsonb;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "matching_pool_size" integer;--> statement-breakpoint
ALTER TABLE "matching_suggestions" ADD CONSTRAINT "matching_suggestions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matching_suggestions" ADD CONSTRAINT "matching_suggestions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matching_suggestions_service_id_idx" ON "matching_suggestions" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "matching_suggestions_reviewed_by_idx" ON "matching_suggestions" USING btree ("reviewed_by");--> statement-breakpoint
CREATE INDEX "matching_suggestions_status_idx" ON "matching_suggestions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "request_provider_matches_request_rank_idx" ON "request_provider_matches" USING btree ("request_id","rank");--> statement-breakpoint
CREATE INDEX "request_provider_matches_provider_notified_idx" ON "request_provider_matches" USING btree ("provider_profile_id","notified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "request_provider_matches_accepted_uq" ON "request_provider_matches" USING btree ("request_id") WHERE "request_provider_matches"."provider_response" = 'accepted';--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD CONSTRAINT "request_provider_matches_exclusion_pairing_ck" CHECK (("request_provider_matches"."eligible" = false) = ("request_provider_matches"."exclusion_reason" is not null));--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD CONSTRAINT "request_provider_matches_excluded_unranked_ck" CHECK ("request_provider_matches"."eligible" = true or ("request_provider_matches"."rank" is null and "request_provider_matches"."score_micros" is null));--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD CONSTRAINT "request_provider_matches_response_pairing_ck" CHECK (("request_provider_matches"."provider_response" = 'none') = ("request_provider_matches"."responded_at" is null));--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD CONSTRAINT "request_provider_matches_score_range_ck" CHECK ("request_provider_matches"."score_micros" is null or "request_provider_matches"."score_micros" between 0 and 1000000);--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD CONSTRAINT "request_provider_matches_exclusion_reason_ck" CHECK ("request_provider_matches"."exclusion_reason" is null or "request_provider_matches"."exclusion_reason" in ('service_not_offered','outside_service_area','unavailable','not_verified','at_capacity'));--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD CONSTRAINT "request_provider_matches_provider_response_ck" CHECK ("request_provider_matches"."provider_response" in ('none','accepted','declined','offer_sent'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_matching_pool_size_ck" CHECK ("services"."matching_pool_size" is null or "services"."matching_pool_size" between 1 and 50);
--> statement-breakpoint
-- Spec 017 §3 "Status transition" / §4 Migration: matching moves a request `submitted -> matching`.
-- `drizzle/0011_add_request_columns.sql` deliberately seeded only the transitions spec 015 itself
-- implements, leaving unimplemented ones to fail loudly at the spec-003 DB trigger. This is the
-- transition spec 017 implements, so spec 017 seeds it. `matching -> offers_open` is spec 018's
-- and is deliberately NOT seeded here. Idempotent, in the same style as 0011.
INSERT INTO "requests_status_transitions" ("from_status", "to_status") VALUES
  ('submitted', 'matching')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint

-- Spec 017 §3 API contract: this spec's own Permission seed for the admin matching surfaces
-- (AC-2 weight configuration, AC-6 explainability, AC-7 suggestion review), per spec 009 §4.3's
-- convention ("each domain spec owns and inserts its own rows here") — the same pattern spec 010
-- used for `catalog.suggestion` (drizzle/0006_lean_shaman.sql). `read` covers the two GET
-- surfaces (explainability, suggestions list) at risk tier 'low', matching spec 010's 'view'
-- precedent; `configure` covers the weight PATCH and the suggestion approve/reject actions at
-- risk tier 'medium', exactly as §3's endpoint table names. Both roles the spec's endpoint table
-- lists — operations_admin and super_admin — get identical grants; risk tier 'medium' resolves
-- via spec 009's plain permit branch (lib/admin-rbac/actions.ts), never the high/critical
-- approval workflow, so no separate AdminAction approval step is introduced here.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('matching.config', 'read', 'low'),
	('matching.config', 'configure', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('operations_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
