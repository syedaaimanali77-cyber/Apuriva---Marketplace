# Spec: Request Creation & Lifecycle

**File:** `docs/specs/2026-08-28-015-request-creation-lifecycle.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §27–§28, §37–§38, §125, §132.9, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, §14, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No request flow exists. The five request tables (`requests`, `request_field_values`,
`request_attachments`, `requests_status_history`, `requests_status_transitions`) **already exist**
as spec 003's deliberately minimal baseline skeletons — identity, audit, `version` and structural
FKs only, with `requests_status_transitions` empty and no feature columns anywhere. Master spec §28
defines what a request can contain (service, description, structured fields, budget, date/time,
location, attachments, urgency), §37 defines the customer-facing status progression, §38 defines
cancellation rules and financial-consequence disclosure, and §125 defines the request state machine.

**Who is affected:** Every customer initiating the core transactional flow; providers who will
receive it (spec 017's matching/distribution); the AI assistant, which must create requests through
this same authoritative path (master spec §132.9 — AI cannot invent providers/services, and must go
through real backend state).

**Why it matters now:** It's the entry point of Milestone 4 and the literal next step after
search/service-page in the customer journey.

**Success looks like:** A customer can submit a valid, service-specific request (respecting required
fields from spec 011) that reaches the `submitted` state — the state spec 017 consumes as "eligible
for matching" — and can cancel it before provider selection, with any consequence disclosed first.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a service's required fields **When** a request is submitted with all required fields valid **Then** the row is created `draft` and transitioned to `submitted` in one transaction (both steps recorded in `requests_status_history`), and `status = 'submitted'` is itself what makes it eligible for matching — no separate eligibility flag exists |
| AC-2 | **Given** a required field missing or invalid **When** submission is attempted **Then** the API returns `400 VALIDATION_ERROR` whose `errors[]` names each offending field by its `ServiceField.key`, and **no** `requests` row persists at all (the whole create runs in one transaction) |
| AC-3 | **Given** a request with optional budget left blank **When** submitted **Then** it succeeds — budget is never mandatory, in any of master spec §27's three shapes (target amount, range, "I'm not sure"/omitted) |
| AC-4 | **Given** a request in `submitted`/`matching`/`offers_open` (before provider selection) **When** the customer cancels **Then** the consequence is disclosed by `GET .../cancel-preview` before the destructive action, the request moves to `cancelled`, and the transition is recorded in `requests_status_history`. Within this spec's implemented scope no provider has been notified yet (distribution is spec 017, notification delivery spec 026), so master spec §38's "notify affected providers" obligation is carried by the documented hook in §3, not by notification code shipped here |
| AC-5 | **Given** a request's status **When** viewed by the customer **Then** it is mapped to master spec §37's progression (Request sent → Providers notified → Offers received → Provider selected → Payment → Booking confirmed) through the single mapping defined in §3, and no internal matching mechanic (pool size, ranking, excluded providers, `request_provider_matches` rows) is ever exposed on a customer-facing endpoint |
| AC-6 | **Given** the AI assistant creating a request on a customer's behalf (spec 034/036) **When** it calls the request-creation MCP tool **Then** it invokes the same `lib/requests/create.ts` domain function the HTTP route invokes — the route is a thin transport wrapper holding no validation of its own, so no path with weaker validation exists |
| AC-7 | **Given** an attempted invalid state transition (e.g. cancelling an already-`completed` request) **When** attempted **Then** it is rejected per §3's deterministic status rule (`422 REQUEST_NOT_CANCELLABLE` for a non-cancellable state, `409 CONFLICT` for a concurrent/version race), never silently succeeding — and the `requests_status_transition_trg` DB trigger rejects it independently even if application code were bypassed |

---

## 3. API contract

### Endpoints

Routes live at `app/api/v1/requests/**/route.ts` (Next.js App Router — this repo is a single
Next.js app, **not** the `apps/web` + `apps/api` + `packages/ui` layout the template prose assumes).
Every route is `withApiRoute` (`lib/api/handler.ts`) wrapping a call into `lib/requests/*`, and
every mutation calls `requireSession` + `requireCsrf` (`lib/auth/require-session.ts`) and
`requireActiveMode(session, 'customer')` (`lib/auth/require-mode.ts`).

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/requests` | session (customer mode) | `201` `ApiResponse<RequestDto>` | requires `Idempotency-Key`; replay returns `200` with the original request (see below) |
| `GET` | `/api/v1/requests` | session (customer mode, own only) | `200` `PagedResponse<RequestSummaryDto>` | `?filter=active\|history` (default `active`) |
| `GET` | `/api/v1/requests/{id}` | session (owner) | `200` `ApiResponse<RequestDto>` | ownership-checked |
| `GET` | `/api/v1/requests/{id}/cancel-preview` | session (owner) | `200` `ApiResponse<CancelPreviewDto>` | read-only dry run; never mutates |
| `POST` | `/api/v1/requests/{id}/cancel` | session (owner) | `200` `ApiResponse<RequestDto>` | body carries `expectedVersion` |

**Deliberately not in this spec:** `POST /requests/{id}/attachments`. Attachment *upload* is spec
027's (`/files/upload-url` → `/files/{id}/finalize`), and `file_assets` is still its spec-003
skeleton (`uploaded_by_user_id` only — no size, MIME, scan status or storage key), so no client can
legitimately obtain a `fileAssetId` yet. This spec ships the linkage
(`request_attachments.file_asset_id` plus ownership validation of any supplied id) and nothing
else — see §8 #1.

**Pagination:** `GET /api/v1/requests` uses the existing `parsePageParams`/`buildPage`
(`lib/api/pagination.ts`, `DEFAULT_PAGE_LIMIT = 20`, `MAX_PAGE_LIMIT = 100`) — not a new scheme.

**Rate limiting:** add one `RateLimitDomain` — `requests: { limit: 30, windowMs: 60_000 }` — to
`RATE_LIMIT_DEFAULTS` in `lib/api/rate-limit.ts`, the same way spec 012 added `location` and spec
014 added `home`. Writes deserve a tighter budget than the `default` 100/60s.

**OpenAPI:** all five routes must be added to `OPENAPI_ROUTES` in `lib/api/openapi-registry.ts` in
the same PR — `scripts/check-openapi-drift.ts` fails CI otherwise.

**Idempotency (`POST /api/v1/requests`).** No generic idempotency infrastructure exists in this repo
yet; **this spec introduces it**, and specs 018/020/021/036 reuse the same helper rather than
inventing a second one. Contract:

- The `Idempotency-Key` header is **required**. Missing/blank → `400 VALIDATION_ERROR` with
  `errors[] = [{ field: 'Idempotency-Key', message: 'is required' }]`. This matches spec 036's
  `MCP_IDEMPOTENCY_KEY_REQUIRED` rule for state-changing tools, so the AI path and the form path
  carry identical requirements.
- **Scope/binding:** the key is scoped to the caller's `customer_profile_id`, enforced by
  `uniqueIndex('requests_customer_idempotency_key_uq').on(customerProfileId, idempotencyKey)` —
  never a globally unique key, so one customer's key can neither collide with nor probe another's.
- **Persistence:** on `requests` itself (`idempotency_key text not null`,
  `idempotency_fingerprint text not null`), following the per-entity pattern specs 020/021 already
  declare (`Booking.idempotency_key`, `Payment.idempotency_key`) rather than a side table.
- **Replay:** same customer + same key + same body fingerprint (SHA-256 over the canonicalized body)
  → `200 ApiResponse<RequestDto>` carrying the originally created request. Exactly one row exists;
  no second row and no second status-history entry are written.
- **Conflicting reuse:** same customer + same key + *different* fingerprint →
  `409 IDEMPOTENCY_KEY_CONFLICT`, nothing written.
- Shared implementation: `lib/api/idempotency.ts` (header parsing + fingerprint), so no route
  hand-rolls it.

**Cancellation consequence (AC-4, master spec §38).** Within the states this spec can cancel
(`submitted`, `matching`, `offers_open`) no payment can exist — payment authorization happens only
after provider selection (spec 021) — so `cancel-preview` deterministically returns
`{ cancellable: true, consequence: null, feeAmountMinorUnits: null, currencyCode: null }`. Spec
023's policy engine is **not** implemented here and **not** duplicated here: the seam is a single
adapter, `lib/requests/cancellation-consequence.ts`, deliberately mirroring the precedent set by
`lib/privacy/booking-lifecycle-adapter.ts` (spec 008's isolated, provisional opinion about another
spec's lifecycle). It is the only place this spec encodes a consequence opinion; when spec 023
ships, only that file changes. Cancellation *after* provider selection is out of scope (§7) and is
spec 023's `POST /bookings/{id}/cancel`.

**Provider-notification hook (AC-4).** `cancelRequest` calls
`lib/requests/cancellation-notification.ts`, which in this spec is a documented no-op returning the
(currently always empty) set of notified providers read from `request_provider_matches`. Spec 017
populates that table and spec 026 delivers the notification; neither is faked here.

**Customer-facing status mapping (AC-5).** One exported map in `lib/types/requests.ts` is the only
place an internal status is turned into a §37 step:

| internal `status` | customer-facing step (§37) |
|---|---|
| `draft` | not shown (never customer-visible; see §4) |
| `submitted` | Request sent |
| `matching` | Providers notified |
| `offers_open` | Offers received |
| `provider_selected` | Provider selected |
| `booking_created` | Booking confirmed (Payment is spec 021's own step within it) |
| `cancelled` / `expired` / `completed` | terminal, shown as itself |

### Request and response types

```typescript
// lib/types/requests.ts
export type RequestStatus =
  | 'draft' | 'submitted' | 'matching' | 'offers_open'
  | 'provider_selected' | 'booking_created'
  | 'cancelled' | 'expired' | 'completed';

export type RequestUrgency = 'normal' | 'urgent';

/** Master spec §27's three shapes. Omitted/`null` = "I'm not sure". `amountMinorUnits` is an
 * integer in minor units and `currencyCode` an ISO-4217-shaped 3-letter uppercase code, matching
 * `moneyColumns()`/`moneyPairChecks()` (lib/db/schema.ts) — never a float. */
