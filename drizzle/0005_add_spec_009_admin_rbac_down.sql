-- Down migration for 0005_add_spec_009_admin_rbac —
-- docs/specs/2026-08-28-009-admin-rbac-roles.md (spec 009).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0005_add_spec_009_admin_rbac added, in reverse order, and nothing else.
--
-- The baseline `permissions` and `roles` tables survive, since spec 009 only extended them. Later specs'
-- permission grants are removed by their own down migrations first.
ALTER TABLE "roles" DROP CONSTRAINT IF EXISTS "roles_name_ck";
ALTER TABLE "permissions" DROP CONSTRAINT IF EXISTS "permissions_risk_tier_ck";
ALTER TABLE "roles" DROP CONSTRAINT IF EXISTS "roles_name_unique";
DROP INDEX IF EXISTS "permissions_role_resource_action_uq";
DROP INDEX IF EXISTS "permissions_role_id_idx";
ALTER TABLE "permissions" DROP CONSTRAINT IF EXISTS "permissions_role_id_roles_id_fk";

-- The three tables this migration created, children first.
DROP TABLE IF EXISTS "admin_role_assignments";
DROP TABLE IF EXISTS "admin_action_approvals";
DROP TABLE IF EXISTS "admin_actions";

-- The seven canonical roles this migration seeded (§4.3), removed before the column that names them.
DELETE FROM "roles"
  WHERE "name" IN ('super_admin', 'operations_admin', 'support_admin', 'finance_admin', 'trust_safety_admin', 'content_admin', 'analytics_admin');

ALTER TABLE "roles" DROP COLUMN IF EXISTS "name";
ALTER TABLE "permissions" DROP COLUMN IF EXISTS "risk_tier";
ALTER TABLE "permissions" DROP COLUMN IF EXISTS "action";
ALTER TABLE "permissions" DROP COLUMN IF EXISTS "resource";
ALTER TABLE "permissions" DROP COLUMN IF EXISTS "role_id";
