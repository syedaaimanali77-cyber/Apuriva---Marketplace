-- Down migration for 0026_add_reviews_ratings —
-- docs/specs/2026-08-28-029-reviews-ratings.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0026
-- added and nothing else.
--
-- ORPHANS NO BYTES. Review media lives in `file_assets`, which this does not delete: those rows
-- simply become unreferenced and fall to spec 027's existing soft-delete/purge sweep. Rolling back
-- returns the `review_media` context to `422 FILE_CONTEXT_NOT_AVAILABLE` and spec 017's rating
-- source to its `null` default — both of which are those ports' documented pre-029 behaviour, so
-- no shipped spec breaks.
--
-- It IS gated on published content. Dropping the columns would silently destroy the rating, text
-- and moderation record of every review, leaving meaningless skeleton rows behind, so this refuses
-- rather than doing that. Once reviews exist, the correct response to a defect is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "reviews") THEN
    RAISE EXCEPTION 'Refusing to roll back 0026: reviews exist and their content would be destroyed';
  END IF;
  IF EXISTS (SELECT 1 FROM "review_responses") THEN
    RAISE EXCEPTION 'Refusing to roll back 0026: review responses exist and their content would be destroyed';
  END IF;
  IF EXISTS (SELECT 1 FROM "review_reports") THEN
    RAISE EXCEPTION 'Refusing to roll back 0026: review reports exist and their content would be destroyed';
  END IF;
END $$;
--> statement-breakpoint

-- Restore spec 027's context vocabulary to its 0023 form. Done FIRST, and gated: a `review_media`
-- asset would violate the narrowed CHECK, so refuse rather than leave the constraint unrestorable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "file_assets" WHERE "context_type" = 'review_media') THEN
    RAISE EXCEPTION 'Refusing to roll back 0026: review_media file assets exist';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document'));--> statement-breakpoint

DROP TABLE IF EXISTS "review_media";--> statement-breakpoint

DROP INDEX IF EXISTS "review_reports_review_reporter_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "review_reports_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "review_reports_resolved_by_admin_id_idx";--> statement-breakpoint
ALTER TABLE "review_reports" DROP CONSTRAINT IF EXISTS "review_reports_resolution_pairing_ck";--> statement-breakpoint
ALTER TABLE "review_reports" DROP CONSTRAINT IF EXISTS "review_reports_details_ck";--> statement-breakpoint
ALTER TABLE "review_reports" DROP CONSTRAINT IF EXISTS "review_reports_status_ck";--> statement-breakpoint
ALTER TABLE "review_reports" DROP CONSTRAINT IF EXISTS "review_reports_reason_ck";--> statement-breakpoint
ALTER TABLE "review_reports" DROP CONSTRAINT IF EXISTS "review_reports_resolved_by_admin_id_admin_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "review_reports" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "review_reports" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "review_reports" DROP COLUMN IF EXISTS "resolved_at";--> statement-breakpoint
ALTER TABLE "review_reports" DROP COLUMN IF EXISTS "resolved_by_admin_id";--> statement-breakpoint
ALTER TABLE "review_reports" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "review_reports" DROP COLUMN IF EXISTS "details";--> statement-breakpoint
ALTER TABLE "review_reports" DROP COLUMN IF EXISTS "reason";--> statement-breakpoint

DROP INDEX IF EXISTS "review_responses_idempotency_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "review_responses_review_id_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "review_responses_moderated_by_admin_id_idx";--> statement-breakpoint
ALTER TABLE "review_responses" DROP CONSTRAINT IF EXISTS "review_responses_flag_signals_ck";--> statement-breakpoint
ALTER TABLE "review_responses" DROP CONSTRAINT IF EXISTS "review_responses_removal_pairing_ck";--> statement-breakpoint
ALTER TABLE "review_responses" DROP CONSTRAINT IF EXISTS "review_responses_text_length_ck";--> statement-breakpoint
ALTER TABLE "review_responses" DROP CONSTRAINT IF EXISTS "review_responses_status_ck";--> statement-breakpoint
ALTER TABLE "review_responses" DROP CONSTRAINT IF EXISTS "review_responses_moderated_by_admin_id_admin_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "review_responses" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "review_responses" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "review_responses" DROP COLUMN IF EXISTS "removal_reason";--> statement-breakpoint
ALTER TABLE "review_responses" DROP COLUMN IF EXISTS "moderated_at";--> statement-breakpoint
ALTER TABLE "review_responses" DROP COLUMN IF EXISTS "moderated_by_admin_id";--> statement-breakpoint
ALTER TABLE "review_responses" DROP COLUMN IF EXISTS "flag_signals";--> statement-breakpoint
ALTER TABLE "review_responses" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "review_responses" DROP COLUMN IF EXISTS "text";--> statement-breakpoint

DROP INDEX IF EXISTS "reviews_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "reviews_provider_visible_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "reviews_author_idempotency_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "reviews_booking_id_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "reviews_moderated_by_admin_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "reviews_service_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "reviews_provider_profile_id_idx";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_flag_signals_ck";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_removal_pairing_ck";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_text_length_ck";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_status_ck";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_rating_ck";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_moderated_by_admin_id_admin_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_service_id_services_id_fk";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT IF EXISTS "reviews_provider_profile_id_provider_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "removal_reason";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "moderated_at";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "moderated_by_admin_id";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "flag_signals";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "text";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "rating";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "service_id";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN IF EXISTS "provider_profile_id";--> statement-breakpoint

-- The two permission rows this migration seeded. Role assignments are untouched: an admin simply
-- loses the ability to resolve reviews, which is the pre-029 state.
DELETE FROM "permissions" WHERE "resource" = 'reviews' AND "action" IN ('read_moderation_queue','moderate');
