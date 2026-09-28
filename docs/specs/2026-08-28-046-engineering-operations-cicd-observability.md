# Spec: Engineering Operations (CI/CD / Observability)

**File:** `docs/specs/2026-08-28-046-engineering-operations-cicd-observability.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §114–§118, §129–§130, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §10, §15–§17, [docs/workflow.md](../workflow.md); specs 001 (health, Vercel Cron, env contract, secret-management open question), 003 (schema conventions), 004 (correlation IDs, `withApiRoute`), 039 (audit separation, request context), 041 (`APP_ENV`, kill switches), 043/044 (browser tests that run on this spec's runner). See §8.

---

## 1. Problem statement

**Today (verified against the repository):**

- **No CI at all:** `.github/` does not exist. The remote is GitHub
  (`github.com/syedaaimanali77-cyber/Apuriva---Marketplace`).
- **There are no lint tool and no browser runner.** Next 16 removed `next lint`
  (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`).
- **Existing scripts** CI can reuse: `typecheck`, `test` (Vitest, `pool: 'threads'`, the isolated
  `*_test` database via `test/db-reset.ts`), `check:env`, `check:schema-checksum` (guards only the
  immutable `0001` baseline), `check:schema-money-lint`, `check:openapi-drift`.
- **Pre-existing test failures exist.** Spec 041 §8 names `lib/db/schema-coverage.test.ts` and
  `lib/db/migrations.integration.test.ts`, and other specs have reported more. The full suite takes
  about 30 minutes on a developer machine. A gate that required a fully green suite would be red on
  its first day.
- **Two deployment artefacts disagree:**
  - `vercel.json` schedules 17 per-domain cron routes (`app/api/v1/cron/*`, bearer `CRON_SECRET`);
  - a `Dockerfile` + `docker-compose.yml` build a `standalone` image whose entrypoint runs migrations.
  - Vercel Cron only calls a **project's production deployment**, is **best-effort**, may deliver a
    run twice, **never retries a failed run**, and is **not updated by an Instant Rollback**. Its
    Hobby plan allows **daily crons only**; per-minute schedules need Pro (all verified in Vercel's
    cron documentation). Nothing fires crons inside the Docker image.
- **Health:** `GET /api/v1/health` (spec 001) always answers `200 {status:'ok'}` and reports
  `db.connected` in the body. Spec 001's own `route.test.ts` asserts 200 **even when the database is
  down**, and the compose healthcheck relies on that as a liveness probe. It also returns the raw
  database error text to anonymous callers.
- **Logging:**
  - The convention is `console.*(JSON.stringify({ event, … }))`, with no shared helper and no
    redaction.
  - Correlation IDs exist for API routes (`lib/api/correlation-id.ts`, `withApiRoute`, spec 039's
    `AsyncLocalStorage` request context).
  - They are absent from cron runs and from the `ai.*`/`mcp.*` log lines, although spec 039 audit rows
    carry them.
- **Background work** is per-domain sweeps over durable rows with their own retry, backoff and
  terminal states:
  - notification deliveries (`lib/notifications/retry.ts`: `2^n` minutes, `failed` plus escalation
    and channel fallback);
  - file scans (`lib/files/sweep.ts`, `scan_next_attempt_at`);
  - payment, payout, refund and no-show sweeps.
- **Hosting blockers for production:**
  - Every sandbox adapter refuses `NODE_ENV=production` (payments, payouts, notifications, AI, file
    storage);
  - no real adapter exists for any of them;
  - Vercel's filesystem is ephemeral, so `FILE_STORAGE_PROVIDER=local` cannot serve production.
- **Missing:** `BUILD_STATUS.md`, backups and a DR runbook; secret management is still "Open" in
  spec 001 §8 #4.

Master §114 requires the full CI gate, staging auto-deploy, approved production deploys, reviewed
migrations and a rollback strategy. §116 requires backups, point-in-time recovery and tested
recovery. §117 requires structured logs, error tracking, tracing, job monitoring, health checks,
alerts and correlation IDs. §118 requires separated environments and secrets. §129–§130 require
`BUILD_STATUS.md`.

**Who is affected:** Every engineer shipping code; on-call responders; anyone relying on the
"monitored"/"alerted" claims scattered across specs 001–045.

**Why it matters now:** It's the last spec because it's the mechanism that makes every prior
spec's CI/observability references real, and it also formalizes how *this entire set of 46
specs* gets built safely, slice by slice.

**Success looks like:**

- Every PR runs a complete, green-able gate.
- `main` auto-deploys to staging, with migrations applied first; production deploys only after
  explicit approval.
- Logs are structured, redacted and correlated.
- Stalled sweeps, a down database and fired kill switches raise an alert.
- Production backups have a 7-day point-in-time retention/recovery window (not an RPO) and a
  recorded restore drill.
