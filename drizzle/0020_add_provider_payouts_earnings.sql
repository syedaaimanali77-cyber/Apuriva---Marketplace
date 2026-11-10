-- Spec 024 §4 "Migration".
--
-- `payouts`, `payout_methods`, `payouts_status_history` and `payouts_status_transitions` are spec 003
-- BASELINE skeletons, and `payouts_status_transition_trg` is already attached — this migration ALTERS
-- them, seeds the transition table, and creates three tables: `provider_earnings_lines`,
-- `earnings_adjustments` and `payout_items`. `0001_baseline_schema.sql` is immutable and untouched.
--
-- Precondition, the same `DO $$` guard shape 0016–0019 use: nothing has ever written a payout, so
-- NOT NULL columns without defaults can be added directly; and spec 022's `0018` reconciliation
-- columns must already exist, because this spec's only write into `refunds` depends on them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "payouts")
     OR EXISTS (SELECT 1 FROM "payout_methods")
     OR EXISTS (SELECT 1 FROM "payouts_status_history") THEN
    RAISE EXCEPTION '0020_add_provider_payouts_earnings requires empty payouts, payout_methods and payouts_status_history';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'refunds' AND column_name = 'reconciliation_state'
  ) THEN
    RAISE EXCEPTION '0020_add_provider_payouts_earnings requires 0018_add_refunds (refunds.reconciliation_state)';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "masked_detail" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "institution_label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "payout_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "destination_token_encrypted" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "provider_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "verification_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "payout_amount_minor_units" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "payout_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "payout_method_id" uuid;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "payout_reference" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "provider_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payouts_status_history" ADD COLUMN "actor_role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts_status_history" ADD COLUMN "detail" text;--> statement-breakpoint
