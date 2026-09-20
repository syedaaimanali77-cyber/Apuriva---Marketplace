-- Down migration for 0029_add_customer_provider_support —
-- docs/specs/2026-08-28-032-customer-provider-support.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0029
-- added and nothing else.
--
-- IT RESTORES THE SPEC 003 SKELETONS, it does not drop them. `support_tickets`, `support_messages`
-- and `support_notes` all belong to `0001_baseline_schema.sql`; only the columns, constraints and
-- indexes 0029 added come off. The baseline's own `requester_user_id` / `support_ticket_id` /
-- `sender_user_id` / `author_user_id` columns, their foreign keys and their three indexes stay,
-- which is what keeps 0001's foreign keys valid.
--
-- ORPHANS NO BYTES AND DESTROYS NO AUDIT RECORD. Attachments live in `file_assets`, which this does
-- not delete: those rows simply become unreferenced and fall to spec 027's existing
-- soft-delete/purge sweep. `security_events` rows written by `recordAdminAuditEvent()` are never
-- touched — audit outlives the feature, which is the whole reason this spec writes to spec 009's
-- store rather than to a table it owns.
--
-- It IS gated on content, the same rule spec 031's rollback applies. Dropping the columns would
-- destroy the substance of every ticket — every description, every reply, every internal note and
-- every resolution reason — while leaving meaningless skeleton rows behind, so this refuses rather
-- than doing that. Once real tickets exist, the correct response to a defect is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support_tickets") THEN
    RAISE EXCEPTION 'Refusing to roll back 0029: support tickets exist and their content would be destroyed';
  END IF;
  IF EXISTS (SELECT 1 FROM "support_messages") OR EXISTS (SELECT 1 FROM "support_notes") THEN
    RAISE EXCEPTION 'Refusing to roll back 0029: support messages or internal notes exist and would be destroyed';
  END IF;
END $$;
--> statement-breakpoint

-- --------------------------------------------------------------------------- support_notes
DROP INDEX IF EXISTS "support_notes_author_idempotency_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "support_notes_ticket_created_idx";--> statement-breakpoint
ALTER TABLE "support_notes" DROP CONSTRAINT IF EXISTS "support_notes_body_length_ck";--> statement-breakpoint
ALTER TABLE "support_notes" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "support_notes" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "support_notes" DROP COLUMN IF EXISTS "body";--> statement-breakpoint

-- --------------------------------------------------------------------------- support_messages
DROP INDEX IF EXISTS "support_messages_sender_idempotency_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "support_messages_ticket_created_idx";--> statement-breakpoint
ALTER TABLE "support_messages" DROP CONSTRAINT IF EXISTS "support_messages_body_length_ck";--> statement-breakpoint
ALTER TABLE "support_messages" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "support_messages" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "support_messages" DROP COLUMN IF EXISTS "is_admin";--> statement-breakpoint
ALTER TABLE "support_messages" DROP COLUMN IF EXISTS "body";--> statement-breakpoint

-- --------------------------------------------------------------------------- support_tickets
DROP INDEX IF EXISTS "support_tickets_escalated_dispute_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "support_tickets_escalated_safety_report_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "support_tickets_context_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "support_tickets_assigned_admin_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "support_tickets_sla_deadline_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "support_tickets_status_priority_created_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "support_tickets_requester_idempotency_uq";--> statement-breakpoint

ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_reason_length_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_description_length_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_subject_length_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_safety_resolution_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_sla_paused_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_reopen_count_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_assigned_pairing_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_awaiting_pairing_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_closed_pairing_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_handoff_pairing_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_resolution_pairing_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_handoff_target_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_resolution_kind_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_context_pairing_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_context_type_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_requester_mode_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_status_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_priority_ck";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_category_ck";--> statement-breakpoint

ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_escalated_dispute_id_disputes_id_fk";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_escalated_safety_report_id_safety_reports_id_fk";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP CONSTRAINT IF EXISTS "support_tickets_assigned_admin_user_id_users_id_fk";--> statement-breakpoint

ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "closed_at";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "resolved_at";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "reopen_count";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "legal_hold";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "escalated_dispute_id";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "escalated_safety_report_id";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "handoff_target";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "resolution_reason";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "resolution_kind";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "ai_summary";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "awaiting_user_since";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "sla_paused_seconds";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "sla_deadline_at";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "assigned_admin_user_id";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "context_id";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "context_type";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "requester_mode";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "status";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "priority";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "category";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "description";--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN IF EXISTS "subject";--> statement-breakpoint

-- --------------------------------------------------------------------------- file_assets
-- Narrow the context vocabulary back by exactly ONE value. `safety_evidence` (spec 030, 0027) and
-- `review_media` (spec 029, 0026) are NOT touched: they were in the vocabulary before 0029 and
-- remain in it after this rollback. Only `support_attachment` is withdrawn.
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document','review_media','safety_evidence'));--> statement-breakpoint

-- The five permission rows this migration seeded. Role assignments are untouched: an admin simply
-- loses the ability to see the support queue, which is the pre-032 state.
DELETE FROM "permissions" WHERE "resource" = 'support' AND "action" IN ('read','assign','respond','triage','resolve');
