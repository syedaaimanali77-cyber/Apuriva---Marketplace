# Spec: Booking Creation & State Machine

**File:** `docs/specs/2026-08-28-020-booking-creation-state-machine.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §39, §43–§45, §103, §115, §125, §132.6, §132.7, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.4, §14, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (the baseline `bookings`, `booking_milestones`, `bookings_status_history`
and `bookings_status_transitions` tables, the `enforce_status_transition()` trigger, and the
`moneyColumns`/`moneyPairChecks`/`scheduledTimeColumns` conventions), spec 004 (envelope, error
codes, rate-limit domains, OpenAPI registry), spec 005 (session, CSRF), spec 006
(`requireActiveMode`, customer/provider profiles), spec 008 (privacy export/deletion and
`lib/privacy/booking-lifecycle-adapter.ts`), spec 010 (`services`, `pricing_model`), spec 012
(address/location privacy), spec 015 (`requests`, `requests_status_history`,
`lib/api/idempotency.ts`), **spec 016** (`reserveProviderSlot()`, the `BusyIntervalLoader` port and
`registerBusyIntervalLoader()`, `provider_services.duration_minutes`/buffers,
`provider_profiles.scheduling_timezone`, `getAvailabilitySummary()`), spec 017
(`request_provider_matches`, `requireOwnProviderProfile` via `lib/availability/owner.ts`),
**spec 018** (the `offers` row, accept/decline/withdraw, `offers.accept_idempotency_key`, the
`offers_request_accepted_uq` backstop, `offers_open → provider_selected`), **spec 019** (offer
price immutability on non-draft rows; the accepted row's price is final) — all *approved and
implemented*.
**Feeds:** spec 021 (payment authorization/capture/protection/settlement — the sole owner of
`completed → protected` and `protected → settled`), spec 022 (refunds), spec 023
(cancellation/no-show), spec 024 (payouts), spec 025 (post-booking conversations), spec 026
(delivery of every booking notification), spec 028 (service-execution detail: milestones and the
completion-evidence requirement), spec 029 (review eligibility), spec 031 (disputes), spec 036
(`create_booking` MCP tool, which must call this spec's `lib/bookings/*` functions).

> **Numbering note.** The authoritative numbering — `docs/specs/INDEX.md`, `docs/specs/README.md`
> and the approved specs 015–019 — is **015 = Request Creation, 016 = Availability & Service
> Areas, 017 = Matching & Distribution, 018 = Offer System & Timer, 019 = Offer Negotiation &
> Comparison, 020 = this spec, 021 = Payment Processing & Protection, 023 = Cancellation & No-Show,
> 028 = Service Execution Lifecycle, 029 = Reviews, 031 = Disputes**. The filename and the `File:`
> line above match it. The header previously read `Status: Approved`, which contradicted
> `docs/specs/INDEX.md` and `docs/specs/README.md` (both list 020 as **Draft**); it is corrected to
> `Draft` and stays there until implementation is completed and reviewed.

> **Repository-shape note.** This repository is a **single Next.js application**. There is no
> `apps/web`, `apps/api`, `apps/worker`, `apps/web-e2e`, `packages/ui` or `packages/types`. Routes
> are `app/api/v1/**/route.ts`, domain logic is `lib/**`, DTOs are `lib/types/*.ts`, UI primitives
> are `ui/` re-exported through `@/components`. There is **no Playwright/Cypress runner** (the only
> test runner is Vitest; `e2e/auth.spec.ts` is an unwired file, not a suite) and **no `lib/mcp`**
> (spec 036 is not built). Every path in this document was checked against the tree.

---

## 1. Problem statement

**Today:** `bookings`, `booking_milestones`, `bookings_status_history` and
`bookings_status_transitions` exist only as spec 003 baseline skeletons. `bookings` carries
`id`, the audit columns, `version`, `offer_id` and a bare `text` status — no scheduled time, no
price, no participants, no idempotency key. `bookings_status_transitions` is **empty**, so the
spec 003 `bookings_status_transition_trg` trigger currently rejects *every* status change. Nothing
in `lib/` or `app/` creates a booking: `lib/offers/decide.ts` explicitly stops at an `accepted`
offer and a request in `provider_selected`, and `app/bookings/page.tsx` is a `PlaceholderPage`
naming this spec. `lib/availability/busy-intervals.ts` ships a registry whose default loader
returns `[]` and whose doc comment says spec 020 registers the real one.

Master spec §39 requires the booking to be fully server-authoritative, revalidating
availability/slot/price/permissions/offer-state immediately before confirmation and preventing
race-condition double booking. §43–§45 define the arrival/start/progress/completion workflow.
§125 defines the booking state machine. §132.6 makes "no duplicate bookings on retries"
non-negotiable, and §115 names this exact case as a critical test example.

**Who is affected:** Every customer and provider once an offer is accepted; spec 016, whose
`reserveProviderSlot()` primitive is fully implemented but inert until this spec registers a busy
loader; spec 008's deletion guard, which reads booking status through a provisional allowlist;
spec 021, which triggers off booking status.

**Why it matters now:** It is the next step in the established order
**015 → 016 → 017 → 018 → 019 → 020**, and the point where an accepted offer (018/019) and
validated availability (016) become a real, confirmed transaction.

**Success looks like:** Accepting an offer creates exactly one booking even under retry and under
two simultaneous attempts, with full server-side revalidation inside the writing transaction; the
booking then progresses `pending → confirmed → provider_en_route → arrived → in_progress →
completed`, every transition validated in application code *and* by the database trigger; a slot
lost between acceptance and confirmation produces `422 SLOT_NO_LONGER_AVAILABLE` with concrete,
re-submittable alternatives rather than a dead end.

### What this spec owns, and what it deliberately does not

| Concern | Owner | Note |
|---|---|---|
| Booking status **vocabulary** (the `bookings_status_ck` CHECK) | **this spec** | one author for the whole enum; later specs add transitions, never statuses |
| The `applyBookingTransition()` primitive, `bookings_status_history` writes, optimistic concurrency | **this spec** | every other spec that changes a booking status calls it |
| The transitions **this spec performs** (seeded rows, §3) | **this spec** | `pending→confirmed`, `confirmed→provider_en_route`, `confirmed→arrived`, `provider_en_route→arrived`, `arrived→in_progress`, `in_progress→completed` |
| `completed → protected`, `protected → settled` | **spec 021** | seeded and performed there; see §3 "Payment boundary" |
| `→ cancelled` / no-show | spec 023 | not seeded here |
| `→ disputed` | spec 031 | not seeded here |
| `→ refunded` | spec 022 | not seeded here |
| `→ failed` | spec 021 | a booking whose payment gate refuses; not seeded here |
| Slot resolution, buffers, the provider row lock | spec 016 | consumed, never reimplemented |
| Offer price, the 2-minute window, accept/decline/withdraw | specs 018/019 | read-only here |
| Milestone content, evidence-requirement source, evidence storage | spec 028 / spec 027 | this spec ships the **gate**, not the requirement |
| Notification delivery (channel, template, send) | spec 026 | this spec writes no `notifications` row |

---

## 2. Acceptance criteria

All times are the **database clock** (`clock_timestamp()`), never a client clock and never `now()`
(frozen at transaction start), exactly as spec 018 established. "Participant" means the request's
customer (resolved through `customer_profiles.user_id`) or the accepted offer's provider (resolved
through `provider_profiles.user_id`). A non-participant always receives `404`, never `403` —
spec 015/018/019's rule.

| # | Criterion |
|---|---|
| AC-1 | **Given** an accepted offer **When** `POST /api/v1/bookings` is called **Then**, inside one transaction that already holds the request, offer and provider row locks, the server revalidates — in the fixed order of §3 "Creation, in evaluation order" — the caller's identity and active mode, the offer's current status (`accepted`, not superseded/withdrawn/expired), the request's current status (`provider_selected`), the absence of an existing booking for that offer, the scheduled instant, the provider's schedule and slot (via spec 016's `reserveProviderSlot()`), and the price/currency copied verbatim from the accepted offer row. No value that determines the booking is taken from the client except `offerId`, `scheduledAt` and the `Idempotency-Key` |
| AC-2 | **Given** a slot that became unavailable between offer acceptance and booking confirmation **When** confirmation is attempted **Then** the transaction is rolled back, nothing is written, and the customer receives `422 SLOT_NO_LONGER_AVAILABLE` whose `details` carry `requestedStartAt`, `durationMinutes`, `scheduledTimezone`, `nextAvailableDate` and `alternatives`: **0–3** concrete, re-submittable `scheduledAt` instants for the **same provider, same service, same duration and same local time-of-day**, computed by spec 016's slot rules, ordered earliest-first, within `ALTERNATIVE_LOOKAHEAD_DAYS = 14` local days of the failed date (§3 "Slot-conflict alternatives"). The offer stays `accepted` and the request stays `provider_selected`, so a retry with one of the returned instants and a **new** `Idempotency-Key` succeeds. It is never a silent failure and never an empty `422` body |
| AC-3 | **Given** an identical booking-creation request retried (network retry, double-click, duplicate MCP tool call) **When** the same `Idempotency-Key` and the same body are used **Then** exactly one `bookings` row exists and every retry returns that same booking with `200` (the first call returns `201`); the same key with a **different** body returns `409 IDEMPOTENCY_KEY_CONFLICT` and writes nothing; a missing key returns `400 VALIDATION_ERROR` |
| AC-4 | **Given** a `confirmed` booking **When** the provider marks "On my way", then "I've Arrived", then "Start Service" **Then** the status progresses `confirmed → provider_en_route → arrived → in_progress`, one explicit authenticated provider action per transition, each recorded as one `bookings_status_history` row with `actor_user_id` and `actor_role`; "On my way" is **optional**, so `confirmed → arrived` is also valid; each new status is immediately readable by both participants through `GET /api/v1/bookings/{id}` and the booking list |
| AC-5 | **Given** a completion-evidence requirement reported by this spec's `CompletionEvidenceGate` (§3) **When** either the customer or the provider marks the booking complete while the gate reports the requirement unmet **Then** completion is rejected `422 COMPLETION_EVIDENCE_REQUIRED` and nothing is written, **identically regardless of which party called**; **given** the gate reports no requirement (which is the shipped default until spec 028/027 install a real gate) **Then** completion succeeds without evidence, for either party |
| AC-6 | **Given** any booking status transition **When** attempted out of the seeded transition graph (e.g. `pending → in_progress`, `confirmed → completed`, anything out of `completed`) **Then** the server rejects it with `409 INVALID_STATUS_TRANSITION` in application code, **and** the spec 003 `bookings_status_transition_trg` trigger independently rejects it at the database (`SQLSTATE 23514`) even if application code is bypassed; a transition whose `expectedVersion` is stale is rejected `409 CONFLICT` naming the current version |
| AC-7 | **Given** any booking status change **When** it is performed **Then** it was caused by an explicit, authenticated, authorized participant action through one of this spec's routes — no spec 020 code path, timer, cron job, GPS ping, geofence or time signal ever transitions a booking on its own. Location/time signals may be displayed or logged by later specs as verification aids, but this spec exposes no interface through which such a signal can move the state machine |
| AC-8 | **Given** a booking `In Progress` **When** either the customer or the provider (both have equal authority to do so) marks it `Completed` **Then** the transition succeeds without requiring the other party's confirmation, and both parties are notified of the completion and who performed it |
| AC-9 | **Given** the customer and the provider both send a `complete` request for the same booking at effectively the same time **When** both requests independently pass authorization and completion-evidence validation **Then** exactly one `Completed` transition is recorded server-side (no corrupted state, no duplicate `bookings_status_history` rows), and the request that loses the race is treated as an idempotent success returning the already-completed booking, not an error — a request that fails authorization or evidence validation is always rejected on its own merits and never gets a free pass merely because the other party's request already completed the booking |
| AC-10 | **Given** a booking marked `Completed` by one party **When** the other party disagrees with that completion **Then** they may explicitly open a dispute (spec 031), but the system never automatically creates one merely from the other party's lack of confirmation — a dispute exists only if that party opens one |
| AC-11 | **Given** a `complete` request **When** fewer than `MIN_IN_PROGRESS_SECONDS = 60` seconds of database time have elapsed since the booking's `arrived → in_progress` history row **Then** it is rejected `422 COMPLETION_TOO_EARLY` with `details.retryAfterSeconds`, for **either** party symmetrically, and nothing is written; and **given** `clock_timestamp()` is still earlier than `scheduled_at − EARLY_START_GRACE_MINUTES (60)` **When** `confirmed → provider_en_route` or `confirmed → arrived` is attempted **Then** it is rejected `422 BOOKING_NOT_STARTABLE_YET`, so the whole chain cannot be rushed to `completed` moments after confirmation (§3 "Unilateral-completion safeguards") |
| AC-12 | **Given** two simultaneous booking-creation attempts that would occupy overlapping time for the same provider **When** both run **Then** exactly one commits and the other receives `422 SLOT_NO_LONGER_AVAILABLE`, guaranteed by spec 016's `reserveProviderSlot()` provider row lock taken inside this spec's writing transaction before the insert, with `bookings_offer_id_uq` as an independent database backstop for the one-booking-per-offer rule |
| AC-13 | **Given** a user's data export or account deletion (spec 008) **Then** the export includes the bookings that user took part in — status, scheduled time, price, and the status history rows — with no idempotency key, no idempotency fingerprint and no counterparty user id; deletion **never** deletes or anonymizes a booking row, because bookings are financial/audit records (§4 "Retention and privacy"), and a user with a booking in a non-resolved status is refused deletion by spec 008's existing `hasActiveBooking()` guard |

Marking a booking `Completed` (AC-8) is a status-machine transition only — it does not itself
trigger payment protection, payout eligibility, or settlement. The `protected`/`settled`
transitions, and whatever triggers them, are owned by **spec 021**, which reads booking status as
an input; no code path in this spec causes those payment-side effects (§3 "Payment boundary").

"Notified" in AC-4 and AC-8 means, for this spec: the transition and its actor are durably recorded
in `bookings_status_history` and are immediately readable by **both** participants through this
spec's read surface, so neither party can be completed-against silently. Channel delivery (push,
email, in-app) is **spec 026's** and this spec writes no `notifications` row — the same boundary
spec 016 §7 and spec 018 §7 already draw.

---

## 3. API contract

Routes live under `app/api/v1/bookings/**/route.ts` (single Next.js app — **not** `apps/api`).
Every route is `withApiRoute` (`lib/api/handler.ts`) calling a new `lib/bookings/*` module. Every
route calls `requireSession`; every mutation also calls `requireCsrf(request, session.id)`
(`lib/auth/require-session.ts`). Route handlers read `{id}` from the URL with the existing helper
pattern — a new `app/api/v1/bookings/booking-id.ts`, mirroring `app/api/v1/offers/offer-id.ts`.

**Active mode (`requireActiveMode`, `lib/auth/require-mode.ts`).** `POST /bookings` and every
customer-side read require `'customer'`. `provider-en-route`, `arrived` and `start-service` require
`'provider'` **and** `requireOwnProviderProfile(session.userId)` (`lib/availability/owner.ts`).
`POST /bookings/{id}/complete` is the one route open to **either** mode: it resolves the caller's
role from the booking's participants and requires the active mode to *match the role it resolved* —
a user who is both the customer and a provider must be in the mode of the party they are acting as,
so the recorded `actor_role` is never ambiguous. A wrong active mode is `403 FORBIDDEN`; it is
never silently coerced.

**No route accepts the caller's own customer or provider id from the client.** Participation is
resolved server-side from `session.userId` through `customer_profiles`/`provider_profiles`, so
there is no IDOR surface. A caller who is not a participant gets `404 BOOKING_NOT_FOUND`.

**Rate limiting.** A new `bookings` domain is added to `RateLimitDomain` / `RATE_LIMIT_DEFAULTS`
(`lib/api/rate-limit.ts`) at `30 / 60_000` per `session.userId` — the same budget and the same
reasoning spec 015 used for `requests` and spec 018 for `offers` (a transactional write surface
deserves a tighter budget than the shared `default` of 100/60s). No existing domain is changed.

**Idempotency.** `Idempotency-Key` is **required** on `POST /api/v1/bookings` (`400
VALIDATION_ERROR` without it) and on `POST /api/v1/bookings/{id}/complete`. It is **not** required
on `provider-en-route`, `arrived` or `start-service`: each is naturally idempotent because
repeating it finds the booking already in the target status and returns `200` with the current
booking (§3 "Lifecycle transitions"). Reuses `requireIdempotencyKey` and `idempotencyFingerprint`
from `lib/api/idempotency.ts` (spec 015). Storage is on the entity, per the established pattern:
`bookings.idempotency_key` / `idempotency_fingerprint`, unique **per `customer_profile_id`**
(`bookings_customer_idempotency_key_uq`) — never globally unique, which would let one customer's
key collide with another's. The creation fingerprint covers `{ offerId, scheduledAt }`.

**OpenAPI.** Every route below is added to `OPENAPI_ROUTES` (`lib/api/openapi-registry.ts`) in the
same PR, tag `bookings`; `npm run check:openapi-drift` (`scripts/check-openapi-drift.ts`) fails CI
otherwise. No existing entry's path or method changes.

### Endpoints

| Method | Route | Auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/v1/bookings` | session, customer mode, CSRF, request owner, **`Idempotency-Key`** | `201` `ApiResponse<BookingDto>` (replay `200`) | `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `404 OFFER_NOT_FOUND`, `409 IDEMPOTENCY_KEY_CONFLICT`, `409 BOOKING_ALREADY_EXISTS`, `422 OFFER_NOT_ACCEPTABLE`, `422 REQUEST_NOT_ACTIONABLE`, `422 SLOT_NO_LONGER_AVAILABLE`, `429` |
| `GET` | `/api/v1/bookings/{id}` | session, participant (either mode) | `200` `ApiResponse<BookingDto>` | `401`, `404 BOOKING_NOT_FOUND`, `429` |
| `GET` | `/api/v1/bookings/{id}/status-history` | session, participant (either mode) | `200` `ApiResponse<BookingStatusHistoryDto[]>` — `occurredAt ASC` | `401`, `404 BOOKING_NOT_FOUND`, `429` |
| `GET` | `/api/v1/bookings` | session; own bookings only, role taken from the **active mode** | `200` `PagedResponse<BookingSummaryDto>` | `400` (bad `filter`/paging), `401`, `403 FORBIDDEN`, `429` |
| `POST` | `/api/v1/bookings/{id}/provider-en-route` | session, provider mode, CSRF, the booking's provider | `200` `ApiResponse<BookingDto>` | `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `404 BOOKING_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`, `409 CONFLICT`, `422 BOOKING_NOT_STARTABLE_YET`, `429` |
| `POST` | `/api/v1/bookings/{id}/arrived` | session, provider mode, CSRF, the booking's provider | `200` `ApiResponse<BookingDto>` | as above |
| `POST` | `/api/v1/bookings/{id}/start-service` | session, provider mode, CSRF, the booking's provider | `200` `ApiResponse<BookingDto>` | `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `404 BOOKING_NOT_FOUND`, `409 INVALID_STATUS_TRANSITION`, `409 CONFLICT`, `429` |
| `POST` | `/api/v1/bookings/{id}/complete` | session, **customer *or* provider** — whichever participant the caller is, in that active mode — CSRF, **`Idempotency-Key`** | `200` `ApiResponse<BookingDto>` | `400 VALIDATION_ERROR`, `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `404 BOOKING_NOT_FOUND`, `409 IDEMPOTENCY_KEY_CONFLICT`, `409 INVALID_STATUS_TRANSITION`, `422 COMPLETION_EVIDENCE_REQUIRED`, `422 COMPLETION_TOO_EARLY`, `429` |

**Route-shape note.** The draft listed a single `provider-arrived` route while AC-4 described three
statuses reached by two taps — an internal contradiction, because `confirmed → provider_en_route →
arrived` cannot be driven by one action without the server inventing a transition the customer
never saw a cause for (which AC-7 forbids). It is split into `provider-en-route` and `arrived`, and
`confirmed → arrived` is seeded so the "on my way" step stays optional. `provider-arrived` is
renamed `arrived` for consistency with `start-service`/`complete`, none of which repeat the actor
in the path.

On `POST /bookings/{id}/complete` the **order of evaluation is fixed and normative** (AC-9):
(1) session, (2) CSRF, (3) participant resolution + active-mode match, (4) `Idempotency-Key`
presence, (5) status must be `in_progress` **or already `completed`** (anything else →
`409 INVALID_STATUS_TRANSITION`), (6) the `MIN_IN_PROGRESS_SECONDS` dwell check, (7) the
completion-evidence gate, (8) *only then* the concurrency-safe conditional update. A request that
fails any of (1)–(7) is rejected on its own merits **even if** the other party's concurrent request
has already completed the booking. A request that passes all of (1)–(7) and then loses the
conditional update returns `200` with the already-completed booking.

### Authorization matrix (AC-1, AC-7, AC-8)

Every cell below is normative. "Ownership" is always resolved **server-side from
`session.userId`** — no route accepts a `customerProfileId` or `providerProfileId` from the client,
so none of these routes has an IDOR surface. `403 FORBIDDEN` means *authenticated but in the wrong
mode* and is the **only** `403` these routes emit besides `403 CSRF_TOKEN_INVALID`; every other
authorization failure is `404`, so a booking id cannot be probed by observing a different status
(spec 015/018/019's rule).

| Route | Session | Active mode | Ownership resolved by | Wrong mode | Not a participant | CSRF | `Idempotency-Key` |
|---|---|---|---|---|---|---|---|
| `POST /bookings` | required | `customer` | `offers → requests → customer_profiles.user_id = session.userId` | `403 FORBIDDEN` | `404 OFFER_NOT_FOUND` | required | **required** |
| `GET /bookings/{id}` | required | either | `bookings.customer_profile_id` **or** `bookings.provider_profile_id` maps to `session.userId` | — (either mode reads) | `404 BOOKING_NOT_FOUND` | n/a | n/a |
| `GET /bookings/{id}/status-history` | required | either | as above | — | `404 BOOKING_NOT_FOUND` | n/a | n/a |
| `GET /bookings` | required | `customer` **or** `provider` — the active mode *selects the role*, it is never inferred | the caller's own profile for that mode | — | returns an empty page, never another user's rows | n/a | n/a |
| `POST /bookings/{id}/provider-en-route` | required | `provider` + `requireOwnProviderProfile` | `bookings.provider_profile_id = ownProfile.id` | `403 FORBIDDEN` | `404 BOOKING_NOT_FOUND` | required | not required (naturally idempotent) |
| `POST /bookings/{id}/arrived` | required | `provider` + `requireOwnProviderProfile` | as above | `403 FORBIDDEN` | `404 BOOKING_NOT_FOUND` | required | not required |
| `POST /bookings/{id}/start-service` | required | `provider` + `requireOwnProviderProfile` | as above | `403 FORBIDDEN` | `404 BOOKING_NOT_FOUND` | required | not required |
| `POST /bookings/{id}/complete` | required | `customer` **or** `provider`, and the mode **must match the participant role the server resolved** | both profile columns are checked; the matching one fixes `actor_role` | `403 FORBIDDEN` | `404 BOOKING_NOT_FOUND` | required | **required** |

The `complete` row is the only asymmetry in this spec, and it is deliberate: AC-8 gives both parties
equal authority. The mode-must-match rule exists so that a user who happens to hold **both** a
customer and a provider profile on the same booking (possible in principle, since
`customer_profiles` and `provider_profiles` are independent rows on one `users` row) cannot produce
an ambiguous `actor_role`. It never *blocks* a legitimate party: the party simply has to be in their
own mode, which is the mode the UI already puts them in.

`requireActiveMode` (`lib/auth/require-mode.ts`, spec 006) only checks the mode; ownership is this
spec's own resource check on top, exactly as that module's doc comment requires.

### Creation, in evaluation order (AC-1, AC-3, AC-12)

`POST /api/v1/bookings` body: `{ offerId, scheduledAt? }`.

Outside the transaction (read-only, so a stranger never causes a lock):

1. `requireSession` → `requireCsrf` → `requireActiveMode(session, 'customer')`.
2. `checkRateLimit('bookings', session.userId)`.
3. `requireIdempotencyKey(request)`; validate the body shape (`offerId` a UUID, `scheduledAt` an
   ISO-8601 instant when present) → `400 VALIDATION_ERROR`.
4. Resolve `offerId` → its request → the request's `customer_profiles.user_id`. Not found, or not
   the caller's, or the offer is `draft` → `404 OFFER_NOT_FOUND` (never `403`, so offer ids cannot
   be probed) — the same rule `lib/offers/decide.ts` already applies.

Inside one transaction, taking locks in the repository's single global order
**`requests` → `offers` → `provider_profiles`** (spec 018's `decide.ts` already takes
`requests → offers`; spec 016's schedule writer takes `provider_profiles` alone, so this order
introduces no deadlock cycle):

5. `SELECT … FROM requests WHERE id = $requestId FOR UPDATE`.
6. `SELECT … FROM offers WHERE id = $offerId FOR UPDATE`.
7. **Idempotent replay.** If a `bookings` row already exists for
   `(customer_profile_id, idempotency_key)`: same fingerprint → return it (`200`); different
   fingerprint → `409 IDEMPOTENCY_KEY_CONFLICT`.
8. **One booking per offer.** Any existing booking for this `offer_id` with a *different*
   idempotency key → `409 BOOKING_ALREADY_EXISTS` with `details.bookingId`.
9. **Offer state.** `offers.status` must be exactly `accepted`. `revised` → `422
   OFFER_NOT_ACCEPTABLE` with `details.reason = 'superseded'`; `declined`/`withdrawn`/`expired` →
   `422 OFFER_NOT_ACCEPTABLE` naming the status; `sent`/`viewed` → `422 OFFER_NOT_ACCEPTABLE` with
   `reason = 'not_accepted'`. An `accepted` offer's `expires_at` is historical and is **not**
   re-checked — spec 018 §3 already settled that "spec 020 decides what an accepted offer permits".
10. **Request state.** `requests.status` must be `provider_selected`, else
    `422 REQUEST_NOT_ACTIONABLE` naming the status.
11. **Scheduled instant.** `scheduledAt` from the body when supplied, else
    `requests.preferred_at`. If both are absent → `400 VALIDATION_ERROR` on field `scheduledAt`
    ("is required because this request has no preferred time"; `requests.preferred_at` is nullable —
    spec 015 makes it optional). A `scheduledAt` already in the past (`clock_timestamp()`) →
    `422 SLOT_NO_LONGER_AVAILABLE` with `alternatives` computed exactly as in the conflict case.
    `scheduled_timezone` is the **provider's** `provider_profiles.scheduling_timezone` (spec 016
    R1), because every window, override and slot boundary the instant is validated against is
    expressed in that zone; `requests.preferred_timezone` remains the customer's stated zone and
    the two may legitimately differ.
12. **Duration.** `offers.estimated_duration_minutes` when non-null, else
    `provider_services.duration_minutes` for `(provider_profile_id, service_id)`, else `60` (that
    column's default). Fixed precedence, no other source.
13. **Slot.** `reserveProviderSlot(tx, { providerProfileId, serviceId, startAt, durationMinutes })`
    — spec 016's primitive, called **inside this transaction, before the insert**, while it holds
    the `provider_profiles` row lock. A thrown `409 SLOT_OVERLAP` is caught and re-thrown as this
    spec's customer-facing `422 SLOT_NO_LONGER_AVAILABLE`; spec 016's message is **not** forwarded,
    because it may name the conflicting interval's `sourceId`, which spec 016 §3 restricts to the
    owning provider.
14. **Price.** `price_amount_minor_units` / `price_currency_code` are copied **verbatim** from the
    accepted `offers` row. The client cannot supply, influence or override them; spec 019's
    immutability trigger already guarantees the source row cannot change under us, and §4's
    `bookings_terms_immutable_trg` guarantees the copy cannot change afterwards.
15. `INSERT INTO bookings (…) VALUES (…, 'pending', …)`, then `confirmBooking()` →
    `applyBookingTransition(tx, …, 'confirmed')` in the same transaction, writing two
    `bookings_status_history` rows (`null → pending` at creation, `pending → confirmed`),
    `actor_user_id = session.userId`, `actor_role = 'customer'`.
16. `UPDATE requests SET status = 'booking_created'` plus one `requests_status_history` row.
17. Commit. Response `201` with the `BookingDto`.

**Why `pending` then `confirmed` in one transaction.** `pending` is the state a booking occupies
while a confirmation gate is outstanding. This spec installs no gate, so the two steps commit
together and `POST /bookings` returns `confirmed`. **Spec 021** interposes its payment
authorization between steps 15a and 15b (its AC-1/AC-6: "no booking is confirmed on a failed
payment") and owns the `pending → failed` transition for a refused authorization. This spec ships
`confirmBooking()` as a separately exported step precisely so spec 021 can gate it without
changing this spec's transition graph, its routes, or its DTO.

### Slot-conflict alternatives (AC-2) — DECIDED

The draft left this Open. It is decided here, using only mechanisms that exist in this repository
today; **spec 017's matching is not re-run**, no new matching, re-offer, reschedule or
propose-time feature is invented, and no other provider appears in the response.

- **Source.** Spec 016's existing, pure slot machinery — `findProviderSchedulingProfile`,
  `loadWeeklyEntries`, `loadOverrides`, `loadServiceBuffers` (`lib/availability/repository.ts`),
  `resolveWindowsForDate` (`resolve.ts`), `findConflictingInterval` (`slots.ts`) — driven through
  the **same registered `BusyIntervalLoader`** this spec registers, so alternatives and reservations
  can never disagree. No new availability query is written.
- **Candidate set.** The **same provider**, the **same service**, the **same duration**, and the
  **same local time-of-day** as the failed attempt, on each subsequent local calendar date, scanned
  forward from the failed attempt's local date over `ALTERNATIVE_LOOKAHEAD_DAYS = 14` days. A
  candidate qualifies only when the whole `[start, start + duration)` interval falls inside a
  resolved window for that date and collides with no buffer-widened busy interval — spec 016 R7/R8,
  unchanged.
- **Ordering.** Strictly ascending by start instant. Deterministic: the same stored schedule,
  overrides and bookings always produce the same list, in the same order.
- **Limit.** At most **3**. Fewer when fewer qualify; `[]` when none do.
- **Shape.** Each entry is `{ startAt, scheduledTimezone, localDate, localTimeOfDay }` — a value
  the customer can submit unchanged as `scheduledAt` on a retry.
- **Fallback.** When `alternatives` is `[]`, `details.nextAvailableDate` carries
  `getAvailabilitySummary(providerProfileId).nextAvailableDate` — spec 016's existing public,
  coarse, non-owner-safe field. The error is still `422 SLOT_NO_LONGER_AVAILABLE` with a full
  `details` object; never an empty body, never a silent failure.
- **Where it runs.** **After** the transaction has rolled back, as a read-only computation. It
  never runs while a lock is held, so a conflicted attempt cannot extend the provider lock or
  serialize behind itself.
- **Privacy (spec 016 §3 "Public vs owner-only information").** Spec 016 restricts what a *non-owner
  may browse*: `GET /providers/{id}/availability` is the only availability **endpoint** open to a
  non-owner, and it returns a coarse summary. This response is not a browsing surface. It is
  returned only to the **customer of an accepted offer with this provider** — a committed
  counterparty — only on a failed booking attempt they themselves made, and it discloses at most 3
  instants, each of which is *the customer's own requested time-of-day* on a later date. It reveals
  nothing the customer could not already learn by repeating at most 14 booking attempts, and it
  reveals **no** weekly row, override row, window boundary, buffer, booking id, booking count or
  service area. It is a bounded, compressed form of information the customer can already obtain,
  not a new disclosure channel. The `bookings` rate-limit domain (30/60s) bounds the probing rate;
  the 14-day horizon and the 3-entry cap bound the disclosure per call.
- **When no alternatives exist.** `alternatives: []`, `nextAvailableDate` set when spec 016 can find
  one within its own 30-day lookahead and `null` otherwise, and the same `422
  SLOT_NO_LONGER_AVAILABLE` code. The UI then shows the date as plain text with no retry
  affordance (§5). The booking is **not** created, the offer is **not** released, the request is
  **not** moved, and no row anywhere is written — the customer's position is exactly as it was
  before the attempt, which is what makes an unlimited number of retries safe.
- **Are existing open offers surfaced? No.** `offers_request_accepted_uq` (a partial unique index on
  `status = 'accepted'`) plus `requestAlreadyClaimedError` in `lib/offers/decide.ts` make a second
  accept impossible while one offer on the request is `accepted`, and the request has already left
  `offers_open`. Those offers are therefore **not actionable**; presenting them would be a dead end
  that invites a click ending in `409 REQUEST_ALREADY_CLAIMED`. Releasing the accepted offer so they
  become actionable again is a cancellation, which is **spec 023's**, not this spec's.
- **Is re-matching allowed? No.** Spec 017's distribution runs on a request in `submitted`/`matching`.
  This request is `provider_selected`. Re-running matching would require unwinding the accept —
  spec 018's single-accept invariant — and would contradict spec 019 §8 #4, which already records
  that "spec 020 revalidates availability at booking" as the agreed answer to stale availability.
  No matching module is imported by `lib/bookings/**`.
- **Deliberately not chosen.** *A general slot picker for customers* — that is a browsing surface and
  would contradict spec 016's public/owner-only rule. *A "notify me" hook on the conflicted slot* —
  spec 016 AC-6's `availability-notify` opt-in exists, but it is keyed on the provider being
  `unavailable` and rejects an `available` provider with `422
  AVAILABILITY_NOTIFY_NOT_APPLICABLE`; reusing it here would mean changing spec 016's AC-6, so it is
  not used.

### Lifecycle transitions (AC-4, AC-6, AC-7, AC-11)

All of `lib/bookings/state-machine.ts`:

```typescript
export const BOOKING_STATUSES = [
  'pending', 'confirmed', 'provider_en_route', 'arrived', 'in_progress',
  'completed', 'protected', 'settled', 'cancelled', 'disputed', 'refunded', 'failed',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type BookingActorRole = 'customer' | 'provider' | 'system';

/** AC-11's constants — exported, so a later spec tunes a value without touching the graph. */
export const MIN_IN_PROGRESS_SECONDS = 60;
export const EARLY_START_GRACE_MINUTES = 60;

