-- Spec 046 — Engineering Operations (docs/specs/2026-08-28-046-engineering-operations-cicd-observability.md §3.8, §4).
--
-- `cron_job_heartbeats`: one row per Vercel Cron job, upserted by `withCronRoute` (lib/cron/route.ts). It is
-- NOT a job queue and NOT a run history. Per-item retry/backoff/dead-letter state stays in each domain's own
-- rows; this covers only a sweep failing as a whole or silently stopping (Vercel Cron never retries a failed
-- invocation). No FK, no money column, no jsonb. Empty on creation: no backfill, no downtime.

CREATE TABLE IF NOT EXISTS "cron_job_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"job" text NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error_code" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cron_job_heartbeats_job_shape_ck" CHECK ("job" ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length("job") <= 64),
	CONSTRAINT "cron_job_heartbeats_consecutive_failures_ck" CHECK ("consecutive_failures" >= 0),
	CONSTRAINT "cron_job_heartbeats_error_code_length_ck" CHECK ("last_error_code" is null or char_length("last_error_code") <= 64)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "cron_job_heartbeats_job_uq" ON "cron_job_heartbeats" USING btree ("job");
