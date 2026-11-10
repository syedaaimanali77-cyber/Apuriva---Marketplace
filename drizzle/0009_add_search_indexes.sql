CREATE TABLE "recent_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"user_id" uuid NOT NULL,
	"q" text,
	"service_id" uuid,
	"category_id" uuid
);
--> statement-breakpoint
ALTER TABLE "recent_searches" ADD CONSTRAINT "recent_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_searches" ADD CONSTRAINT "recent_searches_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recent_searches" ADD CONSTRAINT "recent_searches_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recent_searches_user_id_idx" ON "recent_searches" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "recent_searches_service_id_idx" ON "recent_searches" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "recent_searches_category_id_idx" ON "recent_searches" USING btree ("category_id");
-- ---------------------------------------------------------------------------
-- Spec 013 §4: full-text search over the only two text columns that actually exist to search
-- (`services.name`, `provider_profiles.business_name` — neither table has a `description` column
-- yet). Expression (functional) GIN indexes on `to_tsvector(...)`, not a stored generated column
-- Drizzle's schema DSL has no builder for — same rationale as the status-transition trigger
-- hand-appended to 0001_baseline_schema's generated SQL. No vector/embedding index or `pgvector`
-- extension is introduced here (§7 Out of scope).
--> statement-breakpoint
CREATE INDEX "services_name_fts_idx" ON "services" USING gin (to_tsvector('english', "name"));--> statement-breakpoint
CREATE INDEX "provider_profiles_business_name_fts_idx" ON "provider_profiles" USING gin (to_tsvector('english', coalesce("business_name", '')));