# Spec: Monorepo & Environment Foundation

**File:** `docs/specs/2026-08-28-001-monorepo-environment-foundation.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §4.4, §118, §132.20, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §1, §3, §16, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No code exists. There is no monorepo, no app skeleton, no environment/secrets
convention. Every subsequent spec (002–046) assumes `apps/web`, `apps/api`, `apps/worker`, and
a shared `packages/*` set already exist with a working local dev loop and a documented
env-variable contract.

**Who is affected:** Every future contributor and every future spec's implementation — without
this, each feature would invent its own project layout, ad hoc scripts, and inconsistent secret
handling, defeating the "modular monolith, one deployable backend" architecture decision.

**Why it matters now:** It is the literal first buildable slice (master spec §131, Milestone 1)
and a prerequisite for everything else.

**Success looks like:** A fresh clone of the repo, following `README.md`, installs dependencies,
copies `.env.example` to `.env`, and runs `apps/web`, `apps/api`, and `apps/worker` locally
against a local Postgres instance with zero manual code changes.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a fresh clone **When** a contributor runs the documented install command **Then** `apps/web`, `apps/api`, and `apps/worker` all start locally without error |
| AC-2 | **Given** the repo root **When** inspecting `packages/` **Then** `ui`, `types`, `config`, `validation`, `auth`, `ai`, `mcp`, `database`, `location`, `payments` all exist as independently buildable workspace packages |
| AC-3 | **Given** `.env.example` **When** compared against every `process.env.*` read in `apps/*` and `packages/*` **Then** every variable referenced in code has a corresponding documented entry in `.env.example` (no undocumented env var) |
| AC-4 | **Given** a secret value (API key, DB password) **When** searching the git history and working tree **Then** no real secret value is committed — only `.env.example` placeholders |
| AC-5 | **Given** `apps/api` and `apps/web` **When** built independently **Then** each builds and deploys without requiring the other to be present (independent deployability) |
| AC-6 | **Given** the shared packages **When** one app imports from `packages/ui` or `packages/types` **Then** the import resolves through the workspace, not a published npm version |

---

## 3. API contract

Not applicable — this spec establishes project structure, not an API surface. `apps/api`'s
`/api/v1/` root and its shared response envelope are defined in
`docs/specs/2026-08-28-004-api-foundation-response-standards.md`, built on top of this
foundation.

---

## 4. Data model changes

Not applicable — no domain entities. This spec does establish the **database connection and
migration tooling** that `docs/specs/2026-08-28-003-database-core-data-model.md` builds its
schema on top of (`packages/database`: ORM client, migration runner, connection pooling,
per-environment connection strings sourced from env vars).

### Retention and privacy

None — no personal data is introduced by this spec.

---

## 5. UI states

Not applicable at the feature level. This spec does establish `apps/web` as a Next.js App
Router project so that every later spec's "Route(s)" section (`apps/web/app/...`) has somewhere
to live, and wires up the base HTML shell, global error boundary, and a placeholder loading
state so the app never renders blank/broken on first load.

**Route(s):** `apps/web/app/layout.tsx` (root shell only)
**Shared components used/added:** None yet — `packages/ui` is scaffolded empty by
`docs/specs/2026-08-28-002-design-system-ui-primitives.md`.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | none yet (no business logic) | — |
| **Integration** | smoke test: API boots and responds `200` on a health-check route | `apps/api/health.integration.test.ts` |
| **Architecture** | a lint rule / CI check that fails if any `process.env.X` is read without a matching `.env.example` entry | CI script, see §9 |
| **Component** | Next.js app renders root layout without throwing | `apps/web` smoke test |
| **E2E** | none yet | — |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | manual + CI: `docker-compose up` / equivalent boots all three apps |
| AC-3 | `scripts/check-env-parity.ts` (new CI script) |
| AC-4 | CI secret-scanning step (gitleaks or equivalent) |
| AC-5 | CI: `apps/api` build job has no dependency on `apps/web` build output, and vice versa |

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

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Which package manager/workspace tool (npm workspaces, pnpm, Turborepo, Nx) — the master spec mandates a monorepo but not a specific tool | — | Open — recommend pnpm workspaces + Turborepo for build caching across `apps/*`/`packages/*`; confirm before implementation |
| 2 | Local Postgres: Docker Compose vs. a hosted dev database | — | Open — recommend Docker Compose for a zero-cloud-dependency local loop |
| 3 | Secret management approach for staging/production (env vars only, or a secret manager e.g. Doppler/Vault/cloud KMS) | — | Open — must be decided before `docs/specs/2026-08-28-046-...md`, not blocking for local dev |

---

## 9. Rollout

- **Feature flag:** none — this is foundational infrastructure, not a togglable feature.
- **Migration order:** N/A.
- **Rollback:** N/A (nothing in production yet).
- **Observability:** a health-check endpoint (`GET /api/v1/health`) returning process status,
  DB connectivity, and build/version metadata — the first thing every later observability spec
  builds on.
