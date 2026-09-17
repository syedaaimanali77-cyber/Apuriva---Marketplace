-- Spec 025 §4 "Migration" — docs/specs/2026-08-28-025-messaging-conversations.md.
--
-- `conversations`, `conversation_participants` and `messages` are spec 003 BASELINE skeletons — this
-- migration ALTERS them and creates no messaging table. `message_attachments` is deliberately left
-- untouched (spec 027 owns attachments). `0001_baseline_schema.sql` is immutable
-- (`npm run check:schema-checksum`) and is not touched.
--
-- Precondition, the same `DO $$` guard 0016–0018 use: nothing has ever written a participant or a
-- message, so NOT NULL columns without defaults can be added directly. Fail loudly otherwise.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "conversation_participants") OR EXISTS (SELECT 1 FROM "messages") THEN
    RAISE EXCEPTION '0021_add_messaging_conversations requires empty conversation_participants and messages';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "retention_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN "last_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "body" text NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "contact_redacted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "contact_flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "redacted_by_retention" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "idempotency_fingerprint" text NOT NULL;--> statement-breakpoint
-- AC-7: one conversation per booking, enforced by the database. Partial, so the unused
-- `request_id` scope is not constrained.
CREATE UNIQUE INDEX "conversations_booking_id_uq" ON "conversations" USING btree ("booking_id") WHERE "conversations"."booking_id" is not null;--> statement-breakpoint
-- AC-7: exactly one customer and exactly one provider.
CREATE UNIQUE INDEX "conversation_participants_conversation_role_uq" ON "conversation_participants" USING btree ("conversation_id","role");--> statement-breakpoint
-- The one index every read path uses: paged list, `after` delta read, retention sweep, export.
CREATE INDEX "messages_conversation_created_at_id_idx" ON "messages" USING btree ("conversation_id","created_at","id");--> statement-breakpoint
-- AC-8: idempotency scoped per sender, never globally.
CREATE UNIQUE INDEX "messages_sender_idempotency_key_uq" ON "messages" USING btree ("sender_user_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_role_ck" CHECK ("conversation_participants"."role" in ('customer','provider'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_role_ck" CHECK ("messages"."sender_role" in ('customer','provider'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_length_ck" CHECK (char_length("messages"."body") between 1 and 2400);--> statement-breakpoint
-- AC-2's two branches are mutually exclusive by construction: masked OR permitted-and-flagged.
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_exclusive_ck" CHECK (not ("messages"."contact_redacted" and "messages"."contact_flagged"));--> statement-breakpoint
-- Spec 025 §3 "Admin and support access" (AC-5) — this spec's own Permission seed. `medium`: audited
-- and narrowly granted, but no second-admin approval (spec 009 requires one only at high/critical).
-- Seeded for exactly three roles; every other admin role therefore cannot read a conversation.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", 'messaging', 'read_conversation', 'medium'
FROM "roles" r
WHERE r."name" IN ('support_admin', 'trust_safety_admin', 'super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
--> statement-breakpoint
-- Spec 025 §4 AC-9: messages are immutable. The ONLY sanctioned body write is anonymization to the
-- platform redaction sentinel (spec 008's REDACTED_DESCRIPTION), by the retention sweep (AC-4) or
-- the account-deletion sweep (AC-10). `updated_at`, `version` and the flag columns may change.
CREATE OR REPLACE FUNCTION enforce_messages_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'messages rows are immutable and cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'messages identity columns are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body AND NEW.body <> '[redacted]' THEN
    RAISE EXCEPTION 'message bodies are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "messages_append_only_trg" BEFORE UPDATE OR DELETE ON "messages"
FOR EACH ROW EXECUTE FUNCTION enforce_messages_append_only();
