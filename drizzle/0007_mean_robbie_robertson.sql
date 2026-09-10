ALTER TABLE "service_faqs" ADD COLUMN "provider_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "service_faqs" ADD COLUMN "question" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_faqs" ADD COLUMN "answer" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_faqs" ADD COLUMN "source" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_faqs" ADD COLUMN "status" text DEFAULT 'pending_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_fields" ADD COLUMN "key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_fields" ADD COLUMN "label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_fields" ADD COLUMN "type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_fields" ADD COLUMN "required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "service_fields" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "service_fields" ADD COLUMN "validation" jsonb;--> statement-breakpoint
ALTER TABLE "service_fields" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_packages" ADD COLUMN "provider_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "service_packages" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_packages" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "service_packages" ADD COLUMN "amount_minor_units" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "service_packages" ADD COLUMN "currency_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_packages" ADD COLUMN "included_items" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_requirements" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "service_requirements" ADD COLUMN "detail" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_faqs" ADD CONSTRAINT "service_faqs_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_packages" ADD CONSTRAINT "service_packages_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_faqs_provider_profile_id_idx" ON "service_faqs" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_fields_service_id_key_uq" ON "service_fields" USING btree ("service_id","key");--> statement-breakpoint
CREATE INDEX "service_packages_provider_profile_id_idx" ON "service_packages" USING btree ("provider_profile_id");--> statement-breakpoint
ALTER TABLE "service_faqs" ADD CONSTRAINT "service_faqs_source_ck" CHECK ("service_faqs"."source" in ('official','provider','ai_suggested'));--> statement-breakpoint
ALTER TABLE "service_faqs" ADD CONSTRAINT "service_faqs_status_ck" CHECK ("service_faqs"."status" in ('published','pending_review'));--> statement-breakpoint
ALTER TABLE "service_fields" ADD CONSTRAINT "service_fields_type_ck" CHECK ("service_fields"."type" in ('text','select','number','boolean','media'));--> statement-breakpoint
ALTER TABLE "service_packages" ADD CONSTRAINT "service_packages_currency_format_ck" CHECK ("service_packages"."currency_code" ~ '^[A-Z]{3}$');--> statement-breakpoint
ALTER TABLE "service_requirements" ADD CONSTRAINT "service_requirements_kind_ck" CHECK ("service_requirements"."kind" in ('media','duration','buffer','verification'));
--> statement-breakpoint

-- Spec 011 §4 Migration: "minor — seed representative fields for the seeded services from spec
-- 010". One generic required field per one of the 8 MVP services (matched by their fixed slugs
-- from drizzle/0006_lean_shaman.sql) — not a product-approved field catalog, just enough that
-- AC-3 (missing required field) has something real to exercise against a seeded service.
-- Idempotent via the (service_id, key) unique index.
INSERT INTO "service_fields" ("service_id", "key", "label", "type", "required", "sort_order")
SELECT s."id", 'details', 'Additional details', 'text', true, 1
FROM "services" s
WHERE s."slug" IN (
	'general-home-repair', 'home-cleaning', 'personal-grooming', 'event-photography',
	'local-moving', 'event-planning', 'car-maintenance', 'general-consulting'
)
ON CONFLICT ("service_id", "key") DO NOTHING;
--> statement-breakpoint

-- Spec 011 AC-4: one representative optional-media requirement per seeded service, carrying the
-- "why this helps" guidance the service page must show without blocking submission. Not
-- idempotency-guarded by a unique index (ServiceRequirement has none, per spec 011 §4) — guarded
-- here instead by a NOT EXISTS check so re-running this migration file's seed twice can't
-- duplicate rows.
INSERT INTO "service_requirements" ("service_id", "kind", "detail")
SELECT s."id", 'media', '{"helpText": "Adding a few photos helps providers give you a more accurate quote."}'::jsonb
FROM "services" s
WHERE s."slug" IN (
	'general-home-repair', 'home-cleaning', 'personal-grooming', 'event-photography',
	'local-moving', 'event-planning', 'car-maintenance', 'general-consulting'
)
AND NOT EXISTS (
	SELECT 1 FROM "service_requirements" sr WHERE sr."service_id" = s."id" AND sr."kind" = 'media'
);
--> statement-breakpoint

-- Spec 011 §3: this spec's own Permission seed for the Content/Marketplace admin role, per spec
-- 009 §4.3's convention, mirroring spec 010's own catalog.* seed in drizzle/0006_lean_shaman.sql.
INSERT INTO "permissions" ("role_id", "resource", "action", "risk_tier")
SELECT r."id", v.resource, v.action, 'low'
FROM (VALUES
	('catalog.service_field', 'create'),
	('catalog.service_faq', 'create'),
	('catalog.service_faq', 'approve')
) AS v(resource, action)
JOIN "roles" r ON r."name" = 'content_admin'
ON CONFLICT ("role_id", "resource", "action") DO NOTHING;