/**
 * The ONE way any spec changes `bookings.status`. Conditional on `(status, version)`, so a
 * concurrent writer is detected rather than overwritten; writes exactly one
 * `bookings_status_history` row per successful transition. Spec 021 calls this for
 * `completed -> protected` and `protected -> settled`; nothing writes `bookings.status` directly.
 */
export async function applyBookingTransition(
  tx: Tx,
  params: {
    bookingId: string;
    from: BookingStatus;
    to: BookingStatus;
    actorRole: BookingActorRole;
    /** null only for `actorRole: 'system'`. */
    actorUserId: string | null;
    expectedVersion: number;
  },
): Promise<{ applied: boolean; currentStatus: BookingStatus; currentVersion: number }>;
```

Seeded transition graph — **only** the transitions this spec performs, exactly the discipline
specs 011/013/014/015 used for `requests_status_transitions` and spec 018 for
`offers_status_transitions`, so an unimplemented transition fails loudly at the database rather
than silently corrupting state:

```
pending           -> confirmed
confirmed         -> provider_en_route
confirmed         -> arrived           (the "on my way" step is optional)
provider_en_route -> arrived
arrived           -> in_progress
in_progress       -> completed
```

**The complete transition matrix, with exactly one owner per row.** This is the authoritative list;
a transition absent from it exists nowhere and is rejected by the database trigger. "Writes" means
*seeds the `bookings_status_transitions` row **and** performs the write through
`applyBookingTransition()`*; the two always travel together, so there is no transition whose
whitelist and whose caller belong to different specs.

| From | To | Writes | Trigger / actor | Seeded in |
|---|---|---|---|---|
| *(insert)* | `pending` | **020** | customer, `POST /bookings` | n/a — an INSERT, not a transition |
| `pending` | `confirmed` | **020** | `confirmBooking()` in the creation transaction; customer | `0016` |
| `pending` | `failed` | **021** | payment authorization refused (its AC-6) | spec 021's migration |
| `confirmed` | `provider_en_route` | **020** | provider, `POST /provider-en-route` | `0016` |
| `confirmed` | `arrived` | **020** | provider, `POST /arrived` (the en-route step is optional) | `0016` |
| `provider_en_route` | `arrived` | **020** | provider, `POST /arrived` | `0016` |
| `arrived` | `in_progress` | **020** | provider, `POST /start-service` | `0016` |
| `in_progress` | `completed` | **020** | customer **or** provider, `POST /complete` (AC-8) | `0016` |
| `completed` | `protected` | **021** | payment protection window opens (its AC-5a) | spec 021's migration |
| `protected` | `settled` | **021** | protection released, payout eligible (its AC-5b) | spec 021's migration |
| any active → | `cancelled` | **023** | cancellation / no-show | spec 023's migration |
| any → | `disputed` | **031** | a party explicitly opens a dispute (never automatic — AC-10) | spec 031's migration |
| any → | `refunded` | **022** | refund completed | spec 022's migration |

Every pair **not** in this matrix is invalid, including every pair out of `completed` that spec 020
might be tempted to add: `completed` has **no** outgoing transition owned by this spec. There is no
un-complete, no re-open, and no reversal path here; redress is spec 031's.

Not seeded here, and why: `completed → protected` and `protected → settled` (spec 021), `→ failed`
(spec 021), `→ cancelled` (spec 023), `→ disputed` (spec 031), `→ refunded` (spec 022). Each owning
spec seeds its own rows in its own migration and performs them through `applyBookingTransition()`.

Each transition route: resolve the booking and the caller's participation → `404 BOOKING_NOT_FOUND`
if not a participant; if the booking is **already** in the target status, return `200` with the
current booking (natural idempotency, so a double-tap is never an error); otherwise call
`applyBookingTransition`. An `applied: false` caused by a status mismatch is
`409 INVALID_STATUS_TRANSITION` with `details.currentStatus`; caused by a version mismatch it is
`409 CONFLICT` with `details.currentVersion`. The database trigger raising `SQLSTATE 23514` from
`enforce_status_transition()` maps to the same `409 INVALID_STATUS_TRANSITION` — it is the
independent second line of defence AC-6 requires, not the primary check.

**AC-7 in concrete terms.** This spec ships no cron route, no sweep, no scheduler and no webhook.
Every one of the six seeded transitions is reachable only from an authenticated participant's
`POST`. `actor_role: 'system'` exists in the history vocabulary solely so spec 021 can attribute
`protected`/`settled`; no spec 020 call site passes it.

### Unilateral-completion safeguards (AC-8, AC-9, AC-11) — DECIDED

AC-8 stands exactly as approved: either party may complete an `in_progress` booking without the
other's confirmation. The draft's Open Question was what stops that becoming an unrestricted
shortcut. Decided: the following safeguards, **all** enforceable and testable inside the booking
state machine, and **none** of them payment, fraud-scoring, cancellation or dispute machinery
(specs 021/023/031/038 own those and none of them is invoked here):

- **S1 — Only from `in_progress`.** `completed` is reachable from `in_progress` alone. A booking
  cannot jump from `confirmed` or `arrived`; the database trigger enforces it independently (AC-6).
- **S2 — Participant + matching active mode.** The caller must be the booking's customer or its
  provider, in that party's active mode; the resolved role is what gets recorded, so attribution is
  never ambiguous (§3 "Active mode").
- **S3 — Minimum in-progress dwell.** Rejected `422 COMPLETION_TOO_EARLY` until
  `MIN_IN_PROGRESS_SECONDS = 60` of **database** time have elapsed since the `arrived →
  in_progress` history row's `occurred_at`, evaluated as
  `clock_timestamp() - occurred_at >= interval '60 seconds'` in a statement issued after the row
  lock — never from a client clock, never from `now()`. `details.retryAfterSeconds` is the
  remaining whole seconds. 60 seconds sits below any real service duration
  (`provider_services.duration_minutes` defaults to 60 *minutes*), so it blocks only the
  start-then-immediately-complete shortcut and never a genuine short job.
- **S4 — No pre-emptive start.** `confirmed → provider_en_route` and `confirmed → arrived` are
  rejected `422 BOOKING_NOT_STARTABLE_YET` while `clock_timestamp() < scheduled_at −
  EARLY_START_GRACE_MINUTES (60)`, with `details.startableFrom`. Combined with S1 and S3, the
  earliest a booking can possibly reach `completed` is one hour before its scheduled time plus 60
  seconds — so a booking confirmed for next week cannot be run to `completed` seconds after
  creation. This is a *refusal to advance*, never a signal *forcing* an advance, so it is
  consistent with AC-7.
- **S5 — Symmetric evidence gate.** AC-5's gate is consulted identically for both parties; a
  customer cannot bypass a requirement the provider would face, or vice versa.
- **S6 — Mandatory, append-only attribution.** Every completion writes one
  `bookings_status_history` row carrying `actor_user_id` and `actor_role`. This spec exposes no
  UPDATE or DELETE path for history rows (§4), so "who completed this, and when" is always
  provable — which is both the deterrent and the input spec 031 needs.
- **S7 — Completion is never silent.** The completion and its actor are immediately readable by the
  other party through `GET /bookings/{id}` and `GET /bookings/{id}/status-history`; spec 026
  delivers the notification. A party can therefore always see a premature completion and act on it.
- **S8 — Terminal within this spec.** No transition out of `completed` is seeded here, so a
  premature completion cannot be quietly reversed or re-driven by whoever made it; redress is spec
  031's explicit, user-initiated dispute (AC-10), and no dispute is ever auto-created.
- **S9 — Standard write protections.** CSRF, the `bookings` rate-limit domain, and a required
  `Idempotency-Key`, so a retried completion is a replay rather than a second attribution.

**Service-execution preconditions that already exist.** There are none beyond the state machine
itself. `booking_milestones` is an empty spec 003 skeleton that this spec neither reads nor writes;
`services.completion_evidence_required` does not exist (spec 028 adds it); there is no arrival
verification, geofence or timer anywhere in `lib/`. So S1 (must be `in_progress`), S3 (dwell) and S4
(no pre-emptive start) *are* the execution preconditions this architecture can express today, and
this spec deliberately invents no other. Spec 028 may add more through the evidence gate without any
change here.

### Concurrency rules (AC-3, AC-9, AC-12)

Consolidated, because four different races touch this spec and each is closed by a different,
already-proven mechanism. No new primitive is introduced.

| Race | Mechanism | Outcome |
|---|---|---|
| Two creations for the **same offer**, different keys | `SELECT … FOR UPDATE` on `requests` then `offers` (step 5–6) + step 8's check + `bookings_offer_id_uq` | one `201`; the other `409 BOOKING_ALREADY_EXISTS` |
| Two creations with the **same key and body** | the same locks + step 7's replay check + `bookings_customer_idempotency_key_uq` | one `201`, one `200`, one row (AC-3) |
| Two creations with the **same key, different bodies** | step 7's fingerprint comparison under the lock | one `201`; the other `409 IDEMPOTENCY_KEY_CONFLICT`, writing nothing |
| Two creations for **overlapping time, same provider**, different offers/requests | spec 016 `reserveProviderSlot()`'s `FOR UPDATE` on `provider_profiles`, taken inside the writing transaction **before** the insert | one `201`; the other `422 SLOT_NO_LONGER_AVAILABLE` (AC-12) |
| Creation racing a provider **schedule edit** that would strand it | the same provider row lock, from the other side — spec 016's schedule writer already takes it | whichever commits first wins; the loser sees `409 SLOT_OVERLAP` (provider side) or `422 SLOT_NO_LONGER_AVAILABLE` (customer side) |
| Customer and provider **completing simultaneously** | the conditional update below | exactly one transition, one history row; the loser gets `200` (AC-9) |
| Any transition racing another transition on the same booking | `applyBookingTransition`'s `(status, version)` predicate | the loser gets `409 CONFLICT` with `details.currentVersion` |

**Lock order is fixed repository-wide: `requests` → `offers` → `provider_profiles`.** Spec 018's
`lib/offers/decide.ts` already takes `requests → offers` in that order and spec 016's schedule
writer takes `provider_profiles` alone, so adding this spec introduces no cycle and therefore no
deadlock. Any future spec touching two of these must use the same order.

**Completion (AC-9) in detail.** After checks (1)–(7) pass, the transition is the conditional update
`WHERE id = $id AND status = 'in_progress' AND version = $expectedVersion`, performed by
`applyBookingTransition`. Of two near-simultaneous *valid* completions exactly one matches; the loser
re-reads, finds `completed`, and returns `200` with that booking. Exactly one history row exists, so
"who completed it" is unambiguous even under the race. No new column or mechanism is needed beyond
`bookings.version`, which spec 003's `baseColumns()` already provides. Crucially, the checks run
**before** the update, so a caller who fails authorization, the dwell rule or the evidence gate is
rejected on its own merits regardless of what the other party's concurrent request did — losing the
race is an idempotent success only for a request that would otherwise have succeeded.

**Timing is always the database clock.** Every dwell, early-start and past-instant comparison reads
`clock_timestamp()` in a statement issued **after** the relevant row lock is held — never `now()`,
which is frozen at transaction start, and never a client timestamp. This is the rule spec 018
established for offer expiry and it applies unchanged here: a transaction that waited on a lock past
a threshold must observe the time *after* the wait.

### Completion-evidence gate (AC-5) — boundary with specs 027/028

Spec 028 owns the *requirement* (`services.completion_evidence_required`, its §4) and spec 027 owns
evidence *storage*. Neither exists yet, and this spec must not pre-empt either. It therefore ships
the **gate**, not the requirement — the same port-with-inert-default idiom spec 016 used for
`BusyIntervalLoader` and spec 012 for `service-area-check`:

```typescript
// lib/bookings/completion-evidence.ts
export interface CompletionEvidenceStatus { required: boolean; satisfied: boolean }
export type CompletionEvidenceGate =
  (tx: Tx, bookingId: string) => Promise<CompletionEvidenceStatus>;

