-- Down migration for 0032_extend_ai_tool_calls —
-- docs/specs/2026-08-28-036-mcp-tool-catalog-idempotency-errors.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0032
-- added and nothing else: the `ai_tool_calls` table itself is spec 003's baseline and stays, with its
-- baseline columns and `ai_action_id` foreign key. No other table is touched.
--
-- Dropping these columns destroys the record of which tool ran with which server-issued
-- idempotency key. This file is therefore safe ONLY before the first tool call is recorded; the
-- guard below enforces exactly that. After that, the correct response to a defect is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ai_tool_calls") THEN
    RAISE EXCEPTION 'Refusing to roll back 0032: ai_tool_calls rows exist and are the record of executed tool calls';
  END IF;
END $$;

DROP INDEX IF EXISTS "ai_tool_calls_retried_from_call_id_idx";
ALTER TABLE "ai_tool_calls" DROP CONSTRAINT IF EXISTS "ai_tool_calls_retried_from_call_id_ai_tool_calls_id_fk";
ALTER TABLE "ai_tool_calls" DROP COLUMN IF EXISTS "retried_from_call_id";
ALTER TABLE "ai_tool_calls" DROP COLUMN IF EXISTS "error_code";
ALTER TABLE "ai_tool_calls" DROP COLUMN IF EXISTS "output_summary";
ALTER TABLE "ai_tool_calls" DROP COLUMN IF EXISTS "input_params";
ALTER TABLE "ai_tool_calls" DROP COLUMN IF EXISTS "idempotency_key";