- `BUILD_STATUS.md` is maintained.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any PR to `main` **When** opened or updated **Then** GitHub Actions runs the required checks of §3.4 (static: lint, typecheck, env/schema/money/OpenAPI/migration-pairing/secret/no-workspace checks; tests: unit, integration, MCP, security/permission, route-level E2E; build; browser smoke), and merge is blocked unless every one passes. The test checks fail on any failure not in the committed known-failures baseline, and on any baseline entry that now passes (§3.5). |
| AC-2 | **Given** a commit on `main` that passed AC-1 **When** the pipeline completes **Then** staging migrations run and the commit is deployed to the `apuriva-staging` Vercel project automatically. Production deploys only through the `deploy-production` workflow, gated by the GitHub `production` environment's required reviewer, which migrates and then deploys that same commit. |
| AC-3 | **Given** a PR that changes `lib/db/schema.ts` **When** CI runs **Then** `check:migration-pairing` fails unless the PR also adds a new sequentially-numbered `drizzle/NNNN_*.sql`, its hand-written `_down.sql` and the journal entry, so the SQL is reviewable in the PR diff |
| AC-4 | **Given** a request handled by `withApiRoute` or a cron route **When** investigated **Then** the hosting platform's logs filtered by its correlation ID return the `api.request` or `cron.run` line, every structured line emitted during it (including the AI trace steps of §3.9), and any error line. Spec 039's audit rows for the same work carry the same ID. |
| AC-5 | **Given** a sweep (the 17 cron routes) **When** it fails, or stops running **Then** per-item failures keep their domain-owned retry and terminal states (§3.8), and the sweep itself is recorded in `cron_job_heartbeats`. `GET /api/v1/health/detailed` reports it `degraded` after 3 consecutive failures, or `stale` when its last success is older than max(3 × its schedule interval, 10 min), and the §3.10 monitor raises an alert. |
| AC-6 | **Given** the production Neon database **When** operated **Then** its point-in-time-restore **retention window is 7 days** (a restore can target any moment in the last 7 days; this is not an RPO), and a restore drill (§3.11) has been executed and recorded before production launch, then quarterly and after any major infrastructure change |
| AC-7 | **Given** the implementation of any spec **When** its slice completes **Then** `BUILD_STATUS.md` is updated in the same PR with the master §130 sections (§3.12) |
| AC-8 | **Given** `GET /api/v1/health` (spec 001, liveness) **When** polled **Then** its existing contract is unchanged (still `200` whenever the process serves), without the raw database error text. **Given** `GET /api/v1/health/detailed` with the monitoring token or a Super Admin session **When** polled **Then** it accurately reports database, migrations, sweeps and kill switches, answering `503` when the database is down (§3.7). |

---

## 3. Architecture and API contract

### 3.1 Hosting (decision D-1)

**Vercel is the supported deployment target.** It runs two Vercel projects on the **Pro** plan,
which the per-minute crons require.

| Project | Deployed by | `APP_ENV` | Database | Crons |
|---|---|---|---|---|
| `apuriva-staging` | CI `deploy-staging` on every green `main` commit | `staging` | Neon `staging` branch/database | yes: the project's production deployment is staging |
| `apuriva-production` | CI `deploy-production`, manual and approved | `production` | Neon production | yes |

- **Git auto-deploy is disabled on both projects** (CI deploys them). Migrations must run before the
  code that needs them, and Vercel's Git integration cannot order that.
- **No PR preview deployments** in MVP (no preview database is defined); the CI gate is the PR check.
- **Docker** (`Dockerfile`, `docker-compose.yml`) remains a **local/self-host development path only**.
  - It is unchanged, and no scheduler is claimed for it: sweeps run there only when invoked by hand
    (`curl -H "Authorization: Bearer $CRON_SECRET" …`).
  - It is not a supported production target. Adding one would be a new spec with an external
    scheduler.
- **A demo deployment** (spec 045) is a third project, `apuriva-demo`, with the same pipeline shape.
  045 owns its configuration.
- **Local development** is unchanged (spec 001: `npm run dev` plus compose Postgres).

**Known production preconditions, owned by other specs and recorded here only:**

- a real payment, payout, notification, file-storage and AI adapter (specs 021/024/026/027/033),
  because every sandbox refuses `NODE_ENV=production`, which every Vercel deployment sets. The same
  guard stops staging and demo from using sandboxes. Whether that changes is decided only by the
  owning specs (recorded as spec 045 DEP-1); 046 does not alter the guard.
- a durable object-storage adapter (spec 027), because Vercel's filesystem is ephemeral.

046's pipeline deploys regardless; those domains answer their documented `503` until their owners
act.

### 3.2 Cron (decision D-2)

- **Vercel Cron invokes only a project's production deployment.** Vercel sends each scheduled `GET`
  to the production deployment URL of the project whose `vercel.json` declares it. It never calls
  preview deployments.
  - **Staging cron execution is required** (the offer-expiry, payment and notification sweeps must run
    for staging to behave like production). That is why staging is its own Vercel project
    (`apuriva-staging`, §3.1), whose production deployment *is* staging.
  - Without that separate project, staging would have no scheduled sweeps at all.
- **`vercel.json` and the 17 per-domain routes are kept.** There is no queue, no worker, and no
  generic `BackgroundJobRun`; the heartbeat table (§3.8) is the only job-level state.
- **Every cron route is wrapped** by `withCronRoute(jobName, handler)` (`lib/cron/route.ts`, X-3), which:
  1. keeps the existing bearer check, using a constant-time comparison;
  2. mints a correlation ID and runs the handler inside spec 039's request context, so audit rows
     written by a sweep carry it;
  3. updates `cron_job_heartbeats`: `last_started_at` on entry; then `last_succeeded_at`
     (resetting `consecutive_failures`) on a `2xx`, or `last_failed_at`, `last_error_code` and
     `consecutive_failures + 1` on an exception or non-`2xx`;
  4. emits one `cron.run` line: `{event, job, correlationId, status, httpStatus, durationMs}` plus the
     handler's own counts.
- **The handlers' bodies do not change.** The existing sweeps are claim-based and idempotent, which is
  what Vercel's best-effort, possibly-duplicated delivery requires.
- **The schedule** of each job for staleness is read from `vercel.json` by
  `lib/cron/schedules.ts`, the single source.
