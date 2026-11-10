# Monitoring and `[ops-alert]` response

**Owner:** Spec 046 §3.7, §3.9, §3.10 (AC-4, AC-5, AC-8). **Includes** spec 041's kill-switch paging.

## What exists — and what it is not

`.github/workflows/ops-health-check.yml` is a **scheduled health check** run by GitHub Actions every 5
minutes against staging and production. It is **not 24/7 monitoring**:

- scheduled runs are best-effort — they can start late (sometimes 10–15 minutes) or be skipped under
  GitHub load, so detection latency is not guaranteed;
- there is no on-call rotation, escalation or guaranteed delivery;
- GitHub disables scheduled workflows in a **public** repository after 60 days without activity;
- the workflow **cannot alert on its own absence** — hence the weekly check below.

A 24/7 paging vendor can later poll the same endpoint with no code change.

## Weekly human check (required)

Every week, an engineer on the operations rota:

- [ ] opens Actions → *ops-health-check* and confirms runs are **present and recent** (several per hour,
      the latest within ~15 minutes) for both `staging` and `production`;
- [ ] confirms the workflow is **enabled** (not auto-disabled);
- [ ] reviews open issues labelled `ops-alert`;
- [ ] records the check (date, name) in the team's ops log.

## The endpoint

`GET /api/v1/health/detailed` with `Authorization: Bearer <MONITORING_TOKEN>` (or a Super Admin session
that completed MFA). It answers `200` when `healthy` or `degraded` and **`503` when `down`** (the
database is unreachable). `GET /api/v1/health` stays the liveness probe and always answers `200` while
the process serves.

| Dependency | `degraded`/`down` when | `detail` |
|---|---|---|
| `database` | `SELECT 1` fails or exceeds 2 s → **down** | `unreachable`, `timeout` |
| `migrations` | the database is behind `drizzle/meta/_journal.json`, or the check could not run | `migrations_behind`, `migrations_unknown` |
| `cron:<job>` | no heartbeat yet, ≥ 3 consecutive failures, or last success older than max(3 × interval, 10 min) | `never_ran`, `3_consecutive_failures`, `stale`, `heartbeats_unreadable` |
| `kill-switch:<key>` | the spec 041 kill switch is **off**, or could not be read | `kill_switch_off`, `flag_unreadable` |
| `adapter:<port>` | a sandbox adapter, or none, under `APP_ENV=production` | `sandbox_in_production`, `not_configured` |

When the database is down, every row that needs it reports `down` with `database_unavailable`.

`detail` is always a short code — never an error message, host name or credential.

## Alert signals

For each failed check the run turns **red** (GitHub notifies the account that last edited the
schedule), and exactly **one issue per environment and check** is opened — `[ops-alert] <env>: <check>`,
labelled `ops-alert` — or, if already open, commented on. When the check passes again the workflow
comments "Recovered at …" and **closes** the issue. When the endpoint cannot be reached at all, only the
`fetch` issue is touched; the other checks' issues are left as they are (they could not be evaluated).

## Responding to each check

### `fetch` — the endpoint could not be read

1. Open the deployment URL in a browser. If the site is down, check Vercel → project → *Deployments* and
   *Logs*; roll back if the latest deploy caused it ([deploy-rollback.md](deploy-rollback.md)).
2. If the site is up: the token may be wrong. `MONITORING_TOKEN` in the `monitor-<env>` GitHub
   Environment must equal the Vercel project's `MONITORING_TOKEN` (≥ 32 characters). A `401` body is
   reported as `unreachable`.
3. Check `BASE_URL` (the environment **variable**) points at the deployment's production URL.

### `app-database` — `http_503`, `database_down`, `migrations_behind`

- **`database_down` / `http_503`:** check Neon status and the project's compute (suspended? connection
  limit?). Search Vercel logs for `health.db_unreachable` — its `error` field has the cause. If data is
  damaged: [disaster-recovery.md](disaster-recovery.md).
- **`migrations_behind`:** a deploy skipped or failed its migration step. Re-run the deploy workflow for
  the deployed commit (it migrates first). Never hand-edit the migrations table.

### `cron` — `never_ran`, `stale`, `3_consecutive_failures`

1. Filter Vercel logs by `"event":"cron.run"` and the job name. A `status:"error"` line carries the
   `correlationId`; filter by it to see every line from that run.
2. `3_consecutive_failures`: fix the cause; the next `2xx` run resets the counter. Per-item failures
   (a notification delivery, a file scan, a payment reconciliation) keep their own retry and terminal
   states in their domain tables — the heartbeat reports only whole-sweep failure.
3. `stale` / `never_ran`: Vercel → project → *Settings → Cron Jobs* — are the jobs present and enabled?
   After an Instant Rollback the crons may not match the code ([deploy-rollback.md](deploy-rollback.md)).
   Check `CRON_SECRET` is set (a wrong secret answers `401`, which records no heartbeat at all).
4. To run a sweep by hand: `curl -H "Authorization: Bearer $CRON_SECRET" <BASE_URL>/api/v1/cron/<job>`.

### `kill-switch` — a spec 041 kill switch is off

Expected while someone has deliberately switched a capability off. The issue stays open, with a comment
on every failing run, until the switch is back on — by design. The authoritative who/when/why is spec
041's audit row (Admin → Settings → Audit log) and the `feature_flags.kill_switch_changed` log line.
Confirm the change was intended; turn it back on in Admin → Settings → Feature flags when resolved.

### `report-staleness` — `report_stale`

The report's `checkedAt` was more than 120 s from the runner's clock: a cache or proxy is replaying an
old response, or the server clock is wrong. The endpoint sends `Cache-Control: no-store`; check nothing
in front of it (a CDN rule, a proxy) caches `/api/v1/*`.

### `production-adapters` — `sandbox_in_production` (production only)

A sandbox payment, payout, notification, file or AI adapter is configured in production. Sandboxes
refuse `NODE_ENV=production`, so the affected domain answers its documented `503`. Set the real adapter
for that port (owned by specs 021/024/026/027/033). Not fixable by operations alone until those adapters
exist (spec 045 DEP-1).

## Logs and correlation

Logs are the Vercel runtime logs of each project: one JSON object per line with an `event` field.

- API: `api.request` (one per request: method, pathname, status, duration) and `api.unhandled_error`.
- Cron: `cron.run` (job, status, httpStatus, durationMs, counts).
- Health: `health.db_unreachable`.
- AI trace: `ai.turn_started` → `mcp.tool_call` / `mcp.authorization_failed` → `ai.turn_completed`.

Every line emitted while handling one request or one cron run carries the same `correlationId` (the
`x-correlation-id` response header), and spec 039's audit rows written during it carry it too. Secrets,
tokens, message bodies and payment details are redacted by `lib/observability/log.ts` and are never
passed to it.
