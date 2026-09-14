-- Down migration for 0015_add_offer_negotiation_comparison —
-- docs/specs/2026-08-28-019-offer-negotiation-comparison.md §4 "Migration" / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0015
-- added. Like 0014's down (which drops offer price columns), rollback DISCARDS the negotiation data those
-- columns held: every offer_messages / offer_revisions row is deleted, because without their content
-- columns the rows are meaningless. Offer rows already stored as `revised` remain valid under spec 018's
-- `offers_status_ck`, which already allows `revised`. Nothing here touches `bookings` or any other table.

DROP TRIGGER IF EXISTS "offer_revisions_append_only_trg" ON "offer_revisions";
DROP FUNCTION IF EXISTS enforce_offer_revisions_append_only();
DROP TRIGGER IF EXISTS "offers_terms_immutable_trg" ON "offers";
DROP FUNCTION IF EXISTS enforce_offer_terms_immutable();

DELETE FROM "offers_status_transitions"
  WHERE ("from_status", "to_status") IN (('sent', 'revised'), ('viewed', 'revised'));

DELETE FROM "offer_revisions";
DELETE FROM "offer_messages";

ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_same_currency_ck";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_prices_positive_ck";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_new_price_currency_format_ck";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_new_price_pair_ck";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_previous_price_currency_format_ck";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_previous_price_pair_ck";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_distinct_offers_ck";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_number_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_proposed_price_positive_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_proposed_price_currency_format_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_proposed_price_pair_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_change_request_sender_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_proposed_price_kind_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_change_request_offer_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_body_length_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_kind_ck";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_sender_role_ck";

DROP INDEX IF EXISTS "offer_revisions_request_provider_number_uq";
DROP INDEX IF EXISTS "offer_revisions_change_request_message_id_idx";
DROP INDEX IF EXISTS "offer_revisions_actor_user_id_idx";
DROP INDEX IF EXISTS "offer_revisions_provider_profile_id_idx";
DROP INDEX IF EXISTS "offer_revisions_request_id_idx";
DROP INDEX IF EXISTS "offer_revisions_new_offer_id_uq";
DROP INDEX IF EXISTS "offer_revisions_offer_id_uq";
DROP INDEX IF EXISTS "offer_messages_change_request_per_offer_uq";
DROP INDEX IF EXISTS "offer_messages_sender_idempotency_key_uq";
DROP INDEX IF EXISTS "offer_messages_thread_created_at_idx";
DROP INDEX IF EXISTS "offer_messages_provider_profile_id_idx";
DROP INDEX IF EXISTS "offer_messages_request_id_idx";

ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_change_request_message_id_offer_messages_id_fk";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_actor_user_id_users_id_fk";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_provider_profile_id_provider_profiles_id_fk";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_request_id_requests_id_fk";
ALTER TABLE "offer_revisions" DROP CONSTRAINT IF EXISTS "offer_revisions_new_offer_id_offers_id_fk";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_provider_profile_id_provider_profiles_id_fk";
ALTER TABLE "offer_messages" DROP CONSTRAINT IF EXISTS "offer_messages_request_id_requests_id_fk";

ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "change_request_message_id";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "actor_user_id";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "new_price_currency_code";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "new_price_amount_minor_units";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "previous_price_currency_code";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "previous_price_amount_minor_units";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "revision_number";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "provider_profile_id";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "request_id";
ALTER TABLE "offer_revisions" DROP COLUMN IF EXISTS "new_offer_id";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "idempotency_fingerprint";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "proposed_price_currency_code";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "proposed_price_amount_minor_units";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "contact_redacted";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "body";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "sender_role";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "provider_profile_id";
ALTER TABLE "offer_messages" DROP COLUMN IF EXISTS "request_id";

ALTER TABLE "offer_messages" ALTER COLUMN "offer_id" SET NOT NULL;
