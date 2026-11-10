# Deploy and rollback

**Owner:** Spec 046 §3.1, §3.2, §3.4 (AC-2). Every other spec's "Rollback" section depends on this
runbook.

## How code reaches each environment

| Environment | Vercel project | How it is deployed | Migrations |
|---|---|---|---|
| Staging | `apuriva-staging` | automatically by `.github/workflows/deploy-staging.yml` after a green `ci` run on a push to `main` | `npm run db:migrate` with `STAGING_DATABASE_URL`, **before** the deploy |
| Production | `apuriva-production` | only by `.github/workflows/deploy-production.yml` (Actions → *deploy-production* → *Run workflow* → the commit SHA), after the `production` environment's required reviewer approves | `npm run db:migrate` with `PRODUCTION_DATABASE_URL`, **before** the deploy |

- `deploy-production` refuses a SHA that is not on `main`, has no green `ci` push run, or was not
  deployed to staging by `deploy-staging`.
- Git auto-deploy is **disabled** on both Vercel projects, and there are no PR preview deployments.
- Docker (`Dockerfile`, `docker-compose.yml`) is a local/self-host development path only; it has no
  scheduler, so sweeps run there only when called by hand:
  `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/v1/cron/<job>`.

## The migration rule (why code rollback never needs schema rollback)

Migrations are applied **before** the code that needs them and must be **backward-compatible with the
previously deployed code** (expand/contract):

1. *Expand*: add the new column/table/index in a way the old code ignores (nullable or defaulted).
2. Ship code that uses it.
3. *Contract*: remove what the old code needed only in a **later** release, once no deployed or
   rollback-target code reads it.

Reviewers check this on every PR that adds a `drizzle/NNNN_*.sql` (CI's `check:migration-pairing`
guarantees the SQL, its `_down.sql` and the journal entry are all in the diff).

## Rolling back code

1. Vercel → the affected project → *Deployments* → the last good deployment → **Instant Rollback**.
2. **Re-check the crons.** Instant Rollback does **not** update Vercel Cron: the cron configuration stays
   as the most recent deployment defined it. Open Vercel → project → *Settings → Cron Jobs* and confirm
   the jobs match the rolled-back commit's `vercel.json`. If they differ, redeploy that commit through
   the normal workflow (staging: re-run `deploy-staging` for it; production: run `deploy-production` with
   its SHA) instead of relying on the instant rollback.
3. Confirm `GET /api/v1/health/detailed` is healthy and the next `ops-health-check` run is green.
4. Open an issue for the fix-forward; roll forward through a normal PR.

## Rolling back the schema — human only, and rarely

There is **no automatic schema rollback**. CI never runs a `_down.sql`. Because of the expand/contract
rule a code rollback leaves the schema compatible, so a schema rollback is needed only to undo a
migration that is itself harmful. Then:

1. Take a Neon restore point first (note the time; see [disaster-recovery.md](disaster-recovery.md)).
2. Review the migration's `drizzle/NNNN_*_down.sql` with a second engineer.
3. Run it with `npm run db:rollback` against the target database, from an operator machine, with the
   target's `DATABASE_URL` set only for that command.
4. Record what was run, by whom and when in the incident record.

If data was lost or corrupted, restore instead: [disaster-recovery.md](disaster-recovery.md).

## Configuration (DEP-1, DEP-3 — set by the account owners)

- **Vercel (Pro team):** projects `apuriva-staging` and `apuriva-production`; Git auto-deploy disabled;
  each project's environment variables set separately (`.env.example` is the complete list; staging and
  production never share a secret value); `APP_ENV=staging` / `APP_ENV=production`.
- **GitHub Environments:**
  - `staging`: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_STAGING`, `STAGING_DATABASE_URL`.
  - `production` (**required reviewer**): `VERCEL_PROJECT_ID_PRODUCTION`, `PRODUCTION_DATABASE_URL`.
    A job can read only its own environment's secrets, so `VERCEL_TOKEN` and `VERCEL_ORG_ID` must also
    be readable by the production job: add them to `production` as well, or define them once as
    repository secrets.
  - `monitor-staging`, `monitor-production` (**not** gated): see [monitoring.md](monitoring.md).
- **Branch protection on `main`:** require the checks `static`, `test-unit`, `test-integration (1/4)`,
  `test-integration (2/4)`, `test-integration (3/4)`, `test-integration (4/4)`, `test-mcp`,
  `test-security`, `test-e2e-route`, `build` and `browser` (spec 046's eight jobs, the integration job
  reporting one check per shard). Specs 043/044 add theirs.
