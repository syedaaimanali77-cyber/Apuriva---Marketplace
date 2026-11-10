# Spec: Service Execution Lifecycle

**File:** `docs/specs/2026-08-28-028-service-execution-lifecycle.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Implemented:** 2026-09-18 — migration `0024_add_service_execution_lifecycle` (reversible, verified
both ways), `lib/bookings/{evidence,evidence-policy,execution-window,milestones,service-execution}.ts`,
`app/api/v1/bookings/[id]/{milestones,evidence}/route.ts`, and the two `app/bookings/_components/`
sections. All AC-1…AC-12 are covered by passing Vitest suites (§6 traceability).
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §43–§45, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.4, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (the `booking_milestones` baseline skeleton and the `baseColumns()`
convention), spec 004 (envelope, error codes, `RateLimitDomain`, OpenAPI registry), spec 005
(session, CSRF), spec 006 (`requireActiveMode`), spec 009 (`resolvePermission`,
`recordAdminAuditEvent` — referenced, not extended), spec 010 (`services`), spec 015
(`lib/api/idempotency.ts`), spec 017 (`requireOwnProviderProfile` via `lib/availability/owner.ts`),
**spec 020** (`bookings`, the `applyBookingTransition()` primitive, the seeded transition graph,
`lib/bookings/completion-evidence.ts`'s `CompletionEvidenceGate` port, and the
`provider-en-route`/`arrived`/`start-service`/`complete` routes), **spec 027** (`file_assets`, the
`FileContextPolicy` registry, the upload/finalize/read/delete routes, `app/_components/FileUpload.tsx`
and `app/_components/MediaPreview.tsx`) — all *implemented in this repository*.
**Feeds:** spec 029 (review eligibility reads `completed`), spec 031 (disputes may read completion
evidence, and registers `dispute_evidence` itself), spec 040 (the observability counters below).

> **Repository-shape note.** This repository is a **single Next.js application**. There is no
> `apps/web`, `apps/api`, `apps/worker`, `apps/web-e2e`, `packages/ui` or `packages/types`. Routes
> are `app/api/v1/**/route.ts`, domain logic is `lib/**`, DTOs are `lib/types/*.ts`, UI primitives
> live in `ui/` and are re-exported through `@/components`, and app-level components live in
> `app/_components/`. There is **no Playwright or Cypress runner**: the only test runner is Vitest,
> whose `include` covers `**/*.test.{ts,tsx}` and `e2e/**/*.spec.{ts,tsx}`. Every path in this
> document was checked against the tree. The previous draft's `apps/api/bookings/**`,
> `apps/web-e2e/service-execution.spec.ts`, `packages/types/src/service-execution.ts`,
> `packages/ui` `StatusTimeline` and `apps/web/app/provider/schedule/bookings/[id]/active` do not
> exist and are **not** created; §3, §5 and §6 name their real counterparts.

---

## 1. Problem statement

**Today:** Spec 020 is implemented, and it shipped the *state machine* — `applyBookingTransition()`,
the seeded transition rows, the `provider-en-route` / `arrived` / `start-service` / `complete`
routes, and a deliberately inert `CompletionEvidenceGate`
(`lib/bookings/completion-evidence.ts`) whose shipped default returns
`{ required: false, satisfied: true }`. Spec 027 is implemented, and it shipped the *file
substrate* — `file_assets`, the `FileContextPolicy` registry, upload/finalize/signed-read/delete —
with `booking_evidence` reserved in `FILE_CONTEXT_TYPES` but **deliberately unregistered**, so an
upload against it is `422 FILE_CONTEXT_NOT_AVAILABLE` and creates no row.

What is missing is the *workflow content* between those two: `booking_milestones` is still spec
003's bare skeleton (`id`, audit columns, `version`, `booking_id` — no milestone value at all),
`services` has no way to express that a job's completion must be evidenced, no context policy
authorizes booking evidence, and nothing registers the real gate. Master spec §43–§45's
arrival/progress/completion workflow therefore exists only as transitions with no content.

**Who is affected:** Providers executing jobs; customers tracking progress and wanting proof of
what was done; spec 031 (disputes), which needs completion evidence as input; spec 029, which must
be able to trust that `completed` means something was actually delivered.

**Why it matters now:** It is the operational heart of the "Service" step in the customer and
provider journeys (`docs/workflow.md` §1), it is the last piece of the 020 → 027 → 028 chain, and
both of its ports are already shipped and inert — the longer they stay inert, the longer
`completion_evidence_required` is a promise no service can make.

**Success looks like:** A provider's arrival, service start, optional progress milestones, and
completion (with evidence where the *catalog* requires it) are captured accurately and shown to
the customer, without forcing providers into constant status updates; a service that requires
evidence cannot be completed without it, and no client-supplied value can make that requirement go
away.

### What this spec owns, and what it deliberately does not

| Concern | Owner | Note |
|---|---|---|
| Booking status **vocabulary** and **transition validation** | **spec 020** | consumed verbatim; this spec seeds no transition, adds no status, and calls `applyBookingTransition()` never re-implements it |
| The arrival/start/complete **routes and vocabulary** (`provider-en-route`, `arrived`, `start-service`, `complete`) | **spec 020** | reused as-is; this spec adds **no** duplicate transition API |
| Milestone **content** (vocabulary, note, read surface) | **this spec** | `booking_milestones` becomes real here |
| The completion-evidence **requirement** (`services.completion_evidence_required`) and its resolution | **this spec** | registers the real `CompletionEvidenceGate` |
| Evidence **storage**, scanning, signed URLs, deletion, retention | **spec 027** | consumed; no second file system is created |
| **Who may upload/read** booking evidence | **this spec** | via spec 027's `registerFileContextPolicy('booking_evidence', …)` |
| `completed → protected`, `protected → settled`, capture, protection window | **spec 021** | this spec causes no payment side effect |
| Review eligibility from `completed` | **spec 029** | not read, not written, not triggered here |
| Dispute access to evidence, `dispute_evidence` | **spec 031** | registers its own context and its own admin rule |
| Notification delivery for any of the above | **spec 026** | this spec writes no `notifications` row |

---

## 2. Acceptance criteria

All times are the **database clock** (`clock_timestamp()`), never a client clock — spec 018's rule,
carried by spec 020. "Participant" means the booking's customer (via `customer_profiles.user_id`)
or its provider (via `provider_profiles.user_id`). A non-participant always receives `404`, never
`403`.

| # | Criterion |
|---|---|
| AC-1 | **Given** a `confirmed` booking **When** the provider taps "On my way" / "I've Arrived" **Then** the transition is performed by **spec 020's existing** `POST /api/v1/bookings/{id}/provider-en-route` and `POST /api/v1/bookings/{id}/arrived` routes under spec 020's rules, and both participants read the new status immediately through `GET /api/v1/bookings/{id}`. This spec adds **no** arrival route and **no** alternative transition path |
| AC-2 | **Given** an `arrived` booking **When** the provider taps "Start Service" **Then** spec 020's existing `POST /api/v1/bookings/{id}/start-service` moves it to `in_progress`. This spec adds no start route |
| AC-3 | **Given** a booking in `arrived` or `in_progress` **When** its provider posts a milestone (`started`, `working`, `almost_done`, or `custom` with a note) **Then** one `booking_milestones` row is written and is readable by **both** participants — and **no** booking status changes, **no** transition is attempted, and completion is never gated on a milestone having been posted. A booking may go `confirmed → … → completed` with zero milestones and nothing anywhere behaves differently |
| AC-4 | **Given** a booking whose **service** has `services.completion_evidence_required = true` **When** either participant calls spec 020's `POST /api/v1/bookings/{id}/complete` while fewer than `MIN_COMPLETION_EVIDENCE_ASSETS` (1) live `ready` `booking_evidence` assets are bound to that booking **Then** completion is rejected `422 COMPLETION_EVIDENCE_REQUIRED`, nothing is written, and the rejection is **identical for the customer and the provider**. The requirement is read **only** from `bookings.service_id → services.completion_evidence_required` inside the completing transaction; **no request body field, header, query parameter or session value can set, clear, weaken or skip it** |
| AC-5 | **Given** a booking whose service has `completion_evidence_required = false` **When** either participant completes it **Then** completion succeeds with no evidence, exactly as it does today |
| AC-6 | **Given** any request to `POST /api/v1/bookings/{id}/complete` carrying `evidenceFileAssetIds` **When** any listed id is not a live, `ready` `file_assets` row with `context_type = 'booking_evidence'` **and** `context_id = {id}` (the booking being completed) **Then** the request is rejected `422 EVIDENCE_ASSET_INVALID`, nothing is written, and the id is **never** counted toward the requirement. Satisfaction is computed **server-side from the database alone**, so an unauthorized, another booking's, soft-deleted, `pending`, `scanning` or `rejected` asset id can never satisfy completion — and a caller who omits the field entirely is judged by exactly the same server-side count |
| AC-7 | **Given** an upload against `context_type = 'booking_evidence'` **When** the caller is not the booking's provider acting in `provider` mode, or the booking is not in `arrived`/`in_progress`, or the per-booking cap `MAX_BOOKING_EVIDENCE_ASSETS` (10) is reached **Then** spec 027's `upload-url` route refuses it and **no `file_assets` row is created**; a `contextId` that is not a booking the caller provides for is refused identically, so evidence can never be attached to a booking the uploader has no part in |
| AC-8 | **Given** a booking that has reached `completed` (or any later status) **When** its **customer** requests its evidence **Then** they receive the evidence assets and can fetch each one's bytes through spec 027's `GET /api/v1/files/{id}`; **given** the booking has **not** yet reached `completed` **Then** the customer receives an empty list and every direct asset read is refused by spec 027's `canRead`, so evidence is never visible before the completion it evidences. The **provider** who uploaded it may read it at any time. Everyone else — including any admin, until spec 031 registers its own rule — is refused |
| AC-9 | **Given** location, geofence or time signals of any kind **When** the service is executed **Then** they may be displayed or logged as verification aids only: **no route, body field, column or code path in this spec accepts a coordinate, and nothing in this spec can move a booking's state**. Arrival is reached **only** by the provider's explicit authenticated `POST /api/v1/bookings/{id}/arrived` (spec 020, AC-7) |
| AC-10 | **Given** a milestone POST retried with the same `Idempotency-Key` and the same body **Then** exactly one `booking_milestones` row exists and the retry returns that same milestone (`201` first, `200` on replay); the same key with a different body is `409 IDEMPOTENCY_KEY_CONFLICT` and writes nothing; a missing key is `400 VALIDATION_ERROR` |
| AC-11 | **Given** the customer and the provider both call `complete` at effectively the same time on an evidence-requiring booking **Then** spec 020's AC-9 behaviour is preserved exactly: the evidence gate is evaluated for **each** caller on its own merits inside the locked transaction, so a caller who fails the gate is rejected **even if** the other party's concurrent request already completed the booking, and exactly one `bookings_status_history` row is written |
| AC-12 | **Given** a user's data export (spec 008) **Then** it includes the milestones of the bookings that user took part in and the metadata of evidence they uploaded, with no storage key, checksum, scan internals or counterparty user id; deletion follows spec 027's existing rules for the assets and **never** deletes a `booking_milestones` row, which is part of the booking's audit record |

**What AC-4 does not mean.** Marking a booking complete remains a spec 020 state-machine transition
and nothing more. It does not capture payment, open a protection window, make a payout eligible
(**spec 021**/**024**), or create review eligibility (**spec 029**). No code path in this spec
causes any of those effects.

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing mechanism reused | Not created |
|---|---|---|
| Arrival / start / completion transitions | **spec 020's** `provider-en-route`, `arrived`, `start-service`, `complete` routes and `applyBookingTransition()` | a second transition API, a second status vocabulary |
| The evidence gate seam | **spec 020's** `registerCompletionEvidenceGate()` (`lib/bookings/completion-evidence.ts`) | a new port |
| Evidence upload, scanning, signed URLs, deletion, retention | **spec 027's** `lib/files/**` + `app/api/v1/files/**` | a second file-storage system |
| Evidence authorization | **spec 027's** `registerFileContextPolicy('booking_evidence', …)` | a bespoke ACL |
| Participant resolution | **spec 020's** `requireBookingParticipant` (`lib/bookings/read.ts`) | a duplicated ownership rule |
| Provider ownership | **spec 017's** `requireOwnProviderProfile` (`lib/availability/owner.ts`) | a new check |
| Idempotency | **spec 015's** `requireIdempotencyKey` / `idempotencyFingerprint` (`lib/api/idempotency.ts`) + a per-entity key column | a second scheme |
| Session / CSRF / rate limit / envelope / errors | specs 004/005 | a second auth or envelope path |
| Upload/preview UI | **spec 027's** `app/_components/FileUpload.tsx`, `app/_components/MediaPreview.tsx` | a new `EvidenceUpload` component |
| Status timeline UI | the existing `RequestStatusTimeline` (`ui/components/marketplace/RequestStatusTimeline`, re-exported by `@/components`), already used on both booking pages | a `StatusTimeline` primitive — **no such component exists** |

