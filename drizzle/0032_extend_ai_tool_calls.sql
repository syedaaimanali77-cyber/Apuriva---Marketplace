-- ---------------------------------------------------------------------------
-- Spec 036 — MCP Tool Catalog, Idempotency & Errors
-- ---------------------------------------------------------------------------
-- Extends the spec 003 baseline `ai_tool_calls` skeleton (drizzle/0001_baseline_schema.sql:
-- `baseColumns()` + `ai_action_id`) with spec 036 §4's columns. THIS MIGRATION CREATES NO TABLE
-- and touches no other table: `ai_actions` stays spec 034's, `mcp_confirmations` /
-- `mcp_confirmation_parameters` stay spec 035's (spec 036 reuses them without altering them).
--
-- Additive only. `input_params` is NOT NULL, so it is added with a temporary empty-object default
-- — any pre-existing row stays valid — and the default is then dropped, so every new row must
-- state its own redacted input. Nothing wrote `ai_tool_calls` before spec 036, so no backfill.
--
-- jsonb (spec 003 AC-5 exception, registered in lib/db/schema-lint.test.ts): `input_params` and
-- `output_summary` hold spec 036's minimal REDACTED structure — IDs, enum values, minor-unit
-- amounts with currency, timestamps, booleans, and free-text field NAMES only. Read back whole for
-- the AI data export, never queried or filtered on in SQL.

ALTER TABLE "ai_tool_calls" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD COLUMN "input_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ALTER COLUMN "input_params" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD COLUMN "output_summary" jsonb;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD COLUMN "retried_from_call_id" uuid;--> statement-breakpoint

ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_retried_from_call_id_ai_tool_calls_id_fk" FOREIGN KEY ("retried_from_call_id") REFERENCES "public"."ai_tool_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_tool_calls_retried_from_call_id_idx" ON "ai_tool_calls" USING btree ("retried_from_call_id");