- **Instant Rollback does not update crons (Vercel).** The deploy-rollback runbook (§3.11) therefore
  includes "redeploy or verify `vercel.json` crons after rollback".

### 3.3 Secrets and configuration (decision D-3; resolves spec 001 §8 #4)

- **Runtime secrets:** Vercel **Project Environment Variables** (encrypted), set separately per
  project. Staging and production never share a secret value.
- **CI secrets:** GitHub **Environments**:
  - `staging` holds `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_STAGING` and
    `STAGING_DATABASE_URL` (for migrations);
  - `production` holds `VERCEL_PROJECT_ID_PRODUCTION` and `PRODUCTION_DATABASE_URL`, with a
    **required reviewer**.
  - **Monitoring** uses separate, **non-approval-gated** GitHub Environments, `monitor-staging` and
    `monitor-production`. Each holds only that deployment's `MONITORING_TOKEN` (secret) and `BASE_URL`
    (variable), so the scheduled health check never waits for the production deploy approval. The
    monitoring token grants read access to `/health/detailed` only.
- **No secret manager vendor.** `.env.example` stays the complete contract, checked by `check:env`.
- **New documented variables (X-6):** `MONITORING_TOKEN` (the bearer for `/health/detailed`, at least
  32 characters). Existing variables such as `APP_ENV`, `CRON_SECRET` and `DATABASE_URL` are reused.
- **Secret scanning** runs in CI (§3.4), delivering spec 001 AC-4.

### 3.4 CI pipeline: `.github/workflows/ci.yml` (decisions D-4, D-5)

Triggered on `pull_request` to `main` and on `push` to `main`. Node 22 and `npm ci`, with an
`npm` cache.

| Job (required check) | Runs | Needs |
|---|---|---|
| `static` | `npm run lint`; `npm run typecheck`; `check:env`; `check:schema-baseline`; `check:openapi-drift`; `check:migration-pairing` (new, AC-3); `check:no-workspace` (new; spec 001 AC-2: no `pnpm-workspace.yaml`, Turborepo or Nx config, or `packages/`); gitleaks secret scan over the PR diff (push: full history) | — |
| `test-unit` | Vitest on files that are not integration tests, in no other group | Postgres 16 service |
| `test-integration` | Vitest `*.integration.test.ts` not in the MCP or security group; 4 shards (`--shard=i/4`) | Postgres 16 service |
| `test-mcp` | Vitest under `lib/mcp/**`, `lib/mcp-tools/**`, `lib/ai-assistant/**`, `app/api/v1/**/mcp/**` | Postgres 16 service |
| `test-security` | Vitest files whose name contains `access`, `permission`, `boundary`, `security`, `csrf`, `authorization`, `rbac` or `ownership` | Postgres 16 service |
| `test-e2e-route` | Vitest `e2e/**/*.spec.ts` (the repository's route-level end-to-end suite) | Postgres 16 service |
| `build` | `next build` | `static` |
| `browser` | `playwright test` (§3.6) against `next start` | `build`, Postgres 16 service |

- **Test groups:** `scripts/test-groups.ts` assigns every test file to exactly one group, in the
  precedence mcp > security > e2e-route > integration > unit, and fails if a file is in none. The jobs
  run the same `npm test` configuration with that file list. Each job's Postgres service creates
  `apuriva_test`, so `vitest.config.ts`'s `_test` rewrite and `test/db-reset.ts` apply unchanged.
- **Branch protection on `main`** requires all eight checks. Specs 043 and 044 later add their jobs
  (`a11y`, `pwa`, `perf`) and make them required.
- **Coverage:** each test job uploads its v8 coverage report as an artefact, but coverage is not a
  gate. Per-spec ≥80% targets are verified in each spec's own implementation phase.
- **Deploy workflows:**
  - **`deploy-staging.yml`:** on a green `push` to `main` (`workflow_run` of `ci`), in environment
    `staging`: `npm run db:migrate` with `STAGING_DATABASE_URL`, then
    `vercel pull && vercel build --prod && vercel deploy --prebuilt --prod` to `apuriva-staging`.
  - **`deploy-production.yml`:** `workflow_dispatch` with a `sha` input that must be a commit already
    deployed to staging with green CI. In environment `production` (required reviewer): migrate
    `PRODUCTION_DATABASE_URL`, then build and deploy that exact `sha` to `apuriva-production`.
- **Migration safety:** migrations are applied **before** code and must be **backward-compatible with
  the previously deployed code** (expand/contract), so a code rollback never needs a schema rollback.
  `_down.sql` files are run only by a human, per the runbook. This is the rollback strategy of master
  §114.

### 3.5 Baselines for a green-able gate (decision D-5)

- **Tests:** `test/known-failures.json` lists each pre-existing failing test as
  `{ file, testName, owningSpec, reason }`.
  - It is captured once, by one clean full run during 046's implementation, and every entry is
    reported to its owning spec. **No failing test is edited, skipped or weakened to populate it.**
  - Each test job runs Vitest with the JSON reporter, and `scripts/check-test-baseline.ts` then fails
    on a failure not in the list (**new failure**), or on a listed test that now passes (**stale
    entry**: "remove it").
  - The list can only shrink, except through a PR that states why each added entry exists.
- **Lint:** ESLint's native bulk suppressions (`eslint-suppressions.json`, created once with
  `--suppress-all`). New violations fail. ESLint itself fails when a suppressed violation is fixed but
  not pruned (`--prune-suppressions`). It is the same ratchet.

