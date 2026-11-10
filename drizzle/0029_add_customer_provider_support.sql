-- ---------------------------------------------------------------------------
-- Spec 032 — Customer & Provider Support
-- ---------------------------------------------------------------------------
-- THIS MIGRATION CREATES NO TABLE. `support_tickets`, `support_messages` and `support_notes`
-- already exist as spec 003 baseline skeletons (drizzle/0001_baseline_schema.sql), each carrying
-- `baseColumns()` plus its foreign keys and nothing else. This adds their feature columns.
--
-- The skeletons' own column names are authoritative and are NOT renamed:
--   support_tickets.requester_user_id   (not `user_id`)
--   support_messages.sender_user_id     (not `sender_id` + `sender_type`)
--   support_notes.author_user_id        (not `admin_id`)
--
-- `assigned_admin_user_id` references `users`, NOT `admin_profiles`: every existing support FK
-- targets `users`, and `resolvePermission()` / `recordAdminAuditEvent()` both take a `users.id`.
-- Spec 031's `disputes.claimed_by_admin_user_id` made the identical choice.

-- ---------------------------------------------------------------------------
-- support_tickets — feature columns
-- ---------------------------------------------------------------------------
ALTER TABLE "support_tickets" ADD COLUMN "subject" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "description" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "category" text NOT NULL;--> statement-breakpoint
-- Server-derived from `CATEGORY_PRIORITY` (spec 032 AC-4). Never read from a request body.
ALTER TABLE "support_tickets" ADD COLUMN "priority" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "requester_mode" text NOT NULL;--> statement-breakpoint
-- DECIDED-6: a LIVE pointer, re-resolved and re-authorized on every read. Never snapshotted, and
-- deliberately NOT a foreign key: the ticket must stay readable if its subject becomes unreachable.
ALTER TABLE "support_tickets" ADD COLUMN "context_type" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "context_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "assigned_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "sla_deadline_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "sla_paused_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "awaiting_user_since" timestamp with time zone;--> statement-breakpoint
-- Spec 033 advisory output (DECIDED-2). No decision path reads this column and it never reaches a
-- participant-facing DTO.
ALTER TABLE "support_tickets" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "resolution_kind" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "resolution_reason" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "handoff_target" text;--> statement-breakpoint
-- DECIDED-1: one-way cross-references. Never read back to change a ticket's outcome.
ALTER TABLE "support_tickets" ADD COLUMN "escalated_safety_report_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "escalated_dispute_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "legal_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "reopen_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_admin_user_id_users_id_fk" FOREIGN KEY ("assigned_admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_escalated_safety_report_id_safety_reports_id_fk" FOREIGN KEY ("escalated_safety_report_id") REFERENCES "public"."safety_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_escalated_dispute_id_disputes_id_fk" FOREIGN KEY ("escalated_dispute_id") REFERENCES "public"."disputes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Controlled vocabularies. The draft left category/priority/status as free text; they are closed here.
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_category_ck" CHECK ("category" in ('booking','payment','account','provider_quality','technical','safety','other'));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_priority_ck" CHECK ("priority" in ('low','medium','high','critical'));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_status_ck" CHECK ("status" in ('open','assigned','awaiting_user','resolved','closed'));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_mode_ck" CHECK ("requester_mode" in ('customer','provider'));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('booking','payment','dispute'));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_context_pairing_ck" CHECK (("context_type" IS NULL) = ("context_id" IS NULL));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_resolution_kind_ck" CHECK ("resolution_kind" IS NULL OR "resolution_kind" in ('answered','handed_off','not_actionable'));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_handoff_target_ck" CHECK ("handoff_target" IS NULL OR "handoff_target" in ('safety','dispute','refunds'));--> statement-breakpoint

-- Lifecycle invariants, enforced by the database rather than by prose.
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_resolution_pairing_ck" CHECK (("resolution_kind" IS NOT NULL) = ("resolved_at" IS NOT NULL) AND ("resolution_kind" IS NOT NULL) = ("resolution_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_handoff_pairing_ck" CHECK (("resolution_kind" = 'handed_off') = ("handoff_target" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_closed_pairing_ck" CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_awaiting_pairing_ck" CHECK (("status" = 'awaiting_user') = ("awaiting_user_since" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_pairing_ck" CHECK ("status" <> 'open' OR "assigned_admin_user_id" IS NULL);--> statement-breakpoint
-- 1 requester reopen + 1 admin reopen. An unbounded reopen would make `closed` unreachable.
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_reopen_count_ck" CHECK ("reopen_count" BETWEEN 0 AND 2);--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_sla_paused_ck" CHECK ("sla_paused_seconds" >= 0);--> statement-breakpoint

-- AC-9 AT THE DATABASE. Support owns the conversation, not the consequence: a safety matter is
-- handed to spec 030 or recorded as not actionable, and can NEVER be answered away as ordinary
-- support — whatever application code does, and whatever route a later spec adds.
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_safety_resolution_ck" CHECK ("category" <> 'safety' OR "resolution_kind" IS NULL OR "resolution_kind" in ('handed_off','not_actionable'));--> statement-breakpoint

