# Spec: Request Creation & Lifecycle

**File:** `docs/specs/2026-08-28-015-request-creation-lifecycle.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §27–§28, §37–§38, §125, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, §14, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No request entity or flow exists. Master spec §28 defines what a request can contain
(service, description, structured fields, budget, date/time, location, attachments, urgency),
§37 defines the customer-facing status progression, and §38 defines cancellation rules and
financial-consequence disclosure. Master spec §125 defines the request state machine.

**Who is affected:** Every customer initiating the core transactional flow; providers who will
receive it (spec 016); the AI assistant, which must create requests through this same
authoritative path (master spec §132.9 — AI cannot invent providers/services, and must go
through real backend state).

**Why it matters now:** It's the entry point of Milestone 4 and the literal next step after
search/service-page in the customer journey.

**Success looks like:** A customer can submit a valid, service-specific request (respecting
required fields from spec 011) that enters the `Submitted` state and becomes visible to
matching (spec 016); cancellation before provider selection is fast and discloses any
consequence up front.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a service's required fields **When** a request is submitted with all required fields valid **Then** it transitions `Draft → Submitted` and becomes eligible for matching |
| AC-2 | **Given** a required field missing or invalid **When** submission is attempted **Then** the API returns `400 VALIDATION_ERROR` naming the specific fields, and no request record is created in `Submitted` state |
| AC-3 | **Given** a request with optional budget left blank **When** submitted **Then** it succeeds — budget is never mandatory |
| AC-4 | **Given** a request in `Submitted`/`Matching`/`Offers Open` (before provider selection) **When** the customer cancels **Then** cancellation is fast, any financial consequence (normally none pre-selection) is shown before confirmation, and affected providers who were notified are informed |
| AC-5 | **Given** a request's status **When** viewed by the customer **Then** it reflects the exact progression in master spec §37 (Request sent → Providers notified → Offers received → Provider selected → Payment → Booking confirmed) without exposing internal matching mechanics |
| AC-6 | **Given** the AI assistant creating a request on a customer's behalf (spec 034) **When** it calls the request-creation MCP tool **Then** the request is validated and persisted through this exact same API — never a shortcut path with weaker validation |
| AC-7 | **Given** an attempted invalid state transition (e.g. cancelling an already-`Completed` request) **When** attempted **Then** the API rejects it with `409 CONFLICT` or `422`, never silently succeeding |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/requests` | session (customer) | `201` `ApiResponse<RequestDto>` | idempotent via `Idempotency-Key` |
| `GET` | `/api/v1/requests` | session (customer, own only) | `200` `PagedResponse<RequestSummaryDto>` | active/history filter |
| `GET` | `/api/v1/requests/{id}` | session (owner) | `200` `ApiResponse<RequestDto>` | ownership-checked |
| `POST` | `/api/v1/requests/{id}/cancel` | session (owner) | `200` `ApiResponse<RequestDto>` | shows consequence before confirm (frontend calls a dry-run first) |
| `GET` | `/api/v1/requests/{id}/cancel-preview` | session (owner) | `200` `ApiResponse<{ consequence: string | null }>` | |
| `POST` | `/api/v1/requests/{id}/attachments` | session (owner) | `201` | delegates storage to spec 027 |

### Request and response types