export type RequestBudget =
  | { amountMinorUnits: number; currencyCode: string }
  | { minAmountMinorUnits: number; maxAmountMinorUnits: number; currencyCode: string };

export interface CreateRequestRequest {
  serviceId: string;
  description: string;
  /** Keyed by `ServiceField.key` (not id) — the exact shape `validateFieldSubmission`
   * (lib/service-page/fields.ts) already validates, so spec 011's validator is reused verbatim. */
  fieldValues: Record<string, string | number | boolean>;
  budget?: RequestBudget | null;
  /** ISO-8601 instant, paired with `preferredTimezone` (IANA id) per spec 003's
   * `scheduledTimeColumns()` convention, so local wall-clock time stays reconstructible. */
  preferredAt?: string;
  preferredTimezone?: string;
  addressId: string;
  urgency: RequestUrgency;
  /** Accepted but only meaningful once spec 027 ships; every id must already exist in
   * `file_assets` and be owned by the caller. See §8 #1. */
  attachmentIds?: string[];
}

export interface RequestDto {
  id: string;
  status: RequestStatus;
  serviceId: string;
  serviceName: string;
  description: string;
  fieldValues: Record<string, string | number | boolean>;
  budget: RequestBudget | null;
  preferredAt: string | null;
  preferredTimezone: string | null;
  addressId: string;
  urgency: RequestUrgency;
  /** Always `0` in this spec — no offer can exist until spec 018. Never omitted, so the status
   * view has a stable shape. */
  offerCount: number;
  /** AC-5: the §37 step, derived server-side from `status` through the one mapping above. */
  customerFacingStep: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequestSummaryDto {
  id: string;
  status: RequestStatus;
  customerFacingStep: string;
  serviceId: string;
  serviceName: string;
  offerCount: number;
  createdAt: string;
}

export interface CancelPreviewDto {
  cancellable: boolean;
  /** Human-readable consequence, or `null` when there is none — always `null` in this spec's
   * cancellable states (see above). */
  consequence: string | null;
  feeAmountMinorUnits: number | null;
  currencyCode: string | null;
}

export interface CancelRequestRequest {
  expectedVersion: number;
}
```

### Error codes

Extends the shared taxonomy in `lib/api/errors.ts` the same way specs 005/008/009/010/012 do
(SCREAMING_SNAKE_CASE, stable; custom codes pass `{ status }` explicitly). New codes live in
`lib/requests/errors.ts`.

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | missing/invalid required field values (`errors[].field` = the `ServiceField.key`); malformed budget; unknown/unowned `serviceId`/`addressId`/`attachmentIds` (reported as a body-field error, never a 404, so existence is not probeable); missing `Idempotency-Key` |
| `403` | `FORBIDDEN` | session is not in customer mode (`requireActiveMode`) |
| `404` | `REQUEST_NOT_FOUND` | request does not exist **or** is not the caller's — identical either way |
| `409` | `CONFLICT` | `expectedVersion` mismatch, or a concurrent transition won the race |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | same `Idempotency-Key` replayed with a different body |
| `422` | `REQUEST_NOT_CANCELLABLE` | current state is not one of `submitted`/`matching`/`offers_open` |

**Correction against the draft's `403` for non-owners.** This repo's established pattern for "not
found or not yours" is a `404` that never distinguishes the two — `addressNotFoundError` (spec 012),
session revocation and data-export ownership (spec 008). A `403` would confirm that a given request
id exists, which master spec §8/§2.4 argue against. `403` is therefore reserved for the mode check,
which reveals nothing about any resource.

### Breaking-change check

- [x] N/A — new spec. No shipped route, DTO or error code changes meaning.
- [!] One cross-spec consequence, accepted knowingly: once `requests.address_id` exists with the
  baseline `onDelete: 'restrict'` FK, `DELETE /api/v1/addresses/{id}` on an address referenced by a
  request raises `23503` and surfaces spec 012's existing `409 ADDRESS_IN_USE`, whose message says
  "referenced by a booking". The behaviour is correct (the delete must be refused); only the message
  is now narrower than reality. Spec 012's shipped code and message are left untouched here —
  generalizing that string is a one-line follow-up for whoever next owns spec 012.

---

## 4. Data model changes

### Entities

Every table below **already exists** (spec 003 baseline). This spec adds feature columns and indexes
to them — it creates no new table.

| Entity | Change | Columns added |
|---|---|---|
| `requests` | extend | `description text not null`, `...moneyColumns('budgetMin')`, `...moneyColumns('budgetMax')`, `...scheduledTimeColumns('preferred')`, `address_id uuid not null fk->addresses restrict`, `urgency text not null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `request_field_values` | extend | `value jsonb not null` |
| `request_attachments` | extend | `file_asset_id uuid not null fk->file_assets restrict` |
| `requests_status_history` | unchanged | already carries `from_status`/`to_status`/`actor_user_id`/`occurred_at`; the draft's `actor_type`/`actor_id`/`created_at` columns do not exist and are not added — an AI-initiated create acts as the customer's own user, and distinguishing the AI caller is spec 033–036's `AIToolCall` record, not a column here |
| `requests_status_transitions` | seed rows | see "State machine" below |

**Column-name corrections against the draft:** the FK is `customer_profile_id` (not `customer_id`),
the preferred-time pair is `preferred_at` + `preferred_timezone` (not `preferred_at` alone), and
budget is two `moneyColumns()` pairs — one pair cannot express master spec §27's range.

**Budget representation.** `budget_min_*` + `budget_max_*`, with `moneyPairChecks('requests',
'budget_min')` and `moneyPairChecks('requests', 'budget_max')`, plus two added CHECKs: both pairs
null together or set together, and `budget_min_amount_minor_units <= budget_max_amount_minor_units`
with matching currency codes. Semantics: **omitted/"I'm not sure"** → all four null; **target
amount** → min = max; **range** → min < max. Amounts are positive integers in minor units
(application-validated; `400 VALIDATION_ERROR` otherwise), and the currency format is validated by
the existing `moneyPairChecks` regex — no new money helper is introduced.

**jsonb allowlist (required, easy to miss).** `lib/db/schema-lint.test.ts`'s AC-5 test fails on any
jsonb column absent from `ALLOWED_JSONB_COLUMNS`. This spec must add
`request_field_values: ['value']` there, justified by a field value's type being genuinely variable
per `ServiceField.type` and never queried or filtered on.

**Indexes/constraints added:** `requests_address_id_idx` (schema-lint AC-4: every FK column needs its
own covering index), `request_attachments_file_asset_id_idx`, `requests_status_idx` (spec 017 reads
"all `submitted` requests"), and
`uniqueIndex('requests_customer_idempotency_key_uq').on(customer_profile_id, idempotency_key)`.
`request_field_values` already has `request_field_values_request_field_uq` on `(request_id,
service_field_id)` — one value per field per request, so no extra constraint is needed. All FKs stay
`onDelete: 'restrict'` (schema-lint AC-4 forbids cascade/set-null).

### State machine

`requests_status_transitions` is empty today, and the `requests_status_transition_trg` trigger
(BEFORE UPDATE, errcode `23514`) rejects any status change whose `(from, to)` pair is absent — so a
transition is impossible until its row is seeded. **This spec seeds only the four transitions it
performs:**

| from | to | Actor | Owned by |
|---|---|---|---|
| `draft` | `submitted` | customer (or AI on their behalf, same user) | **015** |
| `submitted` | `cancelled` | customer (owner only) | **015** |
| `matching` | `cancelled` | customer (owner only) | **015** |
| `offers_open` | `cancelled` | customer (owner only) | **015** |

Deliberately **not** seeded here — each later spec seeds its own in its own migration, so an
unimplemented transition fails loudly at the DB rather than silently corrupting state:
`submitted → matching` and `matching → offers_open` (spec 017), `offers_open → provider_selected`
(spec 019/020), `provider_selected → booking_created` (spec 020), `→ completed` (spec 028),
`→ expired` (spec 018's offer timer / spec 026). The two `cancelled` rows from
`matching`/`offers_open` *are* seeded here even though nothing can reach those states yet, because
master spec §38 makes pre-selection cancellation this spec's responsibility whichever of those
states the request is in.

**Creation is one transaction:** insert with `status = 'draft'`, insert `request_field_values` and
any `request_attachments`, `UPDATE ... SET status = 'submitted'` (exercising the trigger), and write
both history rows (`null → draft`, `draft → submitted`). Any validation failure rolls the whole thing
back, satisfying AC-2's "no record persists". `draft` is never customer-visible and there is no
draft-resume API in this spec (§7) — it exists so that AC-1/§125's documented first transition is
real and DB-enforced rather than notional.

**Optimistic concurrency:** every state-changing call takes `expectedVersion` and issues
`UPDATE ... WHERE id = $1 AND version = $2`, bumping `version`, exactly as `lib/catalog/categories.ts`
does; a zero-row result throws `CONFLICT` (the `versionConflictError` pattern). The DB trigger is the
independent second line of defence (AC-7).

### Migration

- **Name:** `0011_add_request_columns.sql` — next sequential number, generated by `drizzle-kit
  generate`, with the transition-seed `INSERT`s appended by hand the same way spec 010's seed and
  spec 003's trigger were.
- **Reversible:** yes — forward-only additive DDL; no column drop, no type change, no data rewrite.
  `drizzle/0001_baseline_schema.sql` is **never** edited (`npm run check:schema-checksum`).
- **Backfill required:** no — `requests` is empty in every environment.
- **Note on `not null`:** the new `not null` columns are safe precisely because the table is empty;
  no `DEFAULT`-then-backfill dance is needed and none should be invented.
- **Downtime:** none.

### Retention and privacy

Requests contain personal data (description, address linkage, attachments), so they join the
**existing** privacy machinery — no second mechanism:

- **Export** (`lib/privacy/export.ts`): add a `requests` section to `DataExportPayload`, fetched with
  an explicit column allowlist and the same ownership-scoped join through `customerProfiles` the
  existing `bookings`/`receipts` sections use. Columns exported: `id`, `status`, `serviceId`,
  `description`, `urgency`, `preferredAt`, `createdAt` — never internal matching data.
- **Deletion** (`lib/privacy/deletion.ts`): `sweepDeletions` anonymizes identifying columns and never
  deletes rows. Requests follow the same rule — rows are retained (they are the parent of
  offers/bookings/payments and every FK is `restrict`, so deleting them is impossible anyway) and
  `description`, the only free-text PII on the row, is redacted in the same sweep. A redacted
  description must not break the status view.
- **Active-request blocking of account deletion is not added:** spec 008 AC-4 blocks on an active
  *booking* via `lib/privacy/booking-lifecycle-adapter.ts`, and widening that rule is spec 008's
  decision, not this spec's.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | the request form shows the DS `Skeleton` while `GET /api/v1/services/{id}/fields` (spec 011) resolves; submission shows inline progress on the submit `Button` (`loading`), never a full-page block |
| **Empty** | `/requests` with no active requests shows the DS `EmptyState` with a CTA into `/explore` and `/search` (both already shipped) |
| **Error** | submission failure preserves every entered value and maps each `errors[].field` (a `ServiceField.key`) onto that control's `FormField` error slot |
| **Success** | confirmation transitions into the live status view at `/requests/{id}` showing the §37 progression |

Cancellation uses the existing `ConfirmDialog` (`components/ConfirmDialog.tsx`), populated from
`GET .../cancel-preview` — showing its `consequence`, or "No fee — you haven't been charged yet"
when it is `null` — before the destructive call. The preview is always fetched first; the dialog
never asserts a consequence the server did not return.

**Route(s) (this repo, not the template's `apps/web`):** `app/requests/page.tsx` (replaces the
spec-014 `PlaceholderPage`), `app/requests/new/[serviceId]/page.tsx`, `app/requests/[id]/page.tsx`.

**Shared components:** all from the existing APURIVA Design System. Already exported by
`@/components` and used as-is: `FormField`, `Input`, `Select`, `Checkbox`, `Switch`, `Button`,
`Card`, `Badge`, `EmptyState`, `ErrorState`, `Skeleton`, `ConfirmDialog`, `PriceDisplay`. Two
components this spec needs already exist in `ui/` but are **not yet re-exported**, so
`components/index.ts` gains two thin re-exports — exactly as spec 014 did for
`ActiveBookingBanner`/`Switch`, never a reimplementation:
`ui/components/forms/Textarea.jsx` (the description field) and
`ui/components/marketplace/RequestStatusTimeline.jsx` (the §37 status view).
**No `Stepper` exists** in `ui/` — the draft's reference to one was wrong; a multi-step form, if used,
composes existing primitives. No new design-system primitive is introduced, and no already-shipped
screen is visually redesigned here.

---

## 6. Test plan

Vitest only — this repo has no E2E harness (no Playwright/Cypress is installed), so the draft's
`apps/web-e2e/request-creation.spec.ts` row is removed rather than promised. Integration tests run
against the isolated `<name>_test` database (`vitest.config.ts` rewrites `DATABASE_URL`;
`test/db-reset.ts` refuses any other name) and follow the existing `describe.skipIf(!dbReachable)`
plus transaction-rollback pattern in `lib/db/status-transitions.integration.test.ts`.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | budget parsing/validation; status → §37 step mapping; idempotency fingerprint canonicalization; the transition validator's allowed/denied table | `lib/requests/*.test.ts`, `lib/api/idempotency.test.ts` |
| **Integration** | create → cancel lifecycle; field validation against real `ServiceField` rows; request ownership; address ownership; idempotent replay and conflicting reuse; version conflict; history rows written; DB-trigger rejection of an unseeded transition | `app/api/v1/requests/*.integration.test.ts` |
| **Component** | form states, budget-optional behaviour, field-error mapping, cancel dialog driven by a stubbed preview | `app/requests/**/*.test.tsx` (Testing Library, jsdom) |
| **Contract** | the route handler is a thin wrapper — it performs no validation the domain function does not, which is AC-6's guarantee that a future MCP tool calling `lib/requests/create.ts` gets identical validation | `app/api/v1/requests/create.integration.test.ts` |

No test may assert behaviour only against a mock of the domain module: every rule above is exercised
through the real `lib/requests/*` code path and real database rows.

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/requests/create.integration.test.ts::creates the row draft and transitions it to submitted, recording both history rows` |
| AC-2 | `app/api/v1/requests/create.integration.test.ts::rejects a missing required field by key and persists no row` |
| AC-3 | `app/api/v1/requests/create.integration.test.ts::succeeds with budget omitted, and with each of amount/range` |
| AC-4 | `app/api/v1/requests/cancel.integration.test.ts::previews a null consequence then cancels from submitted/matching/offers_open` |
| AC-5 | `lib/requests/status-mapping.test.ts::maps every internal status to its §37 step` and `app/api/v1/requests/read.integration.test.ts::never exposes matching internals` |
| AC-6 | `app/api/v1/requests/create.integration.test.ts::the route adds no validation beyond createRequest (identical rejection set through the domain function directly)` |
| AC-7 | `app/api/v1/requests/state-machine.integration.test.ts::rejects cancelling a completed request (422) and a stale expectedVersion (409)` and `::the DB trigger rejects an unseeded transition even with no application pre-check` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** matching/distribution itself (spec 017) — this spec only takes the
request to `submitted` and reads nothing from `request_provider_matches` beyond the empty
notification hook.

---

## 7. Out of scope

- Matching, eligibility, ranking and distribution to a provider pool (**spec 017**) — including any
  transition out of `submitted`.
- Offer creation/response/timer (**spec 018**) and offer negotiation/comparison (**spec 019**).
- Provider notification delivery (**spec 026**).
- Booking creation and payment (**specs 020/021**).
- Cancellation *after* provider selection, fees and no-show policy (**spec 023**).
- File upload/storage, and therefore attachment count/size/type limits (**spec 027**).
- Request-specific pre-booking chat (**spec 025**).
- Customer-resumable drafts — no draft list/edit/resume API here; `draft` is an internal,
  single-transaction step only.

*(The draft mis-numbered several of these — offers as 017, distribution as 016, chat as 018/025;
corrected above against `docs/specs/INDEX.md`.)*

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Attachment count/size/type limits per request | Product + spec 027 | **Open — deliberately unresolved.** No limit is invented here: nothing in the master spec or architecture fixes a number, and `file_assets` has no size/MIME columns yet, so this spec cannot enforce one honestly. `attachmentIds` is accepted and ownership-validated; the count/size/type rule is defined and enforced by spec 027 when upload ships, and must exist before any attachment UI is exposed |
| 2 | Cancellation consequence once a request reaches `provider_selected` | spec 023 | Out of scope here (§7). This spec's cancellable states cannot carry a consequence because no payment exists pre-selection; the seam is `lib/requests/cancellation-consequence.ts` and nothing else |
| 3 | This spec introduces the repo's first `Idempotency-Key` implementation | Platform | `lib/api/idempotency.ts` plus a per-entity key column, matching what specs 020/021/036 already assume. Specs 018/020/021 must reuse it rather than add a second scheme |
| 4 | Budget "target amount" is encoded as `min = max` | Platform | Accepted: it keeps master spec §27's three shapes representable with the existing `moneyColumns()` convention and no extra enum column. If a later spec must distinguish "exactly 5,000" from a zero-width range, it adds a `budget_kind` column then |
| 5 | Master spec §38 requires notifying affected providers on cancellation | spec 017/026 | Hook shipped, delivery deferred (§3). The obligation is unmet until 017 and 026 land, and AC-4 says so explicitly rather than implying it is done |

---

## 9. Rollout

- **Feature flag:** none — core transactional flow, not optional.
- **Migration order:** `0011_add_request_columns.sql` ships with the code; additive only, applied
  before the routes are reachable.
- **Rollback:** revert the deploy. The migration is additive and non-destructive, so old code runs
  against the new schema unchanged; no down-migration is run (`db:rollback` only ever undoes the 0001
  baseline, by design).
- **Observability:** request-submission funnel (draft→submitted, then →matched/→booked once 017/020
  exist) tracked by spec 040; cancellation rate and idempotency-key conflict rate monitored — the
  latter directly informs specs 018/020/021, which inherit this mechanism.
