-- Spec 020 §4 "Migration" precondition: `bookings` and `bookings_status_history` are spec 003 baseline
-- skeletons that no code path has ever written (nothing in lib/ or app/ inserts a booking before this
-- spec), so NOT NULL columns without defaults can be added directly. Fail loudly otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bookings") OR EXISTS (SELECT 1 FROM "bookings_status_history") THEN
    RAISE EXCEPTION '0016_add_booking_creation_state_machine requires empty bookings and bookings_status_history';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "request_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "service_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "customer_profile_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "provider_profile_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "address_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "scheduled_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "scheduled_timezone" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "duration_minutes" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "price_amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "price_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings_status_history" ADD COLUMN "actor_role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_profile_id_customer_profiles_id_fk" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."customer_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Spec 020 §4 I-3: one booking per offer, at the database. Replaces the baseline's non-unique index.
DROP INDEX IF EXISTS "bookings_offer_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_offer_id_uq" ON "bookings" USING btree ("offer_id");--> statement-breakpoint
-- Spec 020 §4 I-4: idempotency scoped per CUSTOMER, never globally (spec 015/018 precedent).
CREATE UNIQUE INDEX "bookings_customer_idempotency_key_uq" ON "bookings" USING btree ("customer_profile_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bookings_request_id_idx" ON "bookings" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "bookings_service_id_idx" ON "bookings" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "bookings_customer_profile_id_idx" ON "bookings" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE INDEX "bookings_provider_profile_id_idx" ON "bookings" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX "bookings_address_id_idx" ON "bookings" USING btree ("address_id");--> statement-breakpoint
-- The index the spec 016 BusyIntervalLoader reads on every reservation and alternatives scan.
CREATE INDEX "bookings_provider_scheduled_at_idx" ON "bookings" USING btree ("provider_profile_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_customer_scheduled_at_idx" ON "bookings" USING btree ("customer_profile_id","scheduled_at");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_pair_ck" CHECK (("price_amount_minor_units" is null) = ("price_currency_code" is null));--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_currency_format_ck" CHECK ("price_currency_code" is null or "price_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_price_positive_ck" CHECK ("bookings"."price_amount_minor_units" > 0);--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_duration_positive_ck" CHECK ("bookings"."duration_minutes" between 1 and 1440);--> statement-breakpoint
-- Spec 020 §4 I-1: the WHOLE booking status vocabulary, authored once, here. Later specs add
-- transitions into bookings_status_transitions; none of them adds a status name.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_status_ck" CHECK ("bookings"."status" in ('pending','confirmed','provider_en_route','arrived','in_progress','completed','protected','settled','cancelled','disputed','refunded','failed'));--> statement-breakpoint
ALTER TABLE "bookings_status_history" ADD CONSTRAINT "bookings_status_history_actor_role_ck" CHECK ("bookings_status_history"."actor_role" in ('customer','provider','system'));--> statement-breakpoint
-- Spec 020 §4 I-8: a real user unless the actor is the system (spec 021's protected/settled).
ALTER TABLE "bookings_status_history" ADD CONSTRAINT "bookings_status_history_actor_pairing_ck" CHECK (("bookings_status_history"."actor_user_id" is null) = ("bookings_status_history"."actor_role" = 'system'));--> statement-breakpoint
-- Spec 020 §3 "Lifecycle transitions": the SIX transitions this spec performs, and only those. The
-- spec-003 bookings_status_transition_trg rejects any status change absent from this table, so
-- nothing else is performable — in particular nothing into `protected`/`settled` (spec 021),
-- `failed` (spec 021), `cancelled` (spec 023), `disputed` (spec 031) or `refunded` (spec 022).
-- Each of those specs seeds its own rows in its own migration. Idempotent: re-running adds nothing.
INSERT INTO "bookings_status_transitions" ("from_status", "to_status") VALUES
  ('pending', 'confirmed'),
  ('confirmed', 'provider_en_route'),
  ('confirmed', 'arrived'),
  ('provider_en_route', 'arrived'),
  ('arrived', 'in_progress'),
  ('in_progress', 'completed')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 020 §3 step 16 — the request transition spec 018 §7 explicitly left to this spec.
-- `booking_created -> completed` is deliberately NOT seeded (spec 028 owns it).
INSERT INTO "requests_status_transitions" ("from_status", "to_status") VALUES
  ('provider_selected', 'booking_created')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 020 §4 I-7 "Terms immutability": once a booking row exists, the agreed offer, participants,
-- service, address, schedule, duration, price and idempotency data can never change — by ANY code
-- path, including a later spec's. This is what makes "the price authority is the accepted offer
-- row" (AC-1) enforceable rather than a convention, and it is why rescheduling is out of scope:
-- a reschedule flow must amend this trigger explicitly in its own migration.
CREATE OR REPLACE FUNCTION enforce_booking_terms_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.offer_id IS DISTINCT FROM OLD.offer_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.customer_profile_id IS DISTINCT FROM OLD.customer_profile_id
     OR NEW.provider_profile_id IS DISTINCT FROM OLD.provider_profile_id
     OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.address_id IS DISTINCT FROM OLD.address_id
     OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
     OR NEW.scheduled_timezone IS DISTINCT FROM OLD.scheduled_timezone
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
     OR NEW.price_amount_minor_units IS DISTINCT FROM OLD.price_amount_minor_units
     OR NEW.price_currency_code IS DISTINCT FROM OLD.price_currency_code
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.idempotency_fingerprint IS DISTINCT FROM OLD.idempotency_fingerprint THEN
    RAISE EXCEPTION 'Booking % terms are immutable', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bookings_terms_immutable_trg
  BEFORE UPDATE ON "bookings"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_booking_terms_immutable();
--> statement-breakpoint
-- Spec 020 §4 safeguard S6: the status history is the attribution record behind every transition —
-- "who completed this booking, and when" must always be provable, so it is append-only.
CREATE OR REPLACE FUNCTION enforce_bookings_status_history_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bookings_status_history rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER bookings_status_history_append_only_trg
  BEFORE UPDATE OR DELETE ON "bookings_status_history"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_bookings_status_history_append_only();
