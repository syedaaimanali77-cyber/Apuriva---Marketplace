-- Spec 031 §4 "Migration" — docs/specs/2026-08-28-031-disputes-resolution.md.
--
-- THIS MIGRATION CREATES NO TABLE. All five dispute tables are spec 003 BASELINE skeletons from
-- `0001_baseline_schema.sql` (id, audit columns, version, plus their foreign keys) that no code has
-- ever inserted into; this fills in the columns that make a dispute mean something. They are
-- ALTERED, never recreated — `0001_baseline_schema.sql` is immutable
-- (`npm run check:schema-checksum`) and is not touched.
--
-- Number: `_journal.json`'s head was `0027_add_blocking_safety_incidents` (spec 030), so this is 0028.
--
-- IT ALSO DOES NOT WIDEN ANY EXISTING VOCABULARY. Unlike spec 030, which had to add
-- `safety_evidence`, this spec's file context `dispute_evidence` has been in
-- `file_assets_context_type_ck` since the baseline, and `bookings.status = 'disputed'` and
-- `payments.protection_state = 'disputed'` have been admitted since 0001 and 0017 respectively.
-- Only the two `bookings_status_transitions` rows are new, and they add no status name.
--
-- THERE IS NO MONEY HERE. No `refunds` column, no `payouts` column, no `payments` column. A
-- dispute holds a payout through spec 021's protection state (which spec 024 already refuses to
-- pay out from) and reaches a refund only through spec 022's `refunds/override` chain. The
-- `refund_admin_action_id` column below points at spec 009's approval record, NOT at a refund:
-- no `refunds` row exists at proposal time.
--
-- Precondition: the five tables receive NOT NULL columns without defaults, so they must be empty.
-- Nothing in lib/ or app/ has ever written to them. The DO block below refuses loudly rather than
-- silently defaulting if that assumption is ever wrong. NO BACKFILL: there is no existing data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "disputes")
     OR EXISTS (SELECT 1 FROM "dispute_evidence")
     OR EXISTS (SELECT 1 FROM "dispute_messages")
     OR EXISTS (SELECT 1 FROM "dispute_resolutions")
     OR EXISTS (SELECT 1 FROM "dispute_appeals") THEN
    RAISE EXCEPTION 'Refusing to apply 0028: a disputes* table is not empty, so the NOT NULL columns below cannot be added safely';
  END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- disputes — fill in the spec 003 skeleton
-- ---------------------------------------------------------------------------
ALTER TABLE "disputes" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "reason" text NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "claimed_by_admin_user_id" uuid;--> statement-breakpoint
-- Spec 033 advisory output (AC-6). NO decision path reads this column and it never reaches a
-- participant-facing DTO.
ALTER TABLE "disputes" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "legal_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- DECIDED-9: a ONE-WAY cross-reference to spec 030. Never read to change a dispute outcome.
ALTER TABLE "disputes" ADD COLUMN "escalated_safety_report_id" uuid;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint

