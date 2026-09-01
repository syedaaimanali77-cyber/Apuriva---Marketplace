# Spec: Application & Environment Foundation

**File:** `docs/specs/2026-08-28-001-application-environment-foundation.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §4.2, §4.4 (proposed deviation, pending re-approval — see note below), §118, §132.20, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §1, §3, §16, [docs/workflow.md](../workflow.md)

> **Revision note (2026-08-29):** This spec previously called for a monorepo — three separate
> applications (`apps/web`, `apps/api`, `apps/worker`) plus ten shared `packages/*` workspace
> libraries — per Master Spec §4.4 ("Use a monorepo"). The product owner explicitly requested a
> simpler alternative. This revision proposes replacing the monorepo with a single Next.js
> application, pending re-approval of this deviation from §4.4. The Master Spec's underlying "modular
> monolith, one deployable backend, don't start with microservices" principle (§4.2) is fully
> preserved — only the multi-app/multi-package *packaging* is removed, not the architectural
> discipline behind it.
>
> **Known follow-up, not done here:** specs 002–046 and `docs/workflow.md` still reference the
> original `apps/web` / `apps/api` / `packages/*` paths in their Route(s), API contract, and Test
> plan sections. Those references are now inconsistent with this revision and will need a
> separate reconciliation pass — intentionally out of scope for this change, which touches only
> this file.

---

## 1. Problem statement

**Today:** No code exists. There is no application skeleton, no environment/secrets convention.
Every subsequent spec (002–046) was originally written assuming a multi-app monorepo. This
revision replaces that assumption with a single Next.js application containing both the frontend
and the backend, so the project doesn't carry multi-package workspace tooling before there is
any real need to share code across more than one deployable unit.

**Who is affected:** Every future contributor and every future spec's implementation — a simpler
foundation means less tooling overhead inherited by every later spec, at the cost of an update
pass needed across specs that still reference the old multi-app paths (see follow-up note above).

**Why it matters now:** It is the literal first buildable slice (master spec §131, Milestone 1)
and a prerequisite for everything else.

**Success looks like:** A fresh clone of the repo, following `README.md`, installs dependencies
with a single `npm install`, copies `.env.example` to `.env`, and runs the one application
locally against a local Postgres instance with zero manual code changes — no workspace tooling,
no multi-package build orchestration, no separate processes to start.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a fresh clone **When** a contributor runs `npm install` and the documented start command **Then** the single application starts locally without error |
| AC-2 | **Given** the repo root **When** inspected **Then** there is exactly one `package.json` and no workspace/monorepo tooling present (no `pnpm-workspace.yaml`, no Turborepo/Nx config, no `packages/` directory) |
| AC-3 | **Given** `.env.example` **When** compared against every `process.env.*` read in the application **Then** every variable referenced in code has a corresponding documented entry in `.env.example` (no undocumented env var) |
| AC-4 | **Given** a secret value (API key, DB password) **When** searching the git history and working tree **Then** no real secret value is committed — only `.env.example` placeholders |
| AC-5 | **Given** the application's internal modules (auth, requests, offers, bookings, payments, etc.) **When** inspected **Then** each lives in its own clearly-bounded folder — the "modular monolith" principle (master spec §4.2) preserved as internal folder structure, not as separately-versioned packages |
| AC-6 | **Given** a background/scheduled job (offer expiry, notification dispatch, payout eligibility) **When** it needs to run outside a normal request/response cycle **Then** it is triggered through the chosen lightweight scheduling mechanism (§8), not a separately-deployed, always-on worker process |

---

## 3. API contract

Not applicable — this spec establishes project structure, not an API surface. The API routes
live inside the single application, under `app/api/v1/...` (Next.js Route Handlers), and their
shared response envelope is defined in
`docs/specs/2026-08-28-004-api-foundation-response-standards.md`, built on top of this
foundation. These are the same routes a future mobile client would call directly — there is no
separate API service to keep in sync with them.

---

## 4. Data model changes

Not applicable — no domain entities. This spec does establish the **database connection and
migration tooling** that `docs/specs/2026-08-28-003-database-core-data-model.md` builds its
schema on top of — an internal database module (ORM client, migration runner, connection
pooling, per-environment connection strings sourced from env vars) living inside the single
application, rather than a separate workspace package.

### Retention and privacy

None — no personal data is introduced by this spec.

---

## 5. UI states

Not applicable at the feature level. This spec does establish the Next.js App Router project so
that every later spec's "Route(s)" section (`app/...`) has somewhere to live, and wires up the
base HTML shell, global error boundary, and a placeholder loading state so the app never renders
blank/broken on first load.

**Route(s):** `app/layout.tsx` (root shell only)
**Shared components used/added:** None yet — the shared UI components are scaffolded empty by
`docs/specs/2026-08-28-002-design-system-ui-primitives.md`, living in an internal components
folder rather than a separate workspace package.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | none yet (no business logic) | — |
| **Integration** | smoke test: the app boots and its health route responds `200` | `app/api/v1/health/route.test.ts` |
| **Architecture** | a lint rule / CI check that fails if any `process.env.X` is read without a matching `.env.example` entry | CI script, see AC-3 below |
| **Component** | Next.js app renders root layout without throwing | root-layout smoke test |
| **E2E** | none yet | — |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | manual + CI: documented start command boots the app |
| AC-2 | CI check: no workspace-tooling config files present in the repo |
| AC-3 | `scripts/check-env-parity.ts` (new CI script) |
| AC-4 | CI secret-scanning step (gitleaks or equivalent) |
| AC-5 | manual review: internal modules (auth, requests, offers, bookings, payments, etc.) each live in a clearly-bounded folder |
| AC-6 | integration test confirming a sample scheduled job fires through the chosen mechanism |

**Coverage:** Not meaningfully measurable at this stage; establishes the coverage tooling that
later specs are held to ≥80% against.

**Not covered, deliberately:** No feature logic exists yet to test.

---

## 7. Out of scope

- Any actual feature/business logic (every subsequent spec).
- Production infrastructure provisioning (hosting, managed Postgres, CDN) — tracked separately,
  not part of this spec; only the *local* dev loop and the *environment variable contract* are
  in scope here.
- CI/CD pipeline itself (lint/typecheck/test/deploy gates) — see
  `docs/specs/2026-08-28-046-engineering-operations-cicd-observability.md`. This spec only
  ensures the repo is structured so that pipeline can be added.
- Splitting the application into multiple deployable units. If a genuine need to share code
  across more than one deployable app arises later (for example, a native mobile codebase that
  needs more than just calling the same API), that would be a new spec revisiting this decision
  — not assumed or pre-built here.
- Updating specs 002–046 and `docs/workflow.md`'s path references to match this revision (see
  the follow-up note above).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Background/scheduled job mechanism | — | Decided — Vercel Cron calling internal Next.js API routes (no separate hosted scheduler/queue service) |
| 2 | Package manager | — | Decided — plain `npm`, the smallest tooling surface for a single `package.json` |
| 3 | Local Postgres | — | Decided — Docker Compose running a local Postgres instance, for a zero-cloud-dependency local loop |
| 4 | Secret management approach for staging/production (env vars only, or a secret manager e.g. Doppler/Vault/cloud KMS) | — | Open — must be decided before `docs/specs/2026-08-28-046-...md`, not blocking for local dev |

---

## 9. Rollout

- **Feature flag:** none — this is foundational infrastructure, not a togglable feature.
- **Migration order:** N/A.
- **Rollback:** N/A (nothing in production yet).
- **Observability:** a health-check endpoint (`GET /api/v1/health`) returning process status,
  DB connectivity, and build/version metadata — the first thing every later observability spec
  builds on.
