-- Down migration for 0027_add_blocking_safety_incidents —
-- docs/specs/2026-08-28-030-blocking-reporting-safety-incidents.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0027
-- added and nothing else.
--
-- ORPHANS NO BYTES AND DESTROYS NO AUDIT RECORD. Evidence lives in `file_assets`, which this does
-- not delete: those rows simply become unreferenced and fall to spec 027's existing
-- soft-delete/purge sweep. `security_events` rows written by `recordAdminAuditEvent()` are never
-- touched — audit outlives the feature, which is the whole reason this spec writes to spec 009's
-- store rather than to a table it owns.
--
-- Rolling back returns all three ports to their documented pre-030 defaults: nobody blocked in
-- messaging, nobody excluded from matching, and `422 FILE_CONTEXT_NOT_AVAILABLE` for
-- `safety_evidence`. No shipped spec breaks. No account state can have been changed by spec 030,
-- because it never writes any, so a rollback cannot strand a restricted user.
--
-- It IS gated on content. Dropping the columns would destroy the substance of every safety report
-- while leaving meaningless skeleton rows behind, so this refuses rather than doing that. Once real
-- reports exist, the correct response to a defect is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "safety_reports") THEN
    RAISE EXCEPTION 'Refusing to roll back 0027: safety reports exist and their content would be destroyed';
  END IF;
END $$;
--> statement-breakpoint

-- Restore spec 027's context vocabulary to its 0026 form. Done FIRST, and gated: a
-- `safety_evidence` asset would violate the narrowed CHECK, so refuse rather than leave the
-- constraint unrestorable. Deliberately refuses even though the assets are under `legal_hold` —
-- held evidence is exactly what must not be silently detached from its vocabulary.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "file_assets" WHERE "context_type" = 'safety_evidence') THEN
    RAISE EXCEPTION 'Refusing to roll back 0027: safety_evidence file assets exist';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document','review_media'));--> statement-breakpoint

-- Restore spec 017's exclusion vocabulary to its 0013 form. Gated: a `blocked` row would violate
-- the narrowed CHECK, so refuse rather than leave the constraint unrestorable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "request_provider_matches" WHERE "exclusion_reason" = 'blocked') THEN
    RAISE EXCEPTION 'Refusing to roll back 0027: matching rows excluded with reason blocked exist';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "request_provider_matches" DROP CONSTRAINT IF EXISTS "request_provider_matches_exclusion_reason_ck";--> statement-breakpoint
ALTER TABLE "request_provider_matches" ADD CONSTRAINT "request_provider_matches_exclusion_reason_ck" CHECK ("request_provider_matches"."exclusion_reason" is null or "request_provider_matches"."exclusion_reason" in ('service_not_offered','outside_service_area','unavailable','not_verified','at_capacity'));--> statement-breakpoint

DROP TABLE IF EXISTS "user_blocks";--> statement-breakpoint

DROP INDEX IF EXISTS "safety_reports_author_idempotency_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "safety_reports_queue_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "safety_reports_restriction_requested_by_admin_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "safety_reports_resolved_by_admin_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "safety_reports_claimed_by_admin_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "safety_reports_target_user_id_idx";--> statement-breakpoint

ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_restriction_pairing_ck";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_resolution_pairing_ck";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_description_length_ck";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_no_self_ck";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_category_ck";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_priority_ck";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_status_ck";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_restriction_requested_by_admin_id_admin_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_resolved_by_admin_id_admin_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_claimed_by_admin_id_admin_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP CONSTRAINT IF EXISTS "safety_reports_target_user_id_users_id_fk";--> statement-breakpoint

ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "restriction_moderation_action_id";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "restriction_requested_by_admin_id";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "restriction_requested_at";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "resolution_reason";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "resolved_by_admin_id";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "resolved_at";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "escalated_at";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "claimed_by_admin_id";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "ai_summary";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "priority";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "description";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "category";--> statement-breakpoint
ALTER TABLE "safety_reports" DROP COLUMN IF EXISTS "target_user_id";--> statement-breakpoint

-- The three permission rows this migration seeded. Role assignments are untouched: an admin simply
-- loses the ability to see the safety queue, which is the pre-030 state.
DELETE FROM "permissions" WHERE "resource" = 'safety_reports' AND "action" IN ('read','escalate','resolve');