/** The shipped default: nothing requires evidence, because no spec has defined a requirement yet. */
export function registerCompletionEvidenceGate(gate: CompletionEvidenceGate): void;
export function resetCompletionEvidenceGate(): void;
```

`POST /bookings/{id}/complete` consults the gate for **both** parties identically and rejects
`422 COMPLETION_EVIDENCE_REQUIRED` when `required && !satisfied`. With the default gate, completion
always succeeds without evidence — which is *correct, not a stub*: no service can require evidence
until spec 028 adds the column. Spec 028 registers the real gate and extends the request body with
`evidenceFileAssetIds`; **this spec's body accepts no evidence field**, because accepting one it
could not store would be a promise it cannot keep. Both branches of AC-5 are fully testable here by
registering a test gate.

### Payment boundary (Open Question 2) — DECIDED

The draft recorded this as Open with a recommendation. It is decided, and stated so that spec 020
and spec 021 **cannot** conflict:

| | Spec 020 | Spec 021 |
|---|---|---|
| The status names `protected`, `settled` exist in `bookings_status_ck` | **owns** (one author for the whole vocabulary) | reads |
| `bookings_status_transitions` rows `completed→protected`, `protected→settled` | does **not** seed | **seeds**, in its own migration |
| Deciding *when* those transitions fire | **never** | **owns** — its AC-5a/5b/5c: window start at `Completed`, release, dispute hold |
| Performing the write | provides `applyBookingTransition()` | **calls** it with `actorRole: 'system'`; never writes `bookings.status` with its own SQL |
| An API route or UI action reaching `protected`/`settled` | **none exists** | owns any it needs |
| Payment authorization/capture, protection window, payout eligibility | **none** — reaching `completed` triggers nothing | **owns entirely** |
| `pending → confirmed` | performs it (`confirmBooking()`), exported as a separate step | may gate it; owns `pending → failed` and seeds that row |
| `bookings.price_amount_minor_units` / `price_currency_code` | **owns**; immutable after insert (§4) | never rewrites them — a price adjustment is spec 021's own entity, not an edit to the agreed booking price |

Consequences, stated as invariants an implementation review can check: **no** file under
`lib/bookings/**` or `app/api/v1/bookings/**` in this spec contains the strings `protected` or
`settled` outside `BOOKING_STATUSES` and the CHECK constraint; **no** spec 020 test asserts a
booking ever reaches them; and spec 021 adds **no** status name to the vocabulary.

**What spec 020 may read from the payment side: nothing.** `lib/bookings/**` and
`app/api/v1/bookings/**` contain no reference to `payments`, `payouts`, `PaymentDto`,
`protectionState` or any spec 021 module. `BookingDto` exposes no payment field. The dependency is
strictly one-directional — spec 021 reads booking status, spec 020 never reads payment status —
which is what makes "no competing ownership" structurally true rather than a convention. If a
booking screen needs to show payment state, it composes two reads at the UI or route layer in
**spec 021's** code, not inside this spec's modules.

**When payment state and booking state are temporarily out of sync.** They will be, routinely: the
two are separate rows written in separate transactions, and spec 021's provider calls and webhooks
are asynchronous. This spec's rule is that **booking status is never repaired from payment state,
and payment state is never inferred from booking status**:

- **Booking status is authoritative for the state machine.** `applyBookingTransition()` validates
  only `(from, to, version)` against the seeded graph. It never consults a payment row, so a lagging,
  failed or missing payment can never block, force or silently alter a spec 020 transition. A booking
  in `in_progress` can be completed whether or not any payment row exists.
- **Payment status is authoritative for money.** Whether funds are held, released or owed is read
  from spec 021's own entity, never derived from `bookings.status`. A booking that has reached
  `completed` but whose protection window has not yet opened is simply `completed` — not "protected
  pending", not an error state, and not something this spec models.
- **`completed` is a fact, not a promise about money.** It records that a participant marked the work
  done. Spec 021 consumes that fact as *its* trigger (its AC-5a) and may act on it seconds or minutes
  later. The lag is expected and is not an inconsistency to reconcile here.
- **Reconciliation, retries and alerting for a payment that never advances a booking out of
  `completed` are spec 021's**, because the retry semantics belong to whoever owns the external
  call. This spec ships no reconciler, no sweep and no cron (AC-7), so it cannot and does not attempt
  to repair the gap.
- **The one hard invariant across the boundary:** a booking can occupy `protected` or `settled` only
  because spec 021 wrote it there. If those statuses ever appear on a booking with no corresponding
  payment record, the defect is in spec 021, and this spec's data model gives it no other way in —
  `bookings_status_transitions` simply has no row spec 020 could use.

### Request and response types

```typescript
// lib/types/bookings.ts  (this repository has no packages/types)
import type { BookingStatus } from '@/lib/bookings/state-machine';

export interface CreateBookingRequest {
  offerId: string;
  /**
   * ISO-8601 instant. Optional: defaults to the request's `preferredAt`. Required (400) when the
   * request has none. Also how a customer retries with one of AC-2's returned alternatives.
   */
  scheduledAt?: string;
}

