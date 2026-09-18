-- Spec 033 §4 "Migration" — docs/specs/2026-08-28-033-ai-assistant-architecture.md.
--
-- Adds `ai_usage_events`, the AI usage/cost/abuse accounting table, and seeds this spec's own
-- `permissions` rows. Purely additive: one new table plus three permission rows.
--
-- `ai_tool_calls`, `ai_conversations`, `ai_messages`, `ai_memories` and `ai_actions` are spec 003
-- BASELINE tables belonging to specs 034/035/036 — this migration does not touch any of them.
-- `0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.
-- Number: `_journal.json`'s head was `0024_add_service_execution_lifecycle` (spec 028), so this is 0025.
--
-- NO BACKFILL AND NO SEED ROWS. An `ai_usage_events` row exists only because a real AI call was
-- accounted; fabricating usage would make the cost figures admins act on fiction (spec 033 §4).
CREATE TABLE "ai_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"task" text NOT NULL,
	"subject_kind" text NOT NULL,
	"user_id" uuid,
	"subject_hash" text,
	"provider_name" text NOT NULL,
	"model_name" text NOT NULL,
	"outcome" text NOT NULL,
	"rejection_reason" text,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cached" boolean DEFAULT false NOT NULL,
	"latency_ms" integer,
	"input_fingerprint" text
);
--> statement-breakpoint
-- Spec 003 AC-4: every FK is RESTRICT and carries its own covering index.
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_events_user_id_idx" ON "ai_usage_events" USING btree ("user_id");--> statement-breakpoint
-- The retention sweep and every summary/quota/abuse window read scans by time.
CREATE INDEX "ai_usage_events_created_at_idx" ON "ai_usage_events" USING btree ("created_at");--> statement-breakpoint
-- A guest's rolling window is keyed by its IP hash, which has no FK to index.
CREATE INDEX "ai_usage_events_guest_subject_idx" ON "ai_usage_events" USING btree ("subject_kind","subject_hash","created_at");--> statement-breakpoint
-- Abuse signal S3 counts repeats of one fingerprint inside an hour.
CREATE INDEX "ai_usage_events_fingerprint_idx" ON "ai_usage_events" USING btree ("input_fingerprint","created_at");--> statement-breakpoint
-- Closed vocabularies at the database, not merely in TypeScript.
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_task_ck" CHECK ("ai_usage_events"."task" in ('search_intent','faq_draft','conversation','summarization','translation'));--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_subject_kind_ck" CHECK ("ai_usage_events"."subject_kind" in ('user','guest','system'));--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_outcome_ck" CHECK ("ai_usage_events"."outcome" in ('succeeded','rejected','failed'));--> statement-breakpoint
-- A rejection always says why, and only a rejection carries a reason.
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_rejection_reason_ck" CHECK (("ai_usage_events"."outcome" = 'rejected') = ("ai_usage_events"."rejection_reason" is not null) and ("ai_usage_events"."rejection_reason" is null or "ai_usage_events"."rejection_reason" in ('rate_limited','quota_exceeded')));--> statement-breakpoint
-- Exactly one subject reference per row, matching its kind. A `system` row carries neither.
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_user_pairing_ck" CHECK (("ai_usage_events"."subject_kind" = 'user') = ("ai_usage_events"."user_id" is not null));--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_guest_pairing_ck" CHECK (("ai_usage_events"."subject_kind" = 'guest') = ("ai_usage_events"."subject_hash" is not null));--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_tokens_ck" CHECK ("ai_usage_events"."tokens_used" >= 0);--> statement-breakpoint
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_latency_ck" CHECK ("ai_usage_events"."latency_ms" is null or "ai_usage_events"."latency_ms" >= 0);--> statement-breakpoint
-- A cache hit reaches no provider, so it can never have consumed tokens (spec 033 §3.8).
ALTER TABLE "ai_usage_events" ADD CONSTRAINT "ai_usage_events_cached_tokens_ck" CHECK (not "ai_usage_events"."cached" or "ai_usage_events"."tokens_used" = 0);--> statement-breakpoint
-- Spec 033 §4 / AC-6 — this spec's own Permission seed. `low`: aggregate-only and read-only, so
-- it needs no second-admin approval (spec 009 requires one at high/critical). Seeded for exactly
-- three roles; every other admin role therefore cannot read AI usage.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", 'ai', 'read_usage', 'low'
FROM "roles" r
WHERE r."name" IN ('analytics_admin', 'finance_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
