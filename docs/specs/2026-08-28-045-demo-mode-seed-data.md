# Spec: Demo Mode & Seed Data

**File:** `docs/specs/2026-08-28-045-demo-mode-seed-data.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §110–§113, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §16, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No demo mode or realistic seed data exists. Master spec §110 requires realistic,
clearly-identifiable, controlled seed data across every entity type (accounts, categories,
services, providers, packages, portfolios, reviews, requests, offers, bookings, notifications,
availability states). §111 requires one-click demo accounts per persona with a reset capability
and clear Demo Mode labeling, no real money. §112 requires demo payments to use the real payment
provider's sandbox, not a fabricated success path.

**Who is affected:** Anyone evaluating the product (stakeholders, sales, QA); every prior spec's
manual/E2E testing, which needs realistic data to exercise against.

**Why it matters now:** Sequenced near the end since it seeds data across every entity from
specs 003–041 — it can only be complete once those entities are finalized.

**Success looks like:** One-click demo accounts (Customer/Provider/Admin) exist, pre-loaded with
realistic, clearly-labeled, resettable data spanning the full marketplace; demo payments run
through the real payment provider's sandbox with simulated success/failure/pending/cancellation,
never fabricated in application code; no real money moves in demo mode.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** the demo entry point **When** a visitor clicks "Try as Customer/Provider/Admin" **Then** they're logged into a pre-created demo account for that persona with one click, no manual signup |
| AC-2 | **Given** demo data **When** inspected **Then** it spans the 8 categories, multiple services, provider profiles with packages/portfolios, reviews, requests, offers (including expired ones), bookings across every status, notifications, and providers in each availability state (Available/Busy/Unavailable) |
| AC-3 | **Given** demo data **When** displayed anywhere in the UI **Then** it is clearly labeled as demo, never indistinguishable from real production data |
| AC-4 | **Given** a demo payment **When** processed **Then** it runs through the payment provider's official sandbox environment, supporting simulated success/failure/pending/cancellation — never a fabricated "success" branch in application code bypassing the real integration |
| AC-5 | **Given** a demo account **When** the user requests a reset **Then** demo data returns to its clean seeded state without affecting any other demo session's data or any production data |
| AC-6 | **Given** demo mode **When** any action is taken **Then** no real money is charged and no real notification (SMS/email/push) is sent to a real external recipient |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/demo/login` | none | `200` `ApiResponse<SessionDto>` | body: `{ persona: 'customer' \| 'provider' \| 'admin' }` |
| `POST` | `/api/v1/demo/reset` | session (demo account only) | `200` | resets caller's demo data to seed state |

### Request and response types

```typescript
// packages/types/src/demo.ts
export interface DemoLoginRequest {
  persona: 'customer' | 'provider' | 'admin';
}
```

Demo accounts are flagged via `User.is_demo boolean` so every other endpoint can branch demo-
specific behavior (e.g. notification dispatch, spec 026, no-ops external sends for demo users
while still exercising the internal notification-creation logic).

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `DEMO_NOT_AVAILABLE_IN_PRODUCTION` | if demo mode is deliberately disabled in a given environment |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `User` | extend | `is_demo boolean default false` |
| (every seeded entity) | extend | implicit via `is_demo`-flagged owning `User`/`CustomerProfile`/`ProviderProfile` — no need to flag every child row individually if ownership chains back to a demo user |

A seed script (`packages/database/seed`) populates the full realistic dataset described in
master spec §110, tagged as demo via the owning accounts' `is_demo` flag.

### Migration

- **Name:** `AddDemoFlagAndSeedScript`
- **Reversible:** yes
- **Backfill required:** yes — run the seed script in non-production environments
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR; seed script reviewed for realism and completeness

### Retention and privacy

Demo data contains no real personal information — all demo user profiles are fabricated,
clearly synthetic (e.g. obviously placeholder names/numbers), never real customer/provider data.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | demo login shows a brief "Setting up your demo..." state |
| **Empty** | N/A — demo accounts are always pre-populated |
| **Error** | reset failure shows retry, never leaves data in a partially-reset inconsistent state |
| **Success** | demo mode banner persistently visible across the entire session (master spec §111's "clear Demo Mode label") |

**Route(s):** `apps/web/app/demo` (entry point), demo banner rendered globally when
`is_demo = true`
**Shared components used/added:** `packages/ui` `DemoModeBanner` (new)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | `is_demo` propagation/branching logic (notification no-op, payment sandbox routing) | `apps/api/demo/**/*.test.ts` |
| **Integration** | one-click login per persona; reset restores clean state without cross-session leakage; demo payment uses real sandbox | `apps/api/demo/*.integration.test.ts` |
| **E2E** | full demo walkthrough per persona touching the core journeys (search→request→offer→booking→payment→completion→review) | `apps/web-e2e/demo-mode.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/web-e2e/demo-mode.spec.ts::one-click login per persona` |
| AC-2 | `packages/database/seed/coverage.test.ts::spans all required entity states` |
| AC-4 | `apps/api/demo/payment.integration.test.ts::real sandbox, not fabricated` |
| AC-5 | `apps/api/demo/reset.integration.test.ts::isolated reset, no cross-session leakage` |
| AC-6 | `apps/api/demo/notifications.integration.test.ts::no real external send` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Seed-data realism/quality as a subjective judgment — functional
completeness (all required states represented) is the acceptance bar, not editorial polish.

---

## 7. Out of scope

- Sales/marketing-specific demo scripting or guided tours (a product/growth concern, not a
  platform spec).
- Multi-tenant demo isolation beyond per-account reset (each demo login gets a consistent,
  resettable dataset; concurrent demo users are not expected to collide given `is_demo`
  scoping, but true multi-tenant sandboxing is not required for MVP).

---

## 8. Risks and open questions

| # | risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Whether demo accounts are shared (one fixed demo login per persona) or provisioned fresh per visitor session | Product | Open — affects AC-5's reset semantics significantly |

---

## 9. Rollout

- **Feature flag:** `demo-mode` (default on in staging/demo environments, off in production
  unless explicitly desired for sales purposes).
- **Migration order:** schema + seed script ships with code; seed script re-run on each
  non-production deploy to keep demo data fresh.
- **Rollback:** revert deploy; demo data itself is disposable/reseedable, not a rollback
  concern.
- **Observability:** demo-session usage volume tracked separately from real production metrics
  (spec 040), explicitly excluded from real revenue/funnel reporting.
