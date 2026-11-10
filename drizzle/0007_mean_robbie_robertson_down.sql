-- Down migration for 0007_mean_robbie_robertson —
-- docs/specs/2026-08-28-011-category-service-pages-requirements.md (spec 011).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0007_mean_robbie_robertson added, in reverse order, and nothing else.
--
-- The baseline `service_faqs`, `service_fields`, `service_packages` and `service_requirements` tables
-- survive, since spec 011 only extended them.
-- This migration's own Permission seed for content_admin (spec 011 §3).
DELETE FROM "permissions"
  WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "name" = 'content_admin')
    AND ("resource", "action") IN (('catalog.service_field', 'create'), ('catalog.service_faq', 'create'), ('catalog.service_faq', 'approve'));

-- The representative field and media requirement this migration seeded on each of 0006's eight services.
DELETE FROM "service_requirements"
  WHERE "kind" = 'media'
    AND "detail" = '{"helpText": "Adding a few photos helps providers give you a more accurate quote."}'::jsonb
    AND "service_id" IN (SELECT "id" FROM "services" WHERE "slug" IN (
      'general-home-repair', 'home-cleaning', 'personal-grooming', 'event-photography',
      'local-moving', 'event-planning', 'car-maintenance', 'general-consulting'));
DELETE FROM "service_fields"
  WHERE "key" = 'details'
    AND "service_id" IN (SELECT "id" FROM "services" WHERE "slug" IN (
      'general-home-repair', 'home-cleaning', 'personal-grooming', 'event-photography',
      'local-moving', 'event-planning', 'car-maintenance', 'general-consulting'));

-- Constraints first: dropping a column that a CHECK references would otherwise fail.
ALTER TABLE "service_requirements" DROP CONSTRAINT IF EXISTS "service_requirements_kind_ck";
ALTER TABLE "service_packages" DROP CONSTRAINT IF EXISTS "service_packages_currency_format_ck";
ALTER TABLE "service_fields" DROP CONSTRAINT IF EXISTS "service_fields_type_ck";
ALTER TABLE "service_faqs" DROP CONSTRAINT IF EXISTS "service_faqs_status_ck";
ALTER TABLE "service_faqs" DROP CONSTRAINT IF EXISTS "service_faqs_source_ck";

DROP INDEX IF EXISTS "service_packages_provider_profile_id_idx";
DROP INDEX IF EXISTS "service_fields_service_id_key_uq";
DROP INDEX IF EXISTS "service_faqs_provider_profile_id_idx";
ALTER TABLE "service_packages" DROP CONSTRAINT IF EXISTS "service_packages_provider_profile_id_provider_profiles_id_fk";
ALTER TABLE "service_faqs" DROP CONSTRAINT IF EXISTS "service_faqs_provider_profile_id_provider_profiles_id_fk";

ALTER TABLE "service_requirements" DROP COLUMN IF EXISTS "detail";
ALTER TABLE "service_requirements" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "service_packages" DROP COLUMN IF EXISTS "included_items";
ALTER TABLE "service_packages" DROP COLUMN IF EXISTS "currency_code";
ALTER TABLE "service_packages" DROP COLUMN IF EXISTS "amount_minor_units";
ALTER TABLE "service_packages" DROP COLUMN IF EXISTS "description";
ALTER TABLE "service_packages" DROP COLUMN IF EXISTS "name";
ALTER TABLE "service_packages" DROP COLUMN IF EXISTS "provider_profile_id";
ALTER TABLE "service_fields" DROP COLUMN IF EXISTS "sort_order";
ALTER TABLE "service_fields" DROP COLUMN IF EXISTS "validation";
ALTER TABLE "service_fields" DROP COLUMN IF EXISTS "options";
ALTER TABLE "service_fields" DROP COLUMN IF EXISTS "required";
ALTER TABLE "service_fields" DROP COLUMN IF EXISTS "type";
ALTER TABLE "service_fields" DROP COLUMN IF EXISTS "label";
ALTER TABLE "service_fields" DROP COLUMN IF EXISTS "key";
ALTER TABLE "service_faqs" DROP COLUMN IF EXISTS "status";
ALTER TABLE "service_faqs" DROP COLUMN IF EXISTS "source";
ALTER TABLE "service_faqs" DROP COLUMN IF EXISTS "answer";
ALTER TABLE "service_faqs" DROP COLUMN IF EXISTS "question";
ALTER TABLE "service_faqs" DROP COLUMN IF EXISTS "provider_profile_id";
