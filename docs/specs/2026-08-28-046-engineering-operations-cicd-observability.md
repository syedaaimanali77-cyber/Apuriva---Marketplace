# Spec: Engineering Operations (CI/CD / Observability)

**File:** `docs/specs/2026-08-28-046-engineering-operations-cicd-observability.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §114–§117, §129–§130, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §15, §17, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 001 established the single-application/local dev loop but not a CI/CD pipeline, and no
structured observability (logging, tracing, alerting, backup/DR) exists despite every prior spec
referencing "monitored," "alerted," or "audited" as if these mechanisms already work end to end.
Master spec §114 requires a full CI pipeline (lint, typecheck, unit, integration, MCP, security/
permission, E2E tests) gating deploys, with reviewed migrations and a rollback strategy. §116
requires automated backups, point-in-time recovery, and tested disaster recovery. §117 requires
structured logs, error tracking, performance monitoring, MCP execution tracing, job monitoring,
health checks, and correlation IDs — audit logs kept separate (already delivered by spec 039).
§129–§130 require a `BUILD_STATUS.md` tracking progress and a vertical-slice development
workflow.

**Who is affected:** Every engineer shipping code; on-call responders; anyone relying on the
"monitored"/"alerted" claims scattered across specs 001–045.

**Why it matters now:** It's the last spec because it's the mechanism that makes every prior
spec's CI/observability references real, and it also formalizes how *this entire set of 46
specs* gets built safely, slice by slice.

**Success looks like:** Every PR runs the full gate (lint → typecheck → unit → integration → MCP
→ security/permission → E2E) before merge; passing PRs auto-deploy to staging, production
requires approval; migrations are reviewed as SQL; structured logs/traces/alerts exist with the
AI request trace fully instrumented; backups are automated and recovery-tested;
`BUILD_STATUS.md` is maintained throughout implementation.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any PR **When** opened **Then** CI runs lint, typecheck, unit tests, integration tests, MCP tests, security/permission tests, and E2E tests, blocking merge on any failure |
| AC-2 | **Given** a PR that passes all checks and merges to main **When** the pipeline completes **Then** it auto-deploys to staging; production deployment requires explicit manual approval |
| AC-3 | **Given** a database migration **When** included in a PR **Then** its generated SQL is visible in the PR for review before merge (ties to every prior spec's §4 "Reviewed SQL" requirement) |
| AC-4 | **Given** a production incident **When** investigated **Then** structured logs, error tracking, and the AI request trace (`User → AI → MCP tool → authorization → backend → result → AI response`) are queryable by correlation ID |
| AC-5 | **Given** a background job (offer expiry, payout eligibility, notification dispatch, analytics ingestion) **When** it fails **Then** it is retried with backoff, and persistent failures land in a monitored dead-letter queue, never silently dropped |
| AC-6 | **Given** the production database **When** backed up **Then** automated backups run on a defined schedule with point-in-time recovery available, and recovery has been tested at least once (documented, not just configured) |
| AC-7 | **Given** the implementation of any spec 001–045 **When** a vertical slice completes **Then** `BUILD_STATUS.md` is updated with Completed/In Progress/Blocked/Tested/Known Limitations/Next Recommended Task |
| AC-8 | **Given** a health-check endpoint **When** polled **Then** it accurately reflects process, database, and critical-dependency status |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/health` | none | `200` (already stubbed spec 001) | this spec makes it fully accurate: DB, queue, AI-provider reachability |
| `GET` | `/api/v1/health/detailed` | admin (Super Admin) or internal monitoring | `200` `ApiResponse<DetailedHealthDto>` | dependency-level breakdown |

### Request and response types

```typescript
// lib/types/ops.ts
export interface DetailedHealthDto {
  status: 'healthy' | 'degraded' | 'down';
  dependencies: Array<{ name: string; status: 'up' | 'down' | 'degraded'; latencyMs?: number }>;
  version: string;
  deployedAt: string;
}
```

### Error codes

Not applicable in the usual REST sense — this spec's "errors" are pipeline failures (CI red
builds, alert firings), not API error codes.

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

No new domain entity. This spec configures infrastructure (CI pipeline definitions, logging/
tracing instrumentation, backup schedules) rather than adding application data, though it may
rely on:

| Entity | Change | Fields |
|---|---|---|
| (operational, not domain) `BackgroundJobRun` | new (if not already implicit in the queue technology) | `id uuid pk`, `job_type text`, `status text`, `attempt_count integer`, `last_error text nullable`, `created_at`, `completed_at timestamptz nullable` |

### Migration

- **Name:** `AddBackgroundJobRunTracking` (if needed beyond the queue technology's own state)
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Logs/traces must not log sensitive payloads (payment details, passwords, full message bodies)
in plaintext — structured logging redacts known-sensitive fields by default.

---

## 5. UI states

Not applicable as a customer-facing screen. `BUILD_STATUS.md` and CI dashboards are
engineering-internal artifacts, not part of the product UI.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Pipeline** | the CI pipeline itself is tested by deliberately introducing a failing lint/type/test case in a throwaway branch and confirming the gate blocks merge | manual verification during implementation |
| **Integration** | health-check accuracy under a simulated dependency outage | `app/api/v1/ops/health.integration.test.ts` |
| **Background job** | retry/backoff/dead-letter behavior under simulated repeated failure | `app/api/v1/cron/job-reliability.test.ts` |
| **DR** | documented, executed recovery drill against a backup, verifying data integrity post-restore | recovery drill runbook + its recorded results |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | CI configuration itself + a verification branch demonstrating each gate blocks on failure |
| AC-5 | `app/api/v1/cron/job-reliability.test.ts::dead-letters after max retries` |
| AC-6 | recovery-drill documentation (evidence, not a unit test) |
| AC-8 | `app/api/v1/ops/health.integration.test.ts::reflects real dependency status` |

**Coverage:** N/A in the usual sense — this spec's "coverage" is pipeline-gate completeness
(AC-1's full checklist) and DR-drill execution, not a code-coverage percentage.

**Not covered, deliberately:** Load/stress testing at production scale (a later, ongoing
operational practice, not a one-time MVP acceptance criterion).

---

## 7. Out of scope

- Multi-region/high-availability infrastructure design (beyond MVP scope per master spec §120's
  "don't over-engineer" guidance).
- Cost-optimization tooling beyond spec 033's AI-specific cost controls.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Hosting/infrastructure provider selection (affects backup/DR mechanics specifics) | — | Open — application hosting is constrained to Vercel (or a Vercel Cron-compatible equivalent) by spec 001 §8's background-job decision; database/backup/DR provider selection remains open |
| 2 | Error-tracking and log-aggregation tool selection (e.g. Sentry + a log platform) | — | Open |
| 3 | Cadence of DR-drill re-verification (one-time vs. periodic) | — | Open — recommend at minimum before production launch and after any major infra change |

---

## 9. Rollout

- **Feature flag:** N/A — this spec is the delivery mechanism for every other spec's flags, not
  itself flaggable.
- **Migration order:** any operational-tracking schema ships with code.
- **Rollback:** the rollback strategy this spec itself establishes (documented deploy-rollback
  runbook) is what every other spec's "Rollback" section ultimately depends on being real.
- **Observability:** this spec **is** the observability layer — its own success is measured by
  whether every prior spec's "Observability" section's claims are actually true in production.
