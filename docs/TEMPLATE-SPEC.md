# Spec: <Feature name>

**File:** `docs/specs/YYYY-MM-DD-<counter>-<slug>.md`
**Status:** Draft | Approved | Implemented | Superseded
**Author:** <name>
**Reviewer:** <name — a human, always>
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §§<x-y>, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §<n>, [docs/workflow.md](../workflow.md)

> Written and approved **before** implementation starts. Stage 1 of
> [the workflow](../workflow.md). If the spec changes mid-implementation, update this file in
> the same pull request — a spec that no longer matches the code is worse than no spec.
>
> Delete the guidance blockquotes when you fill this in. Keep every heading; write "None" where
> a section genuinely does not apply, so a reader can tell the difference between *considered
> and empty* and *forgotten*.

---

## 1. Problem statement

> What is wrong or missing today, for whom, and what does it cost them? Describe the problem,
> not the solution. Two or three paragraphs at most. If you cannot state the problem without
> naming your intended implementation, you do not understand it yet.

**Today:**

**Who is affected:**

**Why it matters now:**

**Success looks like:** <one sentence, observable from outside the system>

---

## 2. Acceptance criteria

> Every criterion is Given/When/Then, independently testable, and observable through the API or
> the UI — not through internal state. These become the tests. A criterion nobody can write a
> test for is not a criterion; rewrite it.

| # | Criterion |
|---|---|
| AC-1 | **Given** <starting state> **When** <action> **Then** <observable outcome> |
| AC-2 | **Given** … **When** … **Then** … |
| AC-3 | **Given** <an invalid input> **When** … **Then** the API returns `400` with code `VALIDATION_ERROR` and no state changes |
| AC-4 | **Given** <an unauthorised caller> **When** … **Then** the API returns `403` and the attempt is recorded |

Each acceptance criterion must be traceable to at least one test in §6, and the pull request
must show that test passing.

---

## 3. API contract

> **Contract first.** Agree the contract here, land it in the API's OpenAPI document
> (`apps/api`), then regenerate the frontend types consumed from `packages/types`. Never
> hand-write a duplicate type on the frontend — import the generated one.
> See [docs/api/README.md](../api/README.md) (create if it does not yet exist).
>
> All routes are versioned under `/api/v1/`. Money fields are always
> `{ amountMinorUnits: number, currencyCode: string }` — never a float. Timestamps are ISO-8601
> UTC. See `docs/specs/2026-08-28-004-api-foundation-response-standards.md` for the shared
> response envelope, pagination, and error-code conventions this contract must follow.

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/<resource>` | `<policy>` | `200` `PagedResponse<XSummary>` | paged, filterable by … |
| `GET` | `/api/v1/<resource>/{id}` | `<policy>` | `200` `ApiResponse<X>` | ownership-checked server-side |
| `POST` | `/api/v1/<resource>` | `<policy>` | `201` + `Location` | idempotent via `Idempotency-Key` header? |
| `PATCH` | `/api/v1/<resource>/{id}` | `<policy>` | `200` | optimistic concurrency via `version` |
| `DELETE` | `/api/v1/<resource>/{id}` | `<policy>` | `204` | soft or hard delete? |

### Request and response types

```typescript
// packages/types/src/<feature>.ts
export interface CreateXRequest {
  // ...
}

