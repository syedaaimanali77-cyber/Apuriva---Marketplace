-- Spec 023 §4 "Migration".
--
-- `policies`, `policy_versions` and `policy_acceptances` are spec 003 BASELINE skeletons — this
-- migration ALTERS them, adds the no-show and cancellation tables, seeds the platform-default
-- cancellation policy, and seeds the three `-> cancelled` booking transitions spec 020 reserved for
-- this spec. `0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not
-- touched.
--
-- Precondition, the same `DO $$` guard 0016/0017/0018 use: nothing has ever written a policy row, so
-- NOT NULL columns without defaults can be added directly and the baseline index swap below is safe.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "policies")
     OR EXISTS (SELECT 1 FROM "policy_versions")
     OR EXISTS (SELECT 1 FROM "policy_acceptances") THEN
    RAISE EXCEPTION '0019_add_cancellation_policy_no_show requires empty policy tables';
  END IF;
END $$;
--> statement-breakpoint
-- Spec 023 §4 C-3: `policy_versions_no_overlap_ex` is a GiST exclusion constraint over
-- (policy_id, validity range). btree_gist supplies the `=` operator class for the uuid column.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "scope" text NOT NULL;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "policies" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD COLUMN "config" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD COLUMN "effective_from" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD COLUMN "effective_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD COLUMN "created_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "booking_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "accepted_config" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "provider_option_key" text;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "booking_created_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD COLUMN "accepted_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_services" ADD COLUMN "cancellation_policy_option" text;--> statement-breakpoint
CREATE TABLE "no_show_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"booking_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reporter_role" text NOT NULL,
	"status" text NOT NULL,
	"reporter_statement" text,
	"evidence" jsonb NOT NULL,
	"location_signal" text NOT NULL,
	"respond_by_at" timestamp with time zone NOT NULL,
	"response_status" text DEFAULT 'pending' NOT NULL,
	"response_statement" text,
	"response_filed_at" timestamp with time zone,
	"outcome" text,
	"resolution_reason" text,
	"resolved_by_admin_id" uuid,
	"resolved_at" timestamp with time zone,
	"counterpart_report_id" uuid,
	"escalated" boolean DEFAULT false NOT NULL,
	"idempotency_key" text NOT NULL,
	"idempotency_fingerprint" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "no_show_reports_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"no_show_report_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "no_show_reports_status_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"booking_id" uuid NOT NULL,
	"policy_version_id" uuid NOT NULL,
	"cancelled_by_user_id" uuid NOT NULL,
	"cancelled_by_role" text NOT NULL,
	"reason_code" text,
	"note" text,
	"tier_min_hours_before" integer,
	"tier_max_hours_before" integer,
	"tier_fee_percent" integer NOT NULL,
	"hours_before_milli" integer NOT NULL,
	"captured_amount_minor_units" integer NOT NULL,
	"captured_currency_code" text NOT NULL,
	"fee_amount_minor_units" integer NOT NULL,
	"refund_amount_minor_units" integer NOT NULL,
	"decision_ref" text NOT NULL,
	"no_show_report_id" uuid,
	"idempotency_key" text NOT NULL,
	"idempotency_fingerprint" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_created_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD CONSTRAINT "policy_acceptances_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_resolved_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("resolved_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_counterpart_report_id_no_show_reports_id_fk" FOREIGN KEY ("counterpart_report_id") REFERENCES "public"."no_show_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_show_reports_status_history" ADD CONSTRAINT "no_show_reports_status_history_report_id_fk" FOREIGN KEY ("no_show_report_id") REFERENCES "public"."no_show_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_show_reports_status_history" ADD CONSTRAINT "no_show_reports_status_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_policy_version_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_no_show_report_id_fk" FOREIGN KEY ("no_show_report_id") REFERENCES "public"."no_show_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Spec 023 §4: the baseline `policy_acceptances_policy_version_user_uq` is at the WRONG GRAIN — it
-- would let a customer accept a given policy version for exactly ONE booking, so their second
-- booking under an unchanged policy would fail. The correct grain is one acceptance per booking.
DROP INDEX IF EXISTS "policy_acceptances_policy_version_user_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "policy_acceptances_booking_uq" ON "policy_acceptances" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "policies_scope_idx" ON "policies" USING btree ("type","scope","scope_id");--> statement-breakpoint
-- C-2: at most one ACTIVE policy per scope, so resolution can never face a tie. Two partial unique
-- indexes because `scope_id` is null exactly for the platform scope, and NULLs do not compare equal.
CREATE UNIQUE INDEX "policies_active_scope_uq" ON "policies" USING btree ("type","scope","scope_id") WHERE "is_active" AND "scope_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "policies_active_platform_uq" ON "policies" USING btree ("type") WHERE "is_active" AND "scope_id" IS NULL;--> statement-breakpoint
CREATE INDEX "policy_versions_policy_effective_idx" ON "policy_versions" USING btree ("policy_id","effective_from" DESC);--> statement-breakpoint
CREATE INDEX "policy_versions_created_by_admin_id_idx" ON "policy_versions" USING btree ("created_by_admin_id");--> statement-breakpoint
CREATE INDEX "policy_acceptances_booking_idx" ON "policy_acceptances" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "no_show_reports_booking_id_idx" ON "no_show_reports" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "no_show_reports_reporter_user_id_idx" ON "no_show_reports" USING btree ("reporter_user_id");--> statement-breakpoint
CREATE INDEX "no_show_reports_resolved_by_admin_id_idx" ON "no_show_reports" USING btree ("resolved_by_admin_id");--> statement-breakpoint
CREATE INDEX "no_show_reports_counterpart_report_id_idx" ON "no_show_reports" USING btree ("counterpart_report_id");--> statement-breakpoint
CREATE INDEX "no_show_reports_status_idx" ON "no_show_reports" USING btree ("status");--> statement-breakpoint
-- The response-timeout sweep's access path.
CREATE INDEX "no_show_reports_respond_by_idx" ON "no_show_reports" USING btree ("status","respond_by_at");--> statement-breakpoint
-- AC-6's read path: the verified-no-show fact spec 017 consumes.
CREATE INDEX "no_show_reports_outcome_idx" ON "no_show_reports" USING btree ("outcome","resolved_at");--> statement-breakpoint
-- C-14: one report per party per booking. C-15: idempotency scoped per booking, never globally.
CREATE UNIQUE INDEX "no_show_reports_booking_reporter_uq" ON "no_show_reports" USING btree ("booking_id","reporter_role");--> statement-breakpoint
CREATE UNIQUE INDEX "no_show_reports_idempotency_uq" ON "no_show_reports" USING btree ("booking_id","idempotency_key");--> statement-breakpoint
-- C-16 / AC-6 "exactly once": at most ONE fault-bearing resolution per booking, so two mutual
-- reports can never double-count and a duplicate can never inflate a reliability count.
CREATE UNIQUE INDEX "no_show_reports_booking_fault_uq" ON "no_show_reports" USING btree ("booking_id") WHERE "outcome" IN ('no_show_confirmed_customer','no_show_confirmed_provider');--> statement-breakpoint
CREATE INDEX "no_show_reports_status_history_report_id_idx" ON "no_show_reports_status_history" USING btree ("no_show_report_id");--> statement-breakpoint
CREATE INDEX "no_show_reports_status_history_actor_user_id_idx" ON "no_show_reports_status_history" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "no_show_reports_status_transitions_from_to_uq" ON "no_show_reports_status_transitions" USING btree ("from_status","to_status");--> statement-breakpoint
CREATE INDEX "booking_cancellations_policy_version_id_idx" ON "booking_cancellations" USING btree ("policy_version_id");--> statement-breakpoint
CREATE INDEX "booking_cancellations_cancelled_by_user_id_idx" ON "booking_cancellations" USING btree ("cancelled_by_user_id");--> statement-breakpoint
CREATE INDEX "booking_cancellations_no_show_report_id_idx" ON "booking_cancellations" USING btree ("no_show_report_id");--> statement-breakpoint
-- C-9: one cancellation per booking, independent of the application check. C-10: idempotency.
CREATE UNIQUE INDEX "booking_cancellations_booking_uq" ON "booking_cancellations" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_cancellations_idempotency_uq" ON "booking_cancellations" USING btree ("booking_id","idempotency_key");--> statement-breakpoint
-- C-1: a platform policy has no target; a scoped one always does.
ALTER TABLE "policies" ADD CONSTRAINT "policies_type_ck" CHECK ("policies"."type" in ('cancellation'));--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_scope_ck" CHECK ("policies"."scope" in ('platform','category','service') and ("policies"."scope" = 'platform') = ("policies"."scope_id" is null));--> statement-breakpoint
-- C-4: no inverted or empty validity interval.
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_interval_ck" CHECK ("policy_versions"."effective_to" is null or "policy_versions"."effective_to" > "policy_versions"."effective_from");--> statement-breakpoint
-- C-5: a structural floor at the database. The full grammar is validateCancellationPolicyConfig().
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_config_ck" CHECK (jsonb_typeof("policy_versions"."config") = 'object' and jsonb_typeof("policy_versions"."config" -> 'tiers') = 'array' and jsonb_array_length("policy_versions"."config" -> 'tiers') > 0);--> statement-breakpoint
-- C-3: "multiple active versions cover the same instant" is IMPOSSIBLE, not merely discouraged.
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_no_overlap_ex" EXCLUDE USING gist ("policy_id" WITH =, tstzrange("effective_from", "effective_to") WITH &&);--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD CONSTRAINT "policy_acceptances_source_ck" CHECK ("policy_acceptances"."source" in ('platform_default','category_override','service_override'));--> statement-breakpoint
ALTER TABLE "policy_acceptances" ADD CONSTRAINT "policy_acceptances_config_ck" CHECK (jsonb_typeof("policy_acceptances"."accepted_config") = 'object');--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_status_ck" CHECK ("no_show_reports"."status" in ('reported','awaiting_response','under_review','resolved','withdrawn'));--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_reporter_role_ck" CHECK ("no_show_reports"."reporter_role" in ('customer','provider'));--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_outcome_ck" CHECK ("no_show_reports"."outcome" is null or "no_show_reports"."outcome" in ('no_show_confirmed_customer','no_show_confirmed_provider','no_fault','inconclusive','escalated_to_dispute'));--> statement-breakpoint
-- Spec 023 §3 "Evidence model": the ONLY location datum this system holds is this three-valued
-- derived enum. There is no coordinate column here, by construction.
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_location_signal_ck" CHECK ("no_show_reports"."location_signal" in ('address_within_service_area','address_outside_service_area','unavailable'));--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_response_status_ck" CHECK ("no_show_reports"."response_status" in ('pending','filed','no_response'));--> statement-breakpoint
-- C-18: a resolution always has an outcome, an instant, a named admin and a reason (master §68).
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_resolution_pairing_ck" CHECK (("no_show_reports"."status" = 'resolved') = ("no_show_reports"."outcome" is not null) and ("no_show_reports"."outcome" is null) = ("no_show_reports"."resolved_at" is null) and ("no_show_reports"."outcome" is null) = ("no_show_reports"."resolved_by_admin_id" is null) and ("no_show_reports"."outcome" is null) = ("no_show_reports"."resolution_reason" is null));--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_response_pairing_ck" CHECK (("no_show_reports"."response_status" = 'filed') = ("no_show_reports"."response_filed_at" is not null));--> statement-breakpoint
-- C-21: a report is never its own counterpart.
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_counterpart_ck" CHECK ("no_show_reports"."counterpart_report_id" is null or "no_show_reports"."counterpart_report_id" <> "no_show_reports"."id");--> statement-breakpoint
ALTER TABLE "no_show_reports" ADD CONSTRAINT "no_show_reports_evidence_ck" CHECK ("no_show_reports"."evidence" is null or jsonb_typeof("no_show_reports"."evidence") = 'object');--> statement-breakpoint
ALTER TABLE "no_show_reports_status_history" ADD CONSTRAINT "no_show_reports_status_history_actor_role_ck" CHECK ("no_show_reports_status_history"."actor_role" in ('customer','provider','admin','system'));--> statement-breakpoint
ALTER TABLE "no_show_reports_status_history" ADD CONSTRAINT "no_show_reports_status_history_actor_pairing_ck" CHECK (("no_show_reports_status_history"."actor_user_id" is null) = ("no_show_reports_status_history"."actor_role" = 'system'));--> statement-breakpoint
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_role_ck" CHECK ("booking_cancellations"."cancelled_by_role" in ('customer','provider','admin'));--> statement-breakpoint
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_fee_percent_ck" CHECK ("booking_cancellations"."tier_fee_percent" between 0 and 100);--> statement-breakpoint
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_captured_pair_ck" CHECK (("booking_cancellations"."captured_amount_minor_units" is null) = ("booking_cancellations"."captured_currency_code" is null));--> statement-breakpoint
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_captured_currency_format_ck" CHECK ("booking_cancellations"."captured_currency_code" is null or "booking_cancellations"."captured_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- C-11: the fee can NEVER exceed what was captured, and the two halves always reconcile — at the
-- database, not only in application code.
ALTER TABLE "booking_cancellations" ADD CONSTRAINT "booking_cancellations_amounts_ck" CHECK ("booking_cancellations"."captured_amount_minor_units" >= 0 and "booking_cancellations"."fee_amount_minor_units" >= 0 and "booking_cancellations"."fee_amount_minor_units" <= "booking_cancellations"."captured_amount_minor_units" and "booking_cancellations"."refund_amount_minor_units" = "booking_cancellations"."captured_amount_minor_units" - "booking_cancellations"."fee_amount_minor_units");--> statement-breakpoint
-- Spec 023 §3 "No-show workflow": the transitions THIS spec performs, and only those. `resolved` and
-- `withdrawn` have no outgoing transition — escalation after resolution is spec 031's, not a reopen.
INSERT INTO "no_show_reports_status_transitions" ("from_status", "to_status") VALUES
  ('reported', 'awaiting_response'),
  ('awaiting_response', 'under_review'),
  ('awaiting_response', 'withdrawn'),
  ('under_review', 'resolved')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Attach spec 003's EXISTING generic trigger function; it derives the transitions table from
-- TG_TABLE_NAME, so creating the table above is all that was needed. No new trigger function.
CREATE TRIGGER no_show_reports_status_transition_trg
  BEFORE UPDATE ON "no_show_reports"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_status_transition();
--> statement-breakpoint
-- Spec 020 §3 reserved every `-> cancelled` booking transition for spec 023. These three are the
-- cancellable states (§3 "Cancellation eligibility"): `pending` is closed by spec 021's
-- authorization sweep, and `in_progress` onward is a completion/dispute matter, not a cancellation.
INSERT INTO "bookings_status_transitions" ("from_status", "to_status") VALUES
  ('confirmed', 'cancelled'),
  ('provider_en_route', 'cancelled'),
  ('arrived', 'cancelled')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 023 §3 "Admin resolution" — `resolve` is MEDIUM, not high: the admin picks an outcome from a
-- closed set (never an amount), the consequence is computed from the booking's own snapshot, and
-- every resolution is audited. Spec 022's `refunds/override` stays `high` for discretionary money.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('no_show_reports', 'read', 'low'),
	('no_show_reports', 'resolve', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('trust_safety_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
--> statement-breakpoint
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('cancellation_policy', 'read', 'low'),
	('cancellation_policy', 'configure', 'medium')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('operations_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
--> statement-breakpoint
-- Spec 023 §3 "The platform default" / §4 "Migration" — the deterministic seed. `effective_from` is
-- the epoch so EVERY existing and future booking resolves to it; no booking is ever left
-- unpriceable by a seed that starts "now". No category or service override is seeded: an override
-- is always a deliberate admin act.
INSERT INTO "policies" ("type", "scope", "scope_id", "is_active")
VALUES ('cancellation', 'platform', NULL, true);
--> statement-breakpoint
INSERT INTO "policy_versions" ("policy_id", "config", "effective_from", "effective_to", "created_by_admin_id", "note")
SELECT p."id",
       '{"tiers":[{"minHoursBefore":24,"maxHoursBefore":null,"feePercent":0},{"minHoursBefore":12,"maxHoursBefore":24,"feePercent":25},{"minHoursBefore":0,"maxHoursBefore":12,"feePercent":50},{"minHoursBefore":null,"maxHoursBefore":0,"feePercent":100}],"allowedOptions":[]}'::jsonb,
       '1970-01-01T00:00:00Z'::timestamptz,
       NULL,
       NULL,
       'Spec 023 platform default: 0% beyond 24h, 25% in [12h,24h), 50% under 12h, 100% at or after the scheduled time.'
FROM "policies" p
WHERE p."type" = 'cancellation' AND p."scope" = 'platform';
--> statement-breakpoint
-- C-6: a published policy version is IMMUTABLE. A change is a NEW version — that is what makes an
-- existing booking's snapshot unalterable. Only `effective_to` may be set, and only once.
CREATE OR REPLACE FUNCTION enforce_policy_version_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.config IS DISTINCT FROM OLD.config
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_by_admin_id IS DISTINCT FROM OLD.created_by_admin_id THEN
    RAISE EXCEPTION 'Policy version % is immutable; publish a new version instead', OLD.id
      USING ERRCODE = '23514';
  END IF;
  IF OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
    RAISE EXCEPTION 'Policy version % already has an end instant; it cannot be changed', OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER policy_versions_immutable_trg
  BEFORE UPDATE ON "policy_versions"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_policy_version_immutable();
--> statement-breakpoint
-- C-8 / AC-1: the snapshot is never rewritten. This is the whole point of PolicyAcceptance — a later
-- configuration change cannot reach back and alter an existing customer's terms.
CREATE OR REPLACE FUNCTION enforce_policy_acceptance_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'policy_acceptances rows are immutable (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER policy_acceptances_immutable_trg
  BEFORE UPDATE OR DELETE ON "policy_acceptances"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_policy_acceptance_immutable();
--> statement-breakpoint
-- C-13: a recorded cancellation consequence is a financial record — append-only.
CREATE OR REPLACE FUNCTION enforce_booking_cancellation_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'booking_cancellations rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER booking_cancellations_immutable_trg
  BEFORE UPDATE OR DELETE ON "booking_cancellations"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_booking_cancellation_immutable();
--> statement-breakpoint
-- C-20: the attribution record behind every no-show transition is append-only.
CREATE OR REPLACE FUNCTION enforce_no_show_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'no_show_reports_status_history rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER no_show_reports_status_history_append_only_trg
  BEFORE UPDATE OR DELETE ON "no_show_reports_status_history"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_no_show_history_append_only();
--> statement-breakpoint
-- C-20 / AC-10: evidence and either party's own words are IMMUTABLE once written. The single
-- exception is the retention sweep's MINIMISING write (spec 008's existing sweep), which can only
-- ever remove, never alter: statements go to NULL, and `evidence` — a NOT NULL column — goes to the
-- empty object, which is this table's way of spelling "nothing is left here".
CREATE OR REPLACE FUNCTION enforce_no_show_evidence_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.evidence IS DISTINCT FROM OLD.evidence
     AND NEW.evidence IS NOT NULL
     AND NEW.evidence <> '{}'::jsonb THEN
    RAISE EXCEPTION 'No-show evidence is immutable (report %)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.location_signal IS DISTINCT FROM OLD.location_signal AND NEW.location_signal <> 'unavailable' THEN
    RAISE EXCEPTION 'No-show location signal is immutable (report %)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.reporter_statement IS NOT NULL
     AND NEW.reporter_statement IS DISTINCT FROM OLD.reporter_statement
     AND NEW.reporter_statement IS NOT NULL THEN
    RAISE EXCEPTION 'A no-show reporter statement is immutable (report %)', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.response_statement IS NOT NULL
     AND NEW.response_statement IS DISTINCT FROM OLD.response_statement
     AND NEW.response_statement IS NOT NULL THEN
    RAISE EXCEPTION 'A no-show response statement is immutable (report %)', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER no_show_reports_evidence_immutable_trg
  BEFORE UPDATE ON "no_show_reports"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_no_show_evidence_immutable();
