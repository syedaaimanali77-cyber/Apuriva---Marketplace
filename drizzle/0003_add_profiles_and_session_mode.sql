ALTER TABLE "customer_profiles" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "business_name" text;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "lifecycle_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "active_mode" text DEFAULT 'customer' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_lifecycle_status_ck" CHECK ("provider_profiles"."lifecycle_status" in ('draft','pending_verification','active','paused','restricted','suspended','banned'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_mode_ck" CHECK ("sessions"."active_mode" in ('customer','provider'));