### Repository paths (normative — the previous draft's monorepo paths do not exist)

| Draft said | Actual repository location |
|---|---|
| `packages/types/src/service-execution.ts` | `lib/types/bookings.ts` (milestone + evidence DTOs added to the existing file) |
| `apps/api/bookings/**` | `lib/bookings/**` (domain) + `app/api/v1/bookings/**/route.ts` (routes) |
| `packages/ui` `StatusTimeline` | `RequestStatusTimeline` via `@/components` — reused, unchanged |
| `EvidenceUpload` "reused from spec 027" | `app/_components/FileUpload.tsx` + `app/_components/MediaPreview.tsx` — the components spec 027 actually shipped |
| `apps/web/app/provider/schedule/bookings/[id]/active` | `app/provider/schedule/bookings/[id]/page.tsx` — the page that already exists; **no `/active` route is added** |
| `apps/web/app/bookings/[id]` | `app/bookings/[id]/page.tsx` — already exists |
| `apps/web-e2e/service-execution.spec.ts` | `e2e/service-execution.spec.ts` (Vitest; there is no Playwright) |

### Routes added by this spec

Routes are `app/api/v1/bookings/**/route.ts` under `withApiRoute` (`lib/api/handler.ts`), calling
new `lib/bookings/*` modules. Every route calls `requireSession`; every mutation also calls
`requireCsrf(request, session.id)`. `{id}` is read with the existing `bookingIdFromUrl` helper
(`app/api/v1/bookings/booking-id.ts`). Rate limiting reuses the **existing `bookings` domain**
(`30 / 60_000` per `session.userId`) — **no new `RateLimitDomain` is added**. Every route is
registered in `OPENAPI_ROUTES` (`lib/api/openapi-registry.ts`) in the same PR, tag `bookings`, or
`npm run check:openapi-drift` fails CI.

