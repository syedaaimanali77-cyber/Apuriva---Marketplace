-- Down migration for 0006_lean_shaman —
-- docs/specs/2026-08-28-010-service-catalog-taxonomy.md (spec 010).
--
-- Hand-written (spec 046 AC-3): drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; it is run only by a human, per
-- docs/operations runbooks. Reverses exactly what 0006_lean_shaman added, in reverse order, and nothing else.
--
-- The baseline `categories`, `subcategories` and `services` tables survive, since spec 010 only extended
-- them. 0007's catalog grants and fields are removed by its own down migration first. Deleting the seeded
-- catalog fails (ON DELETE restrict) while any request, booking or provider row still references it —
-- deliberately: a rollback must never silently orphan live data.
-- This migration's own Permission seed for content_admin (spec 010 §3).
DELETE FROM "permissions"
  WHERE "role_id" IN (SELECT "id" FROM "roles" WHERE "name" = 'content_admin')
    AND ("resource", "action") IN (
      ('catalog.category', 'view'), ('catalog.category', 'create'), ('catalog.category', 'edit'), ('catalog.category', 'retire'),
      ('catalog.subcategory', 'view'), ('catalog.subcategory', 'create'), ('catalog.subcategory', 'edit'), ('catalog.subcategory', 'retire'),
      ('catalog.service', 'view'), ('catalog.service', 'create'), ('catalog.service', 'edit'), ('catalog.service', 'retire'),
      ('catalog.suggestion', 'view'), ('catalog.suggestion', 'approve'), ('catalog.suggestion', 'reject')
    );

-- The eight placeholder services and eight MVP categories this migration seeded (spec 010 §8 risk #1).
DELETE FROM "services"
  WHERE "slug" IN ('general-home-repair', 'home-cleaning', 'personal-grooming', 'event-photography', 'local-moving', 'event-planning', 'car-maintenance', 'general-consulting');
DELETE FROM "categories"
  WHERE "slug" IN ('home-repair-maintenance', 'cleaning', 'beauty-wellness', 'photography-video', 'moving-delivery', 'events', 'automotive', 'personal-professional-services');

-- Constraints first: dropping a column that a CHECK references would otherwise fail.
ALTER TABLE "subcategories" DROP CONSTRAINT IF EXISTS "subcategories_status_ck";
ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "services_status_ck";
ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "services_pricing_model_ck";
ALTER TABLE "categories" DROP CONSTRAINT IF EXISTS "categories_status_ck";

DROP INDEX IF EXISTS "subcategories_category_id_slug_uq";
DROP INDEX IF EXISTS "services_slug_uq";
DROP INDEX IF EXISTS "services_category_id_idx";
DROP INDEX IF EXISTS "categories_slug_uq";
ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "services_category_id_categories_id_fk";

-- The table this migration created (its indexes and foreign keys go with it).
DROP TABLE IF EXISTS "catalog_suggestions";

ALTER TABLE "subcategories" DROP COLUMN IF EXISTS "status";
ALTER TABLE "subcategories" DROP COLUMN IF EXISTS "slug";
ALTER TABLE "subcategories" DROP COLUMN IF EXISTS "name";
ALTER TABLE "services" DROP COLUMN IF EXISTS "metadata";
ALTER TABLE "services" DROP COLUMN IF EXISTS "status";
ALTER TABLE "services" DROP COLUMN IF EXISTS "pricing_model";
ALTER TABLE "services" DROP COLUMN IF EXISTS "slug";
ALTER TABLE "services" DROP COLUMN IF EXISTS "name";
ALTER TABLE "services" DROP COLUMN IF EXISTS "category_id";
ALTER TABLE "categories" DROP COLUMN IF EXISTS "sort_order";
ALTER TABLE "categories" DROP COLUMN IF EXISTS "status";
ALTER TABLE "categories" DROP COLUMN IF EXISTS "slug";
ALTER TABLE "categories" DROP COLUMN IF EXISTS "name";

-- The baseline's NOT NULL on services.subcategory_id. Fails while any service has no subcategory, which a
-- rollback must resolve by hand rather than by inventing a subcategory.
ALTER TABLE "services" ALTER COLUMN "subcategory_id" SET NOT NULL;
