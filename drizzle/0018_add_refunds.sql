-- Spec 022 §4 "Migration".
--
-- `refunds` and `refund_lines` are spec 003 BASELINE skeletons — this migration ALTERS them, adds
-- two small state-machine tables, and seeds the transition rows specs 020 and 021 reserved for this
-- spec. `0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.
--
-- Precondition, the same `DO $$` guard 0016 and 0017 use: nothing has ever written a refund, so
-- NOT NULL columns without defaults can be added directly. Fail loudly otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "refunds") OR EXISTS (SELECT 1 FROM "refund_lines") THEN
    RAISE EXCEPTION '0018_add_refunds requires empty refunds and refund_lines';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "booking_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "status" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "total_amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "total_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "is_override" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "initiated_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "admin_action_id" uuid;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "eligibility_decision_ref" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "refund_reference" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reconciliation_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD COLUMN "line_amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD COLUMN "line_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD COLUMN "reason" text NOT NULL;--> statement-breakpoint
CREATE TABLE "refunds_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"refund_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds_status_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_admin_action_id_admin_actions_id_fk" FOREIGN KEY ("admin_action_id") REFERENCES "public"."admin_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds_status_history" ADD CONSTRAINT "refunds_status_history_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds_status_history" ADD CONSTRAINT "refunds_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_booking_id_idx" ON "refunds" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "refunds_status_idx" ON "refunds" USING btree ("status");--> statement-breakpoint
CREATE INDEX "refunds_initiated_by_user_id_idx" ON "refunds" USING btree ("initiated_by_user_id");--> statement-breakpoint
CREATE INDEX "refunds_admin_action_id_idx" ON "refunds" USING btree ("admin_action_id");--> statement-breakpoint
-- C-12: the index spec 024's reconciliation consumer reads.
CREATE INDEX "refunds_reconciliation_idx" ON "refunds" USING btree ("reconciliation_state","completed_at");--> statement-breakpoint
-- C-1 / AC-8: one refund per idempotency key, scoped per PAYMENT, never globally.
CREATE UNIQUE INDEX "refunds_payment_idempotency_key_uq" ON "refunds" USING btree ("payment_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "refunds_status_history_refund_id_idx" ON "refunds_status_history" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "refunds_status_history_actor_user_id_idx" ON "refunds_status_history" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_status_transitions_from_to_uq" ON "refunds_status_transitions" USING btree ("from_status","to_status");--> statement-breakpoint
-- Spec 022 §4 — the WHOLE refund status vocabulary, authored once, here.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_ck" CHECK ("refunds"."status" in ('requested','processing','completed','failed'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_source_ck" CHECK ("refunds"."source" in ('policy','admin_override'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reconciliation_state_ck" CHECK ("refunds"."reconciliation_state" in ('pending','reconciled'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_total_pair_ck" CHECK (("refunds"."total_amount_minor_units" is null) = ("refunds"."total_currency_code" is null));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_total_currency_format_ck" CHECK ("refunds"."total_currency_code" is null or "refunds"."total_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- I-3 / I-4: no zero-value refund, no negative refund.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_total_positive_ck" CHECK ("refunds"."total_amount_minor_units" > 0);--> statement-breakpoint
-- C-5: an override is always traceable to its spec 009 approval chain.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_override_pairing_ck" CHECK (("refunds"."is_override" = true) = ("refunds"."admin_action_id" is not null) and ("refunds"."is_override" = true) = ("refunds"."source" = 'admin_override'));--> statement-breakpoint
-- C-6: a completed refund always has its completion instant.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_completed_pairing_ck" CHECK (("refunds"."status" = 'completed') = ("refunds"."completed_at" is not null));--> statement-breakpoint
-- C-7: nothing unreconcilable is marked reconciled (spec 024's only write into this table).
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reconciled_pairing_ck" CHECK (("refunds"."reconciliation_state" = 'reconciled') = ("refunds"."reconciled_at" is not null) and ("refunds"."reconciliation_state" <> 'reconciled' or "refunds"."status" = 'completed'));--> statement-breakpoint
-- C-8: failure detail only on failures.
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_failure_pairing_ck" CHECK ("refunds"."failure_code" is null or "refunds"."status" = 'failed');--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_amount_pair_ck" CHECK (("refund_lines"."line_amount_minor_units" is null) = ("refund_lines"."line_currency_code" is null));--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_amount_positive_ck" CHECK ("refund_lines"."line_amount_minor_units" > 0);--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_currency_format_ck" CHECK ("refund_lines"."line_currency_code" is null or "refund_lines"."line_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "refunds_status_history" ADD CONSTRAINT "refunds_status_history_actor_role_ck" CHECK ("refunds_status_history"."actor_role" in ('customer','provider','admin','system'));--> statement-breakpoint
-- C-9: a real user unless the actor is the system (the reconcile sweep).
ALTER TABLE "refunds_status_history" ADD CONSTRAINT "refunds_status_history_actor_pairing_ck" CHECK (("refunds_status_history"."actor_user_id" is null) = ("refunds_status_history"."actor_role" = 'system'));--> statement-breakpoint
-- Spec 022 §4 "Refund status machine": the transitions THIS spec performs, and only those.
-- `requested -> failed` is deliberately absent (nothing fails before the provider is asked), and so
-- is `failed -> processing` (AC-6's retry is a NEW refund row). Idempotent: re-running adds nothing.
INSERT INTO "refunds_status_transitions" ("from_status", "to_status") VALUES
  ('requested', 'processing'),
  ('processing', 'completed'),
  ('processing', 'failed')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Attach spec 003's EXISTING generic trigger function. It derives `refunds_status_transitions`
-- from TG_TABLE_NAME, so creating the table above is all that was needed — no new function.
CREATE TRIGGER refunds_status_transition_trg
  BEFORE UPDATE ON "refunds"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition();
--> statement-breakpoint
-- Spec 021 §4 reserved exactly these three payment transitions for spec 022.
INSERT INTO "payments_status_transitions" ("from_status", "to_status") VALUES
  ('captured', 'refunded'),
  ('captured', 'partially_refunded'),
  ('partially_refunded', 'refunded')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 020 §4 reserved every booking transition into `refunded` for spec 022. Only a FULLY
-- completed refund performs one; a partial refund leaves `bookings.status` untouched.
INSERT INTO "bookings_status_transitions" ("from_status", "to_status") VALUES
  ('completed', 'refunded'),
  ('protected', 'refunded'),
  ('settled', 'refunded'),
  ('cancelled', 'refunded')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 022 §3 "Admin override" — this spec's own Permission seed. Risk tier is carried by the
-- ACTION, not by an amount: `override` is `high`, so EVERY manual refund routes through spec 009's
-- second-admin approval flow and no numeric threshold has to be invented (master spec §70).
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('refunds', 'read', 'low'),
	('refunds', 'override', 'high')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('finance_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
--> statement-breakpoint
-- Spec 022 §4 C-10: refund lines are the immutable explanation of a refund's amount (AC-2).
CREATE OR REPLACE FUNCTION enforce_refund_lines_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'refund_lines rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER refund_lines_append_only_trg
  BEFORE UPDATE OR DELETE ON "refund_lines"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_refund_lines_append_only();
--> statement-breakpoint
-- C-10: the attribution record behind every refund transition is append-only for the same reason.
CREATE OR REPLACE FUNCTION enforce_refunds_status_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'refunds_status_history rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER refunds_status_history_append_only_trg
  BEFORE UPDATE OR DELETE ON "refunds_status_history"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_refunds_status_history_append_only();
--> statement-breakpoint
-- Spec 022 §4 C-11 / I-8: a COMPLETED refund is immutable. The money is back; the record of how
-- much, to whom and why can never be rewritten. The single exception is spec 024's reconciliation
-- write, because that records a downstream fact about an unchanged refund rather than altering it.
CREATE OR REPLACE FUNCTION enforce_refund_completed_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.total_amount_minor_units IS DISTINCT FROM OLD.total_amount_minor_units
       OR NEW.total_currency_code IS DISTINCT FROM OLD.total_currency_code
       OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
       OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
       OR NEW.source IS DISTINCT FROM OLD.source
       OR NEW.is_override IS DISTINCT FROM OLD.is_override
       OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id
       OR NEW.admin_action_id IS DISTINCT FROM OLD.admin_action_id
       OR NEW.eligibility_decision_ref IS DISTINCT FROM OLD.eligibility_decision_ref
       OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
       OR NEW.refund_reference IS DISTINCT FROM OLD.refund_reference
       OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
       OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.idempotency_fingerprint IS DISTINCT FROM OLD.idempotency_fingerprint
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'Refund % is completed and immutable; only reconciliation may be recorded', OLD.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER refunds_completed_immutable_trg
  BEFORE UPDATE ON "refunds"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_refund_completed_immutable();
