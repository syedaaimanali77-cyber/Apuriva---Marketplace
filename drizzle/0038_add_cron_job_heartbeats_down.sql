-- Down migration for 0038_add_cron_job_heartbeats —
-- docs/specs/2026-08-28-046-engineering-operations-cicd-observability.md §4 "Migration".
--
-- Hand-written: drizzle-kit does not generate down migrations. Carries no entry in
-- drizzle/meta/_journal.json, so `npm run db:migrate` never applies it; CI never runs it (§3.4).
-- Discards only operational heartbeat state; `/api/v1/health/detailed` then reports every job `never_ran`.

DROP INDEX IF EXISTS "cron_job_heartbeats_job_uq";

DROP TABLE IF EXISTS "cron_job_heartbeats";