export interface XDto {
  id: string;
  // ...
  createdAt: string; // ISO-8601 UTC
  updatedAt: string;
}
```

State which fields are required, their validation rules, their maximum lengths, and their
formats. Note anything that must never be returned to a client (e.g. another user's contact
info before booking, per master spec §54).

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | request failed validation; `errors[]` lists the field failures |
| `404` | `X_NOT_FOUND` | the resource does not exist or is not visible to this caller |
| `409` | `CONFLICT` | `version` did not match (optimistic concurrency) |
| `422` | `<DOMAIN_RULE>` | a domain invariant rejected the request |

New codes are `SCREAMING_SNAKE_CASE`, stable forever, and listed here before they are used.

### Breaking-change check

- [ ] No existing field removed, renamed, or narrowed in type
- [ ] No existing status code or `code` value changed
- [ ] If any box above is unchecked, this needs a new API version (`/api/v2/`) — record the
      decision and the reasoning behind it in §8 before you build

---

## 4. Data model changes

> PostgreSQL, accessed through the ORM layer in `packages/database`. Primary keys are `uuid`.
> Money is `integer minor_units` + a separate `currency_code` column — never `numeric`/`float`
> for money. Timestamps are `timestamptz`, stored UTC. Variable, genuinely non-relational
> attributes may use `jsonb`; core relationships stay strongly typed foreign keys, per master
> spec §4.3 and §6.

### Entities

| Entity | Change | Fields |
|---|---|---|
| `X` | new | `id uuid pk`, `name text`, …, `created_at timestamptz`, `updated_at timestamptz`, `version integer` |

Include relationships, cardinality, cascade behaviour, and which fields are indexed and why.
Cross-reference the relevant entity group in master spec §124 / architecture §5.2.

### Migration

- **Name:** `<Verb><Noun>` (for example `AddXTable`)
- **Reversible:** yes / no — if not, say what makes it irreversible
- **Backfill required:** yes / no — describe the data movement and its runtime on production
  volumes
- **Downtime:** none expected / describe
- **Reviewed SQL:** paste or link the generated migration; a migration is reviewed as SQL before
  it is applied anywhere

### Retention and privacy

Does this store personal data? For how long? How is it deleted or anonymized on account
deletion (master spec §75)? Is it included in data export (master spec §76)?

---

## 5. UI states

> Every screen ships all four states. A missing empty state or error state is an incomplete
> feature, not a follow-up ticket. Built from the shared accessible primitives in `packages/ui`
> (master spec §106); no ad-hoc one-off components for things the design system already covers.

| State | Behaviour |
|---|---|
| **Loading** | skeleton (not a spinner) for content-heavy views; controls disabled; no layout shift on resolve |
| **Empty** | explains *why* it is empty and offers the primary next action (never a dead end — master spec §22) |
| **Error** | human-readable message derived from the response `code`, a retry affordance, entered data preserved |
| **Success** | the populated view; confirm destructive/high-risk actions per master spec §87; toast or inline confirmation on write |

Also specify: validation behaviour and when it fires, keyboard and screen-reader behaviour,
responsive behaviour across breakpoints (master spec §103), RTL/Urdu behaviour if user-facing
text is involved, and what a user without permission sees (hidden vs. disabled).

**Route(s):** `apps/web/app/…` (Next.js App Router)
**Shared components used/added:** `packages/ui/...`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | domain invariants, service/handler branches, validators, mappers | `apps/api/**/*.test.ts` (Jest/Vitest) |
| **Integration** | endpoint round trip, persistence, auth policy, concurrency, error mapping | `apps/api/**/*.integration.test.ts` |
| **MCP** *(if applicable)* | tool authorization pipeline, ownership checks, idempotency, confirmation requirements | `packages/mcp/**/*.test.ts` |
| **Component** | React component states, hooks, form validation | `apps/web` (Testing Library + Vitest) |
| **E2E** | the one critical journey a user must never lose | `apps/web-e2e` (Playwright) |
| **Accessibility** | automated a11y checks on the route(s) above | CI accessibility gate (master spec §106) |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `<test file>::<test name>` |
| AC-2 | `<test file>::<test name>` |

**Coverage:** ≥80% on new code (enforced by CI, per master spec §114).

**Not covered, deliberately:** <list, with the reason>

---

## 7. Out of scope

> Explicit. This is the section that prevents scope creep during implementation and argument
> during review.

- <thing that a reader might reasonably assume is included, and is not>
- <thing deferred to a later spec — link it if it exists>
- <Phase 2 items from master spec §122 that relate to this feature but are not MVP>

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | | | |

Every open question must be closed before this spec moves to **Approved**. Anything the master
spec leaves admin-configurable (weights, fees, windows, thresholds) belongs here as a
"confirm the default value and who can change it" question, not as a hard-coded constant.

---

## 9. Rollout

- **Feature flag:** name, default, removal criteria — or "none" (master spec §119)
- **Migration order:** does the schema change ship before, with, or after the code?
- **Rollback:** how do we undo this in production?
- **Observability:** what log, metric, or trace tells us it is working? (master spec §117)
