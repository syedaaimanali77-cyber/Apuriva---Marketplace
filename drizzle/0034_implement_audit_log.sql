-- Spec 039 — Audit Logging (docs/specs/2026-08-28-039-audit-logging.md §4).
--
-- Completes spec 003's `audit_logs` STUB. The table is ALTERED, never re-created: `0001_baseline`
-- is checksum-locked, and spec 003's schema-lint requires every table to keep `baseColumns()`
-- (`id`, `created_at`, `updated_at`, `version`). `actor_user_id` (FK -> users, RESTRICT, indexed)
-- already exists and is kept.
--
-- Nothing has ever written to `audit_logs`, so the NOT NULL columns below are added to an EMPTY
-- table. If rows unexpectedly exist, this migration fails loudly rather than inventing values.
-- There is NO backfill: admin events written to `security_events` before this spec stay there as
-- history — neither copied nor deleted (§3.4, D-11).
--
-- Immutability (AC-2, D-3) is enforced by TRIGGERS, not grants: the application, the migrator and
-- the tests all connect as one superuser role that owns every table, so a REVOKE would change
-- nothing. The triggers follow the repository's `*_append_only_trg` convention (0017) and raise
-- 23514. Documented limitation: a superuser can still disable triggers (S-1/S-2).

-- ---------------------------------------------------------------------------
-- audit_logs — the durable, append-only audit store
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_logs"
	ADD COLUMN "actor_type" text NOT NULL,
	ADD COLUMN "actor_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	ADD COLUMN "event_type" text NOT NULL,
	ADD COLUMN "resource" text NOT NULL,
	ADD COLUMN "action" text NOT NULL,
	ADD COLUMN "target_type" text,
	ADD COLUMN "target_id" text,
	ADD COLUMN "reason" text,
	ADD COLUMN "before_value" jsonb,
	ADD COLUMN "after_value" jsonb,
	ADD COLUMN "approval_ref" uuid,
	ADD COLUMN "approval_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	ADD COLUMN "is_emergency_bypass" boolean DEFAULT false NOT NULL,
	ADD COLUMN "correlation_id" text;--> statement-breakpoint

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_approval_ref_admin_actions_id_fk" FOREIGN KEY ("approval_ref") REFERENCES "public"."admin_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_type_ck" CHECK ("actor_type" in ('admin','user','system'));--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_pairing_ck" CHECK (("actor_type" = 'system') = ("actor_user_id" is null));--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_roles_array_ck" CHECK (jsonb_typeof("actor_roles") = 'array');--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_event_type_ck" CHECK (char_length("event_type") between 1 and 128);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_resource_ck" CHECK (char_length("resource") between 1 and 64);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_ck" CHECK (char_length("action") between 1 and 64);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_target_pairing_ck" CHECK ("target_id" is null or "target_type" is not null);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_correlation_id_ck" CHECK ("correlation_id" is null or "correlation_id" ~ '^[A-Za-z0-9_-]{1,100}$');--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_resource_created_at_idx" ON "audit_logs" USING btree ("resource", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type", "target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_correlation_id_idx" ON "audit_logs" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_event_type_created_at_idx" ON "audit_logs" USING btree ("event_type", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_approval_ref_idx" ON "audit_logs" USING btree ("approval_ref");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Append-only: UPDATE, DELETE (row) and TRUNCATE (statement) are all refused (AC-2)
-- ---------------------------------------------------------------------------
-- Row triggers do not fire on TRUNCATE, hence the separate statement-level trigger. The test
-- harness (test/db-reset.ts) drops and recreates the database and never truncates.
CREATE OR REPLACE FUNCTION enforce_audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only_trg
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_audit_logs_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate_trg
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT
  EXECUTE FUNCTION enforce_audit_logs_append_only();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- permissions — §3.7, D-2: `audit_logs/read` for all seven existing roles. Holding it only OPENS
-- the log; what each role sees is scoped by `lib/audit/scope.ts`.
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, v.risk_tier
FROM (VALUES
	('audit_logs', 'read', 'low')
) AS v(resource, action, risk_tier)
JOIN "roles" r ON r."name" IN ('super_admin', 'operations_admin', 'support_admin', 'finance_admin', 'trust_safety_admin', 'content_admin', 'analytics_admin')
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
