ALTER TABLE "request_attachments" ADD COLUMN "file_asset_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "request_field_values" ADD COLUMN "value" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "description" text NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "budget_min_amount_minor_units" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "budget_min_currency_code" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "budget_max_amount_minor_units" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "budget_max_currency_code" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "preferred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "preferred_timezone" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "address_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "urgency" text NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "request_attachments" ADD CONSTRAINT "request_attachments_file_asset_id_file_assets_id_fk" FOREIGN KEY ("file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_address_id_addresses_id_fk" FOREIGN KEY ("address_id") REFERENCES "public"."addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_attachments_file_asset_id_idx" ON "request_attachments" USING btree ("file_asset_id");--> statement-breakpoint
CREATE INDEX "requests_address_id_idx" ON "requests" USING btree ("address_id");--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_customer_idempotency_key_uq" ON "requests" USING btree ("customer_profile_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_budget_min_pair_ck" CHECK (("budget_min_amount_minor_units" is null) = ("budget_min_currency_code" is null));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_budget_min_currency_format_ck" CHECK ("budget_min_currency_code" is null or "budget_min_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_budget_max_pair_ck" CHECK (("budget_max_amount_minor_units" is null) = ("budget_max_currency_code" is null));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_budget_max_currency_format_ck" CHECK ("budget_max_currency_code" is null or "budget_max_currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_status_ck" CHECK ("requests"."status" in ('draft','submitted','matching','offers_open','provider_selected','booking_created','cancelled','expired','completed'));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_urgency_ck" CHECK ("requests"."urgency" in ('normal','urgent'));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_budget_pair_ck" CHECK (("requests"."budget_min_amount_minor_units" is null) = ("requests"."budget_max_amount_minor_units" is null));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_budget_order_ck" CHECK ("requests"."budget_min_amount_minor_units" is null or "requests"."budget_min_amount_minor_units" <= "requests"."budget_max_amount_minor_units");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_budget_currency_match_ck" CHECK ("requests"."budget_min_currency_code" is null or "requests"."budget_min_currency_code" = "requests"."budget_max_currency_code");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_budget_positive_ck" CHECK ("requests"."budget_min_amount_minor_units" is null or "requests"."budget_min_amount_minor_units" > 0);--> statement-breakpoint
-- Spec 015 §4 "State machine": seeded by hand (drizzle-kit generates DDL only, never data), the
-- same way spec 010 appended its catalog seed. The requests_status_transition_trg trigger
-- (spec 003 AC-3) rejects any status UPDATE whose (from, to) pair is absent from this table, so
-- these four rows are exactly what spec 015 is allowed to perform: creation's draft -> submitted,
-- and the customer's pre-provider-selection cancellation from each cancellable state (master
-- spec §38). Every other transition belongs to a later spec (017/018/019/020/028) and is
-- deliberately NOT seeded here, so an unimplemented transition fails loudly at the database
-- instead of silently corrupting state. Idempotent: re-running adds no duplicate rows.
INSERT INTO "requests_status_transitions" ("from_status", "to_status") VALUES
  ('draft', 'submitted'),
  ('submitted', 'cancelled'),
  ('matching', 'cancelled'),
  ('offers_open', 'cancelled')
ON CONFLICT ("from_status", "to_status") DO NOTHING;
