ALTER TABLE "offers" ADD COLUMN "price_amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "price_currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "included_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "provider_message" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "estimated_duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "viewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "accept_idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "offers_provider_idempotency_key_uq" ON "offers" USING btree ("provider_profile_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_request_provider_live_uq" ON "offers" USING btree ("request_id","provider_profile_id") WHERE "offers"."status" in ('draft','sent','viewed');--> statement-breakpoint
CREATE UNIQUE INDEX "offers_request_accepted_uq" ON "offers" USING btree ("request_id") WHERE "offers"."status" = 'accepted';--> statement-breakpoint
CREATE INDEX "offers_status_expires_at_idx" ON "offers" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "offers_request_sent_at_idx" ON "offers" USING btree ("request_id","sent_at");--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_price_pair_ck" CHECK (("price_amount_minor_units" is null) = ("price_currency_code" is null));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_price_currency_format_ck" CHECK ("price_currency_code" is null or "price_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_price_positive_ck" CHECK ("offers"."price_amount_minor_units" > 0);--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_status_ck" CHECK ("offers"."status" in ('draft','sent','viewed','revised','accepted','declined','expired','withdrawn'));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_estimated_duration_ck" CHECK ("offers"."estimated_duration_minutes" is null or "offers"."estimated_duration_minutes" between 1 and 1440);--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_draft_unsent_ck" CHECK (("offers"."status" = 'draft') = ("offers"."sent_at" is null));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_sent_expires_pair_ck" CHECK (("offers"."sent_at" is null) = ("offers"."expires_at" is null));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_two_minute_window_ck" CHECK ("offers"."expires_at" is null or "offers"."expires_at" = "offers"."sent_at" + interval '2 minutes');--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_decided_pairing_ck" CHECK (("offers"."decided_at" is not null) = ("offers"."status" in ('accepted','declined','withdrawn')));--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_accept_key_pairing_ck" CHECK (("offers"."accept_idempotency_key" is not null) = ("offers"."status" = 'accepted'));--> statement-breakpoint
-- Spec 018 §3 "Offer state machine": the ten offer transitions this spec performs. The spec-003
-- trigger rejects any status change absent from this table, so nothing else is performable —
-- in particular nothing into/out of `revised` (spec 019) and nothing out of a terminal state.
INSERT INTO "offers_status_transitions" ("from_status", "to_status") VALUES
  ('draft', 'sent'),
  ('sent', 'viewed'),
  ('sent', 'accepted'),
  ('viewed', 'accepted'),
  ('sent', 'declined'),
  ('viewed', 'declined'),
  ('sent', 'withdrawn'),
  ('viewed', 'withdrawn'),
  ('sent', 'expired'),
  ('viewed', 'expired')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
--> statement-breakpoint
-- Spec 018 §3 "Request state transitions": `matching -> offers_open` (assigned to this spec by
-- spec 017) on the first offer, and `offers_open -> provider_selected` on accept. Request `-> expired`
-- is deliberately NOT seeded (spec 018 §7).
INSERT INTO "requests_status_transitions" ("from_status", "to_status") VALUES
  ('matching', 'offers_open'),
  ('offers_open', 'provider_selected')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
