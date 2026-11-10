-- Down migration for 0019_add_cancellation_policy_no_show —
-- docs/specs/2026-08-28-023-cancellation-policy-no-show.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0019
-- added, and nothing else — it touches no table other than `policies`, `policy_versions`,
-- `policy_acceptances`, `no_show_reports*`, `booking_cancellations`, `provider_services`,
-- `bookings_status_transitions` and `permissions`.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. Once a cancellation has produced a refund, that money
-- cannot be un-moved by any schema change, and `booking_cancellations` / `no_show_reports` are the
-- audit record of a financial consequence and of a Trust & Safety decision — records spec 008
-- requires be retained. This file is safe ONLY before the first cancellation or report exists; the
-- correct response to a defect after that point is a forward fix, and a policy error is corrected
-- by publishing a NEW version, never by rewriting or deleting an old one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "booking_cancellations") OR EXISTS (SELECT 1 FROM "no_show_reports") THEN
    RAISE EXCEPTION 'Refusing to roll back 0019: cancellation/no-show records exist and must be retained';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "no_show_reports_evidence_immutable_trg" ON "no_show_reports";
DROP FUNCTION IF EXISTS enforce_no_show_evidence_immutable();
DROP TRIGGER IF EXISTS "no_show_reports_status_history_append_only_trg" ON "no_show_reports_status_history";
DROP FUNCTION IF EXISTS enforce_no_show_history_append_only();
DROP TRIGGER IF EXISTS "booking_cancellations_immutable_trg" ON "booking_cancellations";
DROP FUNCTION IF EXISTS enforce_booking_cancellation_immutable();
DROP TRIGGER IF EXISTS "policy_acceptances_immutable_trg" ON "policy_acceptances";
DROP FUNCTION IF EXISTS enforce_policy_acceptance_immutable();
DROP TRIGGER IF EXISTS "policy_versions_immutable_trg" ON "policy_versions";
DROP FUNCTION IF EXISTS enforce_policy_version_immutable();
-- Detaches spec 003's shared function from `no_show_reports`. The FUNCTION itself is spec 003's.
DROP TRIGGER IF EXISTS "no_show_reports_status_transition_trg" ON "no_show_reports";

DELETE FROM "permissions" WHERE "resource" = 'no_show_reports' AND "action" IN ('read', 'resolve');
DELETE FROM "permissions" WHERE "resource" = 'cancellation_policy' AND "action" IN ('read', 'configure');

DELETE FROM "bookings_status_transitions"
 WHERE ("from_status", "to_status") IN (
   ('confirmed', 'cancelled'), ('provider_en_route', 'cancelled'), ('arrived', 'cancelled')
 );

DROP TABLE IF EXISTS "booking_cancellations";
DROP TABLE IF EXISTS "no_show_reports_status_history";
DROP TABLE IF EXISTS "no_show_reports_status_transitions";
DROP TABLE IF EXISTS "no_show_reports";

-- The seeded platform default and every version published on top of it.
DELETE FROM "policy_versions" WHERE "policy_id" IN (SELECT "id" FROM "policies" WHERE "type" = 'cancellation');
DELETE FROM "policies" WHERE "type" = 'cancellation';

ALTER TABLE "provider_services" DROP COLUMN IF EXISTS "cancellation_policy_option";

ALTER TABLE "policy_acceptances" DROP CONSTRAINT IF EXISTS "policy_acceptances_config_ck";
ALTER TABLE "policy_acceptances" DROP CONSTRAINT IF EXISTS "policy_acceptances_source_ck";
ALTER TABLE "policy_acceptances" DROP CONSTRAINT IF EXISTS "policy_acceptances_booking_id_bookings_id_fk";
DROP INDEX IF EXISTS "policy_acceptances_booking_uq";
DROP INDEX IF EXISTS "policy_acceptances_booking_idx";
ALTER TABLE "policy_acceptances" DROP COLUMN IF EXISTS "accepted_at";
ALTER TABLE "policy_acceptances" DROP COLUMN IF EXISTS "booking_created_at";
ALTER TABLE "policy_acceptances" DROP COLUMN IF EXISTS "source";
ALTER TABLE "policy_acceptances" DROP COLUMN IF EXISTS "provider_option_key";
ALTER TABLE "policy_acceptances" DROP COLUMN IF EXISTS "accepted_config";
ALTER TABLE "policy_acceptances" DROP COLUMN IF EXISTS "booking_id";
-- Restores the spec 003 baseline index 0019 replaced.
CREATE UNIQUE INDEX IF NOT EXISTS "policy_acceptances_policy_version_user_uq"
  ON "policy_acceptances" USING btree ("policy_version_id","user_id");

ALTER TABLE "policy_versions" DROP CONSTRAINT IF EXISTS "policy_versions_no_overlap_ex";
ALTER TABLE "policy_versions" DROP CONSTRAINT IF EXISTS "policy_versions_config_ck";
ALTER TABLE "policy_versions" DROP CONSTRAINT IF EXISTS "policy_versions_interval_ck";
ALTER TABLE "policy_versions" DROP CONSTRAINT IF EXISTS "policy_versions_created_by_admin_id_admin_profiles_id_fk";
DROP INDEX IF EXISTS "policy_versions_created_by_admin_id_idx";
DROP INDEX IF EXISTS "policy_versions_policy_effective_idx";
ALTER TABLE "policy_versions" DROP COLUMN IF EXISTS "note";
ALTER TABLE "policy_versions" DROP COLUMN IF EXISTS "created_by_admin_id";
ALTER TABLE "policy_versions" DROP COLUMN IF EXISTS "effective_to";
ALTER TABLE "policy_versions" DROP COLUMN IF EXISTS "effective_from";
ALTER TABLE "policy_versions" DROP COLUMN IF EXISTS "config";

ALTER TABLE "policies" DROP CONSTRAINT IF EXISTS "policies_scope_ck";
ALTER TABLE "policies" DROP CONSTRAINT IF EXISTS "policies_type_ck";
DROP INDEX IF EXISTS "policies_active_platform_uq";
DROP INDEX IF EXISTS "policies_active_scope_uq";
DROP INDEX IF EXISTS "policies_scope_idx";
ALTER TABLE "policies" DROP COLUMN IF EXISTS "is_active";
ALTER TABLE "policies" DROP COLUMN IF EXISTS "scope_id";
ALTER TABLE "policies" DROP COLUMN IF EXISTS "scope";
ALTER TABLE "policies" DROP COLUMN IF EXISTS "type";

-- btree_gist is left installed: dropping a shared extension a later migration may rely on is not
-- this migration's to decide, and an unused extension costs nothing.