-- `restrict` throughout (spec 003's baseline rule): a dispute's records must not be removable as a
-- side effect of deleting anything else. Spec 008's account deletion anonymizes the user row in
-- place instead, so a closed dispute stays auditable without retaining the person's identity.
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_claimed_by_admin_user_id_users_id_fk" FOREIGN KEY ("claimed_by_admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_escalated_safety_report_id_safety_reports_id_fk" FOREIGN KEY ("escalated_safety_report_id") REFERENCES "public"."safety_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "disputes" ADD CONSTRAINT "disputes_status_ck" CHECK ("disputes"."status" in ('open','under_review','resolved','appealed','closed'));--> statement-breakpoint
-- AC-7 in mechanical form: a closed dispute always carries its instant, and only a closed one does.
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_closed_pairing_ck" CHECK (("disputes"."status" = 'closed') = ("disputes"."closed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_reason_length_ck" CHECK (char_length("disputes"."reason") BETWEEN 10 AND 2000);--> statement-breakpoint

-- Spec 003 AC-4: every foreign-key column carries its own covering btree index
-- (`lib/db/schema-lint.test.ts` enforces it).
CREATE INDEX "disputes_claimed_by_admin_user_id_idx" ON "disputes" USING btree ("claimed_by_admin_user_id");--> statement-breakpoint
CREATE INDEX "disputes_escalated_safety_report_id_idx" ON "disputes" USING btree ("escalated_safety_report_id");--> statement-breakpoint
-- AC-1's duplicate guard, and the concurrency authority: two simultaneous opens produce exactly
-- one dispute. PARTIAL, so a closed dispute does not block a (hypothetical) later one — though
-- eligibility makes that unreachable anyway.
CREATE UNIQUE INDEX "disputes_booking_open_uq" ON "disputes" USING btree ("booking_id") WHERE "status" <> 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_opener_idempotency_uq" ON "disputes" USING btree ("opened_by_user_id","idempotency_key");--> statement-breakpoint
-- The admin queue's ordering: live disputes first, then FIFO among equals.
CREATE INDEX "disputes_status_created_idx" ON "disputes" USING btree ("status","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- dispute_evidence — the linkage only. Spec 027 owns every byte.
-- ---------------------------------------------------------------------------
ALTER TABLE "dispute_evidence" ADD COLUMN "file_asset_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_evidence" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_evidence" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_file_asset_id_file_assets_id_fk" FOREIGN KEY ("file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispute_evidence_file_asset_id_idx" ON "dispute_evidence" USING btree ("file_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_evidence_dispute_asset_uq" ON "dispute_evidence" USING btree ("dispute_id","file_asset_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- dispute_messages — append-only. No edit column, no soft-delete column.
-- ---------------------------------------------------------------------------
ALTER TABLE "dispute_messages" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_messages" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Spec 025's `applyContactPolicy` in FLAG mode: a dispute only exists post-`confirmed`, so contact
-- details are kept verbatim and flagged as a Trust & Safety signal, never masked. Redacting
-- evidence would be wrong.
ALTER TABLE "dispute_messages" ADD COLUMN "contact_flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_messages" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_messages" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
-- Reuses spec 025's `MESSAGE_BODY_MAX_LENGTH` value rather than inventing a second prose bound.
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_body_length_ck" CHECK (char_length("dispute_messages"."body") BETWEEN 1 AND 2000);--> statement-breakpoint
CREATE INDEX "dispute_messages_dispute_created_idx" ON "dispute_messages" USING btree ("dispute_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_messages_sender_idempotency_uq" ON "dispute_messages" USING btree ("sender_user_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- dispute_resolutions — a DECISION and a PROPOSAL. Never a refund.
-- ---------------------------------------------------------------------------
ALTER TABLE "dispute_resolutions" ADD COLUMN "decision" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD COLUMN "reasoning" text NOT NULL;--> statement-breakpoint
-- DECIDED-2: a `users.id`, not an `admin_profiles.id`. `resolvePermission()` and
-- `recordAdminAuditEvent()` both key on the user id, and so does the different-admin appeal rule.
ALTER TABLE "dispute_resolutions" ADD COLUMN "resolved_by_admin_user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD COLUMN "resolved_at" timestamp with time zone NOT NULL;--> statement-breakpoint
-- Spec 003's money convention: a semantic base name gets its own amount + currency pair, integer
-- minor units only. Never numeric/real (`npm run check:schema-money-lint`).
ALTER TABLE "dispute_resolutions" ADD COLUMN "proposed_refund_amount_minor_units" integer;--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD COLUMN "proposed_refund_currency_code" text;--> statement-breakpoint
-- Spec 009's `admin_actions.id` — the approval chain for the refund spec 022 MAY later create.
-- Deliberately NOT a `refunds.id`: no refund row exists until a second admin approves.
ALTER TABLE "dispute_resolutions" ADD COLUMN "refund_admin_action_id" uuid;--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint

ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_resolved_by_admin_user_id_users_id_fk" FOREIGN KEY ("resolved_by_admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_refund_admin_action_id_admin_actions_id_fk" FOREIGN KEY ("refund_admin_action_id") REFERENCES "public"."admin_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_decision_ck" CHECK ("dispute_resolutions"."decision" in ('no_action','refund_customer','partial_refund_customer','favour_provider','mutual_resolution'));--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_reasoning_length_ck" CHECK (char_length("dispute_resolutions"."reasoning") BETWEEN 10 AND 2000);--> statement-breakpoint
-- Spec 003 money pairing: both columns null together or set together, ISO-4217-shaped code.
ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_proposed_refund_pair_ck" CHECK (("dispute_resolutions"."proposed_refund_amount_minor_units" is null) = ("dispute_resolutions"."proposed_refund_currency_code" is null));--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_proposed_refund_currency_format_ck" CHECK ("dispute_resolutions"."proposed_refund_currency_code" is null or "dispute_resolutions"."proposed_refund_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_proposed_refund_positive_ck" CHECK ("dispute_resolutions"."proposed_refund_amount_minor_units" is null or "dispute_resolutions"."proposed_refund_amount_minor_units" > 0);--> statement-breakpoint
-- AC-5 in mechanical form: a resolution proposing money ALWAYS names an amount, and one that
-- decided against a refund can never carry a number nobody agreed to pay.
ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_refund_pairing_ck" CHECK (("dispute_resolutions"."proposed_refund_amount_minor_units" IS NOT NULL) = ("dispute_resolutions"."decision" in ('refund_customer','partial_refund_customer')));--> statement-breakpoint
ALTER TABLE "dispute_resolutions" ADD CONSTRAINT "dispute_resolutions_refund_link_ck" CHECK ("dispute_resolutions"."refund_admin_action_id" IS NULL OR "dispute_resolutions"."proposed_refund_amount_minor_units" IS NOT NULL);--> statement-breakpoint

-- AC-3's double-resolution guard, at the database rather than only in code. REPLACES the skeleton's
-- plain index and still covers the `dispute_id` foreign key (spec 003 AC-4).
DROP INDEX IF EXISTS "dispute_resolutions_dispute_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_resolutions_dispute_uq" ON "dispute_resolutions" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "dispute_resolutions_resolved_by_admin_user_id_idx" ON "dispute_resolutions" USING btree ("resolved_by_admin_user_id");--> statement-breakpoint
CREATE INDEX "dispute_resolutions_refund_admin_action_id_idx" ON "dispute_resolutions" USING btree ("refund_admin_action_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- dispute_appeals — exactly one per dispute, decided by a DIFFERENT admin.
-- ---------------------------------------------------------------------------
ALTER TABLE "dispute_appeals" ADD COLUMN "reason" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD COLUMN "reasoning" text;--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD COLUMN "reviewed_by_admin_user_id" uuid;--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint

ALTER TABLE "dispute_appeals" ADD CONSTRAINT "dispute_appeals_reviewed_by_admin_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_admin_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "dispute_appeals" ADD CONSTRAINT "dispute_appeals_outcome_ck" CHECK ("dispute_appeals"."outcome" IS NULL OR "dispute_appeals"."outcome" in ('upheld','overturned','partially_upheld'));--> statement-breakpoint
ALTER TABLE "dispute_appeals" ADD CONSTRAINT "dispute_appeals_reason_length_ck" CHECK (char_length("dispute_appeals"."reason") BETWEEN 10 AND 2000);--> statement-breakpoint
-- A decided appeal always names its reviewer, its reasoning and its instant — or is wholly undecided.
ALTER TABLE "dispute_appeals" ADD CONSTRAINT "dispute_appeals_decision_pairing_ck" CHECK (("dispute_appeals"."outcome" IS NULL) = ("dispute_appeals"."reasoning" IS NULL) AND ("dispute_appeals"."outcome" IS NULL) = ("dispute_appeals"."reviewed_by_admin_user_id" IS NULL) AND ("dispute_appeals"."outcome" IS NULL) = ("dispute_appeals"."decided_at" IS NULL));--> statement-breakpoint

-- AC-4's one-appeal rule, at the database. REPLACES the skeleton's plain index and still covers the
-- `dispute_id` foreign key (spec 003 AC-4).
DROP INDEX IF EXISTS "dispute_appeals_dispute_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_appeals_dispute_uq" ON "dispute_appeals" USING btree ("dispute_id");--> statement-breakpoint
CREATE INDEX "dispute_appeals_reviewed_by_admin_user_id_idx" ON "dispute_appeals" USING btree ("reviewed_by_admin_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispute_appeals_appellant_idempotency_uq" ON "dispute_appeals" USING btree ("appellant_user_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- bookings_status_transitions — the two pairs spec 020 reserved for this spec
-- ---------------------------------------------------------------------------
-- Spec 020's `state-machine.ts` header names them: "`-> disputed` (spec 031)". Neither adds a
-- status name — `disputed` has been in `bookings_status_ck` since the baseline. The database
-- trigger remains the independent second line of defence; `registerBookingTransitions()` in
-- `lib/disputes/index.ts` is only the friendly error.
INSERT INTO "bookings_status_transitions" ("from_status", "to_status") VALUES
  ('protected', 'disputed'),
  ('disputed', 'protected')
ON CONFLICT ("from_status", "to_status") DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permissions — EXACTLY THREE, and none of them moves money
-- ---------------------------------------------------------------------------
-- Master §69 assigns "Reports, DISPUTES, safety" to the Trust & Safety Admin and "Requests,
-- bookings, providers" to the Operations Admin, so T&S decides and Operations watches.
--
-- `finance_admin` is deliberately absent: Finance sees the refund request through spec 022's own
-- `refunds/read`, which already carries the amount, the reason and the approval chain, and does not
-- need the evidence or the parties' private messages to authorize money.
--
-- Every tier is low/medium (master §70's "authorized admin + reason/audit"), so this spec NEVER
-- calls `authorizeAndInitiate()`. The money a resolution may PROPOSE travels through spec 022's
-- `refunds/override` at tier `high`, which migration 0018 already seeded with second-admin
-- approval. Gating the same decision twice would buy nothing.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('disputes', 'read', 'low')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('operations_admin', 'trust_safety_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;--> statement-breakpoint

INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('disputes', 'resolve', 'medium'),
	('disputes', 'review_appeal', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('trust_safety_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
