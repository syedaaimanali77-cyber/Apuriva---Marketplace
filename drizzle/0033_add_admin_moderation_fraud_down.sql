-- Down migration for 0033_add_admin_moderation_fraud —
-- docs/specs/2026-08-28-038-admin-moderation-fraud-abuse.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0033
-- added and nothing else: the three spec 038 tables, the `moderation_evidence` context value and
-- spec 038's own permission rows. Role assignments are untouched.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. Lifecycle values already written by spec 038 stay as
-- they are and must be reported — nothing here reverts them silently. Revert the deploy FIRST, so
-- no running code still reads these tables.
--
-- `moderation_evidence` assets must be re-homed or removed before the narrower context constraint
-- can be restored; the guard below refuses rather than silently leaving rows the CHECK rejects.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "file_assets" WHERE "context_type" = 'moderation_evidence') THEN
    RAISE EXCEPTION 'Refusing to roll back 0033: moderation_evidence file assets exist';
  END IF;
END $$;

DELETE FROM "permissions" WHERE "resource" = 'moderation' AND "action" IN ('read','warn','restrict','suspend','ban','intervene_booking','freeze_payout','reverse','review_appeal');
DELETE FROM "permissions" WHERE "resource" = 'fraud_signals' AND "action" IN ('read','triage');

ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("context_type" IS NULL OR "context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document','review_media','safety_evidence','support_attachment'));

DROP TABLE IF EXISTS "moderation_appeals";
DROP TABLE IF EXISTS "moderation_actions";
DROP TABLE IF EXISTS "fraud_signals";
