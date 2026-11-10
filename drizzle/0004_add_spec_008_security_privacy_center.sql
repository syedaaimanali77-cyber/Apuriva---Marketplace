ALTER TABLE "sessions" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "lifecycle_status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_grace_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "data_export_request_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "data_export_status" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "data_export_file_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_data_export_file_asset_id_file_assets_id_fk" FOREIGN KEY ("data_export_file_asset_id") REFERENCES "public"."file_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_data_export_file_asset_id_idx" ON "users" USING btree ("data_export_file_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_data_export_request_id_uq" ON "users" USING btree ("data_export_request_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_lifecycle_status_ck" CHECK ("users"."lifecycle_status" in ('active','restricted','suspended','banned','deletion_pending','deleted'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_data_export_status_ck" CHECK ("users"."data_export_status" is null or "users"."data_export_status" in ('pending','processing','ready','failed'));