export interface BookingDto {
  id: string;
  requestId: string;
  offerId: string;
  serviceId: string;
  /** Profile ids, not user ids — the same identifiers specs 015–019 already expose. */
  customerProfileId: string;
  providerProfileId: string;
  status: BookingStatus;
  /** UTC instant, paired with the IANA zone it was scheduled in (spec 003 AC-2). */
  scheduledAt: string;
  scheduledTimezone: string;
  durationMinutes: number;
  priceAmountMinorUnits: number;
  currencyCode: string;
  /** The operational address, revealed to each party under spec 012's rules. */
  addressId: string;
  createdAt: string;
  updatedAt: string;
  /** Optimistic-concurrency token; send it back as `expectedVersion` where a route accepts one. */
  version: number;
}

export type BookingListFilter = 'upcoming' | 'active' | 'completed' | 'cancelled' | 'disputed';

export interface BookingSummaryDto {
  id: string;
  status: BookingStatus;
  scheduledAt: string;
  scheduledTimezone: string;
  serviceName: string;
  /** The *counterparty's* display name for the caller's role. Never a user id. */
  counterpartyName: string | null;
  priceAmountMinorUnits: number;
  currencyCode: string;
}

export interface BookingStatusHistoryDto {
  fromStatus: BookingStatus | null;
  toStatus: BookingStatus;
  /** 'system' only for spec 021's payment-driven transitions. */
  actorRole: 'customer' | 'provider' | 'system';
  occurredAt: string;
}

