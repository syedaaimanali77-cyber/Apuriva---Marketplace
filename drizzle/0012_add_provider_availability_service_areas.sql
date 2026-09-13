CREATE TABLE "provider_availability_notification_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"customer_profile_id" uuid NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "provider_availability_notification_requests_status_ck" CHECK ("provider_availability_notification_requests"."status" in ('pending','sent','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "provider_availabilities" ADD COLUMN "day_of_week" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_availabilities" ADD COLUMN "start_minute" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_availabilities" ADD COLUMN "end_minute" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_availability_overrides" ADD COLUMN "date" date NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_availability_overrides" ADD COLUMN "is_available" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_availability_overrides" ADD COLUMN "start_minute" integer;--> statement-breakpoint
ALTER TABLE "provider_availability_overrides" ADD COLUMN "end_minute" integer;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "scheduling_timezone" text DEFAULT 'Asia/Karachi' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD COLUMN "mode" text NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD COLUMN "radius_meters" integer;--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD COLUMN "center_address_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD COLUMN "cities" jsonb;--> statement-breakpoint
ALTER TABLE "provider_services" ADD COLUMN "duration_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_services" ADD COLUMN "buffer_before_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_services" ADD COLUMN "buffer_after_minutes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_availability_notification_requests" ADD CONSTRAINT "provider_availability_notification_requests_customer_profile_id_customer_profiles_id_fk" FOREIGN KEY ("customer_profile_id") REFERENCES "public"."customer_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_availability_notification_requests" ADD CONSTRAINT "provider_availability_notification_requests_provider_profile_id_provider_profiles_id_fk" FOREIGN KEY ("provider_profile_id") REFERENCES "public"."provider_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_availability_notification_requests_customer_profile_id_idx" ON "provider_availability_notification_requests" USING btree ("customer_profile_id");--> statement-breakpoint
CREATE INDEX "provider_availability_notification_requests_provider_profile_id_idx" ON "provider_availability_notification_requests" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_availability_notification_requests_pending_uq" ON "provider_availability_notification_requests" USING btree ("customer_profile_id","provider_profile_id") WHERE "provider_availability_notification_requests"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD CONSTRAINT "provider_service_areas_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD CONSTRAINT "provider_service_areas_center_address_id_addresses_id_fk" FOREIGN KEY ("center_address_id") REFERENCES "public"."addresses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_availabilities_provider_day_idx" ON "provider_availabilities" USING btree ("provider_profile_id","day_of_week");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_availability_overrides_provider_date_uq" ON "provider_availability_overrides" USING btree ("provider_profile_id","date");--> statement-breakpoint
CREATE INDEX "provider_service_areas_service_id_idx" ON "provider_service_areas" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "provider_service_areas_center_address_id_idx" ON "provider_service_areas" USING btree ("center_address_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_service_areas_provider_service_uq" ON "provider_service_areas" USING btree ("provider_profile_id","service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_service_areas_provider_global_uq" ON "provider_service_areas" USING btree ("provider_profile_id") WHERE "provider_service_areas"."service_id" is null;--> statement-breakpoint
ALTER TABLE "provider_availabilities" ADD CONSTRAINT "provider_availabilities_day_of_week_ck" CHECK ("provider_availabilities"."day_of_week" between 0 and 6);--> statement-breakpoint
ALTER TABLE "provider_availabilities" ADD CONSTRAINT "provider_availabilities_start_minute_ck" CHECK ("provider_availabilities"."start_minute" between 0 and 1439);--> statement-breakpoint
ALTER TABLE "provider_availabilities" ADD CONSTRAINT "provider_availabilities_end_minute_ck" CHECK ("provider_availabilities"."end_minute" between 1 and 1440);--> statement-breakpoint
ALTER TABLE "provider_availabilities" ADD CONSTRAINT "provider_availabilities_range_ck" CHECK ("provider_availabilities"."start_minute" < "provider_availabilities"."end_minute");--> statement-breakpoint
ALTER TABLE "provider_availability_overrides" ADD CONSTRAINT "provider_availability_overrides_start_pairing_ck" CHECK (("provider_availability_overrides"."is_available" = false) = ("provider_availability_overrides"."start_minute" is null));--> statement-breakpoint
ALTER TABLE "provider_availability_overrides" ADD CONSTRAINT "provider_availability_overrides_end_pairing_ck" CHECK (("provider_availability_overrides"."is_available" = false) = ("provider_availability_overrides"."end_minute" is null));--> statement-breakpoint
ALTER TABLE "provider_availability_overrides" ADD CONSTRAINT "provider_availability_overrides_range_ck" CHECK ("provider_availability_overrides"."start_minute" is null or ("provider_availability_overrides"."start_minute" between 0 and 1439 and "provider_availability_overrides"."end_minute" between 1 and 1440 and "provider_availability_overrides"."start_minute" < "provider_availability_overrides"."end_minute"));--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD CONSTRAINT "provider_service_areas_mode_ck" CHECK ("provider_service_areas"."mode" in ('radius','cities','remote'));--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD CONSTRAINT "provider_service_areas_radius_shape_ck" CHECK (("provider_service_areas"."mode" <> 'radius') or ("provider_service_areas"."radius_meters" is not null and "provider_service_areas"."center_address_id" is not null and "provider_service_areas"."radius_meters" between 1000 and 500000));--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD CONSTRAINT "provider_service_areas_cities_shape_ck" CHECK (("provider_service_areas"."mode" <> 'cities') or ("provider_service_areas"."cities" is not null));--> statement-breakpoint
ALTER TABLE "provider_service_areas" ADD CONSTRAINT "provider_service_areas_remote_shape_ck" CHECK (("provider_service_areas"."mode" <> 'remote') or ("provider_service_areas"."radius_meters" is null and "provider_service_areas"."center_address_id" is null and "provider_service_areas"."cities" is null));--> statement-breakpoint
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_duration_positive_ck" CHECK ("provider_services"."duration_minutes" > 0);--> statement-breakpoint
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_buffers_non_negative_ck" CHECK ("provider_services"."buffer_before_minutes" >= 0 and "provider_services"."buffer_after_minutes" >= 0);