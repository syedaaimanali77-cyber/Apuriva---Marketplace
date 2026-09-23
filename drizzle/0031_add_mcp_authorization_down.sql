-- Down migration for 0031_add_mcp_authorization —
-- docs/specs/2026-08-28-035-mcp-tool-architecture-authorization.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0031
-- added and nothing else. It never touches `ai_actions`, `ai_conversations`, `ai_messages`,
-- `ai_memories`, `ai_tool_calls`, `users`, `roles`, or any table another spec owns; the only row
-- it removes from `permissions` is this spec's own seed.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. Dropping `mcp_confirmations` destroys the record of
-- what a user approved and the parameters they approved it against. That record is the evidence
-- that a medium/high action was authorised, so this file is safe ONLY before the first
-- confirmation exists; the guard below enforces exactly that. After that, the correct response to
-- a defect is a forward fix — and because spec 034's executor port returns to its inert default
-- when this spec stops registering it, the assistant simply proposes no actions in the meantime.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "mcp_confirmations") THEN
    RAISE EXCEPTION 'Refusing to roll back 0031: mcp_confirmations rows exist and are the record of what users approved';
  END IF;
END $$;

DELETE FROM "permissions" WHERE "resource" = 'mcp' AND "action" = 'read_registry';

DROP INDEX IF EXISTS "mcp_confirmation_parameters_confirmation_label_uq";
DROP INDEX IF EXISTS "mcp_confirmation_parameters_mcp_confirmation_id_idx";
DROP TABLE IF EXISTS "mcp_confirmation_parameters";

DROP INDEX IF EXISTS "mcp_confirmations_expires_at_idx";
DROP INDEX IF EXISTS "mcp_confirmations_user_id_idx";
DROP TABLE IF EXISTS "mcp_confirmations";
