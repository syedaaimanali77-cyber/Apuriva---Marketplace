CREATE TABLE "admin_action_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"admin_action_id" uuid NOT NULL,
	"approver_admin_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_action_approvals_decision_ck" CHECK ("admin_action_approvals"."decision" in ('approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"admin_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"action_type" text NOT NULL,
	"risk_tier" text NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"reason" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"is_emergency_bypass" boolean DEFAULT false NOT NULL,
	"post_action_review_by_admin_id" uuid,
	"post_action_reviewed_at" timestamp with time zone,
	"post_action_review_notes" text,
	CONSTRAINT "admin_actions_risk_tier_ck" CHECK ("admin_actions"."risk_tier" in ('high','critical')),
	CONSTRAINT "admin_actions_status_ck" CHECK ("admin_actions"."status" in ('Pending','Approved','Rejected','Executed','PostActionReviewRequired','PostActionReviewed'))
);
--> statement-breakpoint
CREATE TABLE "admin_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"admin_profile_id" uuid NOT NULL,
	"role_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "role_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "resource" text NOT NULL;--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "action" text NOT NULL;--> statement-breakpoint
ALTER TABLE "permissions" ADD COLUMN "risk_tier" text NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_action_approvals" ADD CONSTRAINT "admin_action_approvals_admin_action_id_admin_actions_id_fk" FOREIGN KEY ("admin_action_id") REFERENCES "public"."admin_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_action_approvals" ADD CONSTRAINT "admin_action_approvals_approver_admin_id_admin_profiles_id_fk" FOREIGN KEY ("approver_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_admin_id_admin_profiles_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_post_action_review_by_admin_id_admin_profiles_id_fk" FOREIGN KEY ("post_action_review_by_admin_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignments" ADD CONSTRAINT "admin_role_assignments_admin_profile_id_admin_profiles_id_fk" FOREIGN KEY ("admin_profile_id") REFERENCES "public"."admin_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_role_assignments" ADD CONSTRAINT "admin_role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_action_approvals_admin_action_id_idx" ON "admin_action_approvals" USING btree ("admin_action_id");--> statement-breakpoint
CREATE INDEX "admin_action_approvals_approver_admin_id_idx" ON "admin_action_approvals" USING btree ("approver_admin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_action_approvals_admin_action_uq" ON "admin_action_approvals" USING btree ("admin_action_id");--> statement-breakpoint
CREATE INDEX "admin_actions_admin_id_idx" ON "admin_actions" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "admin_actions_post_action_review_by_admin_id_idx" ON "admin_actions" USING btree ("post_action_review_by_admin_id");--> statement-breakpoint
CREATE INDEX "admin_role_assignments_admin_profile_id_idx" ON "admin_role_assignments" USING btree ("admin_profile_id");--> statement-breakpoint
CREATE INDEX "admin_role_assignments_role_id_idx" ON "admin_role_assignments" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_role_assignments_admin_profile_role_uq" ON "admin_role_assignments" USING btree ("admin_profile_id","role_id");--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permissions_role_id_idx" ON "permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_role_resource_action_uq" ON "permissions" USING btree ("role_id","resource","action");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_name_unique" UNIQUE("name");--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_risk_tier_ck" CHECK ("permissions"."risk_tier" in ('low','medium','high','critical'));--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_name_ck" CHECK ("roles"."name" in ('super_admin','operations_admin','support_admin','finance_admin','trust_safety_admin','content_admin','analytics_admin'));--> statement-breakpoint
-- Spec 009 §4.3: the seven canonical roles, seeded exactly once. ON CONFLICT DO NOTHING makes this
-- safe to re-run (e.g. against an environment where they already exist) — drizzle-kit's DSL has no
-- data-seed builder, so (per lib/db/schema.ts's existing convention for hand-written SQL Drizzle
-- can't generate) this is appended by hand rather than generated.
INSERT INTO "roles" ("name") VALUES
	('super_admin'),
	('operations_admin'),
	('support_admin'),
	('finance_admin'),
	('trust_safety_admin'),
	('content_admin'),
	('analytics_admin')
ON CONFLICT ("name") DO NOTHING;