-- Down migration for 0034_implement_audit_log —
-- docs/specs/2026-08-28-039-audit-logging.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0034
-- added: the triggers and their function, the added columns/constraints/indexes (returning
-- `audit_logs` to spec 003's stub) and spec 039's own permission rows. Role assignments are untouched.
--
-- PRE-LAUNCH ONLY. Dropping the columns DESTROYS STORED AUDIT CONTENT. Never run this once real audit
-- data exists. Revert the deploy FIRST, so no running code still writes to these columns.

DROP TRIGGER IF EXISTS audit_logs_no_truncate_trg ON "audit_logs";
DROP TRIGGER IF EXISTS audit_logs_append_only_trg ON "audit_logs";
DROP FUNCTION IF EXISTS enforce_audit_logs_append_only();

DELETE FROM "permissions" WHERE "resource" = 'audit_logs' AND "action" = 'read';

DROP INDEX IF EXISTS "audit_logs_approval_ref_idx";
DROP INDEX IF EXISTS "audit_logs_event_type_created_at_idx";
DROP INDEX IF EXISTS "audit_logs_correlation_id_idx";
DROP INDEX IF EXISTS "audit_logs_target_idx";
DROP INDEX IF EXISTS "audit_logs_resource_created_at_idx";
DROP INDEX IF EXISTS "audit_logs_created_at_idx";

ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_approval_ref_admin_actions_id_fk";

ALTER TABLE "audit_logs"
	DROP COLUMN IF EXISTS "correlation_id",
	DROP COLUMN IF EXISTS "is_emergency_bypass",
	DROP COLUMN IF EXISTS "approval_chain",
	DROP COLUMN IF EXISTS "approval_ref",
	DROP COLUMN IF EXISTS "after_value",
	DROP COLUMN IF EXISTS "before_value",
	DROP COLUMN IF EXISTS "reason",
	DROP COLUMN IF EXISTS "target_id",
	DROP COLUMN IF EXISTS "target_type",
	DROP COLUMN IF EXISTS "action",
	DROP COLUMN IF EXISTS "resource",
	DROP COLUMN IF EXISTS "event_type",
	DROP COLUMN IF EXISTS "actor_roles",
	DROP COLUMN IF EXISTS "actor_type";
