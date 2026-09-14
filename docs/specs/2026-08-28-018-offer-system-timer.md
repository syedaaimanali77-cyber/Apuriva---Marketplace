# Spec: Offer System & 2-Minute Timer

**File:** `docs/specs/2026-08-28-018-offer-system-timer.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §31–§32, §36, §115, §125, §132.4, §132.6, §132.18, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.3, §5.4, §6.1, §10, §14, [docs/workflow.md](../workflow.md)

**Depends on:** spec 001 (§8 risk #1: Vercel Cron calling internal routes — the only background-job
mechanism in this repository), spec 003 (baseline `offers`, `offers_status_history`,
`offers_status_transitions` and the `enforce_status_transition()` trigger; `moneyColumns` money
convention), spec 004 (envelope, error codes, rate limiting, OpenAPI registry), spec 005 (session,
CSRF), spec 006 (`requireActiveMode`, customer/provider profiles), spec 008 (privacy export/deletion),
spec 015 (requests, `lib/api/idempotency.ts`), spec 016 (`requireOwnProviderProfile`), **spec 017**
(distribution — `request_provider_matches.notified_at`, `provider_response`, the pricing-model →
action mapping, and the `send_offer` action state this spec makes real) — all *approved and
implemented*.
**Feeds:** spec 019 (negotiation, revision, comparison), spec 020 (booking creation from an
accepted offer), spec 026 (offer/expiry notification delivery), spec 036 (`send_offer`,
`accept_offer`, `get_offers` MCP tools).

> **Numbering note.** This document's `**File:**` line previously read `...-017-offer-system-timer.md`,
> a leftover from the pre-shift draft numbering. The repository's authoritative numbering —
> `docs/specs/INDEX.md`, `docs/specs/README.md` and the **approved** specs 015 and 017 — is
> **015 = Request Creation, 016 = Availability & Service Areas, 017 = Matching & Distribution,
> 018 = this spec, 019 = Offer Negotiation & Comparison, 020 = Booking Creation**. The draft's §7
> reference to negotiation as "spec 018" is corrected to **spec 019**; its "spec 020/091" and
> "spec 095" references (no such specs exist) are corrected to spec 020 and architecture §6.1.

---

## 1. Problem statement

**Today:** `offers` exists only as spec 003's baseline skeleton — `id`, audit columns, `version`,
`request_id`, `provider_profile_id`, and an unconstrained `status text` — with an empty
`offers_status_transitions` table, so the DB trigger rejects every status change. There is no
price, no timer, and no route. Spec 017 already distributes quote/custom-priced requests to a
provider pool and shows those providers `availableAction: 'send_offer'`, but the action is an
inert "coming soon" state because offer creation is this spec's.

Master spec §31 defines the offer flow and fields; §32 fixes the response window at **exactly
2 minutes**, decided by the server/database — "the browser timer is cosmetic" — and §132.4 makes
"Do not trust browser timers" a non-negotiable rule.

**Who is affected:** Providers responding to quote/custom-priced requests; customers deciding under
time pressure; the Vercel Cron expiry job, which must persist expiry even when no client is
connected.

**Why it matters now:** It is the highest-risk timing-correctness feature in the MVP and the next
step after spec 017 in the established order **015 → 016 → 017 → 018 → 019 → 020**. Spec 020's
booking creation consumes the accepted offer this spec produces.

**Success looks like:** A distributed provider sends an offer whose `expires_at` is computed by the
database as exactly `sent_at + 2 minutes`; the customer can accept it only while the database clock
is strictly before `expires_at`; an expired offer can never become `accepted` under any race; the
expired state is persisted by a background job without any client, and remains in history; at most
one offer per request is ever accepted.

> **Scope boundary.** This spec ends at an **accepted** offer and the request moving to
> `provider_selected`. It creates **no booking**, no payment, and no `revised` state — booking is
> spec 020's `POST /api/v1/bookings` (which references `offerId`), revision/negotiation is spec 019's.

---

## 2. Acceptance criteria

All times below are the **database clock** (`clock_timestamp()`), never a client or app-server
clock. `T` = the offer's `sent_at`; `expires_at` = `T + 2 minutes` exactly.

| # | Criterion |
|---|---|
| AC-1 | **Given** a live offer with `expires_at = T + 2:00` **When** the owning customer attempts to accept it at any database instant `≥ T + 2:00.000` (including `T + 2:00:01`) **Then** the API rejects with `422 OFFER_EXPIRED`, writes nothing, and the offer can never later become `accepted` — regardless of what countdown any client displays |
| AC-2 | **Given** a live offer **When** the owning customer accepts it at a database instant strictly before `expires_at` (e.g. `T + 1:59`) **Then** it becomes `accepted` with `decided_at` set, the request moves `offers_open → provider_selected`, and `200` is returned |
| AC-3 | **Given** an offer whose `expires_at` has passed **When** no client reads or polls it **Then** the offer-expiry cron job persists `status = 'expired'` (with an `offers_status_history` row, actor `null`) no later than **120 seconds** after `expires_at` under the decided `* * * * *` schedule; **and** every read endpoint reports it as `expired` from the instant `expires_at` passes, whether or not the job has run yet |
| AC-4 | **Given** an expired, declined, withdrawn or accepted offer **When** either the owning customer (request list/detail) or the owning provider (offer detail, inbox) views it **Then** it is still returned with its terminal status and timestamps — no offer row is ever deleted |
| AC-5 | **Given** a request still in `matching`/`offers_open` whose previous offer from a provider is `expired` or `withdrawn` **When** that provider sends a fresh offer **Then** a new offer row is created with its own independent `sent_at`/`expires_at` window, the previous row keeps its terminal status unchanged, and at no time does that provider hold more than one live offer on that request |
| AC-6 | **Given** concurrent accept attempts **Then** exactly one state change wins, enforced by `SELECT … FOR UPDATE` on the request and offer rows plus a partial unique index: (a) same offer, same `Idempotency-Key` → both `200` with the identical accepted offer; (b) same offer, different keys → one `200`, the other `409 OFFER_ALREADY_DECIDED`; (c) two different offers on the same request → one `200`, the other `409 REQUEST_ALREADY_CLAIMED`; (d) an accept racing the expiry job → either the accept commits (it held the lock strictly before `expires_at`) or it receives `422 OFFER_EXPIRED`, never both `accepted` and `expired`. This spec creates no booking in any case |
| AC-7 | **Given** an offer-creation request **When** it is submitted **Then** it is accepted only from a provider with a `request_provider_matches` row for that request with `notified_at` set (else `403 NOT_DISTRIBUTED_TO_PROVIDER`), on a request in `matching`/`offers_open` (else `422 REQUEST_NOT_ACTIONABLE`), for a `quote`/`custom` service (else `422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL`); and `sent_at`/`expires_at` are always database-computed — any client-supplied `sentAt`, `expiresAt`, `status` or duration field is ignored |
| AC-8 | **Given** a live offer **When** the owning customer declines it or the owning provider withdraws it **Then** it moves to `declined`/`withdrawn` with `decided_at` set; repeating the same action returns `200`; acting on an offer already in a different terminal state returns `409 OFFER_ALREADY_DECIDED`; acting at or after `expires_at` returns `422 OFFER_EXPIRED` |
| AC-9 | **Given** an offer-creation request retried with the same `Idempotency-Key` **When** the body fingerprint matches **Then** the original offer is returned with `200` and no second offer, timer or history row is created; **when** the fingerprint differs **Then** `409 IDEMPOTENCY_KEY_CONFLICT` and nothing is written |

---

## 3. API contract

Routes live under `app/api/v1/**/route.ts` (Next.js App Router — this repository is a single
Next.js app, **not** the `apps/web` + `apps/api` + `apps/worker` + `packages/*` layout the draft
assumed). Every route is `withApiRoute` (`lib/api/handler.ts`) wrapping a call into a new
`lib/offers/*` module. Every route calls `requireSession`; every mutation additionally calls
`requireCsrf` (`lib/auth/require-session.ts`). Customer routes call
`requireActiveMode(session, 'customer')` and resolve ownership through the caller's
`customer_profiles` row; provider routes call `requireActiveMode(session, 'provider')` and resolve
the provider through `requireOwnProviderProfile(session.userId)` (`lib/availability/owner.ts`) —
**no route ever accepts a provider or customer id from the client**. No admin route is added.

**OpenAPI:** every route below is added to `OPENAPI_ROUTES` (`lib/api/openapi-registry.ts`, tag
`offers`) in the same PR — `scripts/check-openapi-drift.ts` fails otherwise. The cron route lives
under `app/api/v1/cron/`, which the drift check deliberately excludes, exactly like the existing
`data-export-sweep` and `account-deletion-sweep` routes.

**Rate limiting:** a new `offers` domain is added to `RateLimitDomain` / `RATE_LIMIT_DEFAULTS`
(`lib/api/rate-limit.ts`) at `30 / 60_000`, keyed by `session.userId` — the same write-surface
budget specs 015 (`requests`) and 017 (`matching`) chose. The cron route is not rate-limited.

**Idempotency:** reuses `lib/api/idempotency.ts` (`requireIdempotencyKey`, `idempotencyFingerprint`),
whose own header comment already names spec 018 as a consumer. Storage is per-entity on `offers`,
the same pattern spec 015 uses on `requests`.

### Endpoints

| Method | Route | Auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/api/v1/offers` | session, provider mode, CSRF, **`Idempotency-Key` required** | `201` `ApiResponse<OfferDto>` (replay: `200`) | `400`, `401`, `403 FORBIDDEN`, `403 NOT_DISTRIBUTED_TO_PROVIDER`, `404 NOT_FOUND` (no provider profile), `409 IDEMPOTENCY_KEY_CONFLICT`, `409 LIVE_OFFER_EXISTS`, `422 REQUEST_NOT_ACTIONABLE`, `422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL`, `429` |
| `GET` | `/api/v1/requests/{id}/offers` | session, customer mode, request owner | `200` `PagedResponse<OfferDto>` | `401`, `403 FORBIDDEN`, `404 REQUEST_NOT_FOUND`, `429` |
| `GET` | `/api/v1/offers/{id}` | session; owning customer (customer mode) **or** owning provider (provider mode) | `200` `ApiResponse<OfferDto>` | `401`, `403 FORBIDDEN`, `404 OFFER_NOT_FOUND`, `429` |
| `POST` | `/api/v1/offers/{id}/accept` | session, customer mode, CSRF, request owner, **`Idempotency-Key` required** | `200` `ApiResponse<OfferDto>` | `400`, `401`, `403 FORBIDDEN`, `404 OFFER_NOT_FOUND`, `409 OFFER_ALREADY_DECIDED`, `409 REQUEST_ALREADY_CLAIMED`, `422 OFFER_EXPIRED`, `422 REQUEST_NOT_ACTIONABLE`, `429` |
| `POST` | `/api/v1/offers/{id}/decline` | session, customer mode, CSRF, request owner | `200` `ApiResponse<OfferDto>` | `401`, `403 FORBIDDEN`, `404 OFFER_NOT_FOUND`, `409 OFFER_ALREADY_DECIDED`, `422 OFFER_EXPIRED`, `422 REQUEST_NOT_ACTIONABLE`, `429` |
| `POST` | `/api/v1/offers/{id}/withdraw` | session, provider mode, CSRF, offer owner | `200` `ApiResponse<OfferDto>` | `401`, `403 FORBIDDEN`, `404 OFFER_NOT_FOUND`, `409 OFFER_ALREADY_DECIDED`, `422 OFFER_EXPIRED`, `429` |
| `GET` | `/api/v1/cron/offer-expiry-sweep` | `Authorization: Bearer ${CRON_SECRET}` | `200 { status: 'ok', expired: number }` | `401` |

**Route shape — why `POST /api/v1/offers` rather than the draft's `POST /requests/{id}/offers`.**
Approved spec 017 §3 already records that "spec 018 ships `POST /api/v1/offers`", and master spec
§125 / architecture §6 root the domain at `/api/v1/offers`. The request id travels in the body.
The customer's per-request list stays under `/requests/{id}/offers`, mirroring spec 017's
`/requests/{id}/matches`.

**Non-participants get `404`, not `403`.** An offer or request that does not exist and one the caller
does not own are indistinguishable (`404 OFFER_NOT_FOUND` / `404 REQUEST_NOT_FOUND`), the same
anti-probing rule spec 015 applies to requests. `403 FORBIDDEN` is reserved for a wrong active mode
(and `403 CSRF_TOKEN_INVALID` for a missing CSRF header). Offer creation is the one exception: it
returns `403 NOT_DISTRIBUTED_TO_PROVIDER` exactly as spec 017's provider routes do, checked before
anything else.

### Request and response types

```typescript
// lib/types/offers.ts  (this repository has no packages/types)

/** Master spec §125 offer vocabulary. `revised` is RESERVED for spec 019 and never written here. */
export type OfferStatus =
  | 'draft' | 'sent' | 'viewed' | 'revised'
  | 'accepted' | 'declined' | 'expired' | 'withdrawn';

