-- Spec 029 §4 "Migration" — docs/specs/2026-08-28-029-reviews-ratings.md.
--
-- Three ALTERs, one new table, one constraint swap and two permission seeds. `reviews`,
-- `review_responses` and `review_reports` are spec 003 BASELINE skeletons (id, audit columns,
-- version, and one or two foreign keys) that no code has ever inserted into; this migration fills
-- in the columns that make a review mean something. They are ALTERED, never recreated —
-- `0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.
--
-- Number: `_journal.json`'s head was `0025_add_ai_usage_tracking` (spec 033), so this is 0026.
--
-- Creates NO storage: review media is `file_assets` rows with context_type = 'review_media' and
-- context_id = the booking, plus the `review_media` link table that binds them to the review once
-- it exists — exactly the shape `message_attachments` already uses. The only change to spec 027's
-- schema is widening its closed `context_type` vocabulary by one value.
--
-- Precondition: the three tables receive NOT NULL columns without defaults, so they must be empty.
-- Nothing in lib/ or app/ has ever written to them (`lib/privacy/export.ts` only READS `reviews`),
-- so they are. NO BACKFILL anywhere: there is no existing data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "reviews") THEN
    RAISE EXCEPTION '0026_add_reviews_ratings requires an empty reviews';
  END IF;
  IF EXISTS (SELECT 1 FROM "review_responses") THEN
    RAISE EXCEPTION '0026_add_reviews_ratings requires an empty review_responses';
  END IF;
  IF EXISTS (SELECT 1 FROM "review_reports") THEN
    RAISE EXCEPTION '0026_add_reviews_ratings requires an empty review_reports';
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- reviews
-- ---------------------------------------------------------------------------
ALTER TABLE "reviews" ADD COLUMN "provider_profile_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "service_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "rating" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "text" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "status" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "flag_signals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "moderated_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "removal_reason" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_moderated_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("moderated_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- C-1: 1..5, mirroring the five stars the design system's `Rating` primitive renders.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_ck" CHECK ("rating" BETWEEN 1 AND 5);--> statement-breakpoint
-- C-2: the closed status vocabulary, mirroring `bookings_status_ck` / `file_assets_status_ck`.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_status_ck" CHECK ("status" in ('published','flagged','removed'));--> statement-breakpoint
-- C-3: optional text, but never a one-character body. Bounds match `MESSAGE_BODY_MAX_LENGTH`.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_text_length_ck" CHECK ("text" IS NULL OR char_length("text") BETWEEN 10 AND 2000);--> statement-breakpoint
-- C-4 / AC-4 / AC-8, MECHANICALLY: a removal with no named human admin, no instant and no recorded
-- reason is physically unrepresentable. This is what guarantees that no heuristic, no report count
-- and no future code path can hide a review on its own, whatever the application layer does.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_removal_pairing_ck" CHECK (("status" = 'removed') = ("removal_reason" IS NOT NULL AND "moderated_by_admin_id" IS NOT NULL AND "moderated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_flag_signals_ck" CHECK (jsonb_typeof("flag_signals") = 'array');--> statement-breakpoint
-- Spec 003 AC-4: every FK column carries its own covering btree index.
CREATE INDEX "reviews_provider_profile_id_idx" ON "reviews" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX "reviews_service_id_idx" ON "reviews" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "reviews_moderated_by_admin_id_idx" ON "reviews" USING btree ("moderated_by_admin_id");--> statement-breakpoint
-- I-1 / AC-7: one review per booking at the database, independent of the application check.
CREATE UNIQUE INDEX "reviews_booking_id_uq" ON "reviews" USING btree ("booking_id");--> statement-breakpoint
-- I-2: idempotency scoped PER AUTHOR, never globally — the rule specs 015/018/020/028 use.
CREATE UNIQUE INDEX "reviews_author_idempotency_uq" ON "reviews" USING btree ("author_user_id","idempotency_key");--> statement-breakpoint
-- I-3: the public list's read path AND the rating aggregate's, in one partial index. `flagged` is
-- included on purpose — it is publicly visible (AC-4).
CREATE INDEX "reviews_provider_visible_idx" ON "reviews" USING btree ("provider_profile_id","created_at" DESC) WHERE "status" in ('published','flagged');--> statement-breakpoint
-- I-4: the moderation queue.
CREATE INDEX "reviews_status_idx" ON "reviews" USING btree ("status","created_at" DESC);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- review_responses
-- ---------------------------------------------------------------------------
ALTER TABLE "review_responses" ADD COLUMN "text" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_responses" ADD COLUMN "status" text DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_responses" ADD COLUMN "flag_signals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_responses" ADD COLUMN "moderated_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "review_responses" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_responses" ADD COLUMN "removal_reason" text;--> statement-breakpoint
ALTER TABLE "review_responses" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_responses" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_moderated_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("moderated_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_status_ck" CHECK ("status" in ('published','flagged','removed'));--> statement-breakpoint
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_text_length_ck" CHECK (char_length("text") BETWEEN 10 AND 2000);--> statement-breakpoint
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_removal_pairing_ck" CHECK (("status" = 'removed') = ("removal_reason" IS NOT NULL AND "moderated_by_admin_id" IS NOT NULL AND "moderated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "review_responses" ADD CONSTRAINT "review_responses_flag_signals_ck" CHECK (jsonb_typeof("flag_signals") = 'array');--> statement-breakpoint
CREATE INDEX "review_responses_moderated_by_admin_id_idx" ON "review_responses" USING btree ("moderated_by_admin_id");--> statement-breakpoint
-- I-6 / AC-3: exactly one response per review.
CREATE UNIQUE INDEX "review_responses_review_id_uq" ON "review_responses" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_responses_idempotency_uq" ON "review_responses" USING btree ("review_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- review_reports
-- ---------------------------------------------------------------------------
ALTER TABLE "review_reports" ADD COLUMN "reason" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_reports" ADD COLUMN "details" text;--> statement-breakpoint
ALTER TABLE "review_reports" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_reports" ADD COLUMN "resolved_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "review_reports" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "review_reports" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_reports" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_resolved_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_reason_ck" CHECK ("reason" in ('spam','offensive','false_information','personal_information','off_topic','other'));--> statement-breakpoint
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_status_ck" CHECK ("status" in ('open','resolved','dismissed'));--> statement-breakpoint
-- C-8: 'other' must be explained; any details given are bounded.
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_details_ck" CHECK (("reason" <> 'other' OR "details" IS NOT NULL) AND ("details" IS NULL OR char_length("details") BETWEEN 10 AND 2000));--> statement-breakpoint
-- C-9: a resolution always names its admin and its instant.
ALTER TABLE "review_reports" ADD CONSTRAINT "review_reports_resolution_pairing_ck" CHECK (("status" = 'open') = ("resolved_at" IS NULL AND "resolved_by_admin_id" IS NULL));--> statement-breakpoint
CREATE INDEX "review_reports_resolved_by_admin_id_idx" ON "review_reports" USING btree ("resolved_by_admin_id");--> statement-breakpoint
CREATE INDEX "review_reports_status_idx" ON "review_reports" USING btree ("status","created_at");--> statement-breakpoint
-- I-8 / AC-6: one report per reporter per review; a repeat replays rather than piling up.
CREATE UNIQUE INDEX "review_reports_review_reporter_uq" ON "review_reports" USING btree ("review_id","reporter_user_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- review_media — the link table, mirroring `message_attachments`
-- ---------------------------------------------------------------------------
CREATE TABLE "review_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"review_id" uuid NOT NULL,
	"file_asset_id" uuid NOT NULL,
	"position" integer NOT NULL
);--> statement-breakpoint
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_file_asset_id_file_assets_id_fk" FOREIGN KEY ("file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_media" ADD CONSTRAINT "review_media_position_ck" CHECK ("position" BETWEEN 0 AND 4);--> statement-breakpoint
CREATE INDEX "review_media_review_id_idx" ON "review_media" USING btree ("review_id");--> statement-breakpoint
CREATE INDEX "review_media_file_asset_id_idx" ON "review_media" USING btree ("file_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_media_review_asset_uq" ON "review_media" USING btree ("review_id","file_asset_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- file_assets: widen spec 027's closed context vocabulary by ONE value
-- ---------------------------------------------------------------------------
-- The only change to spec 027's schema. Added NOT VALID and validated separately so the ACCESS
-- EXCLUSIVE lock is momentary rather than held for a full-table revalidation.
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document','review_media')) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_assets" VALIDATE CONSTRAINT "file_assets_context_type_ck";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Permissions (spec 009's existing model — no new authorization framework)
-- ---------------------------------------------------------------------------
-- Master §69 scopes Content/Marketplace Admin to services, categories and FAQs; a review is a
-- trust-and-safety matter, so these go to Trust & Safety and Super Admin only — the same pair and
-- the same `medium` tier spec 023 chose for `no_show_reports/resolve`. `medium` per master §70 is
-- "authorized admin + reason/audit": the admin picks an outcome from a closed set, never an amount,
-- and every resolution is audited.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('reviews', 'read_moderation_queue', 'low'),
	('reviews', 'moderate', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('trust_safety_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
