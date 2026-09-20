-- Spec 030 §4 "Migration" — docs/specs/2026-08-28-030-blocking-reporting-safety-incidents.md.
--
-- One ALTER, one new table, one constraint swap and one permission seed. `safety_reports` is a
-- spec 003 BASELINE skeleton (id, audit columns, version, reporter_user_id, booking_id) that no
-- code has ever inserted into; this migration fills in the columns that make a report mean
-- something. It is ALTERED, never recreated — `0001_baseline_schema.sql` is immutable
-- (`npm run check:schema-checksum`) and is not touched.
--
-- Number: `_journal.json`'s head was `0026_add_reviews_ratings` (spec 029), so this is 0027.
--
-- `user_blocks` is genuinely NEW: verified, there is no block table of any kind in the baseline or
-- in any later migration, which is why spec 025 shipped `ConversationBlockGate` inert.
--
-- THERE IS NO ENFORCEMENT HERE (DECIDED-3). No `user_restrictions` table, no
-- `user_restrictions/apply` permission, and nothing that writes `users.lifecycle_status`.
-- Restrictions are spec 038's action; the three `restriction_*` columns below record only that a
-- named admin ASKED for one.
--
-- Precondition: `safety_reports` receives NOT NULL columns without defaults, so it must be empty.
-- Nothing in lib/ or app/ has ever written to it. The DO block below refuses loudly rather than
-- silently defaulting if that assumption is ever wrong. NO BACKFILL: there is no existing data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "safety_reports") THEN
    RAISE EXCEPTION 'Refusing to apply 0027: safety_reports is not empty, so the NOT NULL columns below cannot be added safely';
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- safety_reports — fill in the spec 003 skeleton
-- ---------------------------------------------------------------------------
ALTER TABLE "safety_reports" ADD COLUMN "target_user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "category" text NOT NULL;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "description" text NOT NULL;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "priority" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "status" text DEFAULT 'submitted' NOT NULL;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "claimed_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "resolved_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "resolution_reason" text;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "restriction_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "restriction_requested_by_admin_id" uuid;--> statement-breakpoint
-- Spec 038's `moderation_actions.id`. Deliberately NOT a foreign key: that table does not exist,
-- and inventing one here would be exactly the duplicate enforcement surface this spec refuses.
ALTER TABLE "safety_reports" ADD COLUMN "restriction_moderation_action_id" uuid;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint

