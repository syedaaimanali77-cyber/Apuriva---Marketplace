-- Spec 010 §4: Category/Subcategory/Service gain their real columns (the spec 003 baseline only
-- had id/audit/version + structural FKs); CatalogSuggestion is new. Hand-edited after
-- `drizzle-kit generate` (per lib/db/schema.ts's convention for anything the DSL can't express):
-- the generated `ADD COLUMN ... NOT NULL` statements for `name`/`slug`/`category_id` are unsafe
-- against this environment's existing `categories`/`subcategories`/`services` rows (populated by
-- other specs' integration-test fixtures, e.g. lib/db/test-support.ts's `seedMinimalRequest`), so
-- each is added nullable, backfilled, then constrained NOT NULL — never a blind NOT NULL add that
-- would fail (or silently truncate) against live rows. Reviewed in PR.

CREATE TABLE "catalog_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"entity_type" text NOT NULL,
	"proposed_name" text NOT NULL,
	"proposed_slug" text NOT NULL,
	"category_id" uuid,
	"subcategory_id" uuid,
	"pricing_model" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rationale" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"resulting_entity_id" uuid,
	CONSTRAINT "catalog_suggestions_entity_type_ck" CHECK ("catalog_suggestions"."entity_type" in ('category','subcategory','service')),
	CONSTRAINT "catalog_suggestions_status_ck" CHECK ("catalog_suggestions"."status" in ('pending_review','approved','rejected')),
	CONSTRAINT "catalog_suggestions_pricing_model_ck" CHECK ("catalog_suggestions"."pricing_model" is null or "catalog_suggestions"."pricing_model" in ('fixed','package','hourly','quote','custom'))
);
--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "subcategory_id" DROP NOT NULL;
--> statement-breakpoint

-- categories: name/slug have no safe shared default, so add nullable, backfill, then constrain.
ALTER TABLE "categories" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "categories" SET "name" = 'Untitled', "slug" = 'legacy-' || "id"::text WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint

-- services: category_id backfills from the existing subcategory's category_id (real, correct
-- data — subcategories.category_id already existed and was populated); name/slug backfill same
-- as categories, above.
ALTER TABLE "services" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "pricing_model" text DEFAULT 'quote' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "services" s SET "category_id" = sub."category_id" FROM "subcategories" sub WHERE sub."id" = s."subcategory_id" AND s."category_id" IS NULL;--> statement-breakpoint
UPDATE "services" SET "name" = 'Untitled', "slug" = 'legacy-' || "id"::text WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "category_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint

-- subcategories: same pattern as categories, above.
ALTER TABLE "subcategories" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "subcategories" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "subcategories" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
UPDATE "subcategories" SET "name" = 'Untitled', "slug" = 'legacy-' || "id"::text WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "subcategories" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subcategories" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "catalog_suggestions" ADD CONSTRAINT "catalog_suggestions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_suggestions" ADD CONSTRAINT "catalog_suggestions_subcategory_id_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."subcategories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_suggestions" ADD CONSTRAINT "catalog_suggestions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_suggestions_status_idx" ON "catalog_suggestions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "catalog_suggestions_category_id_idx" ON "catalog_suggestions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "catalog_suggestions_subcategory_id_idx" ON "catalog_suggestions" USING btree ("subcategory_id");--> statement-breakpoint
CREATE INDEX "catalog_suggestions_reviewed_by_idx" ON "catalog_suggestions" USING btree ("reviewed_by");--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "services_category_id_idx" ON "services" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_slug_uq" ON "services" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "subcategories_category_id_slug_uq" ON "subcategories" USING btree ("category_id","slug");--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_status_ck" CHECK ("categories"."status" in ('draft','published','pending_review','retired'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_pricing_model_ck" CHECK ("services"."pricing_model" in ('fixed','package','hourly','quote','custom'));--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_status_ck" CHECK ("services"."status" in ('draft','published','pending_review','retired'));--> statement-breakpoint
ALTER TABLE "subcategories" ADD CONSTRAINT "subcategories_status_ck" CHECK ("subcategories"."status" in ('draft','published','pending_review','retired'));--> statement-breakpoint

-- Spec 010 §8 risk #1 / AC-1: the 8 MVP categories from master spec §14, exactly as named there,
-- seeded `published` (customer-visible from launch) — the initial seed set, not a cap; admins may
-- add more later through the normal admin endpoints. ON CONFLICT on the unique slug makes this
-- safe to re-run on redeploy, matching the seven-roles seed convention in
-- drizzle/0005_add_spec_009_admin_rbac.sql.
INSERT INTO "categories" ("name", "slug", "status", "sort_order") VALUES
	('Home Repair & Maintenance', 'home-repair-maintenance', 'published', 1),
	('Cleaning', 'cleaning', 'published', 2),
	('Beauty & Wellness', 'beauty-wellness', 'published', 3),
	('Photography & Video', 'photography-video', 'published', 4),
	('Moving & Delivery', 'moving-delivery', 'published', 5),
	('Events', 'events', 'published', 6),
	('Automotive', 'automotive', 'published', 7),
	('Personal & Professional Services', 'personal-professional-services', 'published', 8)
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- Spec 010 §8 risk #1: AC-1 requires "one or more services" per category; master spec §14 names
-- only the 8 categories, not a product-approved representative catalog, so this is one clearly
-- generic, minimal placeholder service per category — not a final product seed list (still open,
-- per the spec's own risks/open-questions section). Idempotent via the services slug unique index.
INSERT INTO "services" ("category_id", "name", "slug", "pricing_model", "status")
SELECT c."id", v.name, v.slug, 'quote', 'published'
FROM (VALUES
	('home-repair-maintenance', 'General Home Repair', 'general-home-repair'),
	('cleaning', 'Home Cleaning', 'home-cleaning'),
	('beauty-wellness', 'Personal Grooming', 'personal-grooming'),
	('photography-video', 'Event Photography', 'event-photography'),
	('moving-delivery', 'Local Moving', 'local-moving'),
	('events', 'Event Planning', 'event-planning'),
	('automotive', 'Car Maintenance', 'car-maintenance'),
	('personal-professional-services', 'General Consulting', 'general-consulting')
) AS v(category_slug, name, slug)
JOIN "categories" c ON c."slug" = v.category_slug
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- Spec 010 §3 API contract: this spec's own Permission seed for the Content/Marketplace admin
-- role, per spec 009 §4.3's convention ("each domain spec owns and inserts its own rows here").
-- risk_tier 'low' throughout — spec 010 defines no risk-tiered approval workflow of its own; every
-- catalog mutation resolves via spec 009 §3.1's plain (resource, action) check, never
-- authorizeAndInitiate's high/critical approval branch.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, 'low'
FROM (VALUES
	('catalog.category', 'view'), ('catalog.category', 'create'), ('catalog.category', 'edit'), ('catalog.category', 'retire'),
	('catalog.subcategory', 'view'), ('catalog.subcategory', 'create'), ('catalog.subcategory', 'edit'), ('catalog.subcategory', 'retire'),
	('catalog.service', 'view'), ('catalog.service', 'create'), ('catalog.service', 'edit'), ('catalog.service', 'retire'),
	('catalog.suggestion', 'view'), ('catalog.suggestion', 'approve'), ('catalog.suggestion', 'reject')
) AS v(resource, action)
JOIN "roles" r ON r."name" = 'content_admin'
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;