### 3.6 Browser runner architecture (decision D-6)

046 owns the runner; specs 043 and 044 own the tests that use it.

- **Sharing and ownership:** the Playwright infrastructure (config, `browser/` layout, browser
  database, persona setup, CI job) is shared. **`@axe-core/playwright` is added by spec 043**, and any
  spec may use it once present.
- Test ownership never moves: `browser/a11y/**` is 043's, `browser/pwa/**` and `browser/perf/**`
  are 044's, and `browser/smoke.browser.ts` and `browser/global-setup.ts` are 046's. 046 writes no
  accessibility or PWA test.

- **Dependency:** `@playwright/test` (devDependency), Chromium only in CI
  (`npx playwright install --with-deps chromium`).
- **`playwright.config.ts`:**
  - `testDir: 'browser'`, `testMatch: '**/*.browser.ts'`;
  - `webServer`: `npm run start` on port 3100 with the browser environment below;
  - `globalSetup: 'browser/global-setup.ts'`.
- **Kept apart from Vitest:** the `.browser.ts` suffix never matches Vitest's `include`, and
  `browser/**` is added to Vitest's `exclude` (X-5). The existing `e2e/*.spec.ts` stay Vitest
  route-level tests, and nothing browser-based goes in `e2e/`.
- **Browser database:** `apuriva_browser_test`, whose name ends in `_test` as required by the
  repository rule. It is migrated in CI before `next start`, and never shared with a concurrently
  running Vitest process.
- **`browser/global-setup.ts`** creates the `customer`, `provider` and `admin` personas directly in
  that database with the existing `*-test-support.ts` helpers. The admin completes TOTP through the
  existing spec 005 TOTP helper, so no MFA is skipped. Each persona's storage state is saved for
  tests.
- **Smoke test:** `browser/smoke.browser.ts` (046) loads `/`, `/explore` and a signed-in `/account`,
  proving the runner works.

### 3.7 Health (AC-8; decision D-7)

- **`GET /api/v1/health` (liveness, spec 001):** the contract is unchanged (`200`, `status:'ok'`,
  `version`, `uptimeSeconds`, `db.connected`, `db.latencyMs`).
  - The only change (X-1) is removing `db.error` from the response body and logging it instead as
    `health.db_unreachable`, because it disclosed internal detail to anonymous callers.
  - Spec 001's test, which asserts only `db.connected` as a boolean, stays green unedited, and the
    compose healthcheck is untouched.
- **`GET /api/v1/health/detailed` (readiness and diagnostics, new):**
  - **Auth:** `Authorization: Bearer <MONITORING_TOKEN>` (compared in constant time), **or** a Super
    Admin session. Otherwise `401 UNAUTHENTICATED`.
  - **Conventions:** `withApiRoute`, the `default` rate limit, `Cache-Control: no-store`, and an
    OpenAPI entry (X-4).
  - **Response:** `200 ApiResponse<DetailedHealthDto>`, or **`503`** with the same body when `status`
    is `'down'`.

| Dependency | Check | `down` / `degraded` when |
|---|---|---|
| `database` | `SELECT 1` with a 2-second timeout | unreachable or timed out → **down** |
| `migrations` | the latest `drizzle/meta/_journal.json` index against the applied migrations table | the database is behind the code → **degraded** |
| `cron:<job>` (each of the 17) | `cron_job_heartbeats` | ≥ 3 consecutive failures (`3_consecutive_failures`), stale per AC-5 (`stale`), or no heartbeat row yet (`never_ran`) → **degraded** |
| `kill-switch:<key>` | `isFeatureEnabled` for every registered kill switch (spec 041) | a kill switch is **off** → **degraded** (§3.10 alerts on it) |
| `adapter:<port>` | the configured adapter name for payments, payouts, notifications, files and AI; **no network call** | a sandbox under `APP_ENV=production` → **degraded** |

`status` is `down` if any row is `down`, `degraded` if any is `degraded`, else `healthy`.

```typescript
// lib/types/ops.ts
export type HealthStatus = 'healthy' | 'degraded' | 'down';
export interface DetailedHealthDto {
  status: HealthStatus;
  environment: 'development' | 'staging' | 'production';
  version: string;          // package.json version
  commit: string | null;    // VERCEL_GIT_COMMIT_SHA, null locally
  checkedAt: string;
  dependencies: Array<{ name: string; status: 'up' | 'degraded' | 'down'; latencyMs?: number; detail?: string }>;
}
```

`detail` holds a short code (for example `stale`, `3_consecutive_failures`, `sandbox_in_production`),
never an error message, host name or credential.

### 3.8 Background-job model (AC-5; decision D-8)

**No `BackgroundJobRun` table.** Per-item retry, backoff and terminal states are already durable and
domain-owned. Verified:

- `notification_deliveries` (`retrying` with `2^n`-minute backoff up to `NOTIFICATION_MAX_ATTEMPTS`,
  then `failed` plus escalation and channel fallback, spec 026);
- `file_assets` scan state (`scan_next_attempt_at`, `2^n` backoff, spec 027);
- the payment, refund, payout and no-show sweeps' reconciliation states (specs 021–024).

These are the "dead-letter" states of master §117 and architecture §10, each owned by its spec.
Duplicating them in a generic table would create a second source of truth.

**The one gap these do not cover** is a sweep that stops running or fails as a whole. Vercel never
retries a cron and delivery is best-effort. That is `cron_job_heartbeats`' only responsibility:

