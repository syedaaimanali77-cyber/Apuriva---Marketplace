-- Down migration for 0023_add_file_assets —
-- docs/specs/2026-08-28-027-file-uploads-media-storage.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0023
-- added and nothing else; the two baseline skeletons (and their spec 003 indexes and foreign keys),
-- spec 015's `request_attachments` and spec 008's export references all stay.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. Dropping `storage_key` would ORPHAN stored bytes with
-- nothing left pointing at them, and dropping `status`/`scan_outcome` would destroy the record of
-- what was scanned and what was rejected. This file is therefore GATED: it is safe only before the
-- first real upload exists. Once one does, the correct response to a defect is a forward fix.
--
-- Note it does NOT refuse on spec 008's bare export rows: those carry no `storage_key` (their bytes
-- are keyed separately by the storage port) and predate every column dropped here, so they survive
-- the rollback exactly as they were, which is the whole point of AC-10.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "file_assets" WHERE "storage_key" IS NOT NULL) THEN
    RAISE EXCEPTION 'Refusing to roll back 0023: uploaded file assets exist and their stored bytes would be orphaned';
  END IF;
  IF EXISTS (SELECT 1 FROM "message_attachments") THEN
    RAISE EXCEPTION 'Refusing to roll back 0023: message attachments exist and must be retained';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "file_assets_terminal_trg" ON "file_assets";
DROP FUNCTION IF EXISTS enforce_file_assets_terminal();

DROP INDEX IF EXISTS "file_assets_purge_idx";
DROP INDEX IF EXISTS "file_assets_scan_due_idx";
DROP INDEX IF EXISTS "file_assets_owner_idx";
DROP INDEX IF EXISTS "file_assets_context_idx";
DROP INDEX IF EXISTS "file_assets_owner_idempotency_uq";
DROP INDEX IF EXISTS "file_assets_storage_key_uq";

ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_scan_attempts_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_size_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_ready_requires_object_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_ready_requires_clean_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_rejected_pairing_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_ready_pairing_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_pairing_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_context_type_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_scan_outcome_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_status_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_visibility_ck";
ALTER TABLE "file_assets" DROP CONSTRAINT IF EXISTS "file_assets_kind_ck";

DROP INDEX IF EXISTS "message_attachments_file_asset_id_idx";
ALTER TABLE "message_attachments" DROP CONSTRAINT IF EXISTS "message_attachments_file_asset_id_file_assets_id_fk";
ALTER TABLE "message_attachments" DROP COLUMN IF EXISTS "file_asset_id";

ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "legal_hold";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "storage_deleted_at";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "ready_at";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "rejection_reason";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "scan_next_attempt_at";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "scan_attempts";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "scan_outcome";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "context_id";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "context_type";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "checksum_sha256";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "file_name";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "size_bytes";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "mime_type";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "storage_key";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "status";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "visibility";
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "kind";