/** `details` of `422 SLOT_NO_LONGER_AVAILABLE` (AC-2). */
export interface SlotAlternativeDto {
  startAt: string;
  scheduledTimezone: string;
  localDate: string;      // YYYY-MM-DD in `scheduledTimezone`
  localTimeOfDay: string; // HH:MM — always the customer's own requested time-of-day
}

export interface SlotUnavailableDetails {
  requestedStartAt: string;
  durationMinutes: number;
  scheduledTimezone: string;
  /** 0–3, earliest first. */
  alternatives: SlotAlternativeDto[];
  /** Spec 016's coarse public field; the fallback when `alternatives` is empty. */
  nextAvailableDate: string | null;
}
```

`BookingDto` deliberately carries **no** "who completed this booking" field. That fact already lives
in the `bookings_status_history` row for the `in_progress → completed` transition (`actor_user_id` /
`actor_role`) — the same record every other transition is tracked by — and is read through
`GET /bookings/{id}/status-history`, so AC-8/AC-10's "who performed it" needs no new column and
cannot drift from the audit trail.

### Error codes

Extends spec 004's `API_ERROR_CODES` table in the established SCREAMING_SNAKE_CASE + stability way.
None of these is in the shared baseline map, so each passes `options.status` explicitly — exactly as
spec 005's `MFA_REQUIRED`, spec 016's `SLOT_OVERLAP` and spec 018's `OFFER_EXPIRED` do. All live in
`lib/bookings/errors.ts`.

| HTTP | `code` | When | `details` |
|---|---|---|---|
| `422` | `SLOT_NO_LONGER_AVAILABLE` | step 13's revalidation fails, or the scheduled instant is already past | `SlotUnavailableDetails` (AC-2) |
| `422` | `OFFER_NOT_ACCEPTABLE` | the offer is not `accepted` — superseded, withdrawn, declined, expired, or never accepted | `{ reason, status }` |
| `422` | `REQUEST_NOT_ACTIONABLE` | the request is not `provider_selected` (reuses spec 018's code and meaning) | `{ status }` |
| `409` | `BOOKING_ALREADY_EXISTS` | a booking already exists for this offer under a different idempotency key | `{ bookingId }` |
| `409` | `INVALID_STATUS_TRANSITION` | out-of-graph status change, in application code or mapped from the trigger's `23514` | `{ currentStatus }` |
| `409` | `CONFLICT` | stale `expectedVersion` (spec 003 AC-6) | `{ currentVersion }` |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | same key, different body (reuses spec 015's code) | — |
| `422` | `COMPLETION_EVIDENCE_REQUIRED` | the gate reports `required && !satisfied` | — |
| `422` | `COMPLETION_TOO_EARLY` | S3's dwell check (AC-11) | `{ retryAfterSeconds }` |
| `422` | `BOOKING_NOT_STARTABLE_YET` | S4's early-start guard (AC-11) | `{ startableFrom }` |
| `404` | `BOOKING_NOT_FOUND` | no such booking, or the caller is not a participant | — |
| `404` | `OFFER_NOT_FOUND` | no such offer, or not the caller's (reuses spec 018's code) | — |

Spec 016's `409 SLOT_OVERLAP` is **not** surfaced by any route in this spec: it is the
primitive-level failure, caught inside step 13 and re-thrown as `422 SLOT_NO_LONGER_AVAILABLE` —
precisely the arrangement spec 016 §3 "Interface with spec 020" describes. Its message is dropped
rather than forwarded, because it can name a busy interval's `sourceId`.

### MCP implications (master spec §115, §127; spec 036)

Spec 036 is **not built** — there is no `lib/mcp` in this repository — so this spec ships no tool and
writes no MCP test. But master spec §115 names "repeated booking tool call cannot create two
bookings" as a critical example, and spec 036's catalog already lists `create_booking`, `get_booking`,
`mark_provider_arrived`, `start_service` and `complete_service`. That imposes two **structural**
requirements on this spec's implementation, both of which it already satisfies and both of which an
implementation review must check:

1. **Every guarantee lives in `lib/bookings/*`, not in the route handler.** Authorization,
   revalidation, idempotency, the dwell and early-start guards, the evidence gate and the transition
   primitive are all domain functions; `app/api/v1/bookings/**/route.ts` only wires session, CSRF,
   mode, rate limiting and the envelope. Spec 036 then calls the same functions and inherits the
   guarantees instead of reimplementing them — the arrangement spec 019 §7 already requires of
   `send_provider_message` and `request_offer_change`.
2. **Idempotency is enforced at the database, not per transport.** `bookings_customer_idempotency_key_uq`
   and `bookings_offer_id_uq` are columns and indexes, so a duplicate MCP tool call collides with a
   duplicate HTTP call on exactly the same constraint. AC-3 is therefore satisfied for the tool path
   by construction, which is precisely what master spec §115's critical example requires.

One requirement flows the other way and is **recorded here for spec 036, not applied to it**: spec
036's draft `createBookingSchema` is `{ offerId, idempotencyKey }`, which cannot express AC-2's
retry with a chosen alternative. Spec 036 will need an optional `scheduledAt`, exactly as
`CreateBookingRequest` has. This spec does not edit spec 036.

### Notification boundary (AC-4, AC-8; spec 026)

This spec writes **no** `notifications` row and sends nothing — the same boundary spec 016 §7
(`lib/availability/notify.ts` records the opt-in and explicitly leaves delivery to spec 026) and
spec 018 §7 already draw. What it guarantees instead is that every fact a notification would carry
is durably recorded and readable the moment the transition commits:

- one `bookings_status_history` row per transition, carrying `from_status`, `to_status`,
  `actor_user_id`, `actor_role` and `occurred_at`;
- both participants can read it through `GET /bookings/{id}` and `GET /bookings/{id}/status-history`;
- the structured `booking.transition` log event (§9) carries the same fields.

Spec 026 consumes those records to deliver the customer's arrival/start updates (AC-4) and the
completion notice naming the acting party (AC-8). Until spec 026 ships, the UI's polling (§5) is how
both parties see the change — so AC-4 and AC-8 are satisfiable and testable today without
pre-empting spec 026.

### Breaking-change check

- [x] N/A — new routes and additive columns only; no existing route, DTO field or error code changes
  meaning. `lib/availability/busy-intervals.ts`'s default loader is *replaced at runtime* by
  registration, which is the extension point that module was written for.

---

## 4. Data model changes

### Entities

**These tables are not new.** `bookings`, `booking_milestones`, `bookings_status_history` and
`bookings_status_transitions` are **spec 003 baseline tables** (`drizzle/0001_baseline_schema.sql`,
`lib/db/schema.ts`), deliberately left minimal "pending its owning spec" (spec 003 AC-4). This spec
is that owning spec and adds feature columns to `bookings` only. The draft's claim that all three
were `new`, and its `BookingStatusHistory` / `BookingMilestone` entity names, were both wrong: the
real table names are snake_case plural — `bookings_status_history`, `booking_milestones`.

| Entity | Change | Fields |
|---|---|---|
| `bookings` | **extend** (baseline: `id`, `created_at`, `updated_at`, `version`, `offer_id`, `status text`) | add `request_id uuid not null fk->requests`, `service_id uuid not null fk->services`, `customer_profile_id uuid not null fk->customer_profiles`, `provider_profile_id uuid not null fk->provider_profiles`, `address_id uuid not null fk->addresses`, `scheduled_at timestamptz not null` + `scheduled_timezone text not null` (`scheduledTimeColumns('scheduled')`), `duration_minutes integer not null`, `price_amount_minor_units` + `price_currency_code` (`moneyColumns('price')`, both not null), `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `bookings_status_history` | **reuse** (baseline already has `booking_id`, `from_status`, `to_status`, `actor_user_id`, `occurred_at` + indexes) | add **one** column: `actor_role text not null` — needed because `actor_user_id` is nullable for spec 021's system transitions, and because a user who is both customer and provider would otherwise be unattributable |
| `booking_milestones` | **untouched** | stays the spec 003 skeleton; milestone content is **spec 028's** (its §4 says so). This spec adds no column and writes no row |
| `bookings_status_transitions` | **seed only** | the six rows in §3. No column change |
| `requests_status_transitions` | **seed only** | one row: `('provider_selected', 'booking_created')` — spec 018 §7 explicitly left it to this spec |
| `services`, `provider_services`, `offers`, `requests`, `addresses` | **untouched** | read-only here |