| Column | Type | Notes |
|---|---|---|
| `baseColumns()` | | `id`, `created_at`, `updated_at`, `version` (spec 003 schema-lint) |
| `job` | `text not null` | UNIQUE; a key of `lib/cron/schedules.ts` |
| `last_started_at` | `timestamptz null` | |
| `last_succeeded_at` | `timestamptz null` | |
| `last_failed_at` | `timestamptz null` | |
| `last_error_code` | `text null` | a short code, never a message or payload |
| `consecutive_failures` | `integer not null default 0` | CHECK ≥ 0 |

One row per job, upserted, with no history (history is in the logs). No money and no jsonb column.

### 3.9 Observability (AC-4; decisions D-9, D-10)

- **Destination:** Vercel runtime logs of each project. No log or error vendor; one can be added
  later behind the same events via a Vercel log drain, with no code change.
- **Error tracking:** the structured error events: the existing `api.unhandled_error`, plus
  `cron.run` with `status: 'error'` and `health.db_unreachable`. They are found by `event` and
  `correlationId`.
- **`logEvent(level, event, fields)`** (`lib/observability/log.ts`) is the existing convention made
  callable, **not a new system**:
  - it writes the same one-line `JSON.stringify({ event, … })` to `console.info`, `warn` or `error`;
  - it adds `correlationId` from spec 039's request context when present;
  - it applies redaction.
  - New code uses it. Existing `console.*(JSON.stringify(…))` call sites stay valid and are not
    mass-migrated; only the X-list sites change.
- **Redaction:** before serialisation, any field whose key matches (case-insensitive) `password`,
  `secret`, `token`, `authorization`, `cookie`, `otp`, `totp`, `pin`, `cvv`, `cardnumber`, `pan`,
  `iban`, `accountnumber`, `body`, `messagebody` or `content`, at any depth, is replaced by
  `"[REDACTED]"`. Emails and phone numbers are never logged by the helper's callers. Payment and
  message payloads are never passed to it.
- **Correlation IDs:**
  - API: unchanged (`x-correlation-id`, `withApiRoute`), plus one `api.request` line per request from
    `withApiRoute` (X-2): `{correlationId, method, path (pathname only, no query string), status,
    durationMs}`;
  - cron: minted by `withCronRoute` (§3.2).
- **AI request trace** (master §117). Every step logs with the request's `correlationId`:

  | Step | Line | Where |
  |---|---|---|
  | User → AI | `ai.turn_started` | `lib/ai-assistant/turns.ts` (X-7) |
  | AI → MCP tool | `mcp.tool_call` (existing line, gains `correlationId`) | `lib/mcp/audit.ts` (X-7) |
  | authorization | `mcp.authorization_failed` (existing, gains `correlationId`) or the pipeline's allow | `lib/mcp/security-log.ts` (X-7) |
  | backend → result | the durable spec 039 audit row (already carries `correlationId`) | — |
  | → AI response | `ai.turn_completed` (`outcome`, `durationMs`) | `lib/ai-assistant/turns.ts` (X-7) |

  No prompt or message text is logged.
- **Audit logs stay separate** (spec 039). Nothing here writes to `audit_logs`, and application logs
  are not an audit record.

### 3.10 Alerting and paging (decision D-11; spec 041's kill-switch paging)

**What this is:** GitHub Actions is the chosen **no-vendor mechanism** for **scheduled health-check
workflows**. It is **not** a 24/7 monitoring service. It runs on a best-effort schedule, has no
on-call rotation, escalation or guaranteed delivery, and cannot detect its own gaps (see Limits).

**Workflow:** `.github/workflows/ops-health-check.yml`

- **Triggers:** `schedule: '*/5 * * * *'` and `workflow_dispatch`.
- **Matrix:** `environment: [staging, production]`. Each leg runs in the non-gated GitHub
  Environment `monitor-<environment>` (§3.3) and uses its `MONITORING_TOKEN` (secret) and `BASE_URL`
  (variable).
- **Permissions:** `contents: read`, `issues: write`.
- **Steps, per environment:**

| # | Check | Pass condition | Failure detail |
|---|---|---|---|
| 0 | **Fetch** | `GET <BASE_URL>/api/v1/health/detailed` with the bearer token, 20-second timeout; the JSON body is saved as a run artefact | `unreachable` (timeout, connection error, or non-JSON) |
| 1 | **Database / application health** | HTTP `200`; `database` is `up`; `migrations` is `up` | `http_<code>` (`503` means the database is down), `database_down`, `migrations_behind` |
| 2 | **Critical cron/sweep health** | every `cron:<job>` row is `up`. A job with no heartbeat row yet is reported by the endpoint as `never_ran` (§3.7) and fails here, like `stale` and `3_consecutive_failures`. | the failing job names and their `detail` codes |
| 3 | **Spec 041 kill-switch health** | every `kill-switch:<key>` row is `up` (the switch is on) | the keys that are off |
| 4 | **Staleness of the report itself** | `checkedAt` is within 120 s of the runner's clock, so a cached or replayed response fails | `report_stale` |
| 5 | **Production adapters** (production leg only) | no `adapter:*` row reports `sandbox_in_production` | the adapter ports |

**Alert signal**, all three produced on any failed check:

1. **The workflow run fails** (a red run in the Actions tab). GitHub sends its scheduled-workflow
   failure notification to the account that last modified the workflow's schedule.
2. **A GitHub issue** is the durable team-visible alert. Using `gh` and `GITHUB_TOKEN`, the workflow
   opens, or updates if already open, exactly **one issue per environment and check**:
   - titled `[ops-alert] <environment>: <check>` and labelled `ops-alert`;
   - its body lists the failing dependencies, their `detail` codes, `checkedAt`, and a link to the
     run;
   - repeated failures add a comment rather than a new issue;
   - repository watchers receive issue notifications.