```typescript
// packages/types/src/requests.ts
export interface CreateRequestRequest {
  serviceId: string;
  description: string;
  fieldValues: Record<string, string | number | boolean>;
  budget?: { amountMinorUnits: number; currencyCode: string } | { range: [number, number] } | null;
  preferredDateTime?: string;
  addressId: string;
  urgency: 'normal' | 'urgent';
  attachmentIds?: string[];
}

export interface RequestDto {
  id: string;
  status: 'draft' | 'submitted' | 'matching' | 'offers_open' | 'provider_selected' | 'booking_created' | 'cancelled' | 'expired' | 'completed';
  serviceId: string;
  offerCount: number;
  createdAt: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | missing/invalid required field values |
| `403` | `FORBIDDEN` | non-owner attempts to view/cancel a request |
| `409` | `CONFLICT` | cancel attempted on a request already past a cancellable state |
| `422` | `REQUEST_NOT_CANCELLABLE` | domain rule blocks cancellation in current state |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Request` | new | `id uuid pk`, `customer_id uuid fk->CustomerProfile`, `service_id uuid fk->Service`, `description text`, `status text`, `budget_amount_minor_units integer nullable`, `budget_currency_code text nullable`, `preferred_at timestamptz nullable`, `address_id uuid fk->Address`, `urgency text`, `created_at`, `updated_at`, `version` |
| `RequestFieldValue` | new | `id uuid pk`, `request_id uuid fk->Request`, `service_field_id uuid fk->ServiceField`, `value jsonb` |
| `RequestAttachment` | new | `id uuid pk`, `request_id uuid fk->Request`, `file_asset_id uuid fk->FileAsset` |
| `RequestStatusHistory` (part of §125 state machine enforcement) | new | `id uuid pk`, `request_id uuid fk->Request`, `from_status text`, `to_status text`, `actor_type text`, `actor_id uuid`, `created_at` |

State transitions enforced server-side per master spec §125:
`Draft → Submitted → Matching → Offers Open → Provider Selected → Booking Created → (Cancelled / Expired / Completed)`.

### Migration

- **Name:** `AddRequestTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Requests contain personal data (description, address, attachments) — included in export,
anonymized on deletion except where retained for dispute/audit purposes within policy window.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | request form skeleton while service fields load (spec 011); submission shows inline progress, not a full-page block |
| **Empty** | "Requests" tab with no active requests shows browse/search CTA |
| **Error** | submission failure preserves all entered field values, highlights specific invalid fields |
| **Success** | confirmation screen transitions into the live status view (master spec §37 progression) |

Cancellation is a confirm-dialog action showing consequence text (or "No fee — you haven't been
charged yet" when none applies) before the destructive action executes.

**Route(s):** `apps/web/app/requests/new/[serviceId]`, `apps/web/app/requests/[id]`,
`apps/web/app/requests` (list)
**Shared components used/added:** `packages/ui` `Form`, `Stepper` (if multi-step), `StatusTimeline`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | field-validation-against-schema logic, state-transition validator | `apps/api/requests/**/*.test.ts` |
| **Integration** | full create→cancel lifecycle; ownership checks; idempotent retry does not duplicate | `apps/api/requests/*.integration.test.ts` |
| **MCP** | AI-invoked request creation goes through identical validation as manual form | `packages/mcp/create-service-request.test.ts` |
| **Component** | request form states, budget-optional behavior | `apps/web` (Testing Library) |
| **E2E** | customer submits a request end to end, then cancels before selection | `apps/web-e2e/request-creation.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/requests/create.integration.test.ts::submits valid request` |
| AC-2 | `apps/api/requests/create.integration.test.ts::rejects missing required field` |
| AC-4 | `apps/api/requests/cancel.integration.test.ts::shows consequence and cancels` |
| AC-6 | `packages/mcp/create-service-request.test.ts::same validation as manual path` |
| AC-7 | `apps/api/requests/state-machine.test.ts::rejects invalid transition` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Matching/distribution logic itself (spec 016) — this spec only
covers the request entity reaching `Submitted`/`Matching`, not what happens inside matching.

---

## 7. Out of scope

- Offer creation/response (spec 017).
- Provider notification mechanics (spec 016/026).
- Request-specific pre-booking chat (spec 018/025) — referenced, not detailed here.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Attachment count/size limits per request | Product | Open — default to a conservative limit, confirm before launch |
| 2 | Exact cancellation-consequence rule once a request reaches `Provider Selected` (overlaps with spec 023's cancellation policy) | — | Resolved by spec 023; this spec's cancel-preview endpoint calls into that policy engine rather than duplicating it |

---

## 9. Rollout

- **Feature flag:** none — core transactional flow, not optional.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; in-flight requests remain valid under old code (no destructive
  schema change).
- **Observability:** request-submission funnel (draft→submitted→matched→booked) tracked (spec
  040); cancellation rate alerted if anomalous.
