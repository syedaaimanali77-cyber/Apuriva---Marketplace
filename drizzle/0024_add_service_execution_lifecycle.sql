-- Spec 028 §4 "Migration" — docs/specs/2026-08-28-028-service-execution-lifecycle.md.
--
-- Two ALTERs and nothing else. `booking_milestones` is a spec 003 BASELINE skeleton
-- (id, audit columns, version, booking_id) that no code has ever inserted into; this migration
-- fills in the columns that make a milestone mean something. `services` gains ONE defaulted
-- boolean — the completion-evidence requirement spec 020's `CompletionEvidenceGate` was shipped
-- inert waiting for.
--
-- Adds NO TABLE, and touches NOTHING of spec 027's: booking evidence is `file_assets` rows with
-- context_type = 'booking_evidence' and context_id = the booking, which is the vocabulary entry
-- spec 027 already reserved. `0001_baseline_schema.sql` is immutable
-- (`npm run check:schema-checksum`) and is not touched.
-- Number: `_journal.json`'s head was `0023_add_file_assets` (spec 027), so this is 0024.
--
-- Precondition: `booking_milestones` gets NOT NULL columns, so it must be empty. Nothing in lib/
-- or app/ has ever written to it, so it is. NO BACKFILL anywhere: `completion_evidence_required`
-- defaults to false, which is exactly the behaviour every existing service already has under spec
-- 020's default gate, so no existing row is read or modified and no service's behaviour changes
-- until an admin deliberately turns the flag on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "booking_milestones") THEN
    RAISE EXCEPTION '0024_add_service_execution_lifecycle requires an empty booking_milestones';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "completion_evidence_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_milestones" ADD COLUMN "milestone_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_milestones" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "booking_milestones" ADD COLUMN "created_by_user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_milestones" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_milestones" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_milestones" ADD CONSTRAINT "booking_milestones_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- C-1: the closed milestone vocabulary, mirroring `bookings_status_ck` / `services_status_ck`.
ALTER TABLE "booking_milestones" ADD CONSTRAINT "booking_milestones_type_ck" CHECK ("milestone_type" in ('started','working','almost_done','custom'));--> statement-breakpoint
-- C-2: a bounded note, and a custom milestone must carry one — an unlabelled custom milestone
-- would be a row that says nothing.
ALTER TABLE "booking_milestones" ADD CONSTRAINT "booking_milestones_note_ck" CHECK (("note" IS NULL OR char_length("note") BETWEEN 1 AND 500) AND ("milestone_type" <> 'custom' OR "note" IS NOT NULL));--> statement-breakpoint
-- Spec 003 AC-4 (enforced by lib/db/schema-lint.test.ts): every FK column carries its own
-- covering btree index, so the `created_by_user_id` reference is not an unindexed scan.
CREATE INDEX "booking_milestones_created_by_user_id_idx" ON "booking_milestones" USING btree ("created_by_user_id");--> statement-breakpoint
-- I-1: idempotency scoped PER BOOKING, never globally — the database backstop for AC-10, and the
-- same per-scope rule specs 015/018/020 use for their own keys.
CREATE UNIQUE INDEX "booking_milestones_booking_idempotency_key_uq" ON "booking_milestones" USING btree ("booking_id","idempotency_key");