CREATE TABLE "provider_earnings_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"gross_amount_minor_units" integer NOT NULL,
	"gross_currency_code" text NOT NULL,
	"platform_fee_bps" integer NOT NULL,
	"fee_amount_minor_units" integer NOT NULL,
	"fee_currency_code" text NOT NULL,
	"refunded_amount_minor_units" integer DEFAULT 0 NOT NULL,
	"refunded_currency_code" text NOT NULL,
	"fee_reversal_amount_minor_units" integer DEFAULT 0 NOT NULL,
	"fee_reversal_currency_code" text NOT NULL,
	"net_amount_minor_units" integer NOT NULL,
	"net_currency_code" text NOT NULL,
	"eligible_at" timestamp with time zone,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "earnings_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"adjustment_amount_minor_units" integer NOT NULL,
	"adjustment_currency_code" text NOT NULL,
	"reason" text NOT NULL,
	"admin_action_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"applied_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"idempotency_fingerprint" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payout_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"earnings_line_id" uuid,
	"adjustment_id" uuid,
	"source_refund_id" uuid,
	"item_amount_minor_units" integer NOT NULL,
	"item_currency_code" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payout_method_id_payout_methods_id_fk" FOREIGN KEY ("payout_method_id") REFERENCES "public"."payout_methods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings_adjustments" ADD CONSTRAINT "earnings_adjustments_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings_adjustments" ADD CONSTRAINT "earnings_adjustments_admin_action_id_admin_actions_id_fk" FOREIGN KEY ("admin_action_id") REFERENCES "public"."admin_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings_adjustments" ADD CONSTRAINT "earnings_adjustments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_earnings_line_id_provider_earnings_lines_id_fk" FOREIGN KEY ("earnings_line_id") REFERENCES "public"."provider_earnings_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_adjustment_id_earnings_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."earnings_adjustments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_source_refund_id_refunds_id_fk" FOREIGN KEY ("source_refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- I-22: a plain btree index on EVERY foreign-key column (spec 003's schema lint), plus the access
-- patterns the sweeps, the dashboard and the statement actually use.
CREATE INDEX "payouts_payout_method_id_idx" ON "payouts" USING btree ("payout_method_id");--> statement-breakpoint
CREATE INDEX "payouts_provider_status_idx" ON "payouts" USING btree ("provider_profile_id","status");--> statement-breakpoint
CREATE INDEX "payouts_status_updated_idx" ON "payouts" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "payout_methods_provider_removed_idx" ON "payout_methods" USING btree ("provider_profile_id","removed_at");--> statement-breakpoint
CREATE INDEX "provider_earnings_lines_provider_profile_id_idx" ON "provider_earnings_lines" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX "provider_earnings_lines_payment_id_idx" ON "provider_earnings_lines" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "provider_earnings_lines_service_id_idx" ON "provider_earnings_lines" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "provider_earnings_lines_provider_state_idx" ON "provider_earnings_lines" USING btree ("provider_profile_id","state");--> statement-breakpoint
CREATE INDEX "provider_earnings_lines_provider_created_idx" ON "provider_earnings_lines" USING btree ("provider_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "earnings_adjustments_provider_profile_id_idx" ON "earnings_adjustments" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX "earnings_adjustments_created_by_user_id_idx" ON "earnings_adjustments" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "earnings_adjustments_provider_created_idx" ON "earnings_adjustments" USING btree ("provider_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "payout_items_payout_id_idx" ON "payout_items" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "payout_items_earnings_line_id_idx" ON "payout_items" USING btree ("earnings_line_id");--> statement-breakpoint
CREATE INDEX "payout_items_adjustment_id_idx" ON "payout_items" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "payout_items_source_refund_id_idx" ON "payout_items" USING btree ("source_refund_id");--> statement-breakpoint
-- I-18: one open accruing batch per provider per currency.
CREATE UNIQUE INDEX "payouts_open_batch_uq" ON "payouts" USING btree ("provider_profile_id","payout_currency_code") WHERE status = 'pending';--> statement-breakpoint
-- I-16: exactly one live default per provider per currency (AC-11).
CREATE UNIQUE INDEX "payout_methods_default_uq" ON "payout_methods" USING btree ("provider_profile_id","payout_currency_code") WHERE is_default and removed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_methods_idempotency_uq" ON "payout_methods" USING btree ("provider_profile_id","idempotency_key");--> statement-breakpoint
-- I-21: one earnings line per booking.
CREATE UNIQUE INDEX "provider_earnings_lines_booking_id_uq" ON "provider_earnings_lines" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_adjustments_admin_action_uq" ON "earnings_adjustments" USING btree ("admin_action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_adjustments_idempotency_uq" ON "earnings_adjustments" USING btree ("provider_profile_id","idempotency_key");--> statement-breakpoint
-- I-10 (AC-2, AC-8): a line is paid at most once, an adjustment at most once, a refund recovered at most once.
CREATE UNIQUE INDEX "payout_items_earnings_line_uq" ON "payout_items" USING btree ("earnings_line_id") WHERE kind = 'earnings_line';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_items_adjustment_uq" ON "payout_items" USING btree ("adjustment_id") WHERE kind = 'adjustment';--> statement-breakpoint
CREATE UNIQUE INDEX "payout_items_source_refund_uq" ON "payout_items" USING btree ("source_refund_id") WHERE kind = 'refund_recovery';--> statement-breakpoint
-- I-1..I-3: the payout vocabulary and the evidence each state carries.
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_status_ck" CHECK ("payouts"."status" in ('pending','eligible','processing','paid','failed'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payout_pair_ck" CHECK (("payouts"."payout_amount_minor_units" is null) = ("payouts"."payout_currency_code" is null));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payout_currency_format_ck" CHECK ("payouts"."payout_currency_code" is null or "payouts"."payout_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_positive_when_closed_ck" CHECK ("payouts"."status" = 'pending' or "payouts"."payout_amount_minor_units" > 0);--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_closed_pairing_ck" CHECK (("payouts"."status" = 'pending') = ("payouts"."closed_at" is null));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_paid_pairing_ck" CHECK (("payouts"."status" = 'paid') = ("payouts"."paid_at" is not null));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_failure_pairing_ck" CHECK ("payouts"."failure_code" is null or "payouts"."status" in ('failed','eligible','processing'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_failure_code_ck" CHECK ("payouts"."failure_code" is null or "payouts"."failure_code" in ('destination_invalid','destination_unavailable','rail_temporarily_unavailable','transfer_rejected','transfer_not_received','unknown_failure'));--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_method_required_ck" CHECK ("payouts"."status" = 'pending' or "payouts"."payout_method_id" is not null);--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_attempts_ck" CHECK ("payouts"."attempt_count" >= 0 and ("payouts"."status" not in ('processing','paid','failed') or "payouts"."attempt_count" >= 1));--> statement-breakpoint
-- I-15 (AC-10): a "mask" that could hold a full account number is rejected at the database.
ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_type_ck" CHECK ("payout_methods"."type" in ('bank','mobile_wallet'));--> statement-breakpoint
ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_verification_state_ck" CHECK ("payout_methods"."verification_state" in ('pending','verified','rejected'));--> statement-breakpoint
ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_currency_format_ck" CHECK ("payout_methods"."payout_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_masked_detail_ck" CHECK ("payout_methods"."masked_detail" !~ '[0-9]([^0-9]*[0-9]){4}');--> statement-breakpoint
ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_revoked_requires_removed_ck" CHECK ("payout_methods"."revoked_at" is null or "payout_methods"."removed_at" is not null);--> statement-breakpoint
-- I-19: specs 020/021/022's attribution rule, applied to payouts.
ALTER TABLE "payouts_status_history" ADD CONSTRAINT "payouts_status_history_actor_role_ck" CHECK ("payouts_status_history"."actor_role" in ('admin','system'));--> statement-breakpoint
ALTER TABLE "payouts_status_history" ADD CONSTRAINT "payouts_status_history_actor_pairing_ck" CHECK (("payouts_status_history"."actor_user_id" is null) = ("payouts_status_history"."actor_role" = 'system'));--> statement-breakpoint
-- I-4..I-7 (AC-3): no negative or nonsensical ledger row, and the net identity at the database.
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_amounts_ck" CHECK ("provider_earnings_lines"."gross_amount_minor_units" > 0 and "provider_earnings_lines"."fee_amount_minor_units" >= 0 and "provider_earnings_lines"."refunded_amount_minor_units" >= 0
          and "provider_earnings_lines"."fee_reversal_amount_minor_units" >= 0 and "provider_earnings_lines"."net_amount_minor_units" >= 0
          and "provider_earnings_lines"."refunded_amount_minor_units" <= "provider_earnings_lines"."gross_amount_minor_units"
          and "provider_earnings_lines"."fee_amount_minor_units" <= "provider_earnings_lines"."gross_amount_minor_units"
          and "provider_earnings_lines"."fee_reversal_amount_minor_units" <= "provider_earnings_lines"."fee_amount_minor_units"
          and "provider_earnings_lines"."platform_fee_bps" between 0 and 10000);--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_net_identity_ck" CHECK ("provider_earnings_lines"."net_amount_minor_units" = "provider_earnings_lines"."gross_amount_minor_units" - "provider_earnings_lines"."refunded_amount_minor_units" - "provider_earnings_lines"."fee_amount_minor_units" + "provider_earnings_lines"."fee_reversal_amount_minor_units");--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_currency_uniform_ck" CHECK ("provider_earnings_lines"."gross_currency_code" ~ '^[A-Z]{3}$' and "provider_earnings_lines"."gross_currency_code" = "provider_earnings_lines"."fee_currency_code"
          and "provider_earnings_lines"."gross_currency_code" = "provider_earnings_lines"."refunded_currency_code" and "provider_earnings_lines"."gross_currency_code" = "provider_earnings_lines"."fee_reversal_currency_code"
          and "provider_earnings_lines"."gross_currency_code" = "provider_earnings_lines"."net_currency_code");--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_state_ck" CHECK ("provider_earnings_lines"."state" in ('pending','eligible','paid'));--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_eligible_pairing_ck" CHECK (("provider_earnings_lines"."state" = 'pending') = ("provider_earnings_lines"."eligible_at" is null));--> statement-breakpoint
ALTER TABLE "provider_earnings_lines" ADD CONSTRAINT "provider_earnings_lines_paid_pairing_ck" CHECK (("provider_earnings_lines"."state" = 'paid') = ("provider_earnings_lines"."paid_at" is not null));--> statement-breakpoint
-- I-11, I-12 (AC-9): approval-bound adjustments whose sign always matches their kind.
ALTER TABLE "earnings_adjustments" ADD CONSTRAINT "earnings_adjustments_kind_ck" CHECK ("earnings_adjustments"."kind" in ('credit','debit'));--> statement-breakpoint
ALTER TABLE "earnings_adjustments" ADD CONSTRAINT "earnings_adjustments_sign_ck" CHECK (("earnings_adjustments"."kind" = 'credit' and "earnings_adjustments"."adjustment_amount_minor_units" > 0) or ("earnings_adjustments"."kind" = 'debit' and "earnings_adjustments"."adjustment_amount_minor_units" < 0));--> statement-breakpoint
ALTER TABLE "earnings_adjustments" ADD CONSTRAINT "earnings_adjustments_currency_format_ck" CHECK ("earnings_adjustments"."adjustment_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- I-10: every item kind has exactly its own shape and sign.
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_kind_ck" CHECK ("payout_items"."kind" in ('earnings_line','adjustment','refund_recovery'));--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_shape_ck" CHECK (("payout_items"."kind" = 'earnings_line' and "payout_items"."earnings_line_id" is not null and "payout_items"."adjustment_id" is null and "payout_items"."source_refund_id" is null and "payout_items"."item_amount_minor_units" >= 0)
          or ("payout_items"."kind" = 'adjustment' and "payout_items"."adjustment_id" is not null and "payout_items"."earnings_line_id" is null and "payout_items"."source_refund_id" is null)
          or ("payout_items"."kind" = 'refund_recovery' and "payout_items"."earnings_line_id" is not null and "payout_items"."source_refund_id" is not null and "payout_items"."adjustment_id" is null and "payout_items"."item_amount_minor_units" < 0));--> statement-breakpoint
ALTER TABLE "payout_items" ADD CONSTRAINT "payout_items_currency_format_ck" CHECK ("payout_items"."item_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- Spec 024 §3.5: exactly these five transitions. Spec 003's `payouts_status_transition_trg` is ALREADY
-- attached and rejects every other pair. Idempotent: re-running adds nothing.
INSERT INTO "payouts_status_transitions" ("from_status", "to_status") VALUES
  ('pending', 'eligible'),
  ('eligible', 'processing'),
  ('processing', 'paid'),
  ('processing', 'failed'),
  ('failed', 'eligible')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 024 §3.14 — this spec's own Permission seed, for Finance and Super Admins only. Both
-- money-moving actions are `high`, so every retry and every adjustment needs a second admin.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('payouts', 'read', 'low'),
	('payouts', 'retry', 'high'),
	('payouts', 'adjust', 'high')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('finance_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
--> statement-breakpoint
-- I-20: the payout attribution record is append-only.
CREATE OR REPLACE FUNCTION enforce_payouts_status_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payouts_status_history rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payouts_status_history_append_only_trg
  BEFORE UPDATE OR DELETE ON "payouts_status_history"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payouts_status_history_append_only();
--> statement-breakpoint
-- I-8 (AC-14): an earnings line's core never changes, its net only falls, and it never moves backwards
-- except `eligible -> pending` while it holds no `earnings_line` item.
CREATE OR REPLACE FUNCTION enforce_provider_earnings_line_rules() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_earnings_lines rows are never deleted' USING ERRCODE = '23514';
  END IF;

  IF NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.provider_profile_id IS DISTINCT FROM OLD.provider_profile_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.gross_amount_minor_units IS DISTINCT FROM OLD.gross_amount_minor_units
     OR NEW.gross_currency_code IS DISTINCT FROM OLD.gross_currency_code
     OR NEW.platform_fee_bps IS DISTINCT FROM OLD.platform_fee_bps
     OR NEW.fee_amount_minor_units IS DISTINCT FROM OLD.fee_amount_minor_units THEN
    RAISE EXCEPTION 'Earnings line % has an immutable core', OLD.id USING ERRCODE = '23514';
  END IF;

  IF NEW.refunded_amount_minor_units < OLD.refunded_amount_minor_units
     OR NEW.net_amount_minor_units > OLD.net_amount_minor_units THEN
    RAISE EXCEPTION 'Earnings line % can only be reduced', OLD.id USING ERRCODE = '23514';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'pending' AND NEW.state = 'eligible')
      OR (OLD.state = 'eligible' AND NEW.state = 'paid')
      OR (OLD.state = 'eligible' AND NEW.state = 'pending'
          AND NOT EXISTS (SELECT 1 FROM "payout_items" WHERE earnings_line_id = OLD.id AND kind = 'earnings_line'))
    ) THEN
      RAISE EXCEPTION 'Invalid earnings line state change % -> %', OLD.state, NEW.state USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER provider_earnings_lines_immutable_core_trg
  BEFORE UPDATE OR DELETE ON "provider_earnings_lines"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_provider_earnings_line_rules();
--> statement-breakpoint
-- I-14 (AC-9): the approved figures are the applied figures. Only `applied_at` NULL -> value may change.
CREATE OR REPLACE FUNCTION enforce_earnings_adjustment_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'earnings_adjustments rows are never deleted' USING ERRCODE = '23514';
  END IF;

  IF NEW.provider_profile_id IS DISTINCT FROM OLD.provider_profile_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.adjustment_amount_minor_units IS DISTINCT FROM OLD.adjustment_amount_minor_units
     OR NEW.adjustment_currency_code IS DISTINCT FROM OLD.adjustment_currency_code
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.admin_action_id IS DISTINCT FROM OLD.admin_action_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.idempotency_fingerprint IS DISTINCT FROM OLD.idempotency_fingerprint
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at)
     OR (OLD.applied_at IS NULL AND NEW.applied_at IS NULL) THEN
    RAISE EXCEPTION 'Earnings adjustment % is immutable; only applied_at may be set once', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER earnings_adjustments_immutable_trg
  BEFORE UPDATE OR DELETE ON "earnings_adjustments"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_earnings_adjustment_immutable();
--> statement-breakpoint
-- I-25 (AC-8): a closed batch pays exactly what it held when it closed. Items are inserted only into
-- a `pending` payout, never updated, and deleted only as an earnings-line detach from a `pending` batch.
-- `FOR SHARE` serializes against a concurrent close holding the payout row `FOR UPDATE`.
CREATE OR REPLACE FUNCTION enforce_payout_items_frozen() RETURNS trigger AS $$
DECLARE
  parent_id uuid;
  parent_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'payout_items rows are never updated' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    parent_id := NEW.payout_id;
  ELSE
    parent_id := OLD.payout_id;
  END IF;

  SELECT status INTO parent_status FROM "payouts" WHERE id = parent_id FOR SHARE;

  IF parent_status IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'payout % is % and its items are frozen', parent_id, parent_status
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.kind <> 'earnings_line' THEN
      RAISE EXCEPTION 'only an earnings_line item may be detached' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payout_items_frozen_trg
  BEFORE INSERT OR UPDATE OR DELETE ON "payout_items"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payout_items_frozen();
--> statement-breakpoint
-- I-9: an item's currency is its payout's currency.
CREATE OR REPLACE FUNCTION enforce_payout_item_currency() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "payouts" WHERE id = NEW.payout_id AND payout_currency_code = NEW.item_currency_code
  ) THEN
    RAISE EXCEPTION 'payout item currency % does not match its payout', NEW.item_currency_code USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payout_items_currency_matches_payout_trg
  BEFORE INSERT ON "payout_items"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payout_item_currency();
--> statement-breakpoint
-- I-13: an unapproved (unapplied) adjustment can never reach a batch, whatever the application does.
CREATE OR REPLACE FUNCTION enforce_payout_item_adjustment_applied() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'adjustment' AND NOT EXISTS (
    SELECT 1 FROM "earnings_adjustments" WHERE id = NEW.adjustment_id AND applied_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'an unapplied adjustment cannot be attached to a payout' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payout_items_adjustment_applied_trg
  BEFORE INSERT ON "payout_items"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payout_item_adjustment_applied();
