# Spec: <Feature name>

**File:** `docs/specs/YYYY-MM-DD-<slug>.md`
**Status:** Draft | Approved | Implemented | Superseded
**Author:** <name>
**Reviewer:** <name — a human, always>
**Related:** issue #XXX

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

> **OpenAPI first.** Agree the contract here, land it in the API's OpenAPI document, then
> regenerate the frontend types (`npm run generate:api`). Never hand-write a client DTO.
> See [docs/api/README.md](../api/README.md).

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/<resource>` | `<policy>` | `200` `PagedResponse<XSummaryDto>` | paged, filterable by … |
| `GET` | `/api/v1/<resource>/{id}` | `<policy>` | `200` `ApiResponse<XDto>` | |
| `POST` | `/api/v1/<resource>` | `<policy>` | `201` + `Location` | idempotent? |
| `PUT` | `/api/v1/<resource>/{id}` | `<policy>` | `200` | optimistic concurrency via `RowVersion` |
| `DELETE` | `/api/v1/<resource>/{id}` | `<policy>` | `204` | soft or hard delete? |

### Request and response DTOs

```csharp
// AjBoilerplate.Contracts.<Feature>
public sealed record CreateXRequest(...);
public sealed record XDto(...);
```

State which fields are required, their validation rules, their maximum lengths, and their
formats. Note anything that must never be returned to a client.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | request failed validation; `errors[]` lists the field failures |
| `404` | `X_NOT_FOUND` | the resource does not exist or is not visible to this caller |
| `409` | `CONFLICT` | `RowVersion` did not match |
| `422` | `<DOMAIN_RULE>` | a domain invariant rejected the request |

New codes are `SCREAMING_SNAKE_CASE`, stable forever, and listed here before they are used.

### Breaking-change check

- [ ] No existing field removed, renamed, or narrowed in type
- [ ] No existing status code or `code` value changed
- [ ] If any box above is unchecked, this needs a new API version — record the decision and
      the reasoning behind it in §8 before you build

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `X` | new | `Id`, `Name`, …, `CreatedAt`, `UpdatedAt`, `RowVersion` |

Include relationships, cardinality, cascade behaviour, and which fields are indexed and why.

### Migration

- **Name:** `<Verb><Noun>` (for example `AddXTable`)
- **Reversible:** yes / no — if not, say what makes it irreversible
- **Backfill required:** yes / no — describe the data movement and its runtime on production
  volumes
- **Downtime:** none expected / describe
- **Reviewed SQL:** paste or link the generated script; a migration is reviewed as SQL before
  it is applied anywhere

### Retention and privacy

Does this store personal data? For how long? How is it deleted?

---

## 5. UI states

> Every screen ships all four states. A missing empty state or error state is an incomplete
> feature, not a follow-up ticket. PrimeNG components only.

| State | Behaviour |
|---|---|
| **Loading** | skeleton (not a spinner) for the list; controls disabled; no layout shift on resolve |
| **Empty** | explains *why* it is empty and offers the primary action |
| **Error** | human-readable message derived from the response `code`, a retry affordance, and the `traceId` visible for support |
| **Success** | the populated view; confirm destructive actions; toast on write |

Also specify: validation behaviour and when it fires, keyboard and screen-reader behaviour,
responsive behaviour, and what a user without permission sees (hidden vs. disabled).

**Route(s):** `/…`
**Nx library:** `libs/feature-<name>`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | domain invariants, handler branches, validators, mappers | `AjBoilerplate.UnitTests` |
| **Integration** | endpoint round trip, persistence, auth policy, concurrency, error mapping | `AjBoilerplate.IntegrationTests` |
| **Architecture** | new projects/references still obey the layer rule | `AjBoilerplate.ArchitectureTests` |
| **Component** | Angular component states, signals, form validation | `libs/feature-<name>` (Vitest) |
| **E2E** | the one critical journey a user must never lose | `apps/web-e2e` (Playwright) |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `<TestClass>.<TestName>` |
| AC-2 | `<spec file>` |

**Coverage:** ≥80% on new code (enforced by the quality gate).

**Not covered, deliberately:** <list, with the reason>

---

## 7. Out of scope

> Explicit. This is the section that prevents scope creep during implementation and argument
> during review.

- <thing that a reader might reasonably assume is included, and is not>
- <thing deferred to a later spec — link it if it exists>

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | | | |

Every open question must be closed before this spec moves to **Approved**.

---

## 9. Rollout

- **Feature flag:** name, default, removal criteria — or "none"
- **Migration order:** does the schema change ship before, with, or after the code?
- **Rollback:** how do we undo this in production?
- **Observability:** what log, metric, or trace tells us it is working?