3. **Recovery:** when a later run passes that check, the workflow comments "recovered at `<time>`"
   and closes the issue.

**Kill-switch paging (spec 041 §3.7, owned here):**

- A kill switch turned off appears as a `degraded` `kill-switch:<key>` row. Check 3 therefore opens an
  `[ops-alert] <env>: kill-switch` issue on the next run that executes.
- The authoritative who/when/why stays spec 041's audit row and its
  `feature_flags.kill_switch_changed` log line.
- The issue stays open, and gains a comment on each failing run, until the switch is back on.
  This is intended.

**Limits (accepted, and not presented as monitoring coverage):**

- Scheduled runs are best-effort. They can start late (minutes, sometimes around 10–15) or be
  skipped under GitHub load, so detection latency is not guaranteed.
- GitHub disables scheduled workflows in a **public** repository after 60 days without repository
  activity.
- The workflow cannot alert on its own absence. The runbook (§3.11) requires a weekly human check that
  `ops-health-check` runs are present.
- A 24/7 paging vendor can later poll the same `/health/detailed` endpoint with no code change.

### 3.11 Backup and disaster recovery (AC-6; decision D-12)

- **Production database:** Neon, with **point-in-time restore history retained for 7 days**.
  Neon's storage is encrypted at rest.
- **What "7 days" means:** it is the **retention and recovery window**, i.e. how far back a restore
  can target: any moment within the last 7 days. It is **not a 7-day RPO.**
  - The RPO (how much recent data a restore can lose) is determined by Neon's continuous write-ahead-
    log history, not by this window.
  - This spec sets no RPO or RTO figure. If one is required, it is a separate decision to record in
    `docs/operations/disaster-recovery.md`, and each drill's measured restore duration is logged
    (§3.11) to inform it.
- **Protection against casual deletion:**
  - the production project's deletion is limited to the Neon project owner;
  - the application's database role cannot drop the database;
  - `_down.sql` files are never run by CI.
- **Files:** backup protection for uploaded files belongs to the durable object-storage adapter that
  spec 027 must add (§3.1). Until it exists there are no production files to back up; recorded as a
  dependency.