| Method | Route | Auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/v1/bookings/{id}/milestones` | session, **provider** mode, CSRF, the booking's provider, **`Idempotency-Key`** | `201` `ApiResponse<BookingMilestoneDto>` (replay `200`) | `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `404 BOOKING_NOT_FOUND`, `409 IDEMPOTENCY_KEY_CONFLICT`, `422 MILESTONE_NOT_ALLOWED_IN_STATUS`, `429` |
| `GET` | `/api/v1/bookings/{id}/milestones` | session, participant (either mode) | `200` `ApiResponse<BookingMilestoneDto[]>` — `createdAt ASC` | `401`, `404 BOOKING_NOT_FOUND`, `429` |
| `GET` | `/api/v1/bookings/{id}/evidence` | session, participant (either mode) | `200` `ApiResponse<FileAssetDto[]>` | `401`, `404 BOOKING_NOT_FOUND`, `429` |

**`GET /evidence` returns metadata only.** Bytes are reached exclusively through spec 027's
`GET /api/v1/files/{id}`, which re-runs `canRead` on every URL issue and every content fetch. This
route therefore cannot become a second, weaker way to read a file: for a customer before
completion it returns `[]` (AC-8), and even if an id leaked, spec 027 would refuse the fetch.

### The one change to a spec 020 file

