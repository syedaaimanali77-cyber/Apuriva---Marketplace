ALTER TABLE "admin_profiles" ADD COLUMN "totp_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "admin_profiles" ADD COLUMN "mfa_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "security_events" ADD COLUMN "event_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "security_events" ADD COLUMN "severity" text NOT NULL;--> statement-breakpoint
ALTER TABLE "security_events" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "issued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "expires_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "mfa_satisfied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_label" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip_hash" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");