-- Spec 027 §4 "Migration" — docs/specs/2026-08-28-027-file-uploads-media-storage.md.
--
-- `file_assets` and `message_attachments` are spec 003 BASELINE skeletons — this migration ALTERS
-- them and adds NO TABLE. `request_attachments` (spec 015) is already correct and is not touched.
-- `0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.
-- Number: `_journal.json`'s head was `0022_add_notifications` (spec 026), so this is 0023.
--
-- Precondition: `message_attachments` gets a NOT NULL column, so it must be empty — spec 025 left
-- that table untouched, so it is. There is deliberately NO guard on `file_assets`: spec 008 has
-- always inserted a bare row per export artifact (owner id only) and must keep working UNCHANGED
-- (AC-10), which is why every column added there is nullable or defaulted. No backfill; no existing
-- row is modified; such a row simply reads as a private, pending, context-less document — exactly
-- what it is.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "message_attachments") THEN
    RAISE EXCEPTION '0023_add_file_assets requires an empty message_attachments';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "kind" text DEFAULT 'document' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "file_name" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "checksum_sha256" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "context_type" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "context_id" uuid;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "scan_outcome" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "scan_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "scan_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "storage_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "legal_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "file_assets" ADD COLUMN "idempotency_fingerprint" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN "file_asset_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_file_asset_id_file_assets_id_fk" FOREIGN KEY ("file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- C-13: spec 003's covering-index-per-FK rule.
CREATE INDEX "message_attachments_file_asset_id_idx" ON "message_attachments" USING btree ("file_asset_id");--> statement-breakpoint
-- C-1 / AC-7: closed vocabularies at the database, not merely in TypeScript.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_kind_ck" CHECK ("file_assets"."kind" in ('image','video','document'));--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_visibility_ck" CHECK ("file_assets"."visibility" in ('public','private'));--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_status_ck" CHECK ("file_assets"."status" in ('pending','scanning','ready','rejected'));--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_scan_outcome_ck" CHECK ("file_assets"."scan_outcome" is null or "file_assets"."scan_outcome" in ('clean','rejected','unknown'));--> statement-breakpoint
-- C-2 / AC-8: the seven-value context vocabulary. Being SPELLABLE here is not being USABLE: an
-- upload is accepted only while a context policy is registered (lib/files/contexts/registry.ts).
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_type_ck" CHECK ("file_assets"."context_type" is null or "file_assets"."context_type" in ('request_attachment','message_attachment','portfolio','data_export','booking_evidence','dispute_evidence','verification_document'));--> statement-breakpoint
-- C-3: a context id without a type would be unauthorizable.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_context_pairing_ck" CHECK ("file_assets"."context_id" is null or "file_assets"."context_type" is not null);--> statement-breakpoint
-- C-4: a ready asset always has its instant, and only a ready asset has one.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_ready_pairing_ck" CHECK (("file_assets"."status" = 'ready') = ("file_assets"."ready_at" is not null));--> statement-breakpoint
-- C-5: a rejection always says why.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_rejected_pairing_ck" CHECK (("file_assets"."status" = 'rejected') = ("file_assets"."rejection_reason" is not null));--> statement-breakpoint
-- C-6 / AC-4 AT THE DATABASE: nothing can be `ready` without a clean scan. This is the one
-- constraint that makes "never ready on a guess" true independently of application code.
-- `IS NOT DISTINCT FROM` rather than `=` on purpose: a CHECK is satisfied when it evaluates to
-- NULL, so `status <> 'ready' OR scan_outcome = 'clean'` would ADMIT a `ready` row whose
-- `scan_outcome` is NULL (false OR NULL = NULL) — i.e. exactly the unscanned file this constraint
-- exists to refuse.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_ready_requires_clean_ck" CHECK ("file_assets"."status" <> 'ready' or "file_assets"."scan_outcome" IS NOT DISTINCT FROM 'clean');--> statement-breakpoint
-- C-7: a ready asset always has a real object behind it.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_ready_requires_object_ck" CHECK ("file_assets"."status" <> 'ready' or ("file_assets"."storage_key" is not null and "file_assets"."size_bytes" is not null and "file_assets"."mime_type" is not null));--> statement-breakpoint
-- C-8: sanity.
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_size_ck" CHECK ("file_assets"."size_bytes" is null or "file_assets"."size_bytes" >= 0);--> statement-breakpoint
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_scan_attempts_ck" CHECK ("file_assets"."scan_attempts" >= 0);--> statement-breakpoint
-- C-9: one object per asset — a replayed upload cannot collide with another asset's bytes.
CREATE UNIQUE INDEX "file_assets_storage_key_uq" ON "file_assets" USING btree ("storage_key") WHERE "file_assets"."storage_key" is not null;--> statement-breakpoint
-- C-10: spec 015's per-entity idempotency shape, scoped to the owner.
CREATE UNIQUE INDEX "file_assets_owner_idempotency_uq" ON "file_assets" USING btree ("uploaded_by_user_id","idempotency_key") WHERE "file_assets"."idempotency_key" is not null;--> statement-breakpoint
-- C-11: the context count check, the owner list, and the sweep's two claim paths.
CREATE INDEX "file_assets_context_idx" ON "file_assets" USING btree ("context_type","context_id");--> statement-breakpoint
CREATE INDEX "file_assets_owner_idx" ON "file_assets" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "file_assets_scan_due_idx" ON "file_assets" USING btree ("status","scan_next_attempt_at");--> statement-breakpoint
CREATE INDEX "file_assets_purge_idx" ON "file_assets" USING btree ("deleted_at") WHERE "file_assets"."storage_deleted_at" is null;--> statement-breakpoint
-- C-12 / AC-7: TERMINALITY, enforced independently of application code (master §132.18), the same
-- trigger idiom spec 026 used for `notifications.read_at`. Once an asset is `ready` or `rejected`,
-- its identity and verdict are frozen: only the deletion/retention columns, the file name (for
-- redaction) and the audit/concurrency columns may still move. A rejected file is therefore never
-- re-admitted by convention — it is never re-admitted at all.
CREATE OR REPLACE FUNCTION enforce_file_assets_terminal() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('ready','rejected') THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
       OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
       OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
       OR NEW.visibility IS DISTINCT FROM OLD.visibility
       OR NEW.context_type IS DISTINCT FROM OLD.context_type
       OR NEW.context_id IS DISTINCT FROM OLD.context_id THEN
      RAISE EXCEPTION 'file_assets row % is terminal (%) and may not change status, storage_key, mime_type, size_bytes, visibility or context', OLD.id, OLD.status USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "file_assets_terminal_trg" BEFORE UPDATE ON "file_assets"
FOR EACH ROW EXECUTE FUNCTION enforce_file_assets_terminal();