Constraints and indexes added to `bookings`:

- `check bookings_status_ck: status in ('pending','confirmed','provider_en_route','arrived','in_progress','completed','protected','settled','cancelled','disputed','refunded','failed')` — the whole vocabulary, authored once here. It matches, and makes authoritative, the provisional list spec 008 already encodes in `lib/privacy/booking-lifecycle-adapter.ts`; its `PROVISIONAL_RESOLVED_BOOKING_STATUSES` (`completed`, `settled`, `cancelled`, `refunded`, `failed`) is already correct against this vocabulary, so only its TYPE changes — from `string[]` to `BookingStatus[]`, which is the single-file change that module's own doc comment anticipates and which makes a future status rename fail at compile time rather than silently.
- `...moneyPairChecks('bookings', 'price')` and `check bookings_price_positive_ck: price_amount_minor_units > 0`.
- `check bookings_duration_positive_ck: duration_minutes between 1 and 1440` — the same bound `offers_estimated_duration_ck` uses.
- `unique index bookings_offer_id_uq on (offer_id)` — **replaces** the baseline's non-unique `bookings_offer_id_idx`. This is the database's independent guarantee of one booking per offer (AC-12), beyond the idempotency key and the application check.
- `unique index bookings_customer_idempotency_key_uq on (customer_profile_id, idempotency_key)` — scoped per customer, exactly as `requests_customer_idempotency_key_uq` and `offers_provider_idempotency_key_uq` are.
- One covering index per new FK (spec 003 AC-4): `request_id`, `service_id`, `customer_profile_id`, `provider_profile_id`, `address_id`.
- `index bookings_provider_scheduled_at_idx on (provider_profile_id, scheduled_at)` — the index the `BusyIntervalLoader` reads on every reservation and every alternatives computation.
- `index bookings_status_idx on (status)` and `index bookings_customer_scheduled_at_idx on (customer_profile_id, scheduled_at)` for the list endpoint's filters.
- `check bookings_status_history_actor_role_ck: actor_role in ('customer','provider','system')` and `check bookings_status_history_actor_pairing_ck: (actor_user_id is null) = (actor_role = 'system')`.

**Terms immutability.** A hand-appended trigger `bookings_terms_immutable_trg` — the same technique
spec 003 used for `enforce_status_transition()` and spec 019 for offer-terms immutability, since
Drizzle's DSL has no trigger builder — rejects any `UPDATE` that changes `offer_id`, `request_id`,
`customer_profile_id`, `provider_profile_id`, `service_id`, `address_id`, `scheduled_at`,
`scheduled_timezone`, `duration_minutes`, `price_amount_minor_units`, `price_currency_code`,
`idempotency_key` or `idempotency_fingerprint`. The agreed price and time are then unchangeable by
*any* code path, including a later spec's — which is what makes "the price authority is the accepted
offer row" (AC-1) enforceable rather than a convention. Rescheduling, if a later spec wants it, must
amend this trigger explicitly in that spec's own migration.

`bookings_status_history` is **append-only** in this spec (S6): no route, module or migration here
issues `UPDATE` or `DELETE` against it, and spec 008's deletion path must not either
(§ "Retention and privacy").

**`jsonb`:** none added — so no entry in `lib/db/schema-lint.test.ts`'s reviewed-exception allowlist
is needed.

### Database invariants

Enumerated so an implementation review can check each one, and so each has a named test. Every
invariant holds **even if application code is bypassed**, which is the point: the application checks
are the friendly error, the database is the guarantee.

| # | Invariant | Enforced by |
|---|---|---|
| I-1 | A booking's status is always one of the twelve vocabulary values | `bookings_status_ck` |
| I-2 | A status may change only along a seeded `(from_status, to_status)` pair | spec 003's `bookings_status_transition_trg` + `bookings_status_transitions` |
| I-3 | At most one booking exists per offer | `bookings_offer_id_uq` |
| I-4 | At most one booking exists per `(customer_profile_id, idempotency_key)` | `bookings_customer_idempotency_key_uq` |
| I-5 | Price is positive and its amount/currency are set or null together | `bookings_price_positive_ck`, `moneyPairChecks('bookings','price')` |
| I-6 | Duration is 1–1440 minutes | `bookings_duration_positive_ck` |
| I-7 | The agreed terms (offer, participants, service, address, schedule, duration, price, idempotency) never change after insert | `bookings_terms_immutable_trg` |
| I-8 | A history row's actor is a real user unless the actor is the system | `bookings_status_history_actor_pairing_ck` |
| I-9 | A history actor role is one of customer/provider/system | `bookings_status_history_actor_role_ck` |
| I-10 | No booking row is ever deleted; every FK into it is `onDelete: 'restrict'` | spec 003's baseline FK convention, unchanged |
| I-11 | Two bookings for one provider never occupy overlapping buffered time | `reserveProviderSlot()`'s provider row lock inside the writing transaction (spec 016 AC-2). **Application-level, not a constraint** — see §8 risk #5 for why an `EXCLUDE USING gist` constraint is declined |

I-11 is the one invariant the database does not enforce by itself, and it is called out here rather
than glossed: the guarantee comes from the lock, and `lib/bookings/create-race.integration.test.ts`
proves it across two real connections, which is the same standard
`lib/availability/reserve.integration.test.ts` and `lib/offers/accept-race.integration.test.ts`
already hold.

### Busy-interval loader (the spec 016 contract)

`lib/bookings/busy-intervals.ts` exports the loader and registers it at module load through
`registerBusyIntervalLoader()` (`lib/availability/busy-intervals.ts`), imported once from the
`lib/bookings` barrel so both routes and tests get a live port:

```sql
SELECT b.scheduled_at                                             AS start_at,
       b.scheduled_at + make_interval(mins => b.duration_minutes) AS end_at,
       b.service_id,
       b.id                                                       AS source_id
  FROM bookings b
 WHERE b.provider_profile_id = $1
   AND b.status IN ('pending','confirmed','provider_en_route','arrived','in_progress',
                    'completed','protected','settled','disputed')
   AND b.scheduled_at < $3
   AND b.scheduled_at + make_interval(mins => b.duration_minutes) > $2
```

The occupying set is spec 020's to define (spec 016 §3 point 2), and it is defined as *every status
that has not released the slot*: `cancelled`, `refunded` and `failed` release it; every other status
occupies it — including `pending`, because a booking awaiting spec 021's confirmation gate must
still hold its time, and including `completed`/`protected`/`settled`, so historical time is never
re-sold.

### Migration

- **Name:** `0016_add_booking_creation_state_machine.sql`, paired with
  `0016_add_booking_creation_state_machine_down.sql` — the down-file convention specs 0012–0015
  follow.
- **Contents, in order:** a `DO $$ … RAISE EXCEPTION` precondition asserting that `bookings` and
  `bookings_status_history` are empty (the convention 0015 established), then
  `ALTER TABLE "bookings" ADD COLUMN … NOT NULL` directly — safe precisely because that guard has
  just proved the tables are empty, and loud rather than silent if they ever are not;
  `ALTER TABLE "bookings_status_history" ADD COLUMN "actor_role" text`; the CHECK constraints;
  `DROP INDEX "bookings_offer_id_idx"` then `CREATE UNIQUE INDEX "bookings_offer_id_uq"`; the
  remaining indexes; `CREATE FUNCTION` / `CREATE TRIGGER bookings_terms_immutable_trg`
  (hand-appended after the generated DDL, with `--> statement-breakpoint` separators, exactly as
  `0001_baseline_schema.sql` does); `INSERT INTO "bookings_status_transitions" … ON CONFLICT DO
  NOTHING` (six rows); `INSERT INTO "requests_status_transitions" VALUES
  ('provider_selected','booking_created') ON CONFLICT DO NOTHING`.
- **Reversible:** yes — the down file drops the trigger and its function, drops the added columns,
  restores `bookings_offer_id_idx`, and `DELETE`s exactly the seven seeded transition rows by
  `(from_status, to_status)`, the way `0014_..._down.sql` and `0015_..._down.sql` do.