- **Runbooks** in `docs/operations/`:
  - **`disaster-recovery.md`:** restore to a point in time into a **new Neon branch**, verify it
    (row counts of `users`, `bookings`, `payments`, `audit_logs` against the source at the chosen
    time; the latest migration index; the application's `/health/detailed` against it), then switch
    `DATABASE_URL` and redeploy. It also names the roles allowed to do this.
  - **`deploy-rollback.md`:** Vercel Instant Rollback for code, then re-check the crons (§3.2), and
    **no automatic schema rollback** (§3.4).
  - **`monitoring.md`:** how to respond to each `[ops-alert]` check, and a **weekly human check** that
    `ops-health-check` runs are present and recent, because the workflow cannot report its own
    absence (§3.10).
  - **`restore-drills.md`:** a log of each drill: date, operator, target time, duration, verification
    results and issues. **The first drill is required before production launch**, then quarterly and
    after any major infrastructure change.
- **Nothing here claims a backup exists before Neon is provisioned.** AC-6 is verified only by a
  recorded drill.

### 3.12 `BUILD_STATUS.md` (AC-7)

- `BUILD_STATUS.md` at the repository root is created by 046 with the master §130 sections:
  - Completed; In Progress; Blocked; Tested; Known Limitations; Next Recommended Task;
  - Environment setup; External integrations; Test status (including `test/known-failures.json`);
    Migration status; Demo credentials (spec 045: "none — per-visitor sessions; admin evaluators
    provisioned by operator"); Known bugs.
- It is updated in the same PR as each spec's implementation.
- **`check:build-status`** (in `static`) fails a PR that adds or changes a `docs/specs/*` status to
  `Approved` or `Implemented` without also changing `BUILD_STATUS.md`.

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `cron_job_heartbeats` (operational) | new | per §3.8 |

No domain entity. No `BackgroundJobRun`.

### Migration

- **Files:** `drizzle/NNNN_add_cron_job_heartbeats.sql` (the next free journal index when
  implemented; spec 045 reserves `0038` if it lands first), a hand-written `_down.sql`, and the
  journal entry. The schema goes in `lib/db/schema.ts`.
- **Up:** `CREATE TABLE cron_job_heartbeats` with `baseColumns()`, the UNIQUE `job`, and the CHECK.
  **Down:** `DROP TABLE`. Reversible; no backfill; no downtime.
- **Spec 003's `lib/db/schema-coverage.test.ts` / `migrations.integration.test.ts`** may pin table
  lists. They are already stale (spec 041 §8). The gap they report is recorded in
  `test/known-failures.json`, and they are not edited.

### Retention and privacy

- `cron_job_heartbeats` holds no personal data. `last_error_code` is a short code.
- Logs never carry sensitive payloads (redaction, §3.9). Retention follows the Vercel plan's
  runtime-log retention; longer retention needs a log drain later (§7).

---

## 5. UI states

Not applicable as a customer-facing screen. `BUILD_STATUS.md` and CI dashboards are
engineering-internal artifacts, not part of the product UI. `/health/detailed` is JSON for
monitoring, not a page.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | redaction (keys at any depth, case-insensitive; non-sensitive keys kept); `correlationId` injected from request context; the one-line JSON shape | `lib/observability/log.test.ts` |
| **Unit** | `withCronRoute`: `401` on a missing or wrong bearer (constant-time); a heartbeat success/failure update; a `cron.run` line with `correlationId`; context propagation to an audit write | `lib/cron/route.test.ts` |
| **Unit** | the schedule parser over `vercel.json`; staleness = max(3 × interval, 10 min) | `lib/cron/schedules.test.ts` |
| **Integration** | `/health/detailed`: `401` without the token; `200 healthy`; the database made unreachable → `503 down`; a stale sweep → `degraded`; a kill switch off → `degraded`; a sandbox under `APP_ENV=production` → `degraded`; no error text in `detail` | `app/api/v1/health/detailed/route.integration.test.ts` |
| **Integration** | `/health` still `200` with the database down, and no `db.error` in the body | spec 001's existing `app/api/v1/health/route.test.ts` (unchanged), plus `app/api/v1/health/no-leak.test.ts` (new) |
| **Integration** | heartbeat migration up/down; a real cron route (`sample`) through `withCronRoute` updates its row | `lib/cron/heartbeats.integration.test.ts` |
| **Unit** | `scripts/test-groups.ts` puts every test file in exactly one group; `scripts/check-test-baseline.ts` new/stale detection; `check:migration-pairing`; `check:no-workspace`; `check:build-status` | `scripts/*.test.ts` |
| **Browser** | the runner smoke test | `browser/smoke.browser.ts` |
| **Pipeline** | on a throwaway branch: a lint error, a type error, a failing new test, a schema change without a migration, a fake committed secret, and a broken browser smoke test each turn their required check red; a fixed known-failure turns it red as stale | manual verification, recorded in the implementing PR |
| **Monitor** | against staging, each check turns the `ops-health-check` run red and opens exactly one `[ops-alert] staging: <check>` issue, then comments and closes it on recovery. The triggers are: a kill switch turned off (check 3), a sweep made stale (check 2), a wrong token (check 0/1), and a replayed old report (check 4). A second failing run comments rather than duplicating. | manual verification, recorded |
| **DR** | a restore drill per §3.11 | `docs/operations/restore-drills.md` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `.github/workflows/ci.yml` + branch protection; `scripts/*.test.ts`; the pipeline verification record |
| AC-2 | `deploy-staging.yml` / `deploy-production.yml` + the `production` environment's required reviewer; the first staging and production deploys recorded |
| AC-3 | `scripts/check-migration-pairing.test.ts` + the pipeline record |
| AC-4 | `lib/observability/log.test.ts`, `lib/cron/route.test.ts`, the AI-trace lines' tests under X-7 (`lib/ai-assistant/trace.test.ts`) |
| AC-5 | `lib/cron/route.test.ts`, `lib/cron/schedules.test.ts`, `app/api/v1/health/detailed/route.integration.test.ts::stale sweep` |
| AC-6 | `docs/operations/restore-drills.md` (evidence, not a unit test) |
| AC-7 | `scripts/check-build-status.test.ts` + `BUILD_STATUS.md` |
| AC-8 | `app/api/v1/health/detailed/route.integration.test.ts::reflects real dependency status`, `app/api/v1/health/no-leak.test.ts` |

**Coverage:** ≥80% statements on `lib/observability/**`, `lib/cron/**` and the new scripts. The CI's
completeness is AC-1's check list plus the pipeline verification record.

**Other specs' tests stay green and unedited.** That includes spec 001's `health/route.test.ts` and
`cron/sample/route.test.ts`, and each cron route's own tests. Pre-existing failures go into
`test/known-failures.json` and are reported, never fixed here.

**Not covered, deliberately:** Load/stress testing at production scale (a later, ongoing
operational practice, not a one-time MVP acceptance criterion).

---

## 7. Out of scope

- Multi-region/high-availability infrastructure design (beyond MVP scope per master spec §120's
  "don't over-engineer" guidance).
- Cost-optimization tooling beyond spec 033's AI-specific cost controls.
- A production Docker/self-hosted target and its scheduler (D-1).
- A generic job queue, worker or `BackgroundJobRun` (D-8).
- An error-tracking, log-aggregation or paging vendor. The events are ready for one later (D-10,
  D-11).
- Real payment, payout, notification, file-storage and AI adapters, and changing the sandbox guards
  (their owning specs; see spec 045 DEP-1).
- PR preview deployments.

---

## 8. Dependencies, decisions, risks

### Dependencies

| # | Dependency | Owner | Needed for |
|---|---|---|---|
| DEP-1 | A Vercel **Pro** team with two projects (`apuriva-staging`, `apuriva-production`) and Git auto-deploy disabled | operations (account) | AC-2, crons |
| DEP-2 | A Neon organisation: a production project with a 7-day PITR retention window, plus a staging database | operations (account) | AC-6, AC-2 |
| DEP-3 | GitHub Environments `staging`, `production` (required reviewer), `monitor-staging` and `monitor-production` (not gated), the §3.3 secrets and variables, an `ops-alert` issue label, and branch protection on `main` | repository owner | AC-1, AC-2 |
| DEP-4 | The in-flight working-tree changes (spec 033 OpenAI work in `lib/ai/**`, `package.json`, `package-lock.json`, `.env.example`, `instrumentation.ts`, plus the other unrelated modified files) are landed first. 046 edits `package.json`, `.env.example` and `vitest.config.ts`, and the known-failures baseline must be captured on a clean tree. | — | implementation start |

### Authorized cross-spec changes (X-list)

| # | Owning spec | File(s) | Change |
|---|---|---|---|
| X-1 | 001 | `app/api/v1/health/route.ts` | Remove `db.error` from the body; log it as `health.db_unreachable` instead. Nothing else. |
| X-2 | 004 | `lib/api/handler.ts` | Emit one `api.request` line per request (§3.9). The envelope and error behaviour are unchanged. |
| X-3 | each route's owning spec, as named in that route file's header comment (spec 001 owns `sample`) | the 17 `app/api/v1/cron/*/route.ts` | Wrap the existing handler in `withCronRoute(job, …)`, which moves the inline bearer check into the wrapper. The handler bodies are unchanged. This includes the currently modified `account-deletion-sweep`, **after DEP-4**. |
| X-4 | 004 | `lib/api/openapi-registry.ts` | `/health/detailed` |
| X-5 | 001 | `vitest.config.ts` | Add `browser/**` to `exclude`. Nothing else. |
| X-6 | 001 | `.env.example`, `package.json` (scripts and devDependencies: `eslint`, `eslint-config-next`, `@playwright/test`) | Document `MONITORING_TOKEN`; add the scripts `lint`, `check:migration-pairing`, `check:no-workspace`, `check:build-status`, `test:browser` |
| X-7 | 034/035 | `lib/ai-assistant/turns.ts`, `lib/mcp/audit.ts` (default sink line), `lib/mcp/security-log.ts` | Add `correlationId` and the `ai.turn_started` / `ai.turn_completed` lines through `logEvent`. No behavioural change. |

### Decisions

| # | Decision |
|---|---|
| D-1 | Vercel only: two Pro projects (staging, production), deployed by CI with migrations first. Docker is local/self-host development only, with no scheduler. |
| D-2 | Keep Vercel Cron and the 17 per-domain routes; add `withCronRoute` (constant-time auth, correlation ID, heartbeat, `cron.run`). |
| D-3 | Secrets live in Vercel per-project environment variables and GitHub Environments; there is no secret-manager vendor. This resolves spec 001 §8 #4. |
| D-4 | GitHub Actions `ci.yml` with eight required checks (§3.4). The master §114 stages are named jobs, and every test file belongs to exactly one group. |
| D-5 | Pre-existing failures live in `test/known-failures.json` and lint debt in `eslint-suppressions.json`. Both ratchet: new failures fail, fixed-but-listed entries fail as stale. |
| D-6 | Playwright (Chromium) is the browser runner: `browser/**/*.browser.ts`, excluded from Vitest, running against `next start` on `apuriva_browser_test`. Specs 043 and 044 own their tests. |
| D-7 | `/health` stays liveness (spec 001 contract, minus the leaked error text). The new authenticated `/health/detailed` is accurate readiness, answering `503` when the database is down. |
| D-8 | No `BackgroundJobRun`. Per-item retry and dead-letter states stay domain-owned; `cron_job_heartbeats` covers only whole-sweep failure or silence. |
| D-9 | Logs are Vercel runtime logs. `logEvent` formalises the existing `{event,…}` convention with redaction and automatic `correlationId`. |
| D-10 | No error-tracking vendor; errors are structured error events. |
| D-11 | Alerting is a scheduled GitHub Actions health-check workflow (`ops-health-check.yml`, every 5 minutes, best-effort, not 24/7 monitoring) running five defined checks against `/health/detailed`: application/database, cron/sweep, spec 041 kill switches, report staleness, and production adapters. It signals through a failed run plus one deduplicated `ops-alert` issue per environment and check, closed on recovery. It owns spec 041's kill-switch paging. |
| D-12 | Neon PITR with a 7-day retention/recovery window (not an RPO); a restore drill before launch, then quarterly and after major infrastructure changes; the runbooks in `docs/operations/`. |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | The full suite is slow (about 30 minutes locally) | Group jobs run in parallel; integration is 4-way sharded |
| R-2 | GitHub scheduled monitoring lags or skips runs | Accepted for MVP (§3.10); a vendor can poll the same endpoint later |
| R-3 | Serverless instances make spec 004's in-process rate limits per-instance | A pre-existing spec 004 property; recorded, not changed here |
| R-4 | Staging and production cannot run sandbox adapters under `NODE_ENV=production` | Owned by specs 021/024/026/027/033 (spec 045 DEP-1); `/health/detailed` makes it visible |
| R-5 | The known-failures baseline hides real regressions in listed tests | Entries are per test (not per file), carry an owning spec, and are reported; the ratchet removes them as they are fixed |
| R-6 | A migration incompatible with the previous code blocks rollback | The expand/contract rule (§3.4) is part of PR review; `_down.sql` is human-only |

---

## 9. Rollout

- **Feature flag:** N/A — this spec is the delivery mechanism for every other spec's flags, not
  itself flaggable.
- **Order:**
  1. DEP-4 (a clean tree).
  2. CI (`static`, the test groups with the captured baselines, `build`, `browser` smoke), then turn
     on branch protection.
  3. `withCronRoute`, the heartbeat migration, `/health/detailed` and `logEvent`.
  4. The Vercel projects, the deploy workflows, the monitor, the Neon PITR configuration, the first
     restore drill, the runbooks and `BUILD_STATUS.md`.
- **Rollback:**
  - CI: remove required checks.
  - Application changes: revert the deploy (the handlers are unchanged under the wrapper).
  - The heartbeat `_down.sql` is optional.
  - The documented deploy-rollback runbook is what every other spec's "Rollback" section depends on.
- **Observability:** this spec **is** the observability layer. Its own signals are the CI history, the
  monitor's run history and `/health/detailed`.
