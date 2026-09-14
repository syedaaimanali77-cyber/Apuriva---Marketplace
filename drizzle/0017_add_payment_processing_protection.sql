-- Spec 021 §4 "Migration".
--
-- `payments`, `payment_attempts`, `payment_authorizations`, `payments_status_history` and
-- `payments_status_transitions` are spec 003 BASELINE skeletons — this migration ALTERS them and
-- seeds the transition table. It creates exactly one new table, `price_adjustments`.
-- `0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.
--
-- Precondition, the same `DO $$` guard 0016 uses: nothing has ever written a payment (no code path
-- in lib/ or app/ inserted one before this spec), so NOT NULL columns without defaults can be added
-- directly. Fail loudly otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "payments")
     OR EXISTS (SELECT 1 FROM "payment_attempts")
     OR EXISTS (SELECT 1 FROM "payment_authorizations")
     OR EXISTS (SELECT 1 FROM "payments_status_history") THEN
    RAISE EXCEPTION '0017_add_payment_processing_protection requires empty payment tables';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "charge_amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "charge_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "protection_state" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "protection_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "protection_window_hours" integer DEFAULT 48 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "status" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "failure_reason" text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD COLUMN "attempted_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD COLUMN "authorized_amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD COLUMN "authorized_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD COLUMN "authorized_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD COLUMN "captured_amount_minor_units" integer;--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD COLUMN "captured_currency_code" text;--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD COLUMN "captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD COLUMN "provider_reference" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payments_status_history" ADD COLUMN "actor_role" text NOT NULL;--> statement-breakpoint
-- Spec 021 §4 — the only NEW table in this spec.
CREATE TABLE "price_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"booking_id" uuid NOT NULL,
	"payment_id" uuid,
	"additional_amount_minor_units" integer NOT NULL,
	"additional_currency_code" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"proposed_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"idempotency_fingerprint" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Spec 021 §4 I-1: ONE payment per booking, at the database. Replaces the baseline's non-unique
-- index — the structural anti-double-charge guarantee behind AC-7.
DROP INDEX IF EXISTS "payments_booking_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "payments_booking_id_uq" ON "payments" USING btree ("booking_id");--> statement-breakpoint
-- I-2: idempotency scoped per BOOKING, never globally (spec 015/018/020 precedent).
CREATE UNIQUE INDEX "payments_booking_idempotency_key_uq" ON "payments" USING btree ("booking_id","idempotency_key");--> statement-breakpoint
-- I-15: the access patterns the sweep and the read path actually use.
CREATE INDEX "payments_protection_sweep_idx" ON "payments" USING btree ("protection_state","protection_window_started_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_payment_attempted_at_idx" ON "payment_attempts" USING btree ("payment_id","attempted_at");--> statement-breakpoint
CREATE INDEX "price_adjustments_booking_id_idx" ON "price_adjustments" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "price_adjustments_payment_id_idx" ON "price_adjustments" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "price_adjustments_proposed_by_user_id_idx" ON "price_adjustments" USING btree ("proposed_by_user_id");--> statement-breakpoint
CREATE INDEX "price_adjustments_approved_by_user_id_idx" ON "price_adjustments" USING btree ("approved_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_adjustments_booking_idempotency_key_uq" ON "price_adjustments" USING btree ("booking_id","idempotency_key");--> statement-breakpoint
-- Spec 021 §4 — the WHOLE payment status vocabulary, authored once, here. Later specs add
-- transitions into payments_status_transitions; none of them adds a status name.
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_ck" CHECK ("payments"."status" in ('created','requires_action','authorized','captured','failed','refunded','partially_refunded'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_charge_pair_ck" CHECK (("payments"."charge_amount_minor_units" is null) = ("payments"."charge_currency_code" is null));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_charge_currency_format_ck" CHECK ("payments"."charge_currency_code" is null or "payments"."charge_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_charge_positive_ck" CHECK ("payments"."charge_amount_minor_units" > 0);--> statement-breakpoint
-- I-4: a protection state without a start instant is meaningless.
ALTER TABLE "payments" ADD CONSTRAINT "payments_protection_pairing_ck" CHECK (("payments"."protection_state" is null) = ("payments"."protection_window_started_at" is null));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_protection_state_ck" CHECK ("payments"."protection_state" is null or "payments"."protection_state" in ('held','released','disputed'));--> statement-breakpoint
-- I-5: nothing is protected that was never captured (AC-5).
ALTER TABLE "payments" ADD CONSTRAINT "payments_protection_requires_capture_ck" CHECK ("payments"."protection_state" is null or "payments"."status" in ('captured','refunded','partially_refunded'));--> statement-breakpoint
-- I-6: a configurable window, bounded.
ALTER TABLE "payments" ADD CONSTRAINT "payments_protection_window_hours_ck" CHECK ("payments"."protection_window_hours" between 1 and 720);--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_status_ck" CHECK ("payment_attempts"."status" in ('succeeded','failed','requires_action'));--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD CONSTRAINT "payment_authorizations_authorized_pair_ck" CHECK (("payment_authorizations"."authorized_amount_minor_units" is null) = ("payment_authorizations"."authorized_currency_code" is null));--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD CONSTRAINT "payment_authorizations_authorized_positive_ck" CHECK ("payment_authorizations"."authorized_amount_minor_units" > 0);--> statement-breakpoint
-- I-9: all three capture columns null, or all three set; and a capture never exceeds its authorization.
ALTER TABLE "payment_authorizations" ADD CONSTRAINT "payment_authorizations_captured_pair_ck" CHECK (("payment_authorizations"."captured_amount_minor_units" is null) = ("payment_authorizations"."captured_currency_code" is null) and ("payment_authorizations"."captured_amount_minor_units" is null) = ("payment_authorizations"."captured_at" is null));--> statement-breakpoint
ALTER TABLE "payment_authorizations" ADD CONSTRAINT "payment_authorizations_capture_not_over_ck" CHECK ("payment_authorizations"."captured_amount_minor_units" is null or "payment_authorizations"."captured_amount_minor_units" <= "payment_authorizations"."authorized_amount_minor_units");--> statement-breakpoint
-- I-7: a real user unless the actor is the system (this spec's sweep transitions).
ALTER TABLE "payments_status_history" ADD CONSTRAINT "payments_status_history_actor_role_ck" CHECK ("payments_status_history"."actor_role" in ('customer','provider','system','admin'));--> statement-breakpoint
ALTER TABLE "payments_status_history" ADD CONSTRAINT "payments_status_history_actor_pairing_ck" CHECK (("payments_status_history"."actor_user_id" is null) = ("payments_status_history"."actor_role" = 'system'));--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_status_ck" CHECK ("price_adjustments"."status" in ('pending_approval','approved','rejected','charged','failed'));--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_amount_pair_ck" CHECK (("price_adjustments"."additional_amount_minor_units" is null) = ("price_adjustments"."additional_currency_code" is null));--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_amount_positive_ck" CHECK ("price_adjustments"."additional_amount_minor_units" > 0);--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_currency_format_ck" CHECK ("price_adjustments"."additional_currency_code" is null or "price_adjustments"."additional_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- I-11: an approved or charged adjustment always has a named approver AND an instant (AC-4).
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_approval_pairing_ck" CHECK (("price_adjustments"."approved_by_user_id" is null) = ("price_adjustments"."approved_at" is null));--> statement-breakpoint
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_approved_requires_instant_ck" CHECK ("price_adjustments"."status" not in ('approved','charged') or "price_adjustments"."approved_at" is not null);--> statement-breakpoint
-- I-14: a charged adjustment always points at the payment that carried it.
ALTER TABLE "price_adjustments" ADD CONSTRAINT "price_adjustments_charged_requires_payment_ck" CHECK ("price_adjustments"."status" <> 'charged' or "price_adjustments"."payment_id" is not null);--> statement-breakpoint
-- Spec 021 §4 "Payment status machine": the transitions THIS spec performs, and only those. The
-- spec-003 payments_status_transition_trg rejects any status change absent from this table, so
-- nothing else is performable — in particular nothing into `refunded`/`partially_refunded`, which
-- spec 022 seeds in its own migration. Idempotent: re-running adds nothing.
INSERT INTO "payments_status_transitions" ("from_status", "to_status") VALUES
  ('created', 'requires_action'),
  ('created', 'authorized'),
  ('created', 'captured'),
  ('created', 'failed'),
  ('requires_action', 'authorized'),
  ('requires_action', 'captured'),
  ('requires_action', 'failed'),
  ('authorized', 'captured'),
  ('authorized', 'failed')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 020 §3 "Payment boundary" reserved exactly these three booking transitions for spec 021,
-- and spec 020's migration deliberately did not seed them. This spec is their only performer,
-- always with `actor_role = 'system'`.
INSERT INTO "bookings_status_transitions" ("from_status", "to_status") VALUES
  ('pending', 'failed'),
  ('completed', 'protected'),
  ('protected', 'settled')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 021 §4 I-8: `payment_attempts` is the record of what the provider actually said. It is the
-- evidence behind every AC-6 failure and every AC-1 success, so it is append-only — the same
-- guarantee spec 020 gave `bookings_status_history`.
CREATE OR REPLACE FUNCTION enforce_payment_attempts_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_attempts rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_attempts_append_only_trg
  BEFORE UPDATE OR DELETE ON "payment_attempts"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payment_attempts_append_only();
--> statement-breakpoint
-- Spec 021 §4 I-7: the payment status history is the attribution record behind every transition,
-- so it is append-only for the same reason.
CREATE OR REPLACE FUNCTION enforce_payments_status_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payments_status_history rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payments_status_history_append_only_trg
  BEFORE UPDATE OR DELETE ON "payments_status_history"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payments_status_history_append_only();
