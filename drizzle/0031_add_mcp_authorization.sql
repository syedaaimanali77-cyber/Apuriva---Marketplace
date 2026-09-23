-- ---------------------------------------------------------------------------
-- Spec 035 — MCP Tool Architecture & Authorization
-- ---------------------------------------------------------------------------
-- Adds this spec's own confirmation record (§4, AC-3) and its Permission seed. It creates NO
-- audit table: spec 039 owns the audit log's schema and this spec writes through a port until
-- then (§4 "Audit sink").
--
-- `ai_actions` IS NOT TOUCHED. That table stays wholly spec 034's; the two specs are linked only
-- by the opaque id spec 034 carries as `confirmationId`.
--
-- The bound parameters are a child table rather than one `jsonb` column: they are the exact
-- values the user approved and the pipeline compares against, which is core data, and spec 003
-- AC-5 reserves `jsonb` for genuinely variable service-specific attributes.

-- ---------------------------------------------------------------------------
-- mcp_confirmations — one binding, issued when a medium/high action is proposed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "mcp_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"risk_tier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "mcp_confirmations" ADD CONSTRAINT "mcp_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_confirmations_user_id_idx" ON "mcp_confirmations" USING btree ("user_id");--> statement-breakpoint
-- The expiry sweep and every staleness check read by this column.
CREATE INDEX IF NOT EXISTS "mcp_confirmations_expires_at_idx" ON "mcp_confirmations" USING btree ("expires_at");--> statement-breakpoint
-- Only medium and high are ever confirmed: `low` executes without one and `restricted` is refused
-- before a confirmation could exist (spec 034's risk policy).
ALTER TABLE "mcp_confirmations" ADD CONSTRAINT "mcp_confirmations_risk_tier_ck" CHECK ("mcp_confirmations"."risk_tier" in ('medium','high'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- mcp_confirmation_parameters — the exact parameters bound, in display order (master spec §90)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "mcp_confirmation_parameters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"mcp_confirmation_id" uuid NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint

ALTER TABLE "mcp_confirmation_parameters" ADD CONSTRAINT "mcp_confirmation_parameters_mcp_confirmation_id_mcp_confirmations_id_fk" FOREIGN KEY ("mcp_confirmation_id") REFERENCES "public"."mcp_confirmations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_confirmation_parameters_mcp_confirmation_id_idx" ON "mcp_confirmation_parameters" USING btree ("mcp_confirmation_id");--> statement-breakpoint
-- A label appears at most once per binding: two values for the same label would make "did this
-- parameter change?" ambiguous, and AC-3 has to answer it exactly.
CREATE UNIQUE INDEX IF NOT EXISTS "mcp_confirmation_parameters_confirmation_label_uq" ON "mcp_confirmation_parameters" USING btree ("mcp_confirmation_id","label");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Spec 035 §3 "Admin surface" — this spec's own Permission seed
-- ---------------------------------------------------------------------------
-- `low`: read-only metadata, so no second-admin approval (spec 009 requires one at high/critical).
-- Super Admin only — the registry is a map of everything the assistant can do, including which
-- effects cannot be undone, which is platform-security information rather than routine admin work.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", 'mcp', 'read_registry', 'low'
FROM "roles" r
WHERE r."name" IN ('super_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
