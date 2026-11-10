# Disaster recovery — production database

**Owner:** Spec 046 §3.11 (AC-6, decision D-12). **Audience:** the operators named under "Who may do
this". **Status:** procedure defined; it has **not** been exercised until a drill is recorded in
[restore-drills.md](restore-drills.md). Nothing here claims a backup exists before Neon is
provisioned (DEP-2).

## What protects the data

| Protection | Where it is configured | Verified by |
|---|---|---|
| Neon point-in-time restore (PITR) with a **7-day retention window** | Neon console → production project → Settings → *Instant restore / history retention* = 7 days | the first restore drill |
| Encryption at rest | Neon (always on) | Neon documentation |
| Deletion of the production project limited to the Neon project owner | Neon organisation roles | the operator checklist below |
| The application's database role cannot drop the database | the role the Vercel `DATABASE_URL` uses is not the database owner | `\l` / `\du` check below |
| `_down.sql` files are never run by CI | `.github/workflows/deploy-*.yml` run only `npm run db:migrate` | reading those workflows |

### What "7 days" means — and does not mean

- **It is the retention and recovery window**: a restore can target **any moment within the last 7
  days**. A moment older than 7 days cannot be restored.
- **It is not a 7-day RPO.** The recovery point objective (how much recent data a restore can lose) is
  set by Neon's continuous write-ahead-log history, not by this window.
- **No RPO or RTO figure is set by spec 046.** If the business needs one, record the decision here, in
  a "Recovery objectives" section, with its approver. Each drill's measured restore duration is logged in
  [restore-drills.md](restore-drills.md) to inform it.

## Who may do this

- **Restore and cut-over:** the Neon project owner, or an operator the owner has granted the Neon
  *Admin* role on the production project, **together with** a person holding Vercel access to
  `apuriva-production` (to change `DATABASE_URL` and redeploy).
- A restore is a production change: announce it in the incident channel/issue before starting, and link
  the incident from the drill log or incident record.

## Procedure — restore to a point in time

Always restore **into a new branch**. Never restore over the production branch in place: the
original stays intact for comparison and as a fallback.

1. **Choose the target time** (UTC) — the last moment known good, within the last 7 days. Write it down.
2. **Create the restore branch.** Neon console → production project → *Branches* → *Create branch* →
   *From a point in time* → the target time. Name it `restore-YYYYMMDD-HHMM`.
3. **Get its connection string** (pooled) for the application role. Keep it out of chat and issues.
4. **Verify the restored data** against the source at the chosen time:
   - Row counts:
     ```sql
     select 'users' t, count(*) from users
     union all select 'bookings', count(*) from bookings
     union all select 'payments', count(*) from payments
     union all select 'audit_logs', count(*) from audit_logs;
     ```
     Run it on the restore branch and, for comparison, on a second branch created at the same target
     time (or on production if it is still healthy). The counts must match; if production has moved on,
     production must be **≥** the restore.
   - **Latest migration applied:**
     ```sql
     select id, hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 1;
     ```
     Its count/position must match the latest `idx` in `drizzle/meta/_journal.json` of the commit
     currently deployed (or be behind it only by migrations that `npm run db:migrate` will apply).
   - **Application health against it:** point a staging-like deployment (or a local `next start`) at
     the restore branch and call `GET /api/v1/health/detailed` with the monitoring token: `database` and
     `migrations` must be `up`.
5. **Cut over.** In Vercel → `apuriva-production` → Settings → Environment Variables, set
   `DATABASE_URL` to the restore branch's connection string, then **redeploy** the current production
   deployment (environment variables apply only to new deployments).
6. **Confirm.** `GET /api/v1/health/detailed` on production answers `200` with `database` and
   `migrations` `up`; the next `ops-health-check` run is green; crons resume (their heartbeats move —
   see [monitoring.md](monitoring.md)).
7. **Record** the operation in [restore-drills.md](restore-drills.md) (for a drill) or in the incident
   record (for a real restore): target time, duration from step 2 to step 6, verification results, and
   any issue found.
8. **Afterwards:** keep the previous production branch until the restore is accepted, then delete it
   per Neon retention practice. Do not delete it during the incident.

## Checks the operator repeats before launch and after any infrastructure change

- [ ] Neon production project: history retention is **7 days**.
- [ ] Only the Neon project owner can delete the project.
- [ ] The application role (the user in the production `DATABASE_URL`) is **not** the database owner and
      has no `CREATEDB`/superuser (`\du` shows no such attributes).
- [ ] Staging uses its own Neon branch/database and never shares a credential with production.
- [ ] A restore drill has been recorded within the last quarter.

## Uploaded files

Backup of uploaded files belongs to the durable object-storage adapter spec 027 must add before
production (spec 046 §3.1). Vercel's filesystem is ephemeral and `FILE_STORAGE_PROVIDER=local` cannot
serve production. Until that adapter exists there are no production files to back up; this is a
recorded dependency, not a gap in this runbook.
