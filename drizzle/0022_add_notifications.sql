-- Spec 026 §4 "Migration" — docs/specs/2026-08-28-026-notifications.md.
--
-- `notifications` and `notification_preferences` are spec 003 BASELINE skeletons — this migration ALTERS
-- them and adds exactly one table, `notification_deliveries`. `0001_baseline_schema.sql` is immutable
-- (`npm run check:schema-checksum`) and is not touched. Number: `_journal.json`'s head was
-- `0021_add_messaging_conversations` (spec 025), so this is 0022.
--
-- Precondition, the same `DO $$` guard 0016–0021 use: nothing has ever written either table, so NOT NULL
-- columns without defaults can be added directly. No backfill; no existing row is modified.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "notifications") OR EXISTS (SELECT 1 FROM "notification_preferences") THEN
    RAISE EXCEPTION '0022_add_notifications requires empty notifications and notification_preferences';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "category" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "title" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "event_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "categories" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "marketing_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "marketing_consent_source" text;--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"notification_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"provider_reference" text,
	"failure_code" text,
	"skip_reason" text,
	-- C-7: closed vocabularies. `in_app` is absent — it is the notification row itself.
	CONSTRAINT "notification_deliveries_status_ck" CHECK ("notification_deliveries"."status" in ('pending','retrying','delivered','failed','skipped')),
	CONSTRAINT "notification_deliveries_channel_ck" CHECK ("notification_deliveries"."channel" in ('email','push','sms')),
	-- C-8: a delivered row always has its instant, and only a delivered row has one.
	CONSTRAINT "notification_deliveries_delivered_pairing_ck" CHECK (("notification_deliveries"."status" = 'delivered') = ("notification_deliveries"."delivered_at" is not null)),
	CONSTRAINT "notification_deliveries_attempts_ck" CHECK ("notification_deliveries"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_notification_id_idx" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
-- C-5: the dispatch sweep's claim path.
CREATE INDEX "notification_deliveries_status_due_idx" ON "notification_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- C-6: one delivery row per channel per notification — why a queued row can send late but never twice.
CREATE UNIQUE INDEX "notification_deliveries_notification_channel_uq" ON "notification_deliveries" USING btree ("notification_id","channel");--> statement-breakpoint
-- C-1 / AC-4: master spec §57's seven categories, at the database.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_category_ck" CHECK ("notifications"."category" in ('booking','messages','payments','security','promotions','provider_activity','operational'));--> statement-breakpoint
-- C-2 / AC-7: dedup is structural, not advisory.
CREATE UNIQUE INDEX "notifications_event_key_uq" ON "notifications" USING btree ("recipient_user_id","event_key");--> statement-breakpoint
-- C-3 / AC-8: the exact list ordering, served by the index that matches it.
CREATE INDEX "notifications_recipient_created_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC,"id" DESC);--> statement-breakpoint
-- C-4: the badge count without scanning a long inbox.
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_user_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
-- C-9: structural floor; the grammar lives in `validateCategoryChannelMap()`.
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_categories_ck" CHECK (jsonb_typeof("notification_preferences"."categories") = 'object');--> statement-breakpoint
-- C-10: `read_at` may go null -> set, never set -> different (and never back to null).
CREATE OR REPLACE FUNCTION enforce_notifications_read_at_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'notifications.read_at is immutable once set' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "notifications_read_at_immutable_trg" BEFORE UPDATE ON "notifications"
FOR EACH ROW EXECUTE FUNCTION enforce_notifications_read_at_immutable();
