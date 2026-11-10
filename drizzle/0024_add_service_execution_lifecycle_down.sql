-- Down migration for 0024_add_service_execution_lifecycle —
-- docs/specs/2026-08-28-028-service-execution-lifecycle.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0024
-- added and nothing else.
--
-- Unlike 0023's, this rollback ORPHANS NOTHING. Booking evidence lives in `file_assets`, which 0024
-- does not touch, so every uploaded asset survives intact; rolling 0024 back simply returns spec
-- 020's `CompletionEvidenceGate` to its inert default (completion succeeds without evidence) and
-- returns `booking_evidence` to `422 FILE_CONTEXT_NOT_AVAILABLE` — both of which are those ports'
-- documented pre-028 behaviour, so no shipped spec breaks.
--
-- It IS gated on one thing: posted milestones. Dropping the columns would silently destroy the
-- content of every milestone a provider has posted while leaving a meaningless skeleton row behind,
-- so this refuses rather than doing that. Once milestones exist, the correct response to a defect
-- is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "booking_milestones") THEN
    RAISE EXCEPTION 'Refusing to roll back 0024: booking milestones exist and their content would be destroyed';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "booking_milestones_booking_idempotency_key_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "booking_milestones_created_by_user_id_idx";--> statement-breakpoint
ALTER TABLE "booking_milestones" DROP CONSTRAINT IF EXISTS "booking_milestones_note_ck";--> statement-breakpoint
ALTER TABLE "booking_milestones" DROP CONSTRAINT IF EXISTS "booking_milestones_type_ck";--> statement-breakpoint
ALTER TABLE "booking_milestones" DROP CONSTRAINT IF EXISTS "booking_milestones_created_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "booking_milestones" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "booking_milestones" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "booking_milestones" DROP COLUMN IF EXISTS "created_by_user_id";--> statement-breakpoint
ALTER TABLE "booking_milestones" DROP COLUMN IF EXISTS "note";--> statement-breakpoint
ALTER TABLE "booking_milestones" DROP COLUMN IF EXISTS "milestone_type";--> statement-breakpoint
-- Left last on purpose: any service still flagged would simply stop requiring evidence, which is
-- the pre-028 behaviour. No row is deleted and no evidence asset is touched.
ALTER TABLE "services" DROP COLUMN IF EXISTS "completion_evidence_required";
