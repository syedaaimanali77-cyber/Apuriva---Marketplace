-- Spec 019 §4 "Migration" precondition: offer_messages and offer_revisions are spec 003 baselines that no
-- code path has ever written, so NOT NULL columns without defaults can be added. Fail loudly otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "offer_messages") OR EXISTS (SELECT 1 FROM "offer_revisions") THEN
    RAISE EXCEPTION '0015_add_offer_negotiation_comparison requires empty offer_messages and offer_revisions';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "offer_messages" ALTER COLUMN "offer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "request_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "provider_profile_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "sender_role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "contact_redacted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "proposed_price_amount_minor_units" integer;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "proposed_price_currency_code" text;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "new_offer_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "request_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "provider_profile_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "revision_number" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "previous_price_amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "previous_price_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "new_price_amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "new_price_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "actor_user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD COLUMN "change_request_message_id" uuid;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_new_offer_id_offers_id_fk" FOREIGN KEY ("new_offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_change_request_message_id_offer_messages_id_fk" FOREIGN KEY ("change_request_message_id") REFERENCES "public"."offer_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_messages_request_id_idx" ON "offer_messages" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "offer_messages_provider_profile_id_idx" ON "offer_messages" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX "offer_messages_thread_created_at_idx" ON "offer_messages" USING btree ("request_id","provider_profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_messages_sender_idempotency_key_uq" ON "offer_messages" USING btree ("sender_user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_messages_change_request_per_offer_uq" ON "offer_messages" USING btree ("offer_id") WHERE "offer_messages"."kind" = 'change_request';--> statement-breakpoint
CREATE UNIQUE INDEX "offer_revisions_offer_id_uq" ON "offer_revisions" USING btree ("offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_revisions_new_offer_id_uq" ON "offer_revisions" USING btree ("new_offer_id");--> statement-breakpoint
CREATE INDEX "offer_revisions_request_id_idx" ON "offer_revisions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "offer_revisions_provider_profile_id_idx" ON "offer_revisions" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX "offer_revisions_actor_user_id_idx" ON "offer_revisions" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "offer_revisions_change_request_message_id_idx" ON "offer_revisions" USING btree ("change_request_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_revisions_request_provider_number_uq" ON "offer_revisions" USING btree ("request_id","provider_profile_id","revision_number");--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_sender_role_ck" CHECK ("offer_messages"."sender_role" in ('customer','provider'));--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_kind_ck" CHECK ("offer_messages"."kind" in ('message','change_request'));--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_body_length_ck" CHECK (char_length("offer_messages"."body") between 1 and 1100);--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_change_request_offer_ck" CHECK (("offer_messages"."kind" = 'change_request') = ("offer_messages"."offer_id" is not null));--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_proposed_price_kind_ck" CHECK ("offer_messages"."kind" = 'change_request' or "offer_messages"."proposed_price_amount_minor_units" is null);--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_change_request_sender_ck" CHECK ("offer_messages"."kind" = 'message' or "offer_messages"."sender_role" = 'customer');--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_proposed_price_pair_ck" CHECK (("proposed_price_amount_minor_units" is null) = ("proposed_price_currency_code" is null));--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_proposed_price_currency_format_ck" CHECK ("proposed_price_currency_code" is null or "proposed_price_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "offer_messages" ADD CONSTRAINT "offer_messages_proposed_price_positive_ck" CHECK ("offer_messages"."proposed_price_amount_minor_units" is null or "offer_messages"."proposed_price_amount_minor_units" > 0);--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_number_ck" CHECK ("offer_revisions"."revision_number" between 1 and 5);--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_distinct_offers_ck" CHECK ("offer_revisions"."offer_id" <> "offer_revisions"."new_offer_id");--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_previous_price_pair_ck" CHECK (("previous_price_amount_minor_units" is null) = ("previous_price_currency_code" is null));--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_previous_price_currency_format_ck" CHECK ("previous_price_currency_code" is null or "previous_price_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_new_price_pair_ck" CHECK (("new_price_amount_minor_units" is null) = ("new_price_currency_code" is null));--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_new_price_currency_format_ck" CHECK ("new_price_currency_code" is null or "new_price_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_prices_positive_ck" CHECK ("offer_revisions"."previous_price_amount_minor_units" > 0 and "offer_revisions"."new_price_amount_minor_units" > 0);--> statement-breakpoint
ALTER TABLE "offer_revisions" ADD CONSTRAINT "offer_revisions_same_currency_ck" CHECK ("offer_revisions"."previous_price_currency_code" = "offer_revisions"."new_price_currency_code");--> statement-breakpoint
-- Spec 019 §3 "Offer state machine additions": exactly two transitions. A revision supersedes a LIVE
-- offer; nothing leaves `revised`, and nothing enters it from expired/accepted/declined/withdrawn.
INSERT INTO "offers_status_transitions" ("from_status", "to_status") VALUES
  ('sent', 'revised'),
  ('viewed', 'revised')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 019 §3 "Offer terms are immutable": once an offer row leaves `draft`, its terms and its 2-minute
-- window can never change — a price change is always a NEW row plus an offer_revisions record.
-- `provider_message` is deliberately excluded: spec 018's account-deletion sweep redacts it.
-- `apuriva.test_offer_window_shift` is a transaction-local setting used ONLY by the test fixture
-- `shiftOfferWindow` (lib/offers/offers-test-support.ts) to place a window relative to the database
-- clock; no application path sets it, and it never permits a change to price, currency, items,
-- duration, request or provider.
CREATE OR REPLACE FUNCTION enforce_offer_terms_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.request_id IS DISTINCT FROM OLD.request_id
       OR NEW.provider_profile_id IS DISTINCT FROM OLD.provider_profile_id
       OR NEW.price_amount_minor_units IS DISTINCT FROM OLD.price_amount_minor_units
       OR NEW.price_currency_code IS DISTINCT FROM OLD.price_currency_code
       OR NEW.included_items IS DISTINCT FROM OLD.included_items
       OR NEW.estimated_duration_minutes IS DISTINCT FROM OLD.estimated_duration_minutes THEN
      RAISE EXCEPTION 'Offer % terms are immutable once sent', OLD.id USING ERRCODE = '23514';
    END IF;
    IF (NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at)
       AND current_setting('apuriva.test_offer_window_shift', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Offer % window is immutable once sent', OLD.id USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER offers_terms_immutable_trg
  BEFORE UPDATE ON "offers"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_offer_terms_immutable();
--> statement-breakpoint
-- Spec 019 §4: offer_revisions is the audit record behind every price change — append-only.
CREATE OR REPLACE FUNCTION enforce_offer_revisions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'offer_revisions rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER offer_revisions_append_only_trg
  BEFORE UPDATE OR DELETE ON "offer_revisions"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_offer_revisions_append_only();
