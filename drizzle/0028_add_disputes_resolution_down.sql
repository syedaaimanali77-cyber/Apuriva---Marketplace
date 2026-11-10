-- Down migration for 0028_add_disputes_resolution —
-- docs/specs/2026-08-28-031-disputes-resolution.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0028
-- added and nothing else.
--
-- IT RESTORES THE SPEC 003 SKELETONS, it does not drop them. All five `disputes*` tables belong to
-- `0001_baseline_schema.sql`; only the columns, constraints and indexes 0028 added come off, and
-- the two plain indexes 0028 replaced with unique ones are put back exactly as the baseline had
-- them.
--
-- ORPHANS NO BYTES AND DESTROYS NO AUDIT RECORD. Evidence lives in `file_assets`, which this does
-- not delete: those rows simply become unreferenced and fall to spec 027's existing
-- soft-delete/purge sweep. `security_events` rows written by `recordAdminAuditEvent()` are never
-- touched — audit outlives the feature, which is the whole reason this spec writes to spec 009's
-- store rather than to a table it owns.
--
-- NO VOCABULARY IS NARROWED. Unlike spec 030's rollback, nothing here touches
-- `file_assets_context_type_ck`, `bookings_status_ck` or `payments_protection_state_ck`:
-- `dispute_evidence`, `disputed` and `disputed` were all in those vocabularies before this spec
-- and remain in them after.
--
-- ROLLING BACK RELEASES MONEY THAT WAS HELD. With `registerDisputeGate` gone, spec 021's sweep
-- stops seeing any dispute and resumes releasing protection windows — which is correct, because no
-- dispute record remains to justify the hold. §9 "Rollback" therefore instructs the operator to
-- resolve or close live disputes FIRST, and the content gate below enforces that rather than
-- trusting the runbook.
--
-- It IS gated on content. Dropping the columns would destroy the substance of every dispute —
-- every reasoning, every appeal, every proposed amount — while leaving meaningless skeleton rows
-- behind, so this refuses rather than doing that. Once real disputes exist, the correct response to
-- a defect is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "disputes") THEN
    RAISE EXCEPTION 'Refusing to roll back 0028: disputes exist and their content would be destroyed';
  END IF;
  IF EXISTS (SELECT 1 FROM "dispute_resolutions") OR EXISTS (SELECT 1 FROM "dispute_appeals") THEN
    RAISE EXCEPTION 'Refusing to roll back 0028: dispute decisions exist and would be destroyed';
  END IF;
  IF EXISTS (SELECT 1 FROM "dispute_evidence") OR EXISTS (SELECT 1 FROM "dispute_messages") THEN
    RAISE EXCEPTION 'Refusing to roll back 0028: dispute evidence or messages exist and would be destroyed';
  END IF;
END $$;
--> statement-breakpoint

-- --------------------------------------------------------------------------- dispute_appeals
DROP INDEX IF EXISTS "dispute_appeals_appellant_idempotency_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "dispute_appeals_reviewed_by_admin_user_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "dispute_appeals_dispute_uq";--> statement-breakpoint
-- Restore the baseline's plain index, so the `dispute_id` foreign key keeps its covering index.
CREATE INDEX IF NOT EXISTS "dispute_appeals_dispute_id_idx" ON "dispute_appeals" USING btree ("dispute_id");--> statement-breakpoint

ALTER TABLE "dispute_appeals" DROP CONSTRAINT IF EXISTS "dispute_appeals_decision_pairing_ck";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP CONSTRAINT IF EXISTS "dispute_appeals_reason_length_ck";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP CONSTRAINT IF EXISTS "dispute_appeals_outcome_ck";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP CONSTRAINT IF EXISTS "dispute_appeals_reviewed_by_admin_user_id_users_id_fk";--> statement-breakpoint

ALTER TABLE "dispute_appeals" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP COLUMN IF EXISTS "decided_at";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP COLUMN IF EXISTS "reviewed_by_admin_user_id";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP COLUMN IF EXISTS "reasoning";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP COLUMN IF EXISTS "outcome";--> statement-breakpoint
ALTER TABLE "dispute_appeals" DROP COLUMN IF EXISTS "reason";--> statement-breakpoint