- **Backfill required:** no — `bookings` is empty (no code has ever inserted into it).
- **Downtime:** none (additive; the single `DROP INDEX` is on an empty table).
- **Reviewed SQL:** hand-written for the trigger and the seeds (drizzle-kit generates DDL only,
  never data or triggers), reviewed in PR. `npm run check:schema-baseline` must still pass:
  `0001_baseline_schema.sql` is **not** edited.

### Retention and privacy

Bookings are core financial and audit records. They carry the exact operational `address_id`
(revealed to each party under spec 012's rules — the coarse area before confirmation, the full
address from `confirmed` onward) and the agreed price.

- **Export (spec 008).** `DataExportPayload.bookings` already exists in `lib/privacy/export.ts` as
  `Array<{ id, status, createdAt }>`, populated by joining `bookings → offers → requests →
  customer_profiles` / `provider_profiles`. This spec **widens that existing allowlist** rather than
  adding a new section: each entry gains `scheduledAt`, `scheduledTimezone`, `durationMinutes`,
  `priceAmountMinorUnits`, `currencyCode`, `serviceId` and `statusHistory:
  BookingStatusHistoryDto[]`. The join may also be simplified to read `bookings.customer_profile_id`
  / `bookings.provider_profile_id` directly once those columns exist, which is equivalent and
  cheaper. The allowlist continues to **exclude** `idempotency_key`, `idempotency_fingerprint` and
  every counterparty user id — `BookingStatusHistoryDto` carries `actorRole`, never
  `actor_user_id` — exactly as spec 015/018/019's exports exclude the same classes of field.
- **Deletion (spec 008).** A booking row is **never** deleted and **never** anonymized by account
  deletion: it is the record of a financial transaction, retained per legal/financial policy, and
  `bookings_status_history` stays append-only so attribution survives (S6). Spec 008's existing
  `hasActiveBooking()` guard already refuses deletion while any booking is outside the resolved set,
  and this spec's vocabulary makes that guard correct rather than provisional.
- **No new personal data** is introduced: every field is either a foreign key to an existing entity
  or a value copied from the accepted offer.
- This spec adds **no** `notifications` row and logs no address, price or other personal field.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | booking confirmation shows a progress indicator while the server revalidates; **never** an optimistic "Confirmed" before the `201` arrives (master spec §103, §132.7) |
| **Empty** | the Bookings tab with none yet shows a browse/search CTA — replacing today's `PlaceholderPage` in `app/bookings/page.tsx` |
| **Error** | `SLOT_NO_LONGER_AVAILABLE` renders the conflict plus AC-2's alternatives as up to three selectable times; choosing one re-submits `POST /bookings` with that `scheduledAt` and a **fresh** `Idempotency-Key`, keeping the customer in the flow. With no alternatives it shows `nextAvailableDate` as plain text and no misleading retry affordance |
| **Success** | the booking timeline updates as the provider progresses and as either party completes |

**Live updates: polling, not WebSocket.** The draft promised WebSocket updates. **No WebSocket layer
exists in this repository**, and specs 018 and 019 both say so explicitly
(`app/requests/[id]/OffersPanel.tsx`, `app/_components/RequestMessageThread.tsx`,
`app/provider/requests/page.tsx`). An open booking-detail screen refetches on the spec 018 cadence
and on window focus, and stops refetching once the booking reaches a status this spec cannot leave.

A "Mark Complete" action is available **identically** to both the customer and the provider once a
booking is `in_progress`, subject to the same gate (AC-5) and the same dwell rule (AC-11) — a
disabled control showing the remaining seconds, never a silent failure. Once completed, the timeline
shows which party completed it, read from the status history (AC-8). If the other party disagrees
they see an explicit "Open a dispute" entry point (spec 031); completion never opens one on its own
(AC-10). While spec 031 is unbuilt, that entry point links to support rather than fabricating a
dispute flow.

**Design system.** Every surface is composed from existing primitives re-exported through
`@/components` — `Card`, `Badge`, `Button`, `EmptyState`, `ErrorState`, `Skeleton`, `PriceDisplay`,
`ListRow` — with tokens from `app/styles/apuriva-tokens.css`. No raw hex, font size, radius, shadow
or spacing value is written.

**Route(s):** `app/bookings/page.tsx` (replacing the placeholder), `app/bookings/[id]/page.tsx`,
`app/provider/schedule/bookings/[id]/page.tsx`. The draft's `app/bookings/[id]` and
`app/provider/schedule/bookings/[id]` are correct as *directories*; both are new — only
`app/bookings/page.tsx` and `app/provider/schedule/page.tsx` exist today.

**Booking-confirmation entry point:** `app/bookings/_components/ConfirmBookingPanel.tsx`, mounted in
spec 018's `app/requests/[id]/OffersPanel.tsx` on the accepted offer while the request is
`provider_selected` — the hand-off that panel's own doc comment names ("booking is spec 020's next
step"). It calls `POST /bookings`, shows a pending state until the `201`, renders AC-2's alternatives
as selectable times re-submitted with a fresh `Idempotency-Key`, and navigates with
`window.location.assign` rather than the Next.js router hook, so spec 018's panel keeps rendering
(and testing) without an app-router context. The mount is additive; nothing else in that panel changes.

**Shared components used/added:** reuses `RequestStatusTimeline`
(`components/RequestStatusTimeline.tsx`, re-exported from `components/index.ts`) — the draft called
it `StatusTimeline`, which is the `ui/` internal name, not the app-facing export. **No
`EvidenceUpload` component is added**: evidence is spec 027/028's, and this spec's complete action
takes no evidence input (§3).

**Accessibility.** Status is conveyed as text plus an icon, never colour alone; a status change is
announced once through a polite live region, not on every poll; the dwell countdown on "Mark
Complete" is exposed as text on the disabled control.

---

## 6. Test plan