-- `restrict` is load-bearing for retention (DECIDED-5): spec 008's deletion sweep cannot remove a
-- safety record, so it survives its reporter closing their account, keyed to the anonymized user.
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_claimed_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("claimed_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_resolved_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_restriction_requested_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("restriction_requested_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_status_ck" CHECK ("safety_reports"."status" in ('submitted','under_review','escalated','resolved'));--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_priority_ck" CHECK ("safety_reports"."priority" in ('low','medium','high','critical'));--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_category_ck" CHECK ("safety_reports"."category" in ('harassment','threat','unsafe_behaviour','impersonation','property_damage','other'));--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_no_self_ck" CHECK ("safety_reports"."reporter_user_id" <> "safety_reports"."target_user_id");--> statement-breakpoint
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_description_length_ck" CHECK (char_length("safety_reports"."description") BETWEEN 10 AND 2000);--> statement-breakpoint

-- AC-3/AC-5, the mechanical form: a resolution without a named human admin, an instant and a
-- recorded reason is PHYSICALLY UNREPRESENTABLE, whatever application code does. The same device
-- as spec 029's `reviews_removal_pairing_ck`.
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_resolution_pairing_ck" CHECK (("safety_reports"."status" = 'resolved') = ("safety_reports"."resolution_reason" IS NOT NULL AND "safety_reports"."resolved_by_admin_id" IS NOT NULL AND "safety_reports"."resolved_at" IS NOT NULL));--> statement-breakpoint
-- A restriction REQUEST likewise always names the admin who asked, and when.
ALTER TABLE "safety_reports" ADD CONSTRAINT "safety_reports_restriction_pairing_ck" CHECK (("safety_reports"."restriction_requested_at" IS NULL) = ("safety_reports"."restriction_requested_by_admin_id" IS NULL));--> statement-breakpoint

CREATE INDEX "safety_reports_target_user_id_idx" ON "safety_reports" USING btree ("target_user_id");--> statement-breakpoint
-- Spec 003 AC-4: every foreign-key column carries its own covering btree index, so an admin
-- profile can be read back without a sequential scan (`lib/db/schema-lint.test.ts` enforces it).
CREATE INDEX "safety_reports_claimed_by_admin_id_idx" ON "safety_reports" USING btree ("claimed_by_admin_id");--> statement-breakpoint
CREATE INDEX "safety_reports_resolved_by_admin_id_idx" ON "safety_reports" USING btree ("resolved_by_admin_id");--> statement-breakpoint
CREATE INDEX "safety_reports_restriction_requested_by_admin_id_idx" ON "safety_reports" USING btree ("restriction_requested_by_admin_id");--> statement-breakpoint
-- §3 "Priority" — the queue reads `priority DESC, created_at ASC`, i.e. FIFO among equals.
CREATE INDEX "safety_reports_queue_idx" ON "safety_reports" USING btree ("priority","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_reports_author_idempotency_uq" ON "safety_reports" USING btree ("reporter_user_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- user_blocks — NEW. Nothing to reuse: no block table has ever existed.
-- ---------------------------------------------------------------------------
CREATE TABLE "user_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"blocker_user_id" uuid NOT NULL,
	"blocked_user_id" uuid NOT NULL
);--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_user_id_users_id_fk" FOREIGN KEY ("blocker_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_user_id_users_id_fk" FOREIGN KEY ("blocked_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Self-block is unrepresentable at the database, not merely rejected in application code.
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_no_self_ck" CHECK ("user_blocks"."blocker_user_id" <> "user_blocks"."blocked_user_id");--> statement-breakpoint
-- The concurrency authority: two simultaneous blocks produce exactly one row.
CREATE UNIQUE INDEX "user_blocks_pair_uq" ON "user_blocks" USING btree ("blocker_user_id","blocked_user_id");--> statement-breakpoint
CREATE INDEX "user_blocks_blocked_user_id_idx" ON "user_blocks" USING btree ("blocked_user_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- file_assets: widen spec 027's closed context vocabulary by ONE value
-- ---------------------------------------------------------------------------
-- The only change to spec 027's schema. `safety_evidence` is PRIVATE-only; the policy that makes
-- that true lives in `lib/safety/evidence-policy.ts`, not here.
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document','review_media','safety_evidence'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- request_provider_matches: widen spec 017's closed exclusion vocabulary by ONE value
-- ---------------------------------------------------------------------------
-- AC-1's matching half. `blocked` is admin-only data (`MatchExplainabilityDto` is admin-only), so
-- no customer- or provider-facing DTO changes meaning. The value is only ever written when spec
-- 030's `ProviderBlockSource` is registered; unregistered, spec 017 behaves exactly as before.
ALTER TABLE "request_provider_matches" DROP CONSTRAINT IF EXISTS "request_provider_matches_exclusion_reason_ck";--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD CONSTRAINT "request_provider_matches_exclusion_reason_ck" CHECK ("request_provider_matches"."exclusion_reason" is null or "request_provider_matches"."exclusion_reason" in ('service_not_offered','outside_service_area','unavailable','not_verified','at_capacity','blocked'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permissions — EXACTLY THREE, and none of them sanctions anyone
-- ---------------------------------------------------------------------------
-- Master §64 requires restricted access, so these go to Trust & Safety and Super Admin only.
-- `support_admin` is deliberately excluded: it already reaches conversations through spec 025's
-- `messaging/read_conversation` and does not need the safety queue.
--
-- There is NO `user_restrictions/apply` row here (DECIDED-3). An admin holding all three of these
-- can read, triage, escalate and close a safety report, and nothing else.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('safety_reports', 'read', 'low'),
	('safety_reports', 'escalate', 'medium'),
	('safety_reports', 'resolve', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('trust_safety_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
