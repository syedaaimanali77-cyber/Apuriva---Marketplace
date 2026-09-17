-- Down migration for 0022_add_notifications — docs/specs/2026-08-28-026-notifications.md §4 "Migration"
-- / §9 "Rollback".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it. Reverses exactly what 0022 added
-- and nothing else; the two baseline skeletons (and their spec 003 indexes and foreign keys) stay.
--
-- READ §9 "Rollback" BEFORE APPLYING THIS. Notifications are the user's record of what they were told and
-- `marketing_consent_at` is a compliance record. This file is safe ONLY before the first notification or
-- preference row exists. Once one does, the correct response to a defect is a forward fix.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "notifications") OR EXISTS (SELECT 1 FROM "notification_preferences") THEN
    RAISE EXCEPTION 'Refusing to roll back 0022: notifications or notification preferences exist and must be retained';
  END IF;
END $$;

DROP TRIGGER IF EXISTS "notifications_read_at_immutable_trg" ON "notifications";
DROP FUNCTION IF EXISTS enforce_notifications_read_at_immutable();

DROP TABLE IF EXISTS "notification_deliveries";

ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_categories_ck";
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_category_ck";

DROP INDEX IF EXISTS "notifications_unread_idx";
DROP INDEX IF EXISTS "notifications_recipient_created_idx";
DROP INDEX IF EXISTS "notifications_event_key_uq";

ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "marketing_consent_source";
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "marketing_consent_at";
ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "categories";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "read_at";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "event_key";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "params";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "body";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "title";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "type";
ALTER TABLE "notifications" DROP COLUMN IF EXISTS "category";
