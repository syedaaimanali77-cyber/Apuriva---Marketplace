-- Down migration for 0030_add_ai_conversation_memory —
-- docs/specs/2026-08-28-034-ai-conversation-memory-autonomy.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0030
-- added and nothing else.
--
-- IT RESTORES THE SPEC 003 SKELETONS, it does not drop them. The four AI tables belong to
-- `0001_baseline_schema.sql`; only the columns, constraints and indexes 0030 added come off, and
-- `ai_tool_calls` (spec 036) is never touched.
--
-- It IS gated on content: dropping the columns would destroy every transcript, memory entry and
-- activity record while leaving meaningless skeleton rows behind, so this refuses rather than doing
-- that. Once real use has happened, the correct response to a defect is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ai_messages") THEN
    RAISE EXCEPTION 'Refusing to roll back 0030: AI conversation transcripts exist and would be destroyed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ai_memories") THEN
    RAISE EXCEPTION 'Refusing to roll back 0030: AI memory entries exist and would be destroyed';
  END IF;
  IF EXISTS (SELECT 1 FROM "ai_actions") THEN
    RAISE EXCEPTION 'Refusing to roll back 0030: AI activity records exist and would be destroyed';
  END IF;
END $$;
--> statement-breakpoint

-- --------------------------------------------------------------------------- ai_actions
DROP INDEX IF EXISTS "ai_actions_conversation_idempotency_key_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "ai_actions_conversation_created_at_idx";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP CONSTRAINT IF EXISTS "ai_actions_idempotency_pair_ck";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP CONSTRAINT IF EXISTS "ai_actions_related_pair_ck";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP CONSTRAINT IF EXISTS "ai_actions_related_entity_type_ck";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP CONSTRAINT IF EXISTS "ai_actions_result_ck";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP CONSTRAINT IF EXISTS "ai_actions_risk_tier_ck";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "related_entity_id";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "related_entity_type";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "reversible";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "result";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "required_confirmation";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "risk_tier";--> statement-breakpoint
ALTER TABLE "ai_actions" DROP COLUMN IF EXISTS "action_type";--> statement-breakpoint

-- --------------------------------------------------------------------------- ai_memories
DROP INDEX IF EXISTS "ai_memories_user_key_uq";--> statement-breakpoint
ALTER TABLE "ai_memories" DROP CONSTRAINT IF EXISTS "ai_memories_key_ck";--> statement-breakpoint
ALTER TABLE "ai_memories" DROP COLUMN IF EXISTS "value";--> statement-breakpoint
ALTER TABLE "ai_memories" DROP COLUMN IF EXISTS "key";--> statement-breakpoint

-- --------------------------------------------------------------------------- ai_messages
DROP INDEX IF EXISTS "ai_messages_conversation_idempotency_key_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "ai_messages_conversation_created_at_id_idx";--> statement-breakpoint
ALTER TABLE "ai_messages" DROP CONSTRAINT IF EXISTS "ai_messages_idempotency_ck";--> statement-breakpoint
ALTER TABLE "ai_messages" DROP CONSTRAINT IF EXISTS "ai_messages_role_ck";--> statement-breakpoint
ALTER TABLE "ai_messages" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "ai_messages" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "ai_messages" DROP COLUMN IF EXISTS "body";--> statement-breakpoint
ALTER TABLE "ai_messages" DROP COLUMN IF EXISTS "role";--> statement-breakpoint

-- --------------------------------------------------------------------------- ai_conversations
DROP INDEX IF EXISTS "ai_conversations_user_idempotency_key_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "ai_conversations_user_updated_at_idx";--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP COLUMN IF EXISTS "idempotency_fingerprint";--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP COLUMN IF EXISTS "idempotency_key";--> statement-breakpoint
ALTER TABLE "ai_conversations" DROP COLUMN IF EXISTS "deleted_at";--> statement-breakpoint

-- --------------------------------------------------------------------------- users
ALTER TABLE "users" DROP COLUMN IF EXISTS "ai_proactive_suggestions_enabled";