`POST /api/v1/bookings/{id}/complete` keeps its route, its method, its auth rules, its idempotency
requirement and its normative validation order. Spec 020 §3 explicitly reserved this extension
("Spec 028 registers the real gate and extends the request body with `evidenceFileAssetIds`"). The
body gains one **optional** field:

```typescript
// lib/types/bookings.ts — extends the existing CompleteBookingRequest surface
export interface CompleteBookingRequest {
  /**
   * OPTIONAL, and never authoritative. Each id must be a live `ready` file_assets row with
   * context_type = 'booking_evidence' AND context_id = this booking (AC-6) — otherwise the whole
   * request is 422 EVIDENCE_ASSET_INVALID. It is an explicit declaration of what the provider
   * considers the completion evidence, NOT the thing that satisfies the requirement: satisfaction
   * is counted from the database, so omitting the field changes nothing about whether completion
   * is allowed.
   */
  evidenceFileAssetIds?: string[];
}
```

This is an **additive, backward-compatible** change: a body with no field behaves exactly as it
does today.

### Completion-evidence resolution (AC-4, AC-6) — normative

The gate registered with spec 020's `registerCompletionEvidenceGate()` runs **inside spec 020's
already-locked completion transaction**, at step (7) of spec 020's normative order, for **both**
parties identically:

```typescript
// lib/bookings/evidence.ts
export const MIN_COMPLETION_EVIDENCE_ASSETS = 1;
export const MAX_BOOKING_EVIDENCE_ASSETS = 10;

// Registered from instrumentation.ts via registerServiceExecutionIntegration().
export const completionEvidenceGate: CompletionEvidenceGate = async (tx, bookingId) => {
  // (a) REQUIREMENT — resolved only from the catalog, joined from the booking's own service_id.
  //     The client cannot reach any input to this query.
  const [row] = await queryRows<{ required: boolean; ready_count: number }>(
    tx,
    sql`SELECT s.completion_evidence_required AS required,
               (SELECT count(*) FROM file_assets fa
                 WHERE fa.context_type = 'booking_evidence'
                   AND fa.context_id   = b.id
                   AND fa.status       = 'ready'
                   AND fa.deleted_at IS NULL)::int AS ready_count
          FROM bookings b JOIN services s ON s.id = b.service_id
         WHERE b.id = ${bookingId}`,
  );
  if (!row?.required) return { required: false, satisfied: true };
  return { required: true, satisfied: row.ready_count >= MIN_COMPLETION_EVIDENCE_ASSETS };
};
```

Three properties follow, and each has its own test in §6:

1. **Unforgeable requirement.** `required` comes from `services`, joined through
   `bookings.service_id`. The only client input on the whole path is the booking id in the URL,
   which spec 020 has already authorized. There is no "skip evidence" flag to send.
2. **Unforgeable satisfaction.** The count is over assets whose `context_id` *is this booking*.
   An asset belonging to another booking, to another provider, still `pending`/`scanning`,
   `rejected`, or soft-deleted is not counted. Because the upload policy below only ever lets the
   booking's own provider create such a row, a valid evidence asset for a booking cannot exist
   without that booking's provider having created it.
3. **`evidenceFileAssetIds` cannot widen anything.** It is validated against exactly the same
   predicate *before* the gate runs (a bad id is `422 EVIDENCE_ASSET_INVALID`), and it is never an
   input to the count. It can only cause a request to fail that would otherwise have succeeded.

Because the gate is evaluated per caller inside the lock, spec 020's AC-9 concurrency rule is
preserved unchanged: losing the race is an idempotent success **only** for a caller that already
passed the gate on its own merits.

### Booking-evidence context policy (AC-7, AC-8) — normative

Registered through spec 027's registry, which is what lifts `booking_evidence` out of
`422 FILE_CONTEXT_NOT_AVAILABLE`. It lives in **`lib/bookings/evidence-policy.ts`**, not in
`lib/files/contexts/`: spec 027 §3 makes the consuming spec the owner of "who may see a file in a
given context", and spec 027's own `lib/files/boundaries.test.ts` enforces that `lib/files/**`
never acquires a consuming spec's business rules. Who may attach evidence to a booking, and when,
is a spec 028 rule about bookings. **Spec 027's source is not modified at all.**

