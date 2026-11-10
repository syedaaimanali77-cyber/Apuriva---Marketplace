-- Down migration for 0014_add_offer_system_timer —
-- docs/specs/2026-08-28-018-offer-system-timer.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0014
-- added; the spec 003 baseline `offers` table itself survives, since spec 018 only extended it.
-- Nothing here touches `bookings`, `offer_revisions`, `offer_messages` or any spec 016/017 table.

DELETE FROM "requests_status_transitions"
  WHERE ("from_status", "to_status") IN (('matching', 'offers_open'), ('offers_open', 'provider_selected'));
DELETE FROM "offers_status_transitions"
  WHERE ("from_status", "to_status") IN (
    ('draft', 'sent'), ('sent', 'viewed'), ('sent', 'accepted'), ('viewed', 'accepted'),
    ('sent', 'declined'), ('viewed', 'declined'), ('sent', 'withdrawn'), ('viewed', 'withdrawn'),
    ('sent', 'expired'), ('viewed', 'expired')
  );

ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_accept_key_pairing_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_decided_pairing_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_two_minute_window_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_sent_expires_pair_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_draft_unsent_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_estimated_duration_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_status_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_price_positive_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_price_currency_format_ck";
ALTER TABLE "offers" DROP CONSTRAINT IF EXISTS "offers_price_pair_ck";

DROP INDEX IF EXISTS "offers_request_sent_at_idx";
DROP INDEX IF EXISTS "offers_status_expires_at_idx";
DROP INDEX IF EXISTS "offers_request_accepted_uq";
DROP INDEX IF EXISTS "offers_request_provider_live_uq";
DROP INDEX IF EXISTS "offers_provider_idempotency_key_uq";

ALTER TABLE "offers" DROP COLUMN IF EXISTS "accept_idempotency_key";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "decided_at";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "viewed_at";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "expires_at";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "sent_at";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "estimated_duration_minutes";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "provider_message";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "included_items";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "price_currency_code";
ALTER TABLE "offers" DROP COLUMN IF EXISTS "price_amount_minor_units";
