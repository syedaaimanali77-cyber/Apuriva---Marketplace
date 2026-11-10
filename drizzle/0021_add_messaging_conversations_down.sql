-- Down migration for 0021_add_messaging_conversations —
-- docs/specs/2026-08-28-025-messaging-conversations.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0021
-- added and nothing else. It never touches `0001_baseline_schema.sql`, `message_attachments`,
-- `offer_messages`, or any table another spec owns, and it leaves the four baseline skeletons (and
-- their spec 003 indexes and foreign keys) in place.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. `messages.body` is authoritative user correspondence that
-- spec 008 requires be exportable; dropping it would destroy it irrecoverably. This file is safe ONLY
-- before the first message exists. Once one does, the correct response to a defect is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "messages") THEN
    RAISE EXCEPTION 'Refusing to roll back 0021: messages exist and must be retained';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "messages_append_only_trg" ON "messages";
DROP FUNCTION IF EXISTS enforce_messages_append_only();

DELETE FROM "permissions" WHERE "resource" = 'messaging' AND "action" = 'read_conversation';

ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_contact_exclusive_ck";
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_body_length_ck";
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_sender_role_ck";
ALTER TABLE "conversation_participants" DROP CONSTRAINT IF EXISTS "conversation_participants_role_ck";

DROP INDEX IF EXISTS "messages_sender_idempotency_key_uq";
DROP INDEX IF EXISTS "messages_conversation_created_at_id_idx";
DROP INDEX IF EXISTS "conversation_participants_conversation_role_uq";
DROP INDEX IF EXISTS "conversations_booking_id_uq";

-- Participant rows carry no correspondence; they are removed only because `role` is NOT NULL and
-- cannot survive its own column being dropped on a re-apply. The gate above guarantees no message.
DELETE FROM "conversation_participants";

ALTER TABLE "messages" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "redacted_by_retention";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "contact_flagged";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "contact_redacted";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "sender_role";
ALTER TABLE "messages" DROP COLUMN IF EXISTS "body";
ALTER TABLE "conversation_participants" DROP COLUMN IF EXISTS "last_read_at";
ALTER TABLE "conversation_participants" DROP COLUMN IF EXISTS "role";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "last_message_at";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "retention_applied_at";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "archived_at";