```typescript
// lib/bookings/evidence-policy.ts  (spec 028's own domain — see below)
export const bookingEvidencePolicy: FileContextPolicy = {
  publicEligible: false,                              // never public, ever
  maxPerContext: MAX_BOOKING_EVIDENCE_ASSETS,         // 10
  allowedKinds: ['image', 'video', 'document'],

  // contextId is the BOOKING id. Provider-only, in provider mode, and only while the job is
  // actually being executed — so evidence cannot be pre-staged or added after the fact.
  async canUpload({ userId, activeMode, contextId }) {
    if (activeMode !== 'provider') return false;
    return isExecutingProvider(userId, contextId); // booking.provider_profile_id -> user_id,
                                                   // AND booking.status IN ('arrived','in_progress')
  },

  // The provider who is the booking's provider: always. The customer: only once the booking has
  // reached `completed` or later (AC-8). Nobody else — this spec registers NO admin bypass.
  async canRead({ userId, asset }) {
    const bookingId = asset.context_id;
    if (!bookingId || !isUuid(bookingId)) return false;
    if (await isBookingProvider(userId, bookingId)) return true;
    return isBookingCustomer(userId, bookingId) && await hasReachedCompleted(bookingId);
  },
};
```

`canRead` is deliberately **not** mode-scoped, matching spec 027's default for every context except
`message_attachment` (which inherits spec 025's mode rule). Read authorization is re-evaluated on
every URL issue and every content fetch, so a customer who somehow obtained an id before completion
still cannot fetch the bytes.

**No admin or Trust & Safety bypass is registered here, on purpose.** Spec 031 owns dispute access
to evidence and will register its rule — with spec 009's `resolvePermission` and an audited read,
exactly as spec 025 did for conversations — when it ships. Granting a broad admin read now would
mean shipping an unaudited disclosure path for a feature nobody can yet use. This is recorded as
Open Question 2.

### Milestones

```typescript
// lib/types/bookings.ts
export const BOOKING_MILESTONE_TYPES = ['started', 'working', 'almost_done', 'custom'] as const;
export type BookingMilestoneType = (typeof BOOKING_MILESTONE_TYPES)[number];

export interface BookingMilestoneDto {
  id: string;
  bookingId: string;
  milestoneType: BookingMilestoneType;
  /** Free text, ≤ 500 characters. REQUIRED when milestoneType is 'custom', optional otherwise. */
  note: string | null;
  createdAt: string;
}

export interface CreateBookingMilestoneRequest {
  milestoneType: BookingMilestoneType;
  note?: string;
}
```

The previous draft typed `milestone` as `'started' | 'working' | 'almost_done' | string`, which
collapses to `string` in TypeScript and admits an unbounded, unvalidated vocabulary at the database.
It is replaced by a **closed vocabulary with a CHECK constraint**, matching every other status-like
column in this schema (`bookings_status_ck`, `services_status_ck`, `file_assets` statuses); a
custom milestone is `custom` plus a `note`.

Milestones are append-only: there is no update and no delete route. A milestone may be posted only
while the booking is `arrived` or `in_progress` (`422 MILESTONE_NOT_ALLOWED_IN_STATUS` otherwise).
That window is the **same** one evidence may be attached in, and is named once in
`lib/bookings/execution-window.ts` (`EXECUTING_BOOKING_STATUSES`) so the two rules cannot drift
apart. Posting a milestone performs **no** transition — `lib/bookings/milestones.ts` does not import
`applyBookingTransition` and a boundary test asserts it (§6), the same technique
`lib/bookings/payment-boundary.test.ts` already uses for spec 021.

**Idempotency.** `Idempotency-Key` is **required** on the milestone POST, because a retried POST
would otherwise be a second visible row rather than a replay. Reuses `requireIdempotencyKey` and
`idempotencyFingerprint`; the key is stored on the entity and unique **per booking**
(`booking_milestones_booking_idempotency_key_uq`), never globally — the per-scope rule specs
015/018/020 established. The fingerprint covers `{ milestoneType, note }`.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `COMPLETION_EVIDENCE_REQUIRED` | **existing, spec 020's** — the gate reports `required && !satisfied` |
| `422` | `EVIDENCE_ASSET_INVALID` | **new** — an `evidenceFileAssetIds` entry is not a live `ready` `booking_evidence` asset of this booking (AC-6) |
| `422` | `MILESTONE_NOT_ALLOWED_IN_STATUS` | **new** — milestone posted outside `arrived`/`in_progress` |
| `422` | `FILE_CONTEXT_NOT_AVAILABLE` | **existing, spec 027's** — unchanged; simply stops firing for `booking_evidence` once the policy is registered |

Both new codes are defined in `lib/bookings/errors.ts` with an explicit `status`, the convention
spec 004 established for domain codes (`API_ERROR_CODES` holds only the eight baseline codes; specs
005/016/018/020 all add theirs this way). No existing code's meaning, HTTP status or wording
changes.

### Breaking-change check

- [x] N/A — every change is additive: two new routes, one new optional body field on an existing
  route, two new error codes, one new column on `services` (defaulted `false`, so every existing
  service keeps behaving exactly as it does today), and real columns on an empty baseline table.

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `services` (spec 010) | **extend** | `completion_evidence_required boolean NOT NULL DEFAULT false` |
| `booking_milestones` (spec 003 skeleton) | **fill in** | `milestone_type text NOT NULL`, `note text`, `created_by_user_id uuid NOT NULL → users(id)`, `idempotency_key text NOT NULL`, `idempotency_fingerprint text NOT NULL` |
| `file_assets` (spec 027) | **none** | `context_type = 'booking_evidence'`, `context_id = bookings.id` — the reserved vocabulary entry spec 027 already ships. **No column, no table, no index is added to spec 027's schema** |

**Constraints and indexes**

| # | Name | Rule |
|---|---|---|
| C-1 | `booking_milestones_type_ck` | `milestone_type in ('started','working','almost_done','custom')` |
| C-2 | `booking_milestones_note_ck` | `note is null or char_length(note) between 1 and 500`, **and** `milestone_type <> 'custom' or note is not null` — a custom milestone without a label is meaningless |
| I-1 | `booking_milestones_booking_idempotency_key_uq` | `unique (booking_id, idempotency_key)` — scoped per booking, the database backstop for AC-10 |
| — | `booking_milestones_booking_id_idx` | **already exists** (spec 003); the `createdAt ASC` read uses it |
| — | `file_assets` context lookup | spec 027's existing `(context_type, context_id)` index serves the gate's count; **not re-created** |

`bookings.service_id` (spec 020, `NOT NULL`, FK to `services`) already exists and is the join the
gate uses. No new column on `bookings`.

### Migration

- **Name:** `0024_add_service_execution_lifecycle` (`drizzle/0024_add_service_execution_lifecycle.sql`,
  with a hand-written `drizzle/0024_add_service_execution_lifecycle_down.sql` carrying no
  `_journal.json` entry, exactly as 0023 does). `_journal.json`'s head is `0023_add_file_assets`,
  so this is 0024.
- **Content:** one `ALTER TABLE services ADD COLUMN … DEFAULT false NOT NULL`; five
  `ALTER TABLE booking_milestones ADD COLUMN`; two CHECKs; one unique index. Nothing else.
- **Precondition:** `booking_milestones` receives `NOT NULL` columns, so the migration guards on it
  being empty and raises otherwise — the pattern 0023 used for `message_attachments`. Nothing in
  `lib/` or `app/` has ever inserted a `booking_milestones` row, so it is empty.
- **Reversible:** yes, and **safely** so: the down migration drops exactly what was added. Unlike
  0023's, it orphans no bytes — evidence assets live in `file_assets`, which this migration does
  not touch, so a rollback leaves them intact and simply returns the gate to spec 020's inert
  default. It refuses only if `booking_milestones` is non-empty, so a rollback never silently
  destroys posted milestones.
- **Backfill required:** **no.** `completion_evidence_required` defaults to `false`, which is
  precisely the behaviour every existing service has today (spec 020's default gate). No existing
  row is read or modified, and no service's behaviour changes until an admin deliberately turns the
  flag on.
- **Downtime:** none. `ADD COLUMN … DEFAULT` is metadata-only on the supported Postgres version, and
  `booking_milestones` is empty.
- **Reviewed SQL:** generated, then hand-reviewed in the PR; `npm run check:schema-checksum` keeps
  `0001_baseline_schema.sql` untouched.

**Admin surface.** `completion_evidence_required` is set through spec 010's **existing**
`PATCH /api/v1/admin/services/{id}` (`EditServiceRequest` gains the optional boolean, validated by
`lib/catalog/services.ts` under its existing `expectedVersion` optimistic-concurrency rule). No new
admin route and no new permission are created.

### Retention and privacy

Completion evidence routinely contains photographs of a customer's home or property. It is
`visibility: 'private'` and `publicEligible: false` — there is no code path by which a booking
evidence asset can become public.

- **Retention and deletion** are spec 027's, unchanged: soft delete, the grace period, the byte
  purge sweep, and `legal_hold`. This spec adds no retention rule and no second lifecycle.
- **Export (spec 008):** a user's export includes their bookings' milestones (type, note,
  timestamp) and, through spec 027's existing `exportFileAssetData`, the metadata of evidence they
  uploaded. It carries **no** `storage_key`, `checksum_sha256`, scan internals, idempotency
  material or counterparty user id — `FileAssetDto` and `BookingMilestoneDto` are the whole of what
  leaves the server.
- **Deletion:** `booking_milestones` rows are **never** deleted or anonymized — like
  `bookings_status_history`, they are part of a financial/audit record, and spec 008's existing
  `hasActiveBooking()` guard already refuses deletion while a booking is unresolved. Evidence assets
  follow spec 027's `redactFileAssetsForDeletedUser`.
- **Disclosure boundary:** before completion, evidence is visible only to the provider who uploaded
  it. After completion, additionally to that booking's customer. To nobody else — see Open
  Question 2.

---

## 5. UI states

**Scope note.** Both booking detail pages already exist and already render
`RequestStatusTimeline`. This spec **adds no page, creates no `ui/` primitive, introduces no design
system, changes no token, and does not redesign either page** — it adds two sections to pages that
are already there, built from components that already exist. `app/components/NavShell.tsx`,
`AppHeader.tsx` and `components/index.ts` carry in-flight design-system work and are **not**
touched. Per the project branding rule, neither section introduces a logo or brand placement:
these pages already have their own.

### `app/provider/schedule/bookings/[id]/page.tsx` (extended)

| State | Behaviour |
|---|---|
| **Loading** | existing `Skeleton`; the timeline and action area are the page's, unchanged |
| **In progress** | current status plus a live elapsed timer since the `in_progress` history entry; an optional "Post an update" control offering the three preset milestones and a custom note — visibly optional, never blocking |
| **Evidence required** | when the service requires evidence, the completion control states so **before** it is pressed, with the current count (e.g. "1 photo attached"), using spec 027's `FileUpload` and `MediaPreview` |
| **Error** | a `422 COMPLETION_EVIDENCE_REQUIRED` renders inline in an `Alert` on the same screen, naming exactly what is missing — never a bare toast and never a navigation away |
| **Success** | each posted milestone appends to the list optimistically-confirmed from the server response; completion re-renders the timeline into its completed state |

### `app/bookings/[id]/page.tsx` (extended, customer view)

| State | Behaviour |
|---|---|
| **Empty** | no milestones posted → the customer sees the base status only. **No empty milestone list, no "no updates yet" placeholder** — a provider who posts nothing must not look like a provider who is failing to report |
| **Milestones present** | appended under the existing `RequestStatusTimeline` in `createdAt` order |
| **Before completion** | no evidence section at all (AC-8) |
| **After completion** | an "Evidence" section rendering each asset through spec 027's `MediaPreview`; a still-`scanning` asset shows spec 027's own state, never a broken image |

**Components used:** `Alert`, `Badge`, `Button`, `Card`, `EmptyState`, `ErrorState`, `Icon`,
`Skeleton`, `RequestStatusTimeline` from `@/components`, plus `app/_components/FileUpload.tsx` and
`app/_components/MediaPreview.tsx` from spec 027 — **all existing**. Nothing is conveyed by colour
alone; the milestone control and the upload control are keyboard-reachable and labelled (spec 043).

---

## 6. Test plan

Vitest only. Integration suites live beside the module under test as `*.integration.test.ts` and
`describe.skipIf` themselves without a `DATABASE_URL`, the pattern every spec 015–027 suite uses.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | milestone request parsing, the closed vocabulary, the `custom`-requires-`note` rule, the note length bound | `lib/bookings/milestones.test.ts` |
| **Unit (boundary)** | `lib/bookings/milestones.ts` imports no transition primitive — milestones can never move the state machine (AC-3) | `lib/bookings/execution-boundary.test.ts` |
| **Integration** | the evidence gate: requirement read from `services`, count from `file_assets`, both branches, both parties | `lib/bookings/evidence.integration.test.ts` |
| **Integration** | evidence ownership/context: another booking's asset, another provider's asset, a `pending`/`scanning`/`rejected` asset, a soft-deleted asset — none satisfies, each `422 EVIDENCE_ASSET_INVALID` when listed (AC-6) | `lib/bookings/evidence-authorization.integration.test.ts` |
| **Integration** | the `booking_evidence` context policy: upload allowed only for the booking's provider in provider mode and only in `arrived`/`in_progress`; customer read refused before completion and allowed after; third party always refused; `422 FILE_CONTEXT_NOT_AVAILABLE` when spec 028 is rolled back (AC-7, AC-8) | `lib/bookings/evidence-authorization.integration.test.ts` (with the policy, in spec 028's own domain) |
| **Integration** | milestone idempotency: replay, conflicting body, missing key (AC-10) | `lib/bookings/milestones.integration.test.ts` |
| **Integration** | concurrency: simultaneous customer/provider `complete` on an evidence-requiring booking under the REAL gate — the failing caller is still rejected, exactly one history row (AC-11) | `lib/bookings/evidence-concurrency.integration.test.ts`. Spec 020's own `complete-concurrency.integration.test.ts` already covers the rule with a stub gate and is **not modified** |
| **Integration (routes)** | auth matrix for all three new routes: anonymous `401`, non-participant `404`, wrong mode `403`, missing CSRF `403`, rate limit `429` | `app/api/v1/bookings/execution.integration.test.ts` |
| **Component** | provider page: evidence state before completion; customer page: no empty milestone list, no evidence section before completion | `app/provider/schedule/bookings/[id]/page.test.tsx`, `app/bookings/[id]/page.test.tsx` (both **exist** and are extended) |
| **End-to-end (Vitest)** | arrival → start → milestone → completion blocked without evidence → upload → completion succeeds → customer sees evidence | `e2e/service-execution.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1, AC-2 | `e2e/service-execution.spec.ts::a provider walks a job from arrival to evidenced completion, and the customer sees it` (drives spec 020's own `advanceBooking`) + `lib/bookings/execution-boundary.test.ts::adds no arrival, start or completion route of its own` |
| AC-3 | `lib/bookings/milestones.integration.test.ts::milestone posts write no status history` + `lib/bookings/execution-boundary.test.ts::milestones import no transition primitive` |
| AC-4 | `lib/bookings/evidence.integration.test.ts::requirement comes from services, and blocks completion until evidence exists` + `::no client-supplied value can skip, clear or weaken the requirement` + `app/api/v1/bookings/execution.integration.test.ts::422 COMPLETION_EVIDENCE_REQUIRED, and no body field can bypass it` |
| AC-5 | `lib/bookings/evidence.integration.test.ts::service not requiring evidence completes without any` |
| AC-6 | `lib/bookings/evidence-authorization.integration.test.ts::foreign, unready, deleted and nonexistent ids never satisfy completion` + `app/api/v1/bookings/execution.integration.test.ts::422 EVIDENCE_ASSET_INVALID for an id that is not this bookings evidence` |
| AC-7 | `lib/bookings/evidence-authorization.integration.test.ts::only the bookings provider may upload, and only in provider mode` + `::refuses an upload outside arrived/in_progress` |
| AC-8 | `lib/bookings/evidence-authorization.integration.test.ts::the customer sees evidence only after completion; the provider always` + `app/api/v1/bookings/execution.integration.test.ts::the customer reads evidence only after completion` |
| AC-9 | `app/api/v1/bookings/execution.integration.test.ts::no spec 028 route accepts a location signal or changes booking status` + `lib/bookings/execution-boundary.test.ts::no spec 028 module or route accepts a location, geofence or telemetry signal` + `lib/bookings/milestones.test.ts::ignores any location-shaped field a caller invents` |
| AC-10 | `lib/bookings/milestones.integration.test.ts::idempotent replay, conflicting body, missing key` |
| AC-11 | `lib/bookings/evidence-concurrency.integration.test.ts::a caller declaring a foreign evidence id is rejected even after the booking is completed` + `::re-evaluates the gate per caller rather than caching the winners answer` |
| AC-12 | `lib/bookings/evidence.integration.test.ts::export carries no storage key, checksum or counterparty id` |

**Coverage:** ≥80% on new code.

**Not covered here, deliberately:** the booking state machine's transition validation and the
arrival/start/complete transitions themselves (**spec 020**, already tested in
`lib/bookings/lifecycle.integration.test.ts` and `complete.integration.test.ts`); upload,
scanning, signed URLs, expiry and deletion mechanics (**spec 027**, already tested in
`lib/files/*.integration.test.ts`). This spec tests only the seams it adds.

---

## 7. Out of scope

- Booking status vocabulary, the transition graph, and transition validation — **spec 020**.
- Payment capture, the protection window, `completed → protected`, `protected → settled` — **spec
  021**; nothing here triggers them.
- Review eligibility arising from completion — **spec 029**; nothing here reads or writes it.
- Dispute access to evidence, the `dispute_evidence` context, and any Trust & Safety read path —
  **spec 031**.
- File storage, scanning, CDN, image optimization, retention sweeps — **spec 027**.
- Notification delivery for arrival, milestones or completion — **spec 026**.
- Any use of GPS, geofencing or telemetry to infer, verify or change state (AC-9). Location as a
  *displayed* verification aid would be a separate, later spec.
- Provider "day view" / route planning / job-queue UI.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Which services require completion evidence by default | Product | **Resolved (no code impact).** Per-service, set by an admin through spec 010's existing `PATCH /api/v1/admin/services/{id}`. The column ships `false` for every service, so the platform's behaviour is unchanged on deploy and changes only by deliberate configuration. Nothing is hard-coded here |
| 2 | Should Trust & Safety be able to read booking evidence before spec 031 ships? | Platform + Trust & Safety | **Open — deliberately deferred, and it blocks nothing here.** This spec registers no admin bypass, because an unaudited disclosure path for a feature nobody can yet use is worse than a gap. Spec 031 registers an audited `resolvePermission`-gated rule, exactly as spec 025 did for conversations. If an operational need arises first, the fix is a small additive change to `bookingEvidencePolicy.canRead` plus a seeded permission — not a redesign |
| 3 | `MIN_COMPLETION_EVIDENCE_ASSETS = 1` is platform-wide | Product | Accepted for now. A per-service minimum would be another `services` column and is a forward-compatible change; one asset is the meaningful threshold between "evidenced" and "not evidenced" |
| 4 | A provider could upload one irrelevant photo to clear the gate | Trust & Safety | Accepted and **explicitly not** solved by this spec. Judging evidence *quality* is a human/dispute concern (spec 031), not a completion gate; an automated quality check would block real jobs for real providers. The gate proves evidence exists and is bound to the right booking, which is what it claims to prove |
| 5 | Evidence uploaded during `in_progress` then soft-deleted before completion | Platform | Handled by construction: the gate counts live `ready` rows at completion time inside the locked transaction, so a deleted asset stops counting immediately and completion is re-blocked |

---

## 9. Rollout

- **Feature flag:** none. `services.completion_evidence_required` defaults to `false`, so the flag
  *is* the column: no service's behaviour changes until an admin turns it on for that service.
- **Migration order:** `0024` ships with the code. The gate and the context policy are registered
  in `instrumentation.ts` (the composition root specs 021–027 already use) via
  `registerServiceExecutionIntegration()`, so the wiring stays outside both `lib/bookings` and
  `lib/files` and the dependency stays one-directional.
- **Rollback:** revert the deploy. Unregistering restores spec 020's inert default gate
  (completion succeeds without evidence) and returns `booking_evidence` to
  `422 FILE_CONTEXT_NOT_AVAILABLE` — both are those ports' documented pre-028 behaviour, so no
  shipped spec breaks. Already-uploaded evidence rows survive untouched. The `0024` down migration
  is only needed if the column itself must go, and it refuses while milestones exist.
- **Observability (spec 040):** completion-evidence block rate, milestone posts per completed
  booking, evidence assets per evidence-requiring booking, and `EVIDENCE_ASSET_INVALID` rate — the
  last is the signal that a client is sending ids it should not have.