-- Prose bounds. Message/note bodies reuse spec 025's MESSAGE_BODY_MAX_LENGTH value (2000) rather
-- than inventing a second platform prose bound.
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_subject_length_ck" CHECK (char_length("subject") BETWEEN 5 AND 200);--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_description_length_ck" CHECK (char_length("description") BETWEEN 10 AND 4000);--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_reason_length_ck" CHECK ("resolution_reason" IS NULL OR char_length("resolution_reason") BETWEEN 10 AND 2000);--> statement-breakpoint

CREATE UNIQUE INDEX "support_tickets_requester_idempotency_uq" ON "support_tickets" USING btree ("requester_user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "support_tickets_status_priority_created_idx" ON "support_tickets" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_sla_deadline_idx" ON "support_tickets" USING btree ("sla_deadline_at") WHERE status in ('open','assigned');--> statement-breakpoint
CREATE INDEX "support_tickets_assigned_admin_idx" ON "support_tickets" USING btree ("assigned_admin_user_id");--> statement-breakpoint
CREATE INDEX "support_tickets_context_idx" ON "support_tickets" USING btree ("context_type","context_id");--> statement-breakpoint
-- Spec 003 AC-4: every foreign-key column carries its own covering btree index.
CREATE INDEX "support_tickets_escalated_safety_report_id_idx" ON "support_tickets" USING btree ("escalated_safety_report_id");--> statement-breakpoint
CREATE INDEX "support_tickets_escalated_dispute_id_idx" ON "support_tickets" USING btree ("escalated_dispute_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- support_messages — feature columns
-- ---------------------------------------------------------------------------
-- NOT a spec 025 conversation (DECIDED-7): a support thread is user-to-platform with an admin as a
-- third participant, must survive a block, and is retained as an operational record rather than
-- swept. `is_admin` is the only new authority column; the participant DTO projects it to
-- 'you' | 'support' and never carries an admin's identity.
ALTER TABLE "support_messages" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_messages" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_body_length_ck" CHECK (char_length("body") BETWEEN 1 AND 2000);--> statement-breakpoint
CREATE INDEX "support_messages_ticket_created_idx" ON "support_messages" USING btree ("support_ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_messages_sender_idempotency_uq" ON "support_messages" USING btree ("sender_user_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- support_notes — feature columns
-- ---------------------------------------------------------------------------
-- Admin-internal, in their own table by design: a note is never a row in `support_messages`, so no
-- projection bug in the thread query can leak one, and no participant code path reads this table.
ALTER TABLE "support_notes" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_notes" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_notes" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "support_notes" ADD CONSTRAINT "support_notes_body_length_ck" CHECK (char_length("body") BETWEEN 1 AND 2000);--> statement-breakpoint
CREATE INDEX "support_notes_ticket_created_idx" ON "support_notes" USING btree ("support_ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_notes_author_idempotency_uq" ON "support_notes" USING btree ("author_user_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- file_assets: widen spec 027's closed context vocabulary by ONE value
-- ---------------------------------------------------------------------------
-- The only change to spec 027's schema, and the same DROP/ADD NOT VALID/VALIDATE shape spec 029's
-- migration 0026 used, so the ACCESS EXCLUSIVE lock is momentary rather than held for a full-table
-- revalidation.
--
-- The list below is the LIVE vocabulary: spec 029's `review_media` (0026) and spec 030's
-- `safety_evidence` (0027) are both carried forward. `lib/db/schema.ts` had drifted and omitted
-- `safety_evidence`; recreating this constraint surfaced that, and the declaration is corrected in
-- the same change so the model and the migrations agree again.
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document','review_media','safety_evidence','support_attachment')) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_assets" VALIDATE CONSTRAINT "file_assets_context_type_ck";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permissions — EXACTLY FIVE, and none of them is consequential
-- ---------------------------------------------------------------------------
-- Master §69 gives "Support tickets and user support" to the SUPPORT ADMIN by name, and gives
-- Operations "Requests, bookings, providers". So Support Admin acts and Operations only watches —
-- the same split spec 031 applied to disputes, and for the same reason.
--
-- `trust_safety_admin` and `finance_admin` are deliberately absent. A handed-off ticket reaches
-- them through THEIR OWN queue (safety_reports 030, disputes 031, refunds 022), each of which
-- already carries the full context, the reason and — for money — the four-eyes chain. A second
-- window onto the same matter would duplicate exposure without adding capability.
--
-- Every tier is low/medium, so this spec NEVER calls `authorizeAndInitiate()`: no support action
-- is consequential. There is also no "view sensitive context" permission, because there is no
-- sensitive context to gate — the workspace shows pointers and neutral statuses only.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('support', 'read', 'low')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('support_admin', 'operations_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;--> statement-breakpoint

INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('support', 'assign', 'low'),
	('support', 'respond', 'low'),
	('support', 'triage', 'medium'),
	('support', 'resolve', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('support_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