/** `draft` never leaves the creating transaction, so it is never returned by any endpoint. */
export type VisibleOfferStatus = Exclude<OfferStatus, 'draft'>;

export interface CreateOfferRequest {
  requestId: string;
  /** Positive integer, ≤ 2_147_483_647. Master spec §132.5 — never a float. */
  priceAmountMinorUnits: number;
  /** `^[A-Z]{3}$`; must equal the request budget's currency when the request has a budget. */
  currencyCode: string;
  /** 0–20 items, each trimmed 1–200 chars. Defaults to `[]`. */
  includedItems?: string[];
  /** ≤ 1000 chars; trimmed; empty string stored as null. */
  providerMessage?: string | null;
  /** Integer 1–1440. */
  estimatedDurationMinutes?: number | null;
}

export interface OfferDto {
  id: string;
  requestId: string;
  providerProfileId: string;
  /** `provider_profiles.business_name`; null when unset or after deletion anonymization. */
  providerBusinessName: string | null;
  /** EFFECTIVE status: a stored `sent`/`viewed` row whose `expires_at` has passed is reported
   *  as `expired`, even before the cron job persists it (AC-3). */
  status: VisibleOfferStatus;
  priceAmountMinorUnits: number;
  currencyCode: string;
  includedItems: string[];
  providerMessage: string | null;
  estimatedDurationMinutes: number | null;
  sentAt: string;
  /** Authoritative, database-computed: exactly `sentAt + 2 minutes`. */
  expiresAt: string;
  viewedAt: string | null;
  /** Set for accepted / declined / withdrawn; null for live and expired offers. */
  decidedAt: string | null;
  /** The database clock at read time. Lets a client offset its cosmetic countdown for local
   *  clock drift; it is never used by the server for any decision. */
  serverNow: string;
  version: number;
}
```

No request body is accepted by `accept`, `decline` or `withdraw`; any body is ignored.
Pagination on `GET /requests/{id}/offers` uses `parsePageParams`/`buildPage`
(`lib/api/pagination.ts`), ordered `sent_at DESC, id DESC`.

`IdempotencyKey`, fingerprints and `accept_idempotency_key` are **never** serialized into any DTO.

### Timing rules (the core product rule)

- **Window:** exactly 2 minutes — `OFFER_WINDOW = interval '2 minutes'`, defined once as a named
  constant in `lib/offers/timer.ts` (with the SQL literal it corresponds to) and enforced by a
  database CHECK (`expires_at = sent_at + interval '2 minutes'`). **Not configurable** (master
  spec §32; not an admin setting, not a feature flag, not an env var).
- **Authoritative clock:** the database. `sent_at` is set by `clock_timestamp()` and `expires_at` by
  `sent_at + interval '2 minutes'` **in the same `UPDATE` statement**; neither is ever computed in
  application code, supplied by a client, recomputed, or extended.
- **Live** means: stored status in (`sent`, `viewed`) **and** `clock_timestamp() < expires_at`.
  The boundary is exclusive — at exactly `expires_at` the offer is expired.
- **Every decision re-reads the clock after taking its row locks.** `accept`, `decline` and
  `withdraw` evaluate `clock_timestamp() < expires_at` *inside* the transaction, **after**
  `SELECT … FOR UPDATE` returns. `now()` (transaction start time) is deliberately **not** used: a
  transaction that started before expiry but waited on a lock until after it must see the offer as
  expired.
- **A rejected decision writes nothing.** `OFFER_EXPIRED` rolls the transaction back; persisting
  the `expired` status is the cron job's (and offer creation's — see below) responsibility.
- **Accepted offers never expire.** The window governs only the customer's decision; once
  `accepted`, `expires_at` is historical. Spec 020 decides what an accepted offer permits.
- **The browser countdown is cosmetic only** (§5). No server behaviour reads any client time.

### Offer state machine

`offers_status_transitions` is empty today, so the spec-003 trigger rejects every offer status
change. **This spec's migration seeds exactly these ten rows** (idempotent,
`ON CONFLICT DO NOTHING`), and every transition writes an `offers_status_history` row in the same
transaction:

| from | to | Actor (`actor_user_id`) | Trigger |
|---|---|---|---|
| `draft` | `sent` | provider's user | offer creation (same transaction as the insert) |
| `sent` | `viewed` | customer's user | owning customer's first read of the live offer (list or detail) |
| `sent` | `accepted` | customer's user | `POST …/accept` |
| `viewed` | `accepted` | customer's user | `POST …/accept` |
| `sent` | `declined` | customer's user | `POST …/decline` |
| `viewed` | `declined` | customer's user | `POST …/decline` |
| `sent` | `withdrawn` | provider's user | `POST …/withdraw` |
| `viewed` | `withdrawn` | provider's user | `POST …/withdraw` |
| `sent` | `expired` | `null` (system) | cron sweep, or offer creation clearing a stale row |
| `viewed` | `expired` | `null` (system) | cron sweep, or offer creation clearing a stale row |

**Creation is one transaction:** insert with `status = 'draft'`, then `UPDATE … SET status = 'sent',
sent_at = clock_timestamp(), expires_at = clock_timestamp()…` (exercising the trigger), writing both
history rows (`null → draft`, `draft → sent`) — the same "draft is DB-real but never committed"
precedent spec 015 set for requests. Because the draft row never commits, `lib/requests/read.ts`'s
existing `countOffers` needs no change.

`sent → viewed` is a **conditional** update (`WHERE status = 'sent' AND clock_timestamp() < expires_at`)
issued by the owning customer's read; it never affects the timer, never fails the read, and a read
by the provider never marks an offer viewed.

**Deliberately not seeded:** anything into or out of `revised` (spec 019), and any transition out of
`accepted`/`declined`/`expired`/`withdrawn` — all four are terminal in this spec.

### Request state transitions

Spec 017's approved text assigns `matching → offers_open` to this spec. This spec's migration seeds
both transitions it performs, each with a `requests_status_history` row:

| from | to | Actor | Trigger |
|---|---|---|---|
| `matching` | `offers_open` | provider's user | the first successfully created offer on a request in `matching` |
| `offers_open` | `provider_selected` | customer's user | a successful accept (AC-2) |

An offer expiring, being declined or being withdrawn **never** moves the request back to `matching`
and never expires the request — master spec §32 keeps the request active so a fresh offer can follow.
Request-level expiry (`→ expired`) is **not** implemented here (see §7).

> **Compatibility note — spec 015.** Spec 015 §4's ownership list attributes
> `offers_open → provider_selected` to "spec 019/020" and `→ expired` to "spec 018's offer timer /
> spec 026". Master spec §125 places Provider Selected at offer acceptance, which is this spec's
> action, so this spec seeds it; offer expiry and request expiry are different events, so this spec
> does not seed request `→ expired`. Spec 015 is approved and is **not** edited here; this is
> recorded for its owner.

### Offer creation — rules in evaluation order

Inside one transaction:

1. `requireIdempotencyKey`; fingerprint = `idempotencyFingerprint(body)`. An existing offer with
   `(provider_profile_id, idempotency_key)` → same fingerprint: return it (`200`, its current
   effective state, even if it has since expired); different fingerprint: `409 IDEMPOTENCY_KEY_CONFLICT`.
2. Validate the body (`400 VALIDATION_ERROR` naming each field) — bounds in "Request and response types".
3. `SELECT … FROM requests WHERE id = $1 FOR UPDATE` — serializes creation against accepts and
   other creations on the same request.
4. The provider's `request_provider_matches` row for the request must exist with `notified_at` set,
   else `403 NOT_DISTRIBUTED_TO_PROVIDER` (also returned for a non-existent request id, so ids cannot
   be probed).
5. Request status must be `matching` or `offers_open`, else `422 REQUEST_NOT_ACTIONABLE`.
6. `services.pricing_model` must be `quote` or `custom` (spec 017's `actionForPricingModel`), else
   `422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL`.
7. The match row's `provider_response` must be `none` or `offer_sent`; `declined` or `accepted`
   → `422 REQUEST_NOT_ACTIONABLE`.
8. If the request has a budget, `currencyCode` must equal the budget currency, else
   `400 VALIDATION_ERROR` on `currencyCode` (an offer in a different currency cannot be compared
   with the budget — spec 017's `priceFit` — and this repository has no FX conversion).
9. If this provider has any offer on this request with stored status `declined`
   → `422 REQUEST_NOT_ACTIONABLE` (a customer "no" is final for this spec; changing terms after a
   customer response is spec 019's negotiation flow, master spec §36).
10. If this provider has a stored `sent`/`viewed` offer on this request **past** `expires_at`, it is
    first persisted as `expired` (history actor `null`) in this same transaction, so a stale,
    not-yet-swept row can never block AC-5's fresh offer.
11. If this provider still has a **live** offer on this request → `409 LIVE_OFFER_EXISTS`.
12. Insert + `draft → sent` as above; set the match row's `provider_response = 'offer_sent'` and
    `responded_at = clock_timestamp()` when it was `none` (spec 017 reserved this value for this
    spec); if the request is `matching`, transition it to `offers_open`.

The partial unique index on live offers per `(request_id, provider_profile_id)` is the independent
database guarantee behind step 11.

### Accept — rules in evaluation order

Inside one transaction:

1. `requireIdempotencyKey` (`400` if missing).
2. `SELECT … FROM requests WHERE id = <offer.request_id> FOR UPDATE`, then
   `SELECT … FROM offers WHERE id = $1 FOR UPDATE` — **always request first, then offer**, the same
   lock order creation uses, so no deadlock is possible between the two paths. (A missing offer, or
   one on a request the caller does not own → `404 OFFER_NOT_FOUND`.)
3. Stored `accepted` with `accept_idempotency_key = key` → `200` with the offer (idempotent replay).
4. Stored `accepted` (different key), `declined` or `withdrawn` → `409 OFFER_ALREADY_DECIDED`.
5. Stored `expired`, **or** stored `sent`/`viewed` with `clock_timestamp() >= expires_at`
   → `422 OFFER_EXPIRED`.
6. Request status `provider_selected` or `booking_created` → `409 REQUEST_ALREADY_CLAIMED`; any other
   status except `offers_open` → `422 REQUEST_NOT_ACTIONABLE`.
7. `UPDATE offers SET status = 'accepted', decided_at = clock_timestamp(), accept_idempotency_key = $key`;
   history row; request `offers_open → provider_selected` with its history row.

Decline follows the same lock order and steps 3–6 (with natural idempotency instead of a key: stored
`declined` → `200`; request not `offers_open` → `422 REQUEST_NOT_ACTIONABLE`). Withdraw locks the
offer only (it never changes the request): stored `withdrawn` → `200`; other terminal →
`409 OFFER_ALREADY_DECIDED`; not live → `422 OFFER_EXPIRED`. Other live offers on a request remain
untouched when one is accepted — they can no longer be accepted (step 6) and expire naturally within
2 minutes.

### Concurrency and the single-accept invariant

**At most one offer per request may ever be `accepted`, and an offer can never be both past
`expires_at` and `accepted`.** Enforced by independent layers:

1. **Application** — the locks and post-lock clock read above.
2. **Database** — partial unique index `offers (request_id) WHERE status = 'accepted'`;
   `offers_request_provider_live_uq` on `(request_id, provider_profile_id) WHERE status IN
   ('draft','sent','viewed')`; and the trigger-enforced transition table (no path from `expired`).
3. **Sweep isolation** — the cron sweep selects due rows with `FOR UPDATE SKIP LOCKED`, so it never
   blocks on, or overwrites, an offer an accept currently holds; its `UPDATE` re-evaluates
   `status IN ('sent','viewed') AND expires_at <= clock_timestamp()` so a row accepted in the
   meantime is skipped. A row it skipped is re-examined on the next run.

An accept that holds the offer lock and reads `clock_timestamp() < expires_at` may commit a few
milliseconds after `expires_at`. That is correct and intended: the decision instant is the post-lock
clock read, which was inside the window; the sweep cannot expire that row because it is locked, and
after commit it is no longer `sent`/`viewed`.

### Background expiry (AC-3)

- **Mechanism (decided by spec 001 §8):** a Vercel Cron job calling
  `GET /api/v1/cron/offer-expiry-sweep`, authenticated exactly like the existing sweeps
  (`Authorization: Bearer ${CRON_SECRET}`, `401` otherwise), delegating to
  `runOfferExpirySweep()` in `lib/offers/expiry.ts`. Registered in `vercel.json` with schedule
  **`* * * * *`**. The architecture document's `apps/worker` job queue (§10) does not exist; spec 001
  §8 superseded it, and spec 046 has not shipped a queue or dead-letter mechanism.
- **Why every minute, and why that is sufficient.** One minute is the finest granularity Vercel Cron
  offers, so the draft's "sub-10-second sweep" is not achievable under the decided mechanism. It is
  also not needed for correctness: no accept/decline/withdraw ever relies on the persisted status
  (they re-check `expires_at` after locking), and every read reports the **effective** status. The
  sweep only makes the stored state converge. Worst case: an offer expiring just after a run is
  persisted by the next run, i.e. within **120 s** of `expires_at`, including scheduling jitter.
- **Batching:** each run expires due rows in batches of **500** (a `WITH due AS (SELECT id, status …
  FOR UPDATE SKIP LOCKED LIMIT 500) UPDATE … RETURNING` statement, writing one history row per
  expired offer with its true `from_status`), repeating until a batch returns fewer than 500 rows or
  **45 seconds** have elapsed, so one run can never overlap the next.
- **Idempotent and retry-safe by construction:** it only touches rows still `sent`/`viewed` and past
  expiry; re-running, or two runs overlapping, can expire a row at most once (the trigger and the
  `WHERE` both forbid `expired → expired`). A failed run is retried by the next minute's run — no
  separate retry/dead-letter mechanism is introduced (that is spec 046's).
- **Observability:** one structured log line per run —
  `{ event: 'offers.expiry_sweep', expired, batches, durationMs }` — and
  `{ event: 'offers.expiry_sweep_failed', error }` on failure, the same `console` JSON convention the
  existing sweeps and `withApiRoute` use.

### Provider inbox integration (spec 017)

- `IncomingRequestDto` (`lib/types/matching.ts`) gains
  `currentOffer: { offerId: string; status: VisibleOfferStatus; expiresAt: string; serverNow: string } | null`
  — the provider's most recent offer on that request (effective status), never another provider's.
- `availableActionFor` (`lib/matching/actions.ts`) is extended, and **only** for `quote`/`custom`
  services: `providerResponse = 'offer_sent'` on an actionable request yields `send_offer` again
  when the provider has no live offer and no `declined` offer on the request (AC-5); otherwise
  `decline_only`. Fixed/package/hourly behaviour is unchanged.

> **Compatibility note — spec 017.** Spec 017 §3 reports `decline_only` for any provider who "has
> already responded". AC-5 (master spec §32: "Provider can send a new offer if request remains
> active") requires re-offer after expiry, so this spec narrows that rule for `offer_sent` only.
> Spec 017's document is approved and is not edited; the code change lands with this spec.

### Error codes

Codes outside spec 004's baseline map pass `options.status` explicitly (the spec 005/016/017
convention). Codes reused from earlier specs keep their existing meaning.

| HTTP | `code` | Source | When |
|---|---|---|---|
| `400` | `VALIDATION_ERROR` | 004 | invalid body field, missing/overlong `Idempotency-Key`, currency ≠ request budget currency |
| `401` | `UNAUTHENTICATED` | 004 | no valid session; cron route: `401 UNAUTHORIZED` body as existing sweeps |
| `403` | `FORBIDDEN` | 004 | wrong active mode |
| `403` | `CSRF_TOKEN_INVALID` | 005 | mutation without a valid CSRF header |
| `403` | `NOT_DISTRIBUTED_TO_PROVIDER` | 017 | offer creation by a provider not distributed into the request (or unknown request) |
| `404` | `NOT_FOUND` | 016 | provider route, session user has no provider profile |
| `404` | `REQUEST_NOT_FOUND` | 015 | offer list for a request the caller does not own or that does not exist |
| `404` | `OFFER_NOT_FOUND` | **new** | offer does not exist or caller is not its customer/provider |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | 015 | same key, different creation body |
| `409` | `LIVE_OFFER_EXISTS` | **new** | provider already has a live offer on this request |
| `409` | `OFFER_ALREADY_DECIDED` | **new** | accept/decline/withdraw on an offer already in a different terminal state (incl. accepted under a different key) |
| `409` | `REQUEST_ALREADY_CLAIMED` | 017 | accept when another offer on the request was already accepted |
| `422` | `OFFER_EXPIRED` | **new** | accept/decline/withdraw at or after `expires_at` |
| `422` | `REQUEST_NOT_ACTIONABLE` | 017 | request not in an acting status; provider already declined/accepted via spec 017; customer already declined this provider's offer |
| `422` | `ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL` | 017 | offer on a fixed/package/hourly service |
| `429` | `RATE_LIMITED` | 004 | `offers` domain budget exceeded |

### Breaking-change check

- [x] No existing route changes path, auth or status codes. `IncomingRequestDto` gains one additive
  field (`currentOffer`); `availableAction` can newly return `send_offer` after `offer_sent` for
  quote/custom services only (compatibility note above).

---

## 4. Data model changes

Drizzle ORM (`lib/db/schema.ts`), not Prisma. Constraints enforced by `lib/db/schema-lint.test.ts`
apply: no `numeric`/`real`/`double precision` (money via `moneyColumns`), every timestamp
`timestamptz`, every FK `onDelete: 'restrict'` with a covering index, every jsonb column on the
documented allowlist.

### Entities

| Entity | Change | Fields / constraints |
|---|---|---|
| `offers` | **extend** (spec 003 baseline: `id`, audit, `version`, `request_id`, `provider_profile_id`, both indexed, `status text not null`) | `...moneyColumns('price')` → `price_amount_minor_units integer not null`, `price_currency_code text not null` (+ `moneyPairChecks('offers','price')`, CHECK amount `> 0`); `included_items jsonb not null default '[]'`; `provider_message text null`; `estimated_duration_minutes integer null` (CHECK `between 1 and 1440`); `sent_at timestamptz null`; `expires_at timestamptz null`; `viewed_at timestamptz null`; `decided_at timestamptz null`; `idempotency_key text not null`; `idempotency_fingerprint text not null`; `accept_idempotency_key text null` |
| `offers` CHECKs | new | `status in ('draft','sent','viewed','revised','accepted','declined','expired','withdrawn')` (`revised` reserved for spec 019, never written here); `(status = 'draft') = (sent_at is null)`; `(sent_at is null) = (expires_at is null)`; `expires_at is null or expires_at = sent_at + interval '2 minutes'`; `(decided_at is not null) = (status in ('accepted','declined','withdrawn'))`; `(accept_idempotency_key is not null) = (status = 'accepted')` |
| `offers` indexes | new | unique `(provider_profile_id, idempotency_key)`; partial unique `(request_id, provider_profile_id) WHERE status IN ('draft','sent','viewed')`; partial unique `(request_id) WHERE status = 'accepted'`; `(status, expires_at)` for the sweep; `(request_id, sent_at)` for the customer list |
| `offers_status_transitions` | **seed** (spec 003 baseline) | the ten rows in §3 "Offer state machine" |
| `requests_status_transitions` | **seed** (spec 003 baseline) | exactly `('matching','offers_open')` and `('offers_open','provider_selected')` |

`offers.included_items` is added to the jsonb allowlist in `lib/db/schema-lint.test.ts` with its
rationale (a bounded list of display strings read back whole, never queried). **No new table is
added**, so `lib/db/schema-coverage.test.ts`'s `EXPECTED_TABLES` is unchanged.

**Deliberately unchanged:** `offer_revisions` and `offer_messages` (spec 003 baselines — their
columns are spec 019's; the draft's "new `OfferRevision`/`OfferMessage` tables" already exist and are
not this spec's to shape), `request_provider_matches` (spec 017 already defines `offer_sent`),
`requests` columns, `bookings` (spec 020), and every spec 016 table.

Master spec §31 lists further fields an offer "may include" — availability, terms, offer version.
`version` is the existing baseline column; **availability/proposed time and terms are not added**:
nothing in this spec consumes them, and spec 020 owns the scheduled time a booking is made for.

### Migration

- **Name:** `0014_add_offer_system_timer` (next after `0013_add_matching_ranking_distribution`)
- **Generated by:** `npm run db:generate` (drizzle-kit), with the two transition seeds hand-appended
  in the same style as `0011`/`0013`. The spec 003 baseline and its `.sha256` are **not** touched.
- **Reversible:** yes — hand-written `0014_add_offer_system_timer_down.sql` (constraints and indexes
  first, then columns, then deletes exactly the seeded transition rows), as `0012`/`0013` shipped.
- **Backfill required:** no — `offers` has no rows (nothing could create one before this spec).
- **Downtime:** none.

### Retention and privacy

Integrates with **spec 008's existing** mechanism; no new privacy path:

- **Export** (`lib/privacy/export.ts`): a new `offers` section with an explicit column allowlist —
  `asCustomer`: offers on the caller's own requests (ownership through `customer_profiles`, the join
  the `requests` section already uses); `asProvider`: offers where the caller's provider profile is
  `provider_profile_id`. Fields: `id`, `requestId`, `status`, `priceAmountMinorUnits`,
  `currencyCode`, `includedItems`, `providerMessage`, `estimatedDurationMinutes`, `sentAt`,
  `expiresAt`, `decidedAt`. Idempotency keys/fingerprints are never exported. Offers from *other*
  providers on the caller's request are included for the customer (they are offers made to them);
  a provider never exports another provider's offers.
- **Deletion** (`lib/privacy/deletion.ts`): offer rows are retained (every FK is `restrict`, and an
  accepted offer is the parent of spec 020's booking). When a **provider's** account is swept,
  their offers' `provider_message` is redacted to `REDACTED_DESCRIPTION` (`'[redacted]'`), the same
  sentinel spec 015 uses for request descriptions; price, currency, `included_items` and timestamps
  are retained as the commercial record. `provider_profiles.business_name` is already nulled by the
  existing sweep.
- **Never exposed:** idempotency keys and fingerprints; a provider never sees another provider's
  offer, price or status (the provider inbox carries only `currentOffer` for the caller).

---

## 5. UI states

Built only from the existing APURIVA Design System via `@/components`, styled with
`app/styles/apuriva-tokens.css` tokens. The Design System already ships the two components this
spec needs — `ui/components/marketplace/OfferCard` and `OfferTimer` — but they are not yet
re-exported from `components/index.ts`; this spec adds **re-exports only** (`components/OfferCard.tsx`,
`components/OfferTimer.tsx`, following the existing one-file re-export pattern), with no new
primitive, no token override and no redesign of any shipped screen.

| Surface | State | Behaviour |
|---|---|---|
| Customer — `app/requests/[id]/page.tsx` (spec 015's status view, extended with an offers section) | **Loading** | DS `Skeleton` while `GET /requests/{id}/offers` resolves |
| | **Empty** | "Waiting for offers" with the request's elapsed time since submission, never a blank panel |
| | **Error** | load failure → DS `ErrorState` with retry; `OFFER_EXPIRED` → DS `Alert` "This offer expired — the provider can send a new one"; `REQUEST_ALREADY_CLAIMED` → "You've already selected a provider for this request"; `OFFER_ALREADY_DECIDED` → the offer's actual current state; the list is refetched after every error |
| | **Success** | one `OfferCard` per offer with `OfferTimer`; live offers show Accept/Decline; terminal offers show their status and no actions (AC-4); after accept, the page shows "Provider selected — booking is the next step" and the request timeline advances. **No booking is created and no booking UI is opened** |
| Provider — `app/provider/requests/page.tsx` (spec 017's inbox) | **Success** | spec 017's disabled "Send offer (coming soon)" becomes a working form (price, currency, included items, message, estimated duration) that sends a fresh `Idempotency-Key` per form submission; a live `currentOffer` shows `OfferTimer` and Withdraw; an expired/withdrawn offer shows its status and, when `availableAction` is `send_offer` again, the form (AC-5) |
| | **Error** | `LIVE_OFFER_EXISTS`, `REQUEST_NOT_ACTIONABLE`, `OFFER_EXPIRED` each show their specific DS `Alert` message; the row refetches |

**Countdown (cosmetic only).** `OfferTimer` receives `secondsRemaining`, computed as
`max(0, ceil((expiresAt − serverNow) / 1000) − elapsedSinceFetch)`, where `elapsedSinceFetch` uses the
browser's monotonic `performance.now()` — so a wrong device clock cannot lengthen or shorten the
display. The UI never disables or enables an action from the countdown alone: when it reaches 0 the
view refetches and renders whatever the server returns.

**Refresh without a real-time layer.** Architecture §6.1's WebSocket layer does not exist in this
repository. While any live offer is displayed the view refetches every **10 seconds**, on window
focus, and when a countdown reaches 0; each refetch replaces local state entirely (architecture §6.1:
"refresh authoritative state rather than trusting local state"). WebSocket delivery is not
introduced by this spec.

**Accessibility.** The remaining time is exposed as text (not colour alone); the countdown is not an
`aria-live` region per second — only the transition to expired is announced; `prefers-reduced-motion`
disables any timer animation.

---

## 6. Test plan

**Vitest only.** This repository has **no Playwright or Cypress**, no `lib/mcp` (spec 036 is not
built) and no worker app, so the draft's `apps/web-e2e`, `packages/mcp` and `apps/worker` rows are
removed rather than promised. Integration tests run against the isolated `<name>_test` database only
(`vitest.config.ts` rewrites `DATABASE_URL`; `test/db-reset.ts` refuses any other name), use
`describe.skipIf(!dbReachable)`, call `resetRateLimitState()` in `beforeEach`, and never mock the
database clock: boundary fixtures instead seed `sent_at`/`expires_at` relative to
`clock_timestamp()` (e.g. `sent_at = clock_timestamp() - interval '120001 milliseconds'`), which the
CHECK constraint still accepts. Concurrency tests use **real separate connections**, following
`lib/db/concurrency.integration.test.ts`, `lib/availability/reserve.integration.test.ts` and
`lib/matching/claim.integration.test.ts`.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | body validation and bounds; effective-status derivation (live strictly before `expires_at`, expired at equality); `OFFER_WINDOW` is exactly 2 minutes; countdown arithmetic; extended `availableActionFor` | `lib/offers/validation.test.ts`, `lib/offers/timer.test.ts`, `lib/matching/actions.test.ts` |
| **Integration** | creation rules and ordering, idempotent creation, re-offer, decline/withdraw, request transitions, history rows, DB CHECK/transition enforcement | `lib/offers/create.integration.test.ts`, `lib/offers/decide.integration.test.ts` |
| **Timing** | accept at `T+1:59` succeeds; at `T+2:00:00.001` and `T+2:00:01` rejected; lock-wait past expiry rejected | `lib/offers/expiry-boundary.integration.test.ts` |
| **Concurrency** | AC-6 (a)–(d) across two real connections | `lib/offers/accept-race.integration.test.ts` |
| **Background** | sweep expires due rows without any read, batching, idempotent re-run, `SKIP LOCKED` behaviour, cron auth | `lib/offers/expiry-sweep.integration.test.ts`, `app/api/v1/cron/offer-expiry-sweep/route.integration.test.ts` |
| **API** | every route's auth, mode, CSRF, ownership/404 rules, rate limiting, envelopes | `app/api/v1/offers/offers.integration.test.ts` |
| **Component** | customer offers panel and provider send-offer form states; countdown never gates actions | `app/requests/[id]/page.test.tsx`, `app/provider/requests/page.test.tsx` (Testing Library, jsdom) |
| **Privacy** | export includes own offers only, no idempotency data; provider deletion redacts `provider_message` | `lib/privacy/export.integration.test.ts`, `lib/privacy/deletion.integration.test.ts` |
| **Schema / contract** | jsonb allowlist entry; OpenAPI drift | `lib/db/schema-lint.test.ts`; `npm run check:openapi-drift` |

**Traceability** — every acceptance criterion:

| AC | Test |
|---|---|
| AC-1 | `lib/offers/expiry-boundary.integration.test.ts::rejects accept at T+2:00:00.001 and T+2:00:01 with 422 OFFER_EXPIRED and writes nothing`, `::rejects an accept whose lock wait ends after expires_at`, `::an expired offer can never later become accepted`; `lib/offers/timer.test.ts::an offer is expired exactly at expires_at` |
| AC-2 | `lib/offers/expiry-boundary.integration.test.ts::accepts at T+1:59 and moves the request to provider_selected` |
| AC-3 | `lib/offers/expiry-sweep.integration.test.ts::persists expired with a null-actor history row without any client read`, `::expires more than one batch in a single run`, `::re-running never double-expires`; `app/api/v1/offers/offers.integration.test.ts::reads report expired before the sweep runs`; `app/api/v1/cron/offer-expiry-sweep/route.integration.test.ts::rejects a missing or wrong CRON_SECRET` |
| AC-4 | `app/api/v1/offers/offers.integration.test.ts::terminal offers remain listed for the customer and readable by the provider`; `lib/offers/decide.integration.test.ts::no path deletes an offer row` |
| AC-5 | `lib/offers/create.integration.test.ts::a provider can re-offer after expiry or withdrawal with an independent window`, `::a stale unswept offer is expired in the creating transaction`, `::409 LIVE_OFFER_EXISTS while a live offer exists`, `::re-offer after a customer decline is 422 REQUEST_NOT_ACTIONABLE`; `lib/matching/actions.test.ts::offer_sent yields send_offer again only without a live or declined offer` |
| AC-6 | `lib/offers/accept-race.integration.test.ts::(a) same key concurrent accepts both return the identical offer`, `::(b) different keys — exactly one 200, one 409 OFFER_ALREADY_DECIDED`, `::(c) two offers on one request — exactly one accepted, one 409 REQUEST_ALREADY_CLAIMED`, `::(d) accept racing the sweep never yields accepted and expired`, `::the partial unique index rejects a second accepted offer even bypassing the lock`, `::no booking row is created` |
| AC-7 | `lib/offers/create.integration.test.ts::403 NOT_DISTRIBUTED_TO_PROVIDER for an undistributed provider`, `::422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL for fixed/package/hourly`, `::422 REQUEST_NOT_ACTIONABLE outside matching/offers_open`, `::client-supplied sentAt/expiresAt/status are ignored and expires_at = sent_at + 2 minutes`, `::first offer moves matching to offers_open and sets provider_response offer_sent` |
| AC-8 | `lib/offers/decide.integration.test.ts::decline and withdraw set decided_at`, `::repeating the same action returns 200`, `::a different terminal action returns 409 OFFER_ALREADY_DECIDED`, `::decline/withdraw after expiry return 422 OFFER_EXPIRED` |
| AC-9 | `lib/offers/create.integration.test.ts::same key and body returns the original offer with 200 and one row`, `::same key different body is 409 IDEMPOTENCY_KEY_CONFLICT`, `::missing Idempotency-Key is 400` |

**Coverage:** ≥80% on new code — the repository's established standard; the timing and concurrency
suites above are mandatory, not optional, given master spec §115 and §132.4.

**Not covered, deliberately:** exact countdown copy/animation; MCP tool behaviour (spec 036 must call
the same `lib/offers/*` functions so it inherits these guarantees, tested in spec 036).

---

## 7. Out of scope

- Offer negotiation, change requests, revisions (`revised`), pre-booking chat and offer comparison
  (**spec 019**).
- Booking creation from an accepted offer, and `provider_selected → booking_created` (**spec 020**).
- Payment of any kind (spec 021).
- Notification delivery for new, expiring, accepted or declined offers (**spec 026**).
- Request-level expiry (`requests → expired`) — no expiry policy for requests is defined in the
  master spec or any approved spec; it is not an offer-timer event.
- Real-time WebSocket delivery (architecture §6.1) — polling is used (§5).
- MCP `send_offer` / `accept_offer` / `get_offers` tools (**spec 036**).
- Any admin surface for offers.
- A configurable timer duration — master spec §32 fixes it at exactly 2 minutes.

---

## 8. Risks and open questions

### Decisions resolved in this review

| # | Question | Resolution | Basis |
|---|---|---|---|
| D-1 | Expiry sweep mechanism and latency bound (draft risk #1, "recommend sub-10-second") | **Vercel Cron, `* * * * *`, persisted within 120 s**; correctness does not depend on the sweep | Spec 001 §8 decided Vercel Cron (minute granularity); every decision re-checks `expires_at` post-lock and every read returns effective status |
| D-2 | Offer creation route | `POST /api/v1/offers` | Approved spec 017 §3; master spec §125 / architecture §6 |
| D-3 | Re-offer after a customer decline | Not permitted in this spec | Master §32 grants a fresh offer on **expiry**; changing terms after a customer response is §36 negotiation (spec 019) |
| D-4 | Who moves the request to `provider_selected` | This spec, on accept | Master §125 order; see spec 015 compatibility note |
| D-5 | Idempotency scope | Required on create and accept; natural idempotency on decline/withdraw | `lib/api/idempotency.ts` names spec 018; spec 036 MCP action tools require keys |

### Non-blocking risks

| # | Risk | Owner | Resolution |
|---|---|---|---|
| 1 | Per-minute Vercel Cron requires a hosting plan that allows it; the hosting plan is still open in spec 046 §8 #1 | Platform | **Deployment prerequisite, not an implementation blocker** — correctness holds at any sweep frequency; only the AC-3 120 s persistence bound depends on it |
| 2 | Spec 019's draft says revision "resets 2-minute timer per spec 017" and that `OfferRevision`/`OfferMessage` are "stubbed in spec 017" | Spec 019 owner | Reported, not edited: the tables are spec 003 baselines; spec 019 must define a revision's window without violating this spec's rule that `expires_at` is set once per offer row and never extended |
| 3 | `docs/specs/INDEX.md` says 019 reuses entities "stubbed in spec 018" | Docs | Reported, not edited — they are spec 003 baselines |
| 4 | Live offers from other providers remain live (but unacceptable) for up to 2 minutes after one is accepted | Product | Accepted — they cannot be accepted (`REQUEST_ALREADY_CLAIMED`) and expire naturally; no extra transition is invented |
| 5 | No feature flag, retry/dead-letter or job-run table exists (specs 041/046 unbuilt) | Platform | Accepted — the per-minute re-run is the retry; nothing parallel is invented |

No blocking open question remains.

---

## 9. Rollout

- **Feature flag:** none — core to the marketplace's trust model, and `feature_flags` is still spec
  003's column-less baseline (spec 041).
- **Migration order:** `0014_add_offer_system_timer` ships with the code; the `vercel.json` cron entry
  ships in the same deploy. `CRON_SECRET` already exists for the other sweeps.
- **Rollback:** revert the deploy and apply `0014_add_offer_system_timer_down.sql`
  (`npm run db:rollback` pattern). In-flight offers need no special handling: `expires_at` is stored,
  so any code version evaluates the same instant.
- **Observability:** the sweep's per-run log line (`expired`, `batches`, `durationMs`), plus
  `offers.accept_rejected` logs tagged with the error code (`OFFER_EXPIRED`,
  `OFFER_ALREADY_DECIDED`, `REQUEST_ALREADY_CLAIMED`) through the existing correlation-id logging —
  a spike in expired-at-accept or race rejections indicates a timer or UI refresh bug (master spec
  §117); consumed by spec 040.