-- --------------------------------------------------------------------------- dispute_resolutions
DROP INDEX IF EXISTS "dispute_resolutions_refund_admin_action_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "dispute_resolutions_resolved_by_admin_user_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "dispute_resolutions_dispute_uq";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dispute_resolutions_dispute_id_idx" ON "dispute_resolutions" USING btree ("dispute_id");--> statement-breakpoint

ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_refund_link_ck";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_refund_pairing_ck";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_proposed_refund_positive_ck";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_proposed_refund_currency_format_ck";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_proposed_refund_pair_ck";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_reasoning_length_ck";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_decision_ck";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_refund_admin_action_id_admin_actions_id_fk";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP CONSTRAINT IF EXISTS "dispute_resolutions_resolved_by_admin_user_id_users_id_fk";--> statement-breakpoint

ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "refund_admin_action_id";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "proposed_refund_currency_code";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "proposed_refund_amount_minor_units";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "resolved_at";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "resolved_by_admin_user_id";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "reasoning";--> statement-breakpoint
ALTER TABLE "dispute_resolutions" DROP COLUMN IF EXISTS "decision";--> statement-breakpoint

-- --------------------------------------------------------------------------- dispute_messages
DROP INDEX IF EXISTS "dispute_messages_sender_idempotency_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "dispute_messages_dispute_created_idx";--> statement-breakpoint
ALTER TABLE "dispute_messages" DROP CONSTRAINT IF EXISTS "dispute_messages_body_length_ck";--> statement-breakpoint
ALTER TABLE "dispute_messages" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "dispute_messages" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "dispute_messages" DROP COLUMN IF EXISTS "contact_flagged";--> statement-breakpoint
ALTER TABLE "dispute_messages" DROP COLUMN IF EXISTS "is_admin";--> statement-breakpoint
ALTER TABLE "dispute_messages" DROP COLUMN IF EXISTS "body";--> statement-breakpoint

-- --------------------------------------------------------------------------- dispute_evidence
DROP INDEX IF EXISTS "dispute_evidence_dispute_asset_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "dispute_evidence_file_asset_id_idx";--> statement-breakpoint
ALTER TABLE "dispute_evidence" DROP CONSTRAINT IF EXISTS "dispute_evidence_file_asset_id_file_assets_id_fk";--> statement-breakpoint
ALTER TABLE "dispute_evidence" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "dispute_evidence" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "dispute_evidence" DROP COLUMN IF EXISTS "file_asset_id";--> statement-breakpoint

-- --------------------------------------------------------------------------- disputes
DROP INDEX IF EXISTS "disputes_status_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "disputes_opener_idempotency_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "disputes_booking_open_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "disputes_escalated_safety_report_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "disputes_claimed_by_admin_user_id_idx";--> statement-breakpoint

ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_reason_length_ck";--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_closed_pairing_ck";--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_status_ck";--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_escalated_safety_report_id_safety_reports_id_fk";--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT IF EXISTS "disputes_claimed_by_admin_user_id_users_id_fk";--> statement-breakpoint

ALTER TABLE "disputes" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN IF EXISTS "closed_at";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN IF EXISTS "escalated_safety_report_id";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN IF EXISTS "legal_hold";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN IF EXISTS "ai_summary";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN IF EXISTS "claimed_by_admin_user_id";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN IF EXISTS "reason";--> statement-breakpoint
ALTER TABLE "disputes" DROP COLUMN IF EXISTS "status";--> statement-breakpoint

-- The two transition rows this migration seeded. `disputed` remains a valid booking status —
-- spec 003's baseline vocabulary is untouched; only the ability to REACH it is withdrawn.
DELETE FROM "bookings_status_transitions"
 WHERE ("from_status", "to_status") IN (('protected','disputed'), ('disputed','protected'));--> statement-breakpoint

-- The three permission rows this migration seeded. Role assignments are untouched: an admin simply
-- loses the ability to see the dispute queue, which is the pre-031 state.
DELETE FROM "permissions" WHERE "resource" = 'disputes' AND "action" IN ('read','resolve','review_appeal');
