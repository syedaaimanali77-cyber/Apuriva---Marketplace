-- Down migration for 0025_add_ai_usage_tracking —
-- docs/specs/2026-08-28-033-ai-assistant-architecture.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0025
-- added and nothing else. It never touches `0001_baseline_schema.sql`, `ai_conversations`,
-- `ai_messages`, `ai_memories`, `ai_actions`, `ai_tool_calls`, `security_events`, or any table
-- another spec owns.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. Dropping `ai_usage_events` destroys the cost and abuse
-- history Finance and Trust & Safety act on, and nothing reconstructs it — usage is never
-- backfilled. This file is therefore safe ONLY before the first accounted AI call. Once one
-- exists, the correct response to a defect is a forward fix, and the non-destructive kill switch
-- is `AI_ASSISTANT_ENABLED=false`, not this migration.
--
-- No user data is destroyed in any case: this table stores no prompt, no response and no
-- exportable personal content.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ai_usage_events") THEN
    RAISE EXCEPTION 'Refusing to roll back 0025: ai_usage_events rows exist and must be retained';
  END IF;
END $$;

DELETE FROM "permissions" WHERE "resource" = 'ai' AND "action" = 'read_usage';

DROP INDEX IF EXISTS "ai_usage_events_fingerprint_idx";
DROP INDEX IF EXISTS "ai_usage_events_guest_subject_idx";
DROP INDEX IF EXISTS "ai_usage_events_created_at_idx";
DROP INDEX IF EXISTS "ai_usage_events_user_id_idx";

DROP TABLE IF EXISTS "ai_usage_events";
