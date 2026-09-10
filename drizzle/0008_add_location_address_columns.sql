ALTER TABLE "addresses" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" ALTER COLUMN "location_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "structured" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "addresses" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "latitude_micro_degrees" integer;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "longitude_micro_degrees" integer;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "geo_hierarchy" jsonb;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_lat_lng_pair_ck" CHECK (("locations"."latitude_micro_degrees" is null) = ("locations"."longitude_micro_degrees" is null));--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_latitude_range_ck" CHECK ("locations"."latitude_micro_degrees" is null or "locations"."latitude_micro_degrees" between -90000000 and 90000000);--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_longitude_range_ck" CHECK ("locations"."longitude_micro_degrees" is null or "locations"."longitude_micro_degrees" between -180000000 and 180000000);