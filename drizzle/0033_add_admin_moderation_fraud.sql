-- Spec 038 §4 "Migration" — docs/specs/2026-08-28-038-admin-moderation-fraud-abuse.md.
--
-- Number: `_journal.json`'s head was `0032_extend_ai_tool_calls`, so this is 0033.
--
-- Creates the three spec 038 tables (`fraud_signals`, `moderation_actions`, `moderation_appeals`),
-- widens spec 027's closed file-context vocabulary by exactly ONE value (`moderation_evidence`), and
-- seeds spec 038's `permissions` rows. It rewrites NO lifecycle value and needs NO backfill: nothing
-- in the repository has ever written `restricted`/`suspended`/`banned`.
--
-- NOT DONE HERE, deliberately (§3.16, OQ-4): no foreign key is added to spec 030's
-- `safety_reports.restriction_moderation_action_id`. Integrity is held on this side by
-- `moderation_actions.origin_safety_report_id` plus a one-restriction-per-report unique index.
--
-- There is no money column and no jsonb column.

-- ---------------------------------------------------------------------------
-- fraud_signals — review items only; a signal enforces nothing (AC-3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "fraud_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"target_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"rule_key" text NOT NULL,
	"observed_count" integer NOT NULL,
	"threshold" integer NOT NULL,
	"window_days" integer NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"triaged_by_admin_id" uuid,
	"triage_reason" text,
	"triaged_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_triaged_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("triaged_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_source_ck" CHECK ("fraud_signals"."source" in ('rule_based','ai_assisted'));--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_status_ck" CHECK ("fraud_signals"."status" in ('pending_review','escalated','dismissed','actioned'));--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_rule_key_length_ck" CHECK (char_length("fraud_signals"."rule_key") between 1 and 64);--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_counts_ck" CHECK ("fraud_signals"."observed_count" > 0 and "fraud_signals"."threshold" > 0 and "fraud_signals"."window_days" > 0);--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_triage_reason_length_ck" CHECK ("fraud_signals"."triage_reason" is null or char_length("fraud_signals"."triage_reason") <= 500);--> statement-breakpoint
ALTER TABLE "fraud_signals" ADD CONSTRAINT "fraud_signals_triage_pairing_ck" CHECK ("fraud_signals"."status" = 'pending_review' or ("fraud_signals"."triaged_by_admin_id" is not null and "fraud_signals"."triaged_at" is not null));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fraud_signals_target_user_id_idx" ON "fraud_signals" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fraud_signals_triaged_by_admin_id_idx" ON "fraud_signals" USING btree ("triaged_by_admin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fraud_signals_status_created_idx" ON "fraud_signals" USING btree ("status","created_at");--> statement-breakpoint
-- §3.6 dedupe: at most one OPEN signal per (rule, target).
CREATE UNIQUE INDEX IF NOT EXISTS "fraud_signals_open_rule_target_uq" ON "fraud_signals" USING btree ("rule_key","target_user_id") WHERE "fraud_signals"."status" in ('pending_review','escalated');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- moderation_actions — the durable moderation record (spec 009's admin_actions is only approval)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"action_type" text NOT NULL,
	"scope" text NOT NULL,
	"target_user_id" uuid NOT NULL,
	"provider_profile_id" uuid,
	"booking_id" uuid,
	"refund_treatment" text,
	"risk_tier" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"user_message" text,
	"initiated_by_admin_id" uuid NOT NULL,
	"admin_action_id" uuid,
	"reversal_admin_action_id" uuid,
	"previous_user_standing" text,
	"previous_provider_lifecycle_status" text,
	"superseded_by_moderation_action_id" uuid,
	"origin_safety_report_id" uuid,
	"origin_fraud_signal_id" uuid,
	"activated_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"reversed_by_admin_id" uuid,
	"reversal_reason" text,
	"idempotency_key" text,
	"idempotency_fingerprint" text
);--> statement-breakpoint

ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- AC-3 in mechanical form: every action names a human initiator.
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_initiated_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("initiated_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_admin_action_id_admin_actions_id_fk" FOREIGN KEY ("admin_action_id") REFERENCES "public"."admin_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_reversal_admin_action_id_admin_actions_id_fk" FOREIGN KEY ("reversal_admin_action_id") REFERENCES "public"."admin_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_superseded_by_moderation_action_id_moderation_actions_id_fk" FOREIGN KEY ("superseded_by_moderation_action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_origin_safety_report_id_safety_reports_id_fk" FOREIGN KEY ("origin_safety_report_id") REFERENCES "public"."safety_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_origin_fraud_signal_id_fraud_signals_id_fk" FOREIGN KEY ("origin_fraud_signal_id") REFERENCES "public"."fraud_signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_reversed_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("reversed_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_action_type_ck" CHECK ("moderation_actions"."action_type" in ('warning','restriction','suspension','ban','booking_intervention','payout_freeze'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_scope_ck" CHECK ("moderation_actions"."scope" in ('account','provider_profile','booking'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_risk_tier_ck" CHECK ("moderation_actions"."risk_tier" in ('low','medium','high','critical'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_status_ck" CHECK ("moderation_actions"."status" in ('pending_approval','active','executed','superseded','reversed','rejected'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_refund_treatment_ck" CHECK ("moderation_actions"."refund_treatment" is null or "moderation_actions"."refund_treatment" in ('policy','full'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_previous_user_standing_ck" CHECK ("moderation_actions"."previous_user_standing" is null or "moderation_actions"."previous_user_standing" in ('good','restricted','suspended','banned'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_previous_provider_status_ck" CHECK ("moderation_actions"."previous_provider_lifecycle_status" is null or "moderation_actions"."previous_provider_lifecycle_status" in ('draft','pending_verification','active','paused','restricted','suspended','banned'));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_reason_length_ck" CHECK (char_length("moderation_actions"."reason") between 1 and 500);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_user_message_length_ck" CHECK ("moderation_actions"."user_message" is null or char_length("moderation_actions"."user_message") <= 500);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_reversal_reason_length_ck" CHECK ("moderation_actions"."reversal_reason" is null or char_length("moderation_actions"."reversal_reason") <= 500);--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_scope_target_ck" CHECK ((("moderation_actions"."scope" = 'booking') = ("moderation_actions"."booking_id" is not null)) and (("moderation_actions"."scope" = 'booking') = ("moderation_actions"."action_type" = 'booking_intervention')) and ("moderation_actions"."scope" <> 'provider_profile' or "moderation_actions"."provider_profile_id" is not null) and ("moderation_actions"."action_type" <> 'payout_freeze' or "moderation_actions"."scope" = 'provider_profile') and (("moderation_actions"."refund_treatment" is not null) = ("moderation_actions"."action_type" = 'booking_intervention')));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_active_pairing_ck" CHECK (("moderation_actions"."status" in ('active','executed','superseded','reversed')) = ("moderation_actions"."activated_at" is not null));--> statement-breakpoint
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_reversal_pairing_ck" CHECK (("moderation_actions"."status" = 'reversed') = ("moderation_actions"."reversed_at" is not null and "moderation_actions"."reversed_by_admin_id" is not null and "moderation_actions"."reversal_reason" is not null));--> statement-breakpoint
-- AC-2 in mechanical form: a high/critical action always carries its spec 009 approval record.
ALTER TABLE "moderation_actions" ADD CONSTRAINT "moderation_actions_approval_pairing_ck" CHECK (("moderation_actions"."risk_tier" in ('high','critical')) = ("moderation_actions"."admin_action_id" is not null));--> statement-breakpoint

-- Spec 003 AC-4: every foreign-key column carries its own covering btree index.
CREATE INDEX IF NOT EXISTS "moderation_actions_target_user_id_idx" ON "moderation_actions" USING btree ("target_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_provider_profile_id_idx" ON "moderation_actions" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_booking_id_idx" ON "moderation_actions" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_initiated_by_admin_id_idx" ON "moderation_actions" USING btree ("initiated_by_admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_actions_admin_action_id_uq" ON "moderation_actions" USING btree ("admin_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_actions_reversal_admin_action_id_uq" ON "moderation_actions" USING btree ("reversal_admin_action_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_superseded_by_idx" ON "moderation_actions" USING btree ("superseded_by_moderation_action_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_origin_safety_report_id_idx" ON "moderation_actions" USING btree ("origin_safety_report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_origin_fraud_signal_id_idx" ON "moderation_actions" USING btree ("origin_fraud_signal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_reversed_by_admin_id_idx" ON "moderation_actions" USING btree ("reversed_by_admin_id");--> statement-breakpoint
-- §3.7: one open freeze per provider profile.
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_actions_active_freeze_uq" ON "moderation_actions" USING btree ("provider_profile_id") WHERE "moderation_actions"."action_type" = 'payout_freeze' and "moderation_actions"."status" in ('pending_approval','active');--> statement-breakpoint
-- AC-6: one open intervention per booking.
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_actions_open_intervention_uq" ON "moderation_actions" USING btree ("booking_id") WHERE "moderation_actions"."action_type" = 'booking_intervention' and "moderation_actions"."status" in ('pending_approval','executed');--> statement-breakpoint
-- §3.16 / OQ-4: one restriction per safety report — the integrity spec 030's cross-reference relies on.
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_actions_origin_safety_restriction_uq" ON "moderation_actions" USING btree ("origin_safety_report_id") WHERE "moderation_actions"."action_type" = 'restriction';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_actions_admin_idempotency_uq" ON "moderation_actions" USING btree ("initiated_by_admin_id","idempotency_key") WHERE "moderation_actions"."idempotency_key" is not null;--> statement-breakpoint
-- `getAccountStanding` for a `deletion_pending` account.
CREATE INDEX IF NOT EXISTS "moderation_actions_active_account_idx" ON "moderation_actions" USING btree ("target_user_id") WHERE "moderation_actions"."scope" = 'account' and "moderation_actions"."status" = 'active';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- moderation_appeals — one per action, decided by a different admin (AC-5)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "moderation_appeals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"moderation_action_id" uuid NOT NULL,
	"appellant_user_id" uuid NOT NULL,
	"statement" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_admin_id" uuid,
	"decision_reason" text,
	"decided_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"idempotency_fingerprint" text NOT NULL
);--> statement-breakpoint

ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_moderation_action_id_moderation_actions_id_fk" FOREIGN KEY ("moderation_action_id") REFERENCES "public"."moderation_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_appellant_user_id_users_id_fk" FOREIGN KEY ("appellant_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_decided_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("decided_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_status_ck" CHECK ("moderation_appeals"."status" in ('pending','upheld','denied'));--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_statement_length_ck" CHECK (char_length("moderation_appeals"."statement") between 1 and 2000);--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_decision_reason_length_ck" CHECK ("moderation_appeals"."decision_reason" is null or char_length("moderation_appeals"."decision_reason") <= 500);--> statement-breakpoint
ALTER TABLE "moderation_appeals" ADD CONSTRAINT "moderation_appeals_decision_pairing_ck" CHECK (("moderation_appeals"."status" <> 'pending') = ("moderation_appeals"."decided_by_admin_id" is not null and "moderation_appeals"."decision_reason" is not null and "moderation_appeals"."decided_at" is not null));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_appeals_moderation_action_id_uq" ON "moderation_appeals" USING btree ("moderation_action_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_appeals_appellant_user_id_idx" ON "moderation_appeals" USING btree ("appellant_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_appeals_decided_by_admin_id_idx" ON "moderation_appeals" USING btree ("decided_by_admin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_appeals_status_created_idx" ON "moderation_appeals" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_appeals_appellant_idempotency_uq" ON "moderation_appeals" USING btree ("appellant_user_id","idempotency_key");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- file_assets — exactly ONE new context value (§3.8), the 0029 idiom
-- ---------------------------------------------------------------------------
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document','review_media','safety_evidence','support_attachment','moderation_evidence')) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_assets" VALIDATE CONSTRAINT "file_assets_context_type_ck";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permissions — §3.9, seven existing roles only; tiers per master §70
-- ---------------------------------------------------------------------------
-- Reading moderation: Trust & Safety decides, Operations ("providers, bookings") watches.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('moderation', 'read', 'low')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('trust_safety_admin', 'operations_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;--> statement-breakpoint

-- Account/profile sanctions, reversal and appeals: Trust & Safety and Super Admin only.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('moderation', 'warn', 'medium'),
	('moderation', 'restrict', 'medium'),
	('moderation', 'suspend', 'high'),
	('moderation', 'ban', 'critical'),
	('moderation', 'reverse', 'high'),
	('moderation', 'review_appeal', 'medium'),
	('fraud_signals', 'read', 'low'),
	('fraud_signals', 'triage', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('trust_safety_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;--> statement-breakpoint

-- Booking intervention: Operations owns "bookings" (master §69).
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('moderation', 'intervene_booking', 'high')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('trust_safety_admin', 'operations_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;--> statement-breakpoint

-- Payout freeze: a payout intervention (master §70), so Finance may initiate and approve it.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('moderation', 'freeze_payout', 'high')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('trust_safety_admin', 'finance_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