**Vitest only.** There is no Playwright or Cypress in this repository (`package.json` has no e2e
runner and no e2e script; `e2e/auth.spec.ts` is an unwired leftover), no `lib/mcp` (spec 036 is not
built) and no worker app — so the draft's `e2e/booking-lifecycle.spec.ts` and
`lib/mcp/create-booking.test.ts` rows are **removed rather than promised**, exactly as specs 018 and
019 removed theirs. Integration tests run against the isolated `<name>_test` database only
(`vitest.config.ts` rewrites `DATABASE_URL`; `test/db-reset.ts` refuses any other name), use
`describe.skipIf(!dbReachable)`, call `resetRateLimitState()` in `beforeEach`, and never mock the
database clock — dwell and early-start fixtures seed `occurred_at` / `scheduled_at` relative to
`clock_timestamp()` (e.g. `occurred_at = clock_timestamp() - interval '61 seconds'`). Concurrency
tests use **real separate connections**, following `lib/db/concurrency.integration.test.ts`,
`lib/availability/reserve.integration.test.ts` and `lib/offers/accept-race.integration.test.ts`.
Every test that registers a `BusyIntervalLoader` or a `CompletionEvidenceGate` restores the default
in `afterEach` (`resetBusyIntervalLoader()` already exists; `resetCompletionEvidenceGate()` is added
alongside it) so no suite leaks into another.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | the whole transition matrix (`isAllowedBookingTransition` over every status pair, including every pair spec 021/022/023/031 own); the AC-11 constants; the published alternatives constants and the time-of-day formatting that makes an alternative re-submittable | `lib/bookings/state-machine.test.ts`, `lib/bookings/alternatives.test.ts` |
| **Integration — creation** | the ordered revalidation of steps 4–14; offer/request state rejections; price copied verbatim; the `booking_created` request transition and its history row; the immutability trigger | `lib/bookings/create.integration.test.ts` |
| **Integration — idempotency** | same key + same body → one row, `201` then `200`; same key + different body → `409`; missing key → `400`; the per-customer key scope | `lib/bookings/idempotency.integration.test.ts` |
| **Integration — slot conflict** | `SLOT_OVERLAP` mapped to `422 SLOT_NO_LONGER_AVAILABLE`; the `details` shape; alternatives re-submittable end to end; spec 016's `sourceId` never leaking | `lib/bookings/slot-conflict.integration.test.ts` |
| **Concurrency** | two creations over overlapping time on two connections; two creations with the same key; simultaneous customer + provider completion | `lib/bookings/create-race.integration.test.ts`, `lib/bookings/complete-concurrency.integration.test.ts` |
| **Integration — lifecycle** | the full seeded chain with and without the optional en-route step; out-of-graph rejection in application code **and** with application code bypassed (raw `UPDATE` → trigger `23514`); stale `expectedVersion`; repeat-action idempotency | `lib/bookings/lifecycle.integration.test.ts` |
| **Integration — completion** | symmetry for both parties; the evidence gate both ways; the dwell and early-start guards; no dispute row ever created; no transition out of `completed` | `lib/bookings/complete.integration.test.ts` |
| **Integration — spec 016 port** | the registered loader makes an existing booking block `reserveProviderSlot`, and blocks a provider schedule edit that would strand it (spec 016 §8 risk #6 becomes live here) | `lib/bookings/busy-intervals.integration.test.ts` |
| **API** | every route's auth, active mode, CSRF, participant/404 rules, rate limiting, envelope and status codes | `app/api/v1/bookings/bookings.integration.test.ts` |
| **Component** | customer booking detail and provider active-job screens: loading/empty/error/success, no optimistic "Confirmed", the conflict screen's alternatives, the disabled Mark Complete countdown | `app/bookings/[id]/page.test.tsx`, `app/provider/schedule/bookings/[id]/page.test.tsx`, `app/bookings/_components/ConfirmBookingPanel.test.tsx` (Testing Library, jsdom); spec 018's `app/requests/[id]/OffersPanel.test.tsx` must keep passing unchanged |
| **Privacy** | export includes own bookings and history with no idempotency data and no counterparty user id; deletion never removes a booking row; `hasActiveBooking()` against the real vocabulary | `lib/privacy/export.integration.test.ts`, `lib/privacy/deletion.integration.test.ts`, `lib/privacy/booking-lifecycle-adapter.integration.test.ts` |
| **Cross-spec updates** | spec 015's `§4: no transition belonging to a later spec is performable` moves `provider_selected -> booking_created` into its shipped list — the same one-line update spec 018 made for `offers_open -> provider_selected`; spec 008's `booking-lifecycle-adapter` cases are kept unchanged alongside the new spec 020 cases | `app/api/v1/requests/state-machine.integration.test.ts`, `lib/privacy/booking-lifecycle-adapter.integration.test.ts` |
| **Schema / contract** | migration up + down round-trip; the seeded transition rows; the immutability trigger; OpenAPI drift | `lib/db/migrations.integration.test.ts`, `lib/db/status-transitions.integration.test.ts`; `npm run check:openapi-drift` |
| **Payment-boundary guard** | a source-level assertion that no file under `lib/bookings/**` or `app/api/v1/bookings/**` performs a transition to `protected` or `settled`, and that this spec's migration seeds neither | `lib/bookings/payment-boundary.test.ts` |

**Traceability** — every acceptance criterion:

| AC | Test |
|---|---|
| AC-1 | `lib/bookings/create.integration.test.ts::revalidates offer state, request state, slot and price inside one transaction`, `::price and currency are copied verbatim from the accepted offer and ignore any client value`, `::rejects a superseded/withdrawn/expired/unaccepted offer with 422 OFFER_NOT_ACCEPTABLE`, `::rejects a request not in provider_selected with 422 REQUEST_NOT_ACTIONABLE` |
| AC-2 | `lib/bookings/slot-conflict.integration.test.ts::a slot taken after acceptance yields 422 SLOT_NO_LONGER_AVAILABLE and writes nothing`, `::details carry up to three earliest-first alternatives at the requested time-of-day`, `::an alternative can be re-submitted with a new Idempotency-Key and succeeds`, `::returns nextAvailableDate and an empty alternatives list when none qualify`, `::never leaks spec 016 sourceId, booking ids, counts, buffers or schedule internals`, `::a scheduled time already in the past is treated as a lost slot, with alternatives`; `lib/bookings/alternatives.test.ts::caps disclosure at three alternatives`, `::scans a fourteen local-day horizon` |
| AC-3 | `lib/bookings/idempotency.integration.test.ts::the same key and body returns the original booking with 200 and exactly one row`, `::the same key with a different body is 409 IDEMPOTENCY_KEY_CONFLICT`, `::a missing Idempotency-Key is 400`, `::two customers may use the same key` |
| AC-4 | `lib/bookings/lifecycle.integration.test.ts::confirmed → provider_en_route → arrived → in_progress, one action each, one history row each`, `::confirmed → arrived succeeds without the en-route step`, `::each new status is readable by both participants` |
| AC-5 | `lib/bookings/complete.integration.test.ts::a registered gate reporting required-and-unsatisfied rejects 422 COMPLETION_EVIDENCE_REQUIRED for the customer and for the provider identically`, `::the shipped default gate lets either party complete without evidence` |
| AC-6 | `lib/bookings/state-machine.test.ts::rejects every pair outside the seeded graph`; `lib/bookings/lifecycle.integration.test.ts::pending → in_progress is 409 INVALID_STATUS_TRANSITION`, `::a raw UPDATE bypassing application code is rejected by the trigger with 23514`, `::a stale expectedVersion is 409 CONFLICT` |
| AC-7 | `lib/bookings/lifecycle.integration.test.ts::every status change is attributable to a participant action`; `lib/bookings/payment-boundary.test.ts::this spec ships no cron, sweep or system-actor call site` |
| AC-8 | `lib/bookings/complete.integration.test.ts::the provider completes an in_progress booking without the customer's confirmation` and `::the customer completes an in_progress booking without the provider's confirmation`, `::the completing party is recorded in bookings_status_history and is readable by both` |
| AC-9 | `lib/bookings/complete-concurrency.integration.test.ts::simultaneous customer and provider completion records exactly one transition and one history row, and the loser gets 200 with the completed booking`, `::an unauthorized caller is 404 even when the other party's concurrent request already completed the booking`, `::an evidence-incomplete request is 422 even when the other party's concurrent request already completed the booking` |
| AC-10 | `lib/bookings/complete.integration.test.ts::completion creates no dispute row and no transition to disputed`, `::disputed is not reachable from any transition seeded by this spec` |
| AC-11 | `lib/bookings/complete.integration.test.ts::completion within 60 seconds of in_progress is 422 COMPLETION_TOO_EARLY with retryAfterSeconds, for either party`, `::completion at 61 seconds succeeds`; `lib/bookings/lifecycle.integration.test.ts::en-route/arrived more than 60 minutes before scheduled_at is 422 BOOKING_NOT_STARTABLE_YET`, `::within the grace window it succeeds` |
| AC-12 | `lib/bookings/create-race.integration.test.ts::two overlapping creations on separate connections yield exactly one booking and one 422 SLOT_NO_LONGER_AVAILABLE`, `::bookings_offer_id_uq rejects a second booking for one offer even bypassing the application check` |
| AC-13 | `lib/privacy/export.integration.test.ts::a booking export carries status, schedule, price and history without idempotency data or the counterparty user id`; `lib/privacy/deletion.integration.test.ts::account deletion never removes or anonymizes a booking row`; `lib/privacy/booking-lifecycle-adapter.integration.test.ts::hasActiveBooking against the real status vocabulary` |

**Coverage:** ≥80% on new code — the repository's standard. This spec is named in master spec §115's
critical test examples, so the idempotency (AC-3), creation-race (AC-12) and completion-concurrency
(AC-9) suites are **mandatory, not optional**.

**Not covered, deliberately:** payment authorization/capture/protection/settlement (spec 021);
cancellation and no-show (spec 023); milestone content and the real evidence requirement (spec 028);
evidence upload and storage (spec 027); notification channel delivery (spec 026); review eligibility
(spec 029); dispute mechanics (spec 031); MCP tool behaviour — spec 036 must call this spec's
`lib/bookings/*` functions so it inherits these guarantees, and is tested there.

---

## 7. Out of scope

- **Payment of any kind** — authorization, capture, the protection window, payout eligibility,
  settlement, and the `completed → protected` and `protected → settled` transitions, which spec 021
  seeds and performs (§3 "Payment boundary"). Reaching `completed` here triggers nothing.
- **Cancellation, no-show and the `→ cancelled` transition** (spec 023). Nothing in this spec
  cancels a booking; `cancelled` appears in the vocabulary only so one author owns the enum.
- **Refunds and `→ refunded`** (spec 022).
- **Dispute mechanics and `→ disputed`** (spec 031). This spec only guarantees that a disagreement
  after completion routes to an explicit, user-initiated dispute rather than an automatic one
  (AC-10), and that the audit trail such a dispute would need exists.
- **Post-booking conversations** (spec 025). This spec creates no `conversations` row and no
  message. `conversations.booking_id` is a nullable spec 003 baseline column that spec 025 fills;
  nothing here writes it, and the pre-selection threads spec 019 owns become read-only when the
  request leaves `offers_open`, which this spec's `booking_created` transition causes — that is spec
  019's existing AC-8 behaviour working as designed, not a change made here.
- **Review eligibility** (spec 029) — triggered by `completed`/`settled`, defined there. This spec
  writes no `reviews` row and exposes no review affordance; `reviews.booking_id` stays spec 029's.
- **Service-execution detail** (spec 028): progress milestones, the per-service completion-evidence
  requirement (`services.completion_evidence_required`), and the evidence UI. This spec ships the
  gate interface and its inert default only.
- **Evidence upload, storage, scanning and visibility** (spec 027).
- **Notification delivery** (spec 026): no `notifications` row is written here.
- **Rescheduling an existing booking.** Nothing here changes `scheduled_at` — the immutability
  trigger forbids it. A reschedule flow belongs to a later spec and must amend that trigger
  explicitly.
- **`booking_created → completed` on the parent request.** The request stays `booking_created`;
  whether and when a request reaches `completed` is spec 028's, and that transition row is not
  seeded here.
- **A customer-facing slot browser.** It would contradict spec 016's public/owner-only rule; AC-2's
  bounded alternatives are the only time-suggestion surface in this spec.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact mechanism for "offer alternatives" shown on slot conflict | Product / Platform | **Resolved** (§3 "Slot-conflict alternatives"): the same provider, service, duration and requested time-of-day, computed by spec 016's existing slot rules through this spec's registered busy loader, earliest-first, at most 3, within 14 local days, re-submittable as `scheduledAt`, with `nextAvailableDate` as the fallback. Spec 017 matching is **not** re-run and no new feature is invented |
| 2 | Whether `Protected`/`Settled` are driven by this spec or by spec 021 | Platform | **Resolved** (§3 "Payment boundary"): this spec owns the status *vocabulary* and the `applyBookingTransition()` primitive; **spec 021 seeds both transition rows in its own migration and is the only caller that performs them**, with `actorRole: 'system'`. This spec ships no route, UI action or internal call site that reaches either status, and a source-level test asserts it |
| 3 | Unilateral completion (AC-8) could enable premature completion | Platform | **Resolved** (§3 "Unilateral-completion safeguards"): S1–S9 — only from `in_progress`; participant + matching active mode; a 60-second database-clock dwell since `in_progress` (`422 COMPLETION_TOO_EARLY`); no start earlier than 60 minutes before `scheduled_at` (`422 BOOKING_NOT_STARTABLE_YET`); a symmetric evidence gate; mandatory append-only attribution; both parties can see it immediately; `completed` terminal in this spec; CSRF + rate limit + `Idempotency-Key`. All are state-machine rules testable here; none is payment, fraud-scoring, cancellation or dispute machinery |
| 4 | Spec 016 §8 risk #7 — `scheduled_at` declared with no companion IANA timezone column | Platform | **Resolved here**, as spec 016 asked: §4 adds `scheduled_timezone` via `scheduledTimeColumns('scheduled')`, set to the provider's `scheduling_timezone`, satisfying spec 003 AC-2 |
| 5 | Spec 016 §7 deferred hardening — a Postgres `EXCLUDE USING gist` constraint on `(provider_profile_id, tstzrange)` | Platform | **Considered and declined for this spec.** It needs `btree_gist`, and **no migration in `drizzle/` has ever issued `CREATE EXTENSION`**; the deployment target is not guaranteed to permit one. The row-lock check inside the writing transaction is the repository's established idiom and is what AC-12's concurrency test proves. Recorded as optional future hardening rather than a gap: the status vocabulary this spec fixes now makes a partial constraint expressible whenever an extension becomes acceptable |
| 6 | A provider edits their schedule under a confirmed booking (spec 016 §8 risk #6, previously inert) | Platform | **Becomes live with this spec**: registering the real `BusyIntervalLoader` makes spec 016's existing strand-check reject such an edit with `409 SLOT_OVERLAP`. Covered by `lib/bookings/busy-intervals.integration.test.ts`; no code change in `lib/availability/**` is required |
| 7 | A booking could sit in `pending` forever if spec 021 installs a gate that never resolves | Platform | **Out of scope, named rather than invented.** This spec commits `pending → confirmed` inside the creation transaction, so no booking of this spec's making can linger in `pending`. Any timeout for a gated `pending` booking belongs to **spec 021**, which owns both the gate and `pending → failed` |
| 8 | `EARLY_START_GRACE_MINUTES = 60` may be too tight for a provider who genuinely arrives early | Product | **Accepted, with a named constant.** It is a single exported constant in `lib/bookings/state-machine.ts`, tunable without touching the graph, and it refuses only an advance more than an hour early. The alternative — no guard — would let a booking be run to `completed` seconds after creation, which is exactly what risk #3 asks this spec to prevent |

No **blocking** question remains. Every item above is either resolved in this document or explicitly
assigned to a named later spec.

---

## 9. Rollout

- **Feature flag:** none — core transactional flow, and `app/bookings/page.tsx` is a placeholder
  today, so there is no existing behaviour to flag off.
- **Migration order:** `0016` ships with the code in the same PR. Registering the
  `BusyIntervalLoader` changes spec 016's behaviour from "nothing is occupied" to "confirmed
  bookings are occupied", which is only correct **after** `0016` adds `scheduled_at` and
  `duration_minutes` — so the migration runs before the deploy that registers the loader, the
  ordinary order for this repository.
- **Rollback:** revert the deploy and apply `0016_add_booking_creation_state_machine_down.sql`.
  (`npm run db:rollback` is spec 003's baseline-only script and does not take a migration argument;
  the paired down file is applied directly, as 0012–0015's are.) The down file restores
  the baseline shape; because `bookings` is empty before this spec, an immediate rollback loses no
  data. Once real bookings exist the down file drops columns and is destructive — the standard
  caveat on every down migration here.
- **Observability:** structured `console.log` events, the repository's existing logging idiom (e.g.
  `lib/offers/decide.ts`): `booking.created`, `booking.slot_conflict` (with `alternativesCount`),
  `booking.idempotent_replay`, `booking.transition` (from, to, actor role),
  `booking.completion_too_early`, `booking.invalid_transition`. Booking-confirmation failure rate,
  status-transition latency and idempotency-replay rate are the monitored signals, and they are
  precisely what evidences master spec §115's "no duplicate bookings on retries" guarantee.
