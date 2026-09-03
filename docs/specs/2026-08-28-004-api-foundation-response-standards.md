# Spec: API Foundation & Response Standards

**File:** `docs/specs/2026-08-28-004-api-foundation-response-standards.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §98–§101, §126, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §6, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No API exists. Every later domain spec needs a consistent, versioned way to expose
endpoints — success/error envelopes, pagination, correlation IDs, and rate limiting decided once
so that 40+ future endpoints don't each invent their own conventions, which would make the
future OpenAPI spec and any mobile client integration (master spec §98) inconsistent and
error-prone.

**Who is affected:** Every API consumer: the application, the future mobile app, MCP tools, and any
integration partner reading the OpenAPI doc.

**Why it matters now:** Foundational (Milestone 1); every domain spec's §3 "API contract"
depends on the envelope and error-code conventions defined here.

**Success looks like:** A versioned `/api/v1/` root exists with a documented, enforced response
envelope, standard error-code taxonomy, pagination contract, and rate-limiting middleware, all
captured in a generated OpenAPI document.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any successful `/api/v1/*` response **When** inspected **Then** it matches the shared `ApiResponse<T>` or `PagedResponse<T>` envelope, including a `correlationId` |
| AC-2 | **Given** any error response **When** inspected **Then** it includes an HTTP status, a stable machine-readable `code` (`SCREAMING_SNAKE_CASE`), a human-readable `message`, and a `correlationId` |
| AC-3 | **Given** a validation failure **When** the request is rejected **Then** the response is `400` with code `VALIDATION_ERROR` and an `errors[]` array naming each invalid field |
| AC-4 | **Given** an authenticated request lacking permission **When** rejected **Then** the response is `403` with a stable code, and the attempt is logged |
| AC-5 | **Given** a caller exceeding their rate limit **When** the limit is hit **Then** the response is `429` with a `Retry-After` header, and limits differ by domain (auth, search, messaging, AI, MCP, payment, security) per master spec §100 |
| AC-6 | **Given** a paginated list endpoint **When** called with page parameters **Then** the response includes items, total count, and next-page cursor/offset in a consistent shape reused by every list endpoint |
| AC-7 | **Given** the full set of implemented endpoints **When** the OpenAPI document is generated **Then** it stays in sync with the implementation (CI fails on drift) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/health` | none | `200` `{ status, db, version }` | liveness/readiness |
| `GET` | `/api/v1/openapi.json` | none | `200` OpenAPI 3.x document | generated, not hand-written |

This spec defines the *shared envelope* every other domain's endpoints (spec 005 onward) must
use — it does not itself introduce domain endpoints beyond health/docs.

### Request and response types

```typescript
// lib/types/api.ts
export interface ApiResponse<T> {
  data: T;
  correlationId: string;
}

export interface PagedResponse<T> {
  data: T[];
  page: { limit: number; offset: number; total: number; nextOffset: number | null };
  correlationId: string;
}

export interface ApiError {
  status: number;
  code: string; // SCREAMING_SNAKE_CASE, stable
  message: string;
  errors?: { field: string; message: string }[];
  correlationId: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | request body/query failed schema validation |
| `401` | `UNAUTHENTICATED` | no valid session/token presented |
| `403` | `FORBIDDEN` | authenticated but not permitted for this resource/action |
| `404` | `NOT_FOUND` | resource does not exist or is not visible to this caller |
| `409` | `CONFLICT` | optimistic concurrency (`version`) mismatch |
| `422` | `DOMAIN_RULE_VIOLATION` | a business invariant rejected an otherwise well-formed request |
| `429` | `RATE_LIMITED` | caller exceeded a domain-specific rate limit |
| `500` | `INTERNAL_ERROR` | unexpected server error; never exposes internal detail to the client |

Every subsequent spec's domain-specific error codes (e.g. `OFFER_EXPIRED`,
`BOOKING_SLOT_UNAVAILABLE`) extend this table in that spec's own §3, following the same
`SCREAMING_SNAKE_CASE` and stability rule.

### Breaking-change check

- [ ] No existing field removed, renamed, or narrowed in type
- [ ] No existing status code or `code` value changed
- [ ] If any box above is unchecked, this needs `/api/v2/` — record the decision in §8

---

## 4. Data model changes

None directly — this spec is middleware/contract, not persisted entities. It relies on the
baseline schema from `docs/specs/2026-08-28-003-database-core-data-model.md`.

### Retention and privacy

Correlation IDs and request logs (not response bodies containing personal data) are retained
per the observability policy defined in
`docs/specs/2026-08-28-046-engineering-operations-cicd-observability.md`.

---

## 5. UI states

Not applicable — this is an API-layer spec. It does define the contract that every screen's
Loading/Empty/Error/Success states (per `docs/TEMPLATE-SPEC.md` §5) consume: the frontend's
generic HTTP client maps `ApiError.code` to user-facing error copy centrally, so individual
screens don't hand-roll error-message strings per status code.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | envelope serialization, error-code mapping, pagination math | `app/api/v1/**/*.test.ts` |
| **Integration** | `/api/v1/health` returns `200`; a deliberately invalid request returns `400 VALIDATION_ERROR`; rate limit returns `429` after threshold | `app/api/v1/api-foundation.integration.test.ts` |
| **Architecture** | CI diff check: generated OpenAPI doc matches route definitions | CI script |
| **E2E** | N/A directly | — |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/envelope.test.ts::wraps success responses` |
| AC-3 | `app/api/v1/validation.integration.test.ts::400 on bad input` |
| AC-5 | `app/api/v1/rate-limit.integration.test.ts::429 after threshold` |
| AC-7 | CI `openapi-drift-check` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Domain-specific error codes — tested per owning spec.

---

## 7. Out of scope

- Any domain-specific endpoint (requests, offers, bookings, etc.) — each owning spec defines its
  own routes on top of this envelope.
- GraphQL or any non-REST API style — master spec §98 specifies REST.
- Mobile-app-specific API variations — the same `/api/v1/` contract must serve mobile later
  without a parallel API.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact rate-limit thresholds per domain — master spec says "admin-configurable," not fixed values | — | Remains Open — exact per-domain thresholds are not fixed by this spec; ship sane defaults initially, made configurable through `docs/specs/2026-08-28-041-feature-flags-platform-configuration.md`'s configuration surface |
| 2 | HTTP framework choice | — | Decided — Next.js Route Handlers (`app/api/v1/**/route.ts`) are the HTTP framework for this contract; no separate framework (Fastify, Express, Nest, Hono) is introduced |

---

## 9. Rollout

- **Feature flag:** none — foundational.
- **Migration order:** N/A.
- **Rollback:** revert API deploy; envelope is backward compatible by the breaking-change rule.
- **Observability:** every response carries `correlationId`; structured request logs correlate
  by this ID end-to-end (ties into `docs/specs/2026-08-28-046-...md`).
