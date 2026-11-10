-- Down migration for 0011_add_request_columns —
-- docs/specs/2026-08-28-015-request-creation-lifecycle.md (spec 015).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0011_add_request_columns added, in reverse order, and nothing else.
--
-- The baseline `requests`, `request_attachments` and `request_field_values` tables survive, since spec 015
-- only extended them. Later specs' request transitions are removed by their own down migrations first.
-- The four transitions this migration seeded.
DELETE FROM "requests_status_transitions"
  WHERE ("from_status", "to_status") IN (('draft', 'submitted'), ('submitted', 'cancelled'), ('matching', 'cancelled'), ('offers_open', 'cancelled'));

-- Constraints first: dropping a column that a CHECK references would otherwise fail.
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_budget_positive_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_budget_currency_match_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_budget_order_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_budget_pair_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_urgency_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_status_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_budget_max_currency_format_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_budget_max_pair_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_budget_min_currency_format_ck";
ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_budget_min_pair_ck";

DROP INDEX IF EXISTS "requests_customer_idempotency_key_uq";
DROP INDEX IF EXISTS "requests_status_idx";
DROP INDEX IF EXISTS "requests_address_id_idx";
DROP INDEX IF EXISTS "request_attachments_file_asset_id_idx";

ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "requests_address_id_addresses_id_fk";
ALTER TABLE "request_attachments" DROP CONSTRAINT IF EXISTS "request_attachments_file_asset_id_file_assets_id_fk";

ALTER TABLE "requests" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "urgency";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "address_id";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "preferred_timezone";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "preferred_at";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "budget_max_currency_code";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "budget_max_amount_minor_units";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "budget_min_currency_code";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "budget_min_amount_minor_units";
ALTER TABLE "requests" DROP COLUMN IF EXISTS "description";
ALTER TABLE "request_field_values" DROP COLUMN IF EXISTS "value";
ALTER TABLE "request_attachments" DROP COLUMN IF EXISTS "file_asset_id";
