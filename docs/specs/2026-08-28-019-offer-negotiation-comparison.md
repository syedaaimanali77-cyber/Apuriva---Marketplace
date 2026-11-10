# Spec: Offer Negotiation & Comparison

**File:** `docs/specs/2026-08-28-019-offer-negotiation-comparison.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §23, §31–§36, §54–§55, §124–§125, §132.4, §132.5, §132.9, §132.12–§132.16, §132.18, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4 (Offers module), §5.2, §5.4, §6.1, §9.5, §14, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (baseline `offer_revisions`, `offer_messages`, `offers_status_transitions`,
the `enforce_status_transition()` trigger, `moneyColumns`/`moneyPairChecks`), spec 004 (envelope,
error codes, the existing `messaging` rate-limit domain, OpenAPI registry), spec 005 (session, CSRF),
spec 006 (`requireActiveMode`, customer/provider profiles), spec 008 (privacy export/deletion,
`REDACTED_DESCRIPTION`), spec 012 (coarse distance/area privacy), spec 015 (requests,
`lib/api/idempotency.ts`), spec 016 (`requireOwnProviderProfile`), spec 017
(`request_provider_matches.rank`/`score_breakdown`/`notified_at`/`provider_response`, the AC-6
admin-only explainability rule), **spec 018** (the `offers` table, 2-minute window, accept/decline/
withdraw, expiry sweep, the reserved `revised` status) — all *approved and implemented*.
**Feeds:** spec 020 (booking creation reads the accepted offer row's immutable price), spec 025
(post-selection conversations), spec 026 (delivery of message/change-request/revision
notifications), spec 029 (populates `rating`), spec 036 (`send_provider_message`,
`request_offer_change` MCP tools must call this spec's `lib/negotiation/*` functions), spec 038
(consumes the contact-redaction log signal).

> **Numbering note.** This document's `**File:**` line previously read `...-018-offer-negotiation-comparison.md`,
> and its body referred to the offer system as "spec 017", ranking as "spec 016", and the tables
> as "stubbed in spec 017". The repository's authoritative numbering — `docs/specs/INDEX.md`,
> `docs/specs/README.md` and the approved specs 015, 017 and 018 — is **015 = Request Creation,
> 016 = Availability & Service Areas, 017 = Matching & Distribution, 018 = Offer System & Timer,
> 019 = this spec, 020 = Booking Creation, 025 = Messaging & Conversations**. Every reference below
> uses that numbering. `offer_revisions` and `offer_messages` are **spec 003 baseline tables**
> (`drizzle/0001_baseline_schema.sql`), not stubs from spec 017 or 018.

---

## 1. Problem statement

**Today:** Spec 018 ships offers end to end — one `offers` row per sent offer with a
database-computed, never-extended 2-minute window, accept/decline/withdraw, the expiry sweep, and a
customer offers panel. But the customer can only accept or decline an offer as sent, a provider
cannot clarify a request before pricing it, and there is no side-by-side comparison. `offers.status`
already allows `revised`, but no transition into it is seeded and nothing writes it.
`offer_revisions` and `offer_messages` exist only as spec 003 skeletons (`id`, audit columns,
`version`, one FK each) with **zero rows** — no code path in `lib/` or `app/` reads or writes them.

Master spec §33 allows limited, request-tied chat before provider selection, with contact-sharing
protection and anti-spam limits. §34–§35 require comparable offer display — price,
availability/arrival, rating, distance, badges, what's included, provider message, "why this
provider", Top Match — and comparison of up to 3 providers/offers where it makes sense. §36 gives
the customer Accept / Decline / Request change and the provider Accept / Send revised offer:
every price change is recorded, and both sides confirm the final price.

**Who is affected:** Customers deciding between offers on quote/custom-priced requests; providers
clarifying details before or after pricing.

**Why it matters now:** It is the next step after spec 018 in the established order
**015 → 016 → 017 → 018 → 019 → 020**. Spec 020's booking creation must be able to trust that an
accepted offer carries one exact, immutable, both-sides-confirmed price.

**Success looks like:** A distributed provider and the request's customer exchange request-specific
messages, with contact details removed and bursts rate-limited. A customer can request a change to
an offer. The provider answers with a revised offer, which is a *new offer row* with its own
database-computed 2-minute window, recorded in `offer_revisions` with old and new price, actor and
time. The customer accepts an exact offer row whose price the database will not let change. The
customer compares 2–3 live offers side by side, with a deterministic, rule-based "why this
provider".

> **Scope boundary.** This spec ends where spec 018 ends: at an **accepted** offer and the request in
> `provider_selected`. It creates **no booking** (spec 020) and **no post-selection conversation**
> (spec 025). Pre-selection message threads become read-only once the request leaves
> `matching`/`offers_open`.

### What spec 018 owns vs. what this spec adds

| Concern | Owned by spec 018 (unchanged) | Added by spec 019 |
|---|---|---|
| Offer row, price, 2-minute window, `expires_at = sent_at + 2 min` CHECK, sweep | ✔ | reuses; never modifies an existing row's `sent_at`/`expires_at` |
| `POST /offers`, `GET /offers/{id}`, `GET /requests/{id}/offers`, accept/decline/withdraw | ✔ | additive: accept/decline/withdraw answer `409 OFFER_SUPERSEDED` for a stored `revised` row; `OfferDto` gains four lineage fields; `POST /offers` gains contact redaction of free text |
| Single-accept invariant, lock order, idempotent accept | ✔ | revision/change-request follow the same request-first lock order |
| `offers_status_transitions` | ten seeded rows | seeds exactly `sent → revised`, `viewed → revised` |
| `revised` status | reserved, never written | written on a live offer superseded by a revision |
| Offer terms immutability | by convention (no update path) | enforced by a database trigger |
| Pre-selection message threads, change requests | — | ✔ (`offer_messages`) |
| Revision audit records | — | ✔ (`offer_revisions`) |
| Comparison, Top Match, "why this provider" | — | ✔ (read-only) |

---

## 2. Acceptance criteria

All times are the **database clock** (`clock_timestamp()`), as in spec 018. A *thread* is the pair
(request, provider): one customer ↔ one distributed provider. A *head* offer is a provider's most
recent non-draft offer row on a request. A *comparable* offer is defined in §3 "Comparison".

| # | Criterion |
|---|---|
| AC-1 | **Given** a request in `matching`/`offers_open` **When** the request's customer or a provider distributed into it (`notified_at` set) posts a message **Then** it is stored against that (request, provider) thread only, is readable only by those two parties (anyone else: `404 THREAD_NOT_FOUND`/`404 REQUEST_NOT_FOUND`, or `403 NOT_DISTRIBUTED_TO_PROVIDER` for an undistributed provider), carries only `senderRole` (never a user id, name, phone or email), and a sender's 6th message in the same thread within a rolling 10 minutes is rejected with `429 RATE_LIMITED` and a `Retry-After` computed from the database, writing nothing |
| AC-2 | **Given** 2 or more comparable offers on the customer's own `offers_open` quote/custom request **When** the customer requests the comparison **Then** 2–3 offers are returned, each with price, currency, previous price (if revised), included items, provider message, estimated duration, availability fit, approximate distance, rating (`null` until spec 029), badges, `isTopMatch` and `whyThisProvider`, in the canonical order of §3 — and no score, weight, breakdown value, rank number or exclusion reason |
| AC-3 | **Given** a head offer that is not accepted/declined/withdrawn/revised **When** the customer requests a change (a required note, optional proposed price) **Then** a `change_request` message is recorded on that offer, and the offer's price, status, `expires_at` and `version` are unchanged; the provider may answer only by sending a revised offer (which may match the proposed price) or by leaving the original to stand — never by altering the existing offer; a second change request on the same offer row returns `409 CHANGE_ALREADY_REQUESTED` |
| AC-4 | **Given** a provider's head offer in `sent`/`viewed`/`expired` **When** the provider submits a revision **Then**, in one transaction: a new `offers` row is created with its own database-computed `sent_at` and `expires_at = sent_at + 2 minutes`; the source row becomes `revised` if it was still live (or stays `expired` if it was not); the source row's `sent_at`/`expires_at`/price are untouched; and exactly one `offer_revisions` row records source and new offer ids, previous and new price, actor, `revision_number` and database time |
| AC-5 | **Given** a revised offer chain **When** the customer accepts **Then** they accept one specific offer row by id and the accepted price is that row's `price_amount_minor_units`/`price_currency_code`, which the database refuses to change on any non-draft row; accepting, declining or withdrawing a `revised` row returns `409 OFFER_SUPERSEDED` with `details.currentOfferId` and writes nothing — a price is never resolved as "latest" after the fact |
| AC-6 | **Given** a request with fewer than 2 comparable offers, a request not in `offers_open`, or a service whose `pricing_model` is not `quote`/`custom` **When** the comparison is requested without explicit ids **Then** the response is `200` with `available: false`, the specific `unavailableReason` and `offers: []`, and the customer UI shows no comparison entry point |
| AC-7 | **Given** message, change-request note, or offer/revision `providerMessage`/`includedItems` text **When** it contains an email address or a phone-number-like run of ≥ 10 digits (§3 "Contact redaction") **Then** each match is replaced by `[contact removed]` before storage, the unredacted text is never persisted or logged, the message is still delivered with `contactRedacted: true`, and the legitimate examples in §3 (prices, dates, times, house/street numbers, quantities) pass through unchanged |
| AC-8 | **Given** a thread **When** the request leaves `matching`/`offers_open`, the provider declined the request (spec 017), or the customer declined any of that provider's offers on the request **Then** further posts by either party return `422 THREAD_CLOSED`, and both parties can still read the full thread |
| AC-9 | **Given** concurrent operations on one offer or request **Then** exactly one outcome is committed: revise vs. accept → either the accept commits on the original price and the revise gets `409 OFFER_ALREADY_DECIDED`, or the revise commits and the accept gets `409 OFFER_SUPERSEDED` — never an accepted `revised` row, never an accepted row with a changed price; two revisions of the same source → one `201`, the other `409 OFFER_SUPERSEDED` (or `200` replay for the same `Idempotency-Key` and body); revise vs. expiry sweep → never both `revised` and `expired` on one row, and never two live offers for one provider on one request |
| AC-10 | **Given** a comparison request with explicit `offerIds` **When** more than 3 ids are sent **Then** `422 COMPARISON_LIMIT_EXCEEDED`; fewer than 2, duplicates or malformed ids → `400 VALIDATION_ERROR`; any id that is not a comparable offer on this request (including another customer's offer) → `422 OFFER_NOT_COMPARABLE` naming nothing about offers the caller does not own; exactly one offer on the request is `isTopMatch`, determined from all comparable offers regardless of which ids were selected |
| AC-11 | **Given** the same stored match rows and offers **When** the comparison is read any number of times **Then** `whyThisProvider` is identical, contains only the reason codes whose rule in §3 is satisfied by an **available** factor in the stored `score_breakdown` (or `isTopMatch`), in fixed order, and is `[]` when none apply — no free-form or AI-generated text |
| AC-12 | **Given** a user's data export or account deletion (spec 008) **Then** the export includes the threads, change requests and revisions the user took part in, with no idempotency data, user ids of the counterparty, or other providers' threads; deletion redacts the bodies the deleted user authored to `[redacted]`, and retains prices, revision records and the counterparty's messages |
| AC-13 | **Given** a revision request **When** its currency differs from the source (`400 VALIDATION_ERROR`), its terms are identical to the source (`422 REVISION_UNCHANGED`), the provider already has 5 revisions on the request (`422 REVISION_LIMIT_REACHED`), the provider has a `declined` offer on the request or declined the request (`422 REQUEST_NOT_ACTIONABLE`), or the source is not the head (`409 OFFER_SUPERSEDED`) **Then** nothing is written; a retry with the same `Idempotency-Key` and body returns the original revision with `200`, and with a different body `409 IDEMPOTENCY_KEY_CONFLICT` |

---

## 3. API contract

Routes live under `app/api/v1/**/route.ts` (single Next.js app — **not** `apps/api`/`apps/web`/
`packages/*`). Every route is `withApiRoute` (`lib/api/handler.ts`) calling a new `lib/negotiation/*`
module. Every route calls `requireSession`; every mutation also calls `requireCsrf`
(`lib/auth/require-session.ts`). Customer routes call `requireActiveMode(session, 'customer')` and
resolve ownership through the caller's `customer_profiles` row. Provider routes call
`requireActiveMode(session, 'provider')` and `requireOwnProviderProfile(session.userId)`
(`lib/availability/owner.ts`). **No route accepts the caller's own customer/provider id from the
client**: `{providerProfileId}` in the customer thread routes selects the counterparty and is
authorized server-side. No admin route is added. Route handlers read `{id}` segments from the URL
using the existing helper pattern (`app/api/v1/offers/offer-id.ts`,
`app/api/v1/requests/request-id.ts`, `app/api/v1/providers/me/requests/request-id.ts`).

**Non-participants get `404`, not `403`**, exactly as spec 015/018: a request, offer or thread that
does not exist and one the caller may not see are indistinguishable. `403 FORBIDDEN` is only a
wrong active mode; `403 NOT_DISTRIBUTED_TO_PROVIDER` is the spec 017/018 provider-route answer for a
request the provider was never distributed into.

**Rate limiting (DECIDED):** message routes use the **existing** `messaging` domain (`30 / 60_000`
per `session.userId`, already in `RATE_LIMIT_DEFAULTS`, currently unused). Change-request, revision
and comparison routes use spec 018's `offers` domain (`30 / 60_000`). No new domain is added. The
per-thread anti-spam limit below is **separate** and enforced in the database, because the
in-memory limiter is single-process.

**Idempotency (DECIDED):** `Idempotency-Key` is **required** on every POST in this spec (message,
change request, revision) — each creates a row a retry would otherwise duplicate, and spec 036's
`send_provider_message`/`request_offer_change` action tools require keys. Reuses
`requireIdempotencyKey`/`idempotencyFingerprint` from `lib/api/idempotency.ts`. Storage is
per-entity: message and change-request keys on `offer_messages` (unique per `sender_user_id`);
revision keys on the **new `offers` row** in spec 018's existing `idempotency_key`/
`idempotency_fingerprint` columns (unique per `provider_profile_id`). The revision fingerprint
covers `{ sourceOfferId, body }`, so reusing a `POST /offers` key for a revision (or vice versa)
is a `409 IDEMPOTENCY_KEY_CONFLICT`, never a false replay.

**OpenAPI:** every route below is added to `OPENAPI_ROUTES` (`lib/api/openapi-registry.ts`) in the
same PR, tag `negotiation`; `npm run check:openapi-drift` (`scripts/check-openapi-drift.ts`) fails
otherwise. The summaries of spec 018's existing `/offers/{id}/accept`, `/offers/{id}/decline` and
`/offers/{id}/withdraw` entries are updated to mention `409 OFFER_SUPERSEDED` (no path or method
change).

### Endpoints

| Method | Route | Auth | Success | Errors |
|---|---|---|---|---|
| `GET` | `/api/v1/requests/{id}/message-threads` | session, customer mode, request owner | `200` `PagedResponse<MessageThreadSummaryDto>` | `401`, `403 FORBIDDEN`, `404 REQUEST_NOT_FOUND`, `429` |
| `GET` | `/api/v1/requests/{id}/message-threads/{providerProfileId}/messages` | session, customer mode, request owner | `200` `PagedResponse<OfferMessageDto>` | `401`, `403 FORBIDDEN`, `404 REQUEST_NOT_FOUND`, `404 THREAD_NOT_FOUND`, `429` |
| `POST` | `/api/v1/requests/{id}/message-threads/{providerProfileId}/messages` | session, customer mode, CSRF, request owner, **`Idempotency-Key`** | `201` `ApiResponse<OfferMessageDto>` (replay `200`) | `400`, `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `404 REQUEST_NOT_FOUND`, `404 THREAD_NOT_FOUND`, `409 IDEMPOTENCY_KEY_CONFLICT`, `422 THREAD_CLOSED`, `429` |
| `GET` | `/api/v1/providers/me/requests/{id}/messages` | session, provider mode | `200` `PagedResponse<OfferMessageDto>` | `401`, `403 FORBIDDEN`, `403 NOT_DISTRIBUTED_TO_PROVIDER`, `404 NOT_FOUND` (no provider profile), `429` |
| `POST` | `/api/v1/providers/me/requests/{id}/messages` | session, provider mode, CSRF, **`Idempotency-Key`** | `201` `ApiResponse<OfferMessageDto>` (replay `200`) | `400`, `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `403 NOT_DISTRIBUTED_TO_PROVIDER`, `404 NOT_FOUND`, `409 IDEMPOTENCY_KEY_CONFLICT`, `422 THREAD_CLOSED`, `429` |
| `POST` | `/api/v1/offers/{id}/change-requests` | session, customer mode, CSRF, request owner, **`Idempotency-Key`** | `201` `ApiResponse<OfferMessageDto>` (replay `200`) | `400`, `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `404 OFFER_NOT_FOUND`, `409 CHANGE_ALREADY_REQUESTED`, `409 IDEMPOTENCY_KEY_CONFLICT`, `409 OFFER_ALREADY_DECIDED`, `409 OFFER_SUPERSEDED`, `409 REQUEST_ALREADY_CLAIMED`, `422 REQUEST_NOT_ACTIONABLE`, `422 THREAD_CLOSED`, `429` |
| `POST` | `/api/v1/offers/{id}/revisions` | session, provider mode, CSRF, offer owner, **`Idempotency-Key`** | `201` `ApiResponse<OfferDto>` — the **new** offer (replay `200`) | `400`, `401`, `403 FORBIDDEN`, `403 CSRF_TOKEN_INVALID`, `404 NOT_FOUND`, `404 OFFER_NOT_FOUND`, `409 IDEMPOTENCY_KEY_CONFLICT`, `409 OFFER_ALREADY_DECIDED`, `409 OFFER_SUPERSEDED`, `409 REQUEST_ALREADY_CLAIMED`, `409 LIVE_OFFER_EXISTS` (DB backstop only), `422 REQUEST_NOT_ACTIONABLE`, `422 REVISION_UNCHANGED`, `422 REVISION_LIMIT_REACHED`, `429` |
| `GET` | `/api/v1/offers/{id}/revisions` | session; owning customer (customer mode) **or** owning provider (provider mode) | `200` `ApiResponse<OfferRevisionDto[]>` — the whole chain containing `{id}`, `revisionNumber ASC` | `401`, `403 FORBIDDEN`, `404 OFFER_NOT_FOUND`, `429` |
| `GET` | `/api/v1/requests/{id}/offers/compare` | session, customer mode, request owner; optional `?offerIds=a,b,c` | `200` `ApiResponse<OfferComparisonDto>` | `400`, `401`, `403 FORBIDDEN`, `404 REQUEST_NOT_FOUND`, `422 COMPARISON_LIMIT_EXCEEDED`, `422 OFFER_NOT_COMPARABLE`, `429` |

**Route shape — why not the draft's.** The draft's single `/requests/{id}/messages` for both parties
would have mixed customer and provider authorization in one handler and could not address a
customer's several provider threads. The split mirrors the approved structure: customer data under
`/requests/{id}/…` (spec 015/018), provider data under `/providers/me/requests/{id}/…` (spec 017).
The draft's `POST /offers/{id}/request-change` and `/revise` are renamed to resource-style
`/change-requests` and `/revisions` (each creates a row, `201`), consistent with `/offers` and
`/requests`.

### Request and response types

```typescript
// lib/types/negotiation.ts  (this repository has no packages/types)
import type { VisibleOfferStatus } from './offers';

export type NegotiationSenderRole = 'customer' | 'provider';
export type OfferMessageKind = 'message' | 'change_request';

export interface SendOfferMessageRequest {
  /** Trimmed, 1–1000 characters (measured before redaction). */
  body: string;
}

export interface CreateChangeRequestRequest {
  /** Trimmed, 1–500 characters (measured before redaction). */
  note: string;
  /** Optional positive integer ≤ 2_147_483_647, in the offer's own currency. Never a float. */
  proposedPriceAmountMinorUnits?: number | null;
}

/** Full replacement terms — the same bounds as spec 018's `CreateOfferRequest`, minus `requestId`. */
export interface ReviseOfferRequest {
  priceAmountMinorUnits: number;
  /** Must equal the source offer's currency. */
  currencyCode: string;
  includedItems?: string[];
  providerMessage?: string | null;
  estimatedDurationMinutes?: number | null;
}

export interface OfferMessageDto {
  id: string;
  requestId: string;
  providerProfileId: string;
  /** Set only for `change_request`: the offer row the change was requested on. */
  offerId: string | null;
  kind: OfferMessageKind;
  senderRole: NegotiationSenderRole;
  /** The stored, already-redacted text. */
  body: string;
  contactRedacted: boolean;
  /** `change_request` only; currency is the offer's. */
  proposedPrice: { amountMinorUnits: number; currencyCode: string } | null;
  createdAt: string;
}

export interface MessageThreadSummaryDto {
  providerProfileId: string;
  providerBusinessName: string | null;
  /** The provider's head offer on this request, if any (effective status). */
  headOffer: { offerId: string; status: VisibleOfferStatus } | null;
  messageCount: number;
  lastMessageAt: string | null;
  /** false when AC-8 closes the thread for sending. */
  canSend: boolean;
}

export interface OfferRevisionDto {
  id: string;
  /** The superseded source row. */
  previousOfferId: string;
  /** The new row created by the revision. */
  offerId: string;
  /** 1–5, per (request, provider). */
  revisionNumber: number;
  previousPrice: { amountMinorUnits: number; currencyCode: string };
  newPrice: { amountMinorUnits: number; currencyCode: string };
  actorRole: 'provider';
  /** The change request that prompted it, if the source offer had one. */
  changeRequestMessageId: string | null;
  createdAt: string;
}

export type ComparisonUnavailableReason =
  | 'fewer_than_two_comparable_offers'
  | 'request_not_open_for_offers'
  | 'pricing_model_not_offer_based';

/** Closed set. The UI maps each code to fixed copy (§5); the server never returns prose. */
export type WhyThisProviderReason = 'top_match' | 'available_at_requested_time' | 'nearby';

/** Closed set. `verified` = spec 017 `isVerified` (`provider_profiles.lifecycle_status = 'active'`). */
export type ProviderBadge = 'verified';

export interface ComparedOfferDto {
  offerId: string;
  providerProfileId: string;
  providerBusinessName: string | null;
  status: Extract<VisibleOfferStatus, 'sent' | 'viewed'>;
  priceAmountMinorUnits: number;
  currencyCode: string;
  /** The immediately previous row's price when this offer is a revision; else null. */
  previousPriceAmountMinorUnits: number | null;
  revisionNumber: number;
  includedItems: string[];
  providerMessage: string | null;
  estimatedDurationMinutes: number | null;
  /** From the stored `availability` factor at distribution time: 1 → 'exact', 0.5 → 'same_day', else null. */
  availabilityFit: 'exact' | 'same_day' | null;
  /** Spec 017's coarse `approxKm`; null when either point is unknown. Never coordinates. */
  approxDistanceKm: number | null;
  /** Always null until spec 029 ships a ratings source. */
  rating: { average: number; count: number } | null;
  badges: ProviderBadge[];
  isTopMatch: boolean;
  whyThisProvider: WhyThisProviderReason[];
  expiresAt: string;
}

export interface OfferComparisonDto {
  requestId: string;
  available: boolean;
  unavailableReason: ComparisonUnavailableReason | null;
  /** 2–3 entries when available; [] otherwise. Canonical order (below). */
  offers: ComparedOfferDto[];
  maxOffers: 3;
  serverNow: string;
}
```

```typescript
// lib/types/offers.ts — ADDITIVE fields on spec 018's OfferDto (no field removed or retyped)
export interface OfferDto {
  // …every spec 018 field unchanged…
  /** 0 for an offer not created by a revision. */
  revisionNumber: number;
  previousOfferId: string | null;
  previousPriceAmountMinorUnits: number | null;
  /** Set when this row is `revised`: the row that superseded it. */
  supersededByOfferId: string | null;
}
```

`IdempotencyKey`s, fingerprints, `sender_user_id`, `actor_user_id` and every `score_breakdown`
number are **never** serialized. Unknown body fields are ignored; client-supplied `status`,
`sentAt`, `expiresAt`, `revisionNumber`, `senderRole` or `contactRedacted` have no effect.
Message lists are paginated with `parsePageParams`/`buildPage` (`lib/api/pagination.ts`), ordered
`created_at ASC, id ASC`; thread summaries `last activity DESC, provider_profile_id ASC`.

### Revision model and timer (DECIDED)

Spec 018 fixes that an offer row's `sent_at`/`expires_at` are written once from one
`clock_timestamp()` read and **never recomputed or extended**, enforced by
`offers_two_minute_window_ck`. So a revision **does not reset, pause or extend any timer**. It
creates a **new offer row**, and that row gets its own window exactly as spec 018's creation does.
This is the same "fresh offer, independent window" rule as spec 018 AC-5 (master spec §32).

- **Superseding.** If the source row is still live, it moves `sent|viewed → revised` in the same
  transaction, before the new row is inserted. That is required anyway: `offers_request_provider_live_uq`
  allows one `draft|sent|viewed` row per provider per request. `revised` is **terminal at the row
  level**, with no transition out. Master §125's `Revised → Accepted` is realized across the chain:
  the chain continues on the new row, which can be accepted. `decided_at` stays null on a `revised`
  row, which `offers_decided_pairing_ck` already requires.
- **Revising an expired head.** If the source's effective status is `expired`, the provider may still
  revise it. This covers a customer who requests a change seconds before expiry. The source keeps
  `expired`: if not yet swept, it is persisted as `expired` with a null actor in the same
  transaction, exactly like spec 018 creation rule 10. The revision still links to it.
- **Change requests never touch the timer.** Requesting a change does not pause the source offer's
  window. The source may expire while the provider considers it, and the provider can still revise
  the expired head.
- **Provider "Accept" (master §36).** A provider accepts a customer's requested change by sending a
  revision with those terms. The UI pre-fills the proposed price. The customer must still accept that
  new row, so both sides confirm the exact price. A provider who keeps the original terms does
  nothing: the original offer stands until it expires, and the provider can say so in the thread.
  No separate "reject change" action or state is added.
- **Unprompted revisions** are allowed. A revision is never silent, because it is a new row the
  customer must accept and it is recorded in `offer_revisions`.
- **Fresh offers are not revisions.** A spec 018 `POST /offers` after expiry or withdrawal starts a
  new chain with `revisionNumber = 0` and no `offer_revisions` row. Every row keeps its immutable
  price forever (spec 018 AC-4), so the full price history of a (request, provider) pair can always
  be rebuilt from `offers` plus `offer_revisions`.

**Offer terms are immutable (DECIDED, new DB guarantee).** A `BEFORE UPDATE` trigger on `offers`
(`enforce_offer_terms_immutable()`) raises when `OLD.status <> 'draft'` and any of `request_id`,
`provider_profile_id`, `price_amount_minor_units`, `price_currency_code`, `included_items`,
`estimated_duration_minutes`, `sent_at` or `expires_at` differs. `provider_message` is deliberately
excluded, because spec 018's deletion sweep redacts it. Status, `viewed_at`, `decided_at`,
`accept_idempotency_key`, `updated_at` and `version` stay writable, so every spec 018 path works
unchanged (its creation inserts as `draft`, then sets `sent_at`/`expires_at` while `OLD.status = 'draft'`).

### Offer state machine additions

The migration seeds exactly **two** rows into `offers_status_transitions`
(`ON CONFLICT DO NOTHING`); each use writes an `offers_status_history` row in the same transaction:

| from | to | Actor | Trigger |
|---|---|---|---|
| `sent` | `revised` | provider's user | `POST /offers/{id}/revisions` on a live source |
| `viewed` | `revised` | provider's user | `POST /offers/{id}/revisions` on a live source |

No transition out of `revised`, and none into `revised` from `expired`/`accepted`/`declined`/
`withdrawn`. The expiry sweep (`status IN ('sent','viewed')`) and `markViewed` (`status = 'sent'`)
never touch a `revised` row. No request status transition is added.

### Spec 018 path extensions

- **Accept / decline / withdraw** (`lib/offers/decide.ts`): after taking the same locks, a stored
  `revised` row → `409 OFFER_SUPERSEDED` with `details.currentOfferId`. The current id comes from
  following `offer_revisions.new_offer_id` to the chain's end. This check runs at spec 018 accept
  step 4, **before** the expiry check, so a superseded row is never reported as `OFFER_EXPIRED`.
  Nothing else in spec 018's order changes.
- **Reads** (`lib/offers/read.ts`): `OfferDto` gains the four lineage fields through `LEFT JOIN`s on
  `offer_revisions`. `GET /requests/{id}/offers` keeps listing every row, `revised` ones included.
- **Creation** (`lib/offers/create.ts`): `providerMessage` and `includedItems` pass through contact
  redaction before insert. The idempotency fingerprint stays computed over the raw body, so retries
  still replay.
- **Provider inbox** (`lib/matching/provider-requests.ts`): unchanged. `currentOffer` is already the
  most recent row, which is the head.

> **Compatibility note — spec 018.** Spec 018 is approved and is **not** edited. Its text reserves
> `revised`, the columns of `offer_revisions`/`offer_messages`, and "changing terms after a customer
> response" for this spec. §8 risk 2 asks this spec to define a revision's window without extending
> `expires_at`, which the model above does. The additions (a new error code for a status spec 018
> never wrote, four additive DTO fields, redaction of offer free text, an immutability trigger that
> no spec 018 write path violates) are recorded here for its owner. Spec 018's D-3 stands: a
> customer's **decline** stays final. Negotiation starts from **Request change**, not from decline.

### Revision — rules in evaluation order

1. `requireIdempotencyKey`; fingerprint = `idempotencyFingerprint({ sourceOfferId, body })`. An
   existing `offers` row with `(provider_profile_id, idempotency_key)`: same fingerprint → return it
   (`200`, current effective state); different → `409 IDEMPOTENCY_KEY_CONFLICT`.
2. Validate the body (`400 VALIDATION_ERROR` per field; spec 018 bounds).
3. The source must be a non-draft offer with `provider_profile_id` = caller, else `404 OFFER_NOT_FOUND`.
4. Lock `requests` row `FOR UPDATE`, then the caller's `request_provider_matches` row `FOR UPDATE`,
   then the source `offers` row `FOR UPDATE`. That is **request → match → offer**, the order spec
   018 creation uses and a superset of accept's request → offer, so no deadlock is possible.
   Re-check step 1 under the lock.
5. Request `provider_selected`/`booking_created` → `409 REQUEST_ALREADY_CLAIMED`; any other status
   except `offers_open` → `422 REQUEST_NOT_ACTIONABLE`.
6. Match `provider_response` not in (`none`, `offer_sent`), or any offer from this provider on this
   request stored `declined` → `422 REQUEST_NOT_ACTIONABLE`.
7. Source stored `accepted`/`declined`/`withdrawn` → `409 OFFER_ALREADY_DECIDED`; stored `revised`,
   **or** a newer non-draft row exists for this (request, provider) → `409 OFFER_SUPERSEDED`
   (`details.currentOfferId`).
8. `currencyCode ≠` source currency → `400 VALIDATION_ERROR` on `currencyCode`.
9. Price, `includedItems` (after redaction, order-sensitive), `providerMessage` (after redaction)
   and `estimatedDurationMinutes` all equal the source → `422 REVISION_UNCHANGED`.
10. `count(offer_revisions)` for this (request, provider) `≥ 5` → `422 REVISION_LIMIT_REACHED`.
11. Post-lock clock read: source `sent|viewed` and `clock_timestamp() < expires_at` → `UPDATE … SET
    status = 'revised'` + history row (provider actor). Otherwise, if stored `sent|viewed` past
    expiry → persist `expired` (history actor `null`).
12. Insert the new row as `draft`, then `draft → sent` with `sent_at`/`expires_at` from one
    `clock_timestamp()` read, plus both history rows. This reuses spec 018's creation statements,
    extracted into a shared helper in `lib/offers/create.ts`, not duplicated. The match row already
    holds `offer_sent`, and the request is already `offers_open`.
13. Insert `offer_revisions` (`offer_id` = source, `new_offer_id`, `request_id`,
    `provider_profile_id`, previous/new price, `actor_user_id`, `change_request_message_id` = the
    source's change request if any, `revision_number` = step 10 count + 1,
    `created_at = clock_timestamp()`). Commit → `201`.

Database backstops: `offers_request_provider_live_uq` (→ `409 LIVE_OFFER_EXISTS`),
`offer_revisions_offer_id_uq` (→ `409 OFFER_SUPERSEDED`), `offer_revisions_request_provider_number_uq`
and `offer_revisions_number_ck` (→ `422 REVISION_LIMIT_REACHED`), `offers_provider_idempotency_key_uq`
(→ replay/conflict, as spec 018).

### Change request — rules in evaluation order

1. `requireIdempotencyKey`; fingerprint = `idempotencyFingerprint({ offerId, body })`; existing
   `offer_messages` row with `(sender_user_id, idempotency_key)` → replay `200` / `409 IDEMPOTENCY_KEY_CONFLICT`.
2. Validate (`note` 1–500 trimmed; `proposedPriceAmountMinorUnits` optional positive integer).
3. The offer must be non-draft on a request owned by the caller, else `404 OFFER_NOT_FOUND`.
4. Lock request → match row → offer (`FOR UPDATE`, same order as revision).
5. Request status as revision step 5.
6. AC-8 closure (provider declined the request, or any of the provider's offers on the request is
   `declined`) → `422 THREAD_CLOSED`.
7. Offer stored `accepted`/`declined`/`withdrawn` → `409 OFFER_ALREADY_DECIDED`; `revised` or not the
   head → `409 OFFER_SUPERSEDED`. Effective `expired` is **allowed**.
8. A `change_request` already exists on this offer row → `409 CHANGE_ALREADY_REQUESTED` (DB backstop:
   `offer_messages_change_request_per_offer_uq`).
9. Thread anti-spam window (below; a change request counts as a message) → `429`.
10. Redact `note`; insert `kind = 'change_request'`, `sender_role = 'customer'`, `offer_id`, proposed
    price paired with the offer's currency. The offer row is **not** updated. `201`.

### Messages — rules in evaluation order

1. `requireIdempotencyKey`; fingerprint = `idempotencyFingerprint({ requestId, providerProfileId, body })`;
   replay/conflict against `(sender_user_id, idempotency_key)`.
2. Validate `body` (1–1000 after trim).
3. Authorize:
   - **Customer:** the request must be the caller's, else `404 REQUEST_NOT_FOUND`. The thread exists
     for the customer only if `{providerProfileId}` has a non-draft offer on the request **or** has
     already posted in that thread, else `404 THREAD_NOT_FOUND`. The customer never sees spec 017's
     distribution pool, so a thread with a silent provider cannot be discovered or opened.
   - **Provider:** a `request_provider_matches` row with `notified_at` set, else
     `403 NOT_DISTRIBUTED_TO_PROVIDER` (also for an unknown request id). A provider can therefore
     ask a clarifying question **before** sending an offer (master §33).
4. `SELECT … FROM requests … FOR SHARE`, then the match row `FOR UPDATE`. The thread lock serializes
   the anti-spam count. The request share lock conflicts with accept's `FOR UPDATE`, so no message
   commits after a concurrent selection.
5. AC-8 closure: request status not `matching`/`offers_open`, match `provider_response = 'declined'`,
   or any of the provider's offers on the request `declined` → `422 THREAD_CLOSED`.
6. Anti-spam (below) → `429 RATE_LIMITED`.
7. Redact; insert with `created_at = clock_timestamp()`; `201`.

Reads (`GET`) apply step 3's authorization only: closed threads stay readable to both parties.
**Nothing** marks messages read, and no read receipts exist in this spec.

### Anti-spam limit (DECIDED — replaces draft risk #1 "Open")

- **Scope:** per **sender user**, per **thread** (request, provider), counting both `message` and
  `change_request` rows.
- **Threshold:** at most **5** rows in any rolling **10-minute** window, measured by the database:
  `count(*) WHERE sender_user_id = $u AND request_id = $r AND provider_profile_id = $p AND
  created_at > clock_timestamp() - interval '10 minutes'`. The 6th → `429 RATE_LIMITED` with
  `Retry-After = max(1, ceil(oldest_in_window.created_at + 10 minutes − clock_timestamp()))` seconds.
  Nothing is written.
- **Plus** the existing route-level `messaging` domain (30/min per user), which bounds a provider
  messaging many requests at once.
- **Rationale:** 5 per 10 minutes lets a real back-and-forth continue ("second floor?", "yes", "which
  model?"). It stops a provider flooding a customer, and it is enforced across processes and under
  concurrency by the thread lock. Named constants `THREAD_MESSAGE_LIMIT = 5` and
  `THREAD_MESSAGE_WINDOW = interval '10 minutes'` live in `lib/negotiation/limits.ts`. They are not
  admin-configurable in this spec; runtime configuration is spec 041's.

### Contact redaction (DECIDED)

`redactContactInfo(text): { text: string; redacted: boolean }` in `lib/negotiation/contact-redaction.ts`.
It is a pure function with no I/O and is applied **before storage** to message bodies,
change-request notes, and offer/revision `providerMessage` and each `includedItems` entry.
Validation lengths are checked on the input; the redacted result is what is stored.

1. **Email:** `/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g`.
2. **Phone:** a maximal run beginning with an optional `+` and a digit, consisting of Unicode decimal
   digits (`\p{Nd}`, so Urdu/Arabic-Indic digits count) separated only by single-character runs of
   space, `-`, `.`, `(` or `)` (at most 2 separator characters between two digits), containing
   **≥ 10 digits** in total. This catches `03001234567`, `0300-1234567`, `+92 300 1234567`,
   `(0300) 123 4567`, `wa.me/923001234567` (the digit run inside it).
3. Each match is replaced by the literal `[contact removed]`; `redacted = true` if any replacement
   happened. If the result is only placeholders, the message is still stored and delivered.
4. **Must pass through unchanged** (the unit test's fixture list): `Rs. 3,500`, `3500-4000`,
   `PKR 12000`, `12/05/2026`, `10:30 - 11:30`, `House 12, Street 4, F-7/2`, `2 AC units, 1.5 ton`,
   `Model 2024 inverter`, `call me after 5`, `my email is on my profile`. Commas, `/` and `:` are not
   separators, and no legitimate run in these reaches 10 digits.
5. **Not detected, deliberately:** spelled-out numbers, obfuscations like "zero three zero zero",
   social handles, and URLs without a qualifying digit run. Deeper off-platform detection is spec
   038's. Master §54 forbids aggressively blocking legitimate service information, and the
   ≥ 10-digit threshold follows that.
6. **Never stored or logged:** the unredacted input. A redaction emits one structured log line
   `{ event: 'negotiation.contact_redacted', senderUserId, requestId, field, redactedCount24h }`,
   where `redactedCount24h` is the sender's `contact_redacted = true` rows in the last 24 h. No
   `fraud_signals` row is written, because that table is spec 038's and does not exist. **BOUNDARY:**
   spec 038 consumes this signal.

### Comparison (DECIDED)

**Comparable offer:** an `offers` row on the request with stored status `sent`/`viewed` **and**
`clock_timestamp() < expires_at` (the spec 018 live predicate, read in the same statement). A
`revised` row is never comparable, and `offers_request_provider_live_uq` allows at most one live row
per provider, so comparing offers is comparing providers (master §35).

**Availability:** `available = true` only when all of these hold: the request is the caller's; its
status is `offers_open` (else `request_not_open_for_offers`); its service `pricing_model` is `quote`
or `custom` (else `pricing_model_not_offer_based`; offers cannot exist for other models under spec
018, so this is defensive and is the concrete meaning of master §35's "disable comparison where it
has little value"); and it has ≥ 2 comparable offers (else `fewer_than_two_comparable_offers`).
Reasons are checked in that order. No per-service "comparison enabled" column is added.

**Selection:**
- Without `offerIds`: the first **3** comparable offers in canonical order.
- With `offerIds` (comma-separated UUIDs): 2–3 distinct valid UUIDs (else `400`; > 3 →
  `422 COMPARISON_LIMIT_EXCEEDED`, checked first). Every id must be a comparable offer **on this
  request**, else `422 OFFER_NOT_COMPARABLE`, with `details.offerIds` listing only the rejected ids
  the caller supplied. If the request itself is unavailable (reasons 1–2), the response is the
  `available: false` envelope, not an error. Results are always returned in canonical order, never
  in input order.

**Canonical order:** `request_provider_matches.rank ASC` (spec 017's persisted rank; every offer's
provider has a ranked, notified match row, per spec 018 creation rule 4), then `offers.sent_at ASC`,
then `offers.id ASC`. This is a total order.

**Top Match:** exactly one offer, the first comparable offer in canonical order across **all**
comparable offers on the request, so it does not change with the ids the customer picked.
`isTopMatch` is true on that offer if it is among those returned. There is no stored column (see
§4, `top_match_offer_id` removed).

**Field sources:** price/items/message/duration/`expiresAt` come from the offer row;
`previousPriceAmountMinorUnits`/`revisionNumber` from `offer_revisions`; `availabilityFit` from the
stored `score_breakdown.availability` (`available && normalized = 1` → `exact`, `= 0.5` →
`same_day`, otherwise `null`); `approxDistanceKm` from the same computation spec 017's provider inbox
uses (`approxKm(distanceMeters(requestPoint, serviceAreaCentre))`; the module-private `approxKm` in
`lib/matching/provider-requests.ts` is exported for reuse, not duplicated); `badges` = `['verified']`
iff `isVerified(lifecycle_status)` (`lib/matching/eligibility.ts`); `rating` = `null` (spec 029 owns
ratings and the `reviews` table is still a baseline skeleton). Reading the comparison applies spec
018's conditional `sent → viewed` mark to the returned offers, because it is the owning customer's
read of those offers.

### "Why this provider" (DECIDED — replaces draft risk #2 "Open")

Rule-based only, computed by the pure function `whyThisProvider(breakdown, isTopMatch)` in
`lib/negotiation/why-this-provider.ts`. No AI, no free text, no numbers (master §132.9, §132.16).
Reasons are emitted in this fixed order:

| Code | Rule (all from the stored `request_provider_matches.score_breakdown` of that provider for that request) | UI copy (§5) |
|---|---|---|
| `top_match` | `isTopMatch` | "Top Match for your request" |
| `available_at_requested_time` | `availability.available && availability.normalized = 1` | "Available at your requested time" (request has `preferredAt`) / "Available when you requested" (it does not) |
| `nearby` | `location.available && location.normalized ≥ 0.8` (≡ within 10 km under spec 017's `LOCATION_DECAY_METERS = 50_000`) | "Close to your address" |

- A factor with `available: false`, a null breakdown, or an unmet threshold yields no reason. An empty
  list shows no filler copy.
- `serviceMatch` and `verification` produce no reason: spec 017 risk 8 records them as constant
  across every eligible provider. `rating`, `reliability`, `priceFit`, `experience` and
  `historicalPerformance` have no data source today (`lib/matching/run.ts` passes `null`).
  **BOUNDARY:** a reason for any of them is added only by amending this table when its source spec
  ships. It never appears automatically.
- The breakdown is the **distribution-time snapshot** spec 017 stored. It is not recomputed at read
  time.

> **Compatibility note — spec 017 AC-6.** Spec 017 makes score, weights, `score_breakdown` and
> exclusion reasons admin-only. This spec exposes **none** of those values. It exposes only what
> master spec §34 requires the customer to see: a canonical order, one Top Match boolean, a
> categorical `availabilityFit`, and threshold-derived reason codes, for providers who **already made
> an offer to this customer**. No excluded or silent provider is ever revealed. Spec 017's document is
> approved and not edited.

### Error codes

Codes outside spec 004's baseline map pass `options.status` explicitly (the spec 005/016/017/018
convention). New codes are defined in `lib/negotiation/errors.ts`; reused codes are re-exported from
their owners, never redefined.

| HTTP | `code` | Source | When |
|---|---|---|---|
| `400` | `VALIDATION_ERROR` | 004 | invalid body/query field, missing/overlong `Idempotency-Key`, revision currency ≠ source, bad `offerIds` |
| `401` | `UNAUTHENTICATED` | 004 | no valid session |
| `403` | `FORBIDDEN` | 004 | wrong active mode |
| `403` | `CSRF_TOKEN_INVALID` | 005 | mutation without valid CSRF header |
| `403` | `NOT_DISTRIBUTED_TO_PROVIDER` | 017 | provider thread route for a request the provider was not distributed into (or unknown) |
| `404` | `NOT_FOUND` | 016 | provider route, caller has no provider profile |
| `404` | `REQUEST_NOT_FOUND` | 015 | customer route on a request not owned / not existing |
| `404` | `OFFER_NOT_FOUND` | 018 | offer not existing, draft, or caller not its customer/provider |
| `404` | `THREAD_NOT_FOUND` | **new** | customer thread with a provider who has neither an offer nor a message on the request |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | 015 | same key, different body |
| `409` | `CHANGE_ALREADY_REQUESTED` | **new** | a change request already exists on this offer row |
| `409` | `OFFER_ALREADY_DECIDED` | 018 | source offer accepted/declined/withdrawn |
| `409` | `OFFER_SUPERSEDED` | **new** | acting on a `revised` row, or revising/change-requesting a non-head row; `details.currentOfferId` |
| `409` | `REQUEST_ALREADY_CLAIMED` | 017 | request already `provider_selected`/`booking_created` |
| `409` | `LIVE_OFFER_EXISTS` | 018 | database backstop only |
| `422` | `REQUEST_NOT_ACTIONABLE` | 017 | request not `offers_open`; provider declined the request; provider has a declined offer (revision) |
| `422` | `THREAD_CLOSED` | **new** | AC-8 |
| `422` | `REVISION_UNCHANGED` | **new** | revision terms identical to the source |
| `422` | `REVISION_LIMIT_REACHED` | **new** | 5 revisions already exist for this (request, provider) |
| `422` | `COMPARISON_LIMIT_EXCEEDED` | **new** | more than 3 `offerIds` |
| `422` | `OFFER_NOT_COMPARABLE` | **new** | an explicit id is not a comparable offer on this request |
| `429` | `RATE_LIMITED` | 004 | `messaging`/`offers` domain budget, or the per-thread limit |

### Breaking-change check

- [x] No existing route changes path, method, auth or success status. `OfferDto` gains four additive
  fields. Accept/decline/withdraw can newly return `409 OFFER_SUPERSEDED`, only for `revised` rows,
  which cannot exist before this spec. Offer free text submitted to `POST /offers` may now be stored
  redacted (spec 018 compatibility note above).

---

## 4. Data model changes

Drizzle ORM (`lib/db/schema.ts`), not Prisma. `lib/db/schema-lint.test.ts` rules apply: money via
`moneyColumns`/`moneyPairChecks` (integer minor units, never `numeric`/`real`/`double`), every
timestamp `timestamptz`, every FK `onDelete: 'restrict'` with a covering index, **no new jsonb
column** (the allowlist is unchanged). **No new table** is added, so `EXPECTED_TABLES` in
`lib/db/schema-coverage.test.ts` is unchanged.

### Entities

| Entity | Change | Fields / constraints |
|---|---|---|
| `offer_messages` | **extend** (spec 003 baseline: `id`, audit, `version`, `offer_id uuid not null` FK, `sender_user_id` FK, both indexed; **0 rows**) | `request_id uuid not null` FK → `requests` (indexed); `provider_profile_id uuid not null` FK → `provider_profiles` (indexed); `offer_id` **becomes nullable**; `sender_role text not null` CHECK in (`customer`,`provider`); `kind text not null` CHECK in (`message`,`change_request`); `body text not null` CHECK `char_length(body) between 1 and 1100` (1000 input + placeholder growth headroom); `contact_redacted boolean not null default false`; `...moneyColumns('proposed_price')` nullable + `moneyPairChecks`, CHECK amount `> 0`; `idempotency_key text not null`; `idempotency_fingerprint text not null` |
| `offer_messages` CHECKs / indexes | new | `(kind = 'change_request') = (offer_id is not null)`; `kind = 'change_request' or proposed_price_amount_minor_units is null`; `kind = 'message' or sender_role = 'customer'`; unique `(sender_user_id, idempotency_key)`; partial unique `offer_messages_change_request_per_offer_uq (offer_id) WHERE kind = 'change_request'`; index `(request_id, provider_profile_id, created_at)` for thread reads and the anti-spam count |
| `offer_revisions` | **extend** (spec 003 baseline: `id`, audit, `version`, `offer_id uuid not null` FK, indexed; **0 rows**) | `offer_id` = the **superseded source** (existing column); `new_offer_id uuid not null` FK → `offers`; `request_id uuid not null` FK (indexed); `provider_profile_id uuid not null` FK (indexed); `revision_number integer not null`; `...moneyColumns('previous_price')` not null; `...moneyColumns('new_price')` not null (+ `moneyPairChecks` for both, amounts `> 0`); `actor_user_id uuid not null` FK → `users` (indexed); `change_request_message_id uuid null` FK → `offer_messages` (indexed) |
| `offer_revisions` CHECKs / indexes | new | unique `offer_revisions_offer_id_uq (offer_id)` (a row is revised at most once — no forks); unique `(new_offer_id)`; unique `offer_revisions_request_provider_number_uq (request_id, provider_profile_id, revision_number)`; `offer_revisions_number_ck revision_number between 1 and 5`; `offer_id <> new_offer_id`; `previous_price_currency_code = new_price_currency_code` |
| `offer_revisions` trigger | new | `enforce_offer_revisions_append_only()` — `BEFORE UPDATE OR DELETE` raises (audit records are immutable) |
| `offers` trigger | new | `enforce_offer_terms_immutable()` — `BEFORE UPDATE`, per §3 "Offer terms are immutable" |
| `offers_status_transitions` | **seed** | exactly `('sent','revised')`, `('viewed','revised')` |
| `offers` columns | **unchanged** | lineage is derived from `offer_revisions`; no column added |
| `requests` | **unchanged** | see below |

**`requests.top_match_offer_id` — removed (DECIDED).** The draft added a nullable computed column.
It is not needed and would be wrong. Top Match is a pure function of spec 017's persisted `rank` and
spec 018's live predicate, and a stored value would go stale the instant a top offer expires, is
revised or is withdrawn. Keeping it correct would need writes from the sweep, accept, withdraw and
revision paths, all serialized with the request lock, for a value that is only ever read on the
comparison route. It is computed at read time (§3 "Comparison").

**Deliberately unchanged:** `conversations`, `conversation_participants`, `messages`,
`message_attachments` (spec 003 baselines owned by **spec 025**; pre-selection threads do not use
them), `request_provider_matches` (spec 017), `offers` columns and CHECKs (spec 018), `bookings`
(spec 020), `reviews` (spec 029), `audit_logs` (spec 039).

### Migration

- **Name:** `0015_add_offer_negotiation_comparison` (next after `0014_add_offer_system_timer`).
- **Generated by:** `npm run db:generate` (drizzle-kit) for columns/constraints/indexes. The two
  transition seeds and the two trigger functions are hand-appended in the style of `0011`/`0013`/
  `0014`. The spec 003 baseline and its `.sha256` are **not** touched.
- **Preconditions:** the migration asserts `offer_messages` and `offer_revisions` are empty
  (`DO $$ … RAISE EXCEPTION …`) before adding `NOT NULL` columns without defaults. They are empty in
  every environment today, because no code has ever written them.
- **Reversible:** yes — hand-written `0015_add_offer_negotiation_comparison_down.sql`. It drops both
  triggers and functions, drops the new indexes/constraints, deletes all `offer_messages` and
  `offer_revisions` rows, drops the added columns, restores `offer_messages.offer_id NOT NULL`, and
  deletes exactly the two seeded transition rows. Like `0014`'s down (which drops offer price columns),
  rollback discards the data those columns held. Offer rows already stored as `revised` remain valid
  under spec 018's CHECK, which already allows `revised`.
- **Backfill required:** no.
- **Downtime:** none (both tables empty; trigger creation on `offers` takes a brief lock).

### Retention and privacy

Integrates with **spec 008's existing** mechanism; no new privacy path.

- **Export** (`lib/privacy/export.ts`): a new `negotiation` section with explicit column allowlists:
  - `messages`: every row in threads where the caller is the request's customer (via
    `customer_profiles`) **or** the thread's provider (via `provider_profiles`). Fields: `id`,
    `requestId`, `providerProfileId`, `offerId`, `kind`, `senderRole`, `body` (as stored, redacted),
    `contactRedacted`, `proposedPrice`, `createdAt`. Counterparty messages are included, because they
    were sent to the caller. Never exported: `sender_user_id`, idempotency keys and fingerprints, and
    other providers' threads (for a provider).
  - `revisions`: `offer_revisions` rows on the caller's requests (customer) or by the caller's provider
    profile (provider). Fields: `id`, `previousOfferId`, `offerId`, `revisionNumber`, `previousPrice`,
    `newPrice`, `createdAt`. Never `actor_user_id`.
- **Deletion** (`lib/privacy/deletion.ts`): rows are retained (every FK is `restrict`; revisions are
  the commercial record behind spec 020's price). When a user's account is swept, `offer_messages.body`
  on rows **that user sent** is set to `REDACTED_DESCRIPTION` (`'[redacted]'`). `proposed_price`,
  `kind`, timestamps and every `offer_revisions` row are retained, and so are the counterparty's
  messages (the counterparty's own data). Spec 018's existing `offers.provider_message` redaction is
  unchanged and still permitted by the immutability trigger.
- **Retention period — BOUNDARY:** master §55 requires a configurable historical policy. No
  retention window or purge job is introduced here. Threads stay readable to their two participants
  (AC-8), and the policy, including any pre-selection thread purge, is **spec 025's** (configuration
  via spec 041).
- **Admin access:** no admin route reads threads in this spec, so there is no admin read to audit.
  Admin conversation access and its audit trail are specs 025/039's.
- **Never exposed:** contact details (never stored), user ids, `score_breakdown` numbers, rank
  numbers, exclusion reasons, other providers' threads, prices or offers (a provider sees only their
  own).

---

## 5. UI states

Built only from the APURIVA Design System via `@/components` (`components/index.ts`), styled with
`app/styles/apuriva-tokens.css` tokens. It uses no raw colours, sizes or radii, no token overrides,
and no new primitive. The existing `OfferCard` already accepts `rating`, `verified`, `arrival`,
`duration`, `includes`, `message`, `topMatch`, `secondsRemaining`, `expired` and an `actions` slot
("Accept / Request change / Decline"). `Table`, `Badge`, `Icon`, `PriceDisplay`, `Textarea`,
`FormField`, `Input`, `Button`, `Alert`, `EmptyState`, `ErrorState`, `Skeleton`, `ListRow` and `Card`
are already re-exported. **No `Chat` or message-bubble primitive exists in `ui/`.** The thread is
composed from `Card`/`ListRow`/`Textarea`/`Button`/`Alert` as an app-level component. If design
review wants a dedicated chat primitive, that is a Design System gap to report, not something this
spec creates. The draft's `packages/ui` `ComparisonTable`/`Chat` do not exist and are not added.

| Surface | State | Behaviour |
|---|---|---|
| Customer — `app/requests/[id]/OffersPanel.tsx` (spec 018, extended) | **Success** | Offers are grouped by provider chain; the head is shown as the `OfferCard`, superseded rows collapse into "Revised from `PriceDisplay`" history (from `GET /offers/{id}/revisions`). Live head actions: Accept, Decline, **Request change** (inline `FormField` + `Textarea` note + optional price `Input`), **Messages**. A **Compare offers** `Button` appears only when `GET /requests/{id}/offers/compare` returns `available: true` (AC-6) |
| | **Error** | `OFFER_SUPERSEDED` → `Alert` "This offer was revised — review the new price before accepting", then refetch and focus the new head; `CHANGE_ALREADY_REQUESTED` → "You've already asked for a change on this offer"; `THREAD_CLOSED`, `REQUEST_ALREADY_CLAIMED`, `OFFER_EXPIRED` → their specific copy; list refetched after every error |
| Customer — `app/requests/[id]/compare/page.tsx` (**new**) | **Loading** | `Skeleton` rows while the comparison resolves |
| | **Empty** | `available: false` → `EmptyState` explaining why (e.g. "Comparison needs at least two live offers") with a link back to the request; never a blank page |
| | **Error** | load failure → `ErrorState` with retry; `422 OFFER_NOT_COMPARABLE` (an offer expired or was revised since selection) → `Alert` and reload the default selection |
| | **Success** | ≥ `md` breakpoint: DS `Table`, one column per offer (2–3), rows = price (with "revised from"), availability, distance, rating ("Not yet rated" when `null`), badges, included items, provider message, duration, time left, why this provider, Accept. Below `md`: stacked `OfferCard`s in the same canonical order. Top Match uses `Badge` + `Icon` + text, never colour alone (master §3.5). Reason copy comes from the fixed table in §3. Accept calls spec 018's accept for **that row id** |
| Customer thread — `app/requests/[id]/MessageThread.tsx` (**new**, opened from an offer card or thread list) | **Loading / Empty / Error / Success** | `Skeleton`; "No messages yet — ask a question about this request"; send failure keeps the drafted text and shows the specific error (`429` shows "You can send another message in N s" from `Retry-After`; `THREAD_CLOSED` hides the composer and shows "This conversation closed when you selected a provider"); success appends the server-returned message, and `contactRedacted` shows an `Alert` "Contact details were removed — keep communication on APURIVA" |
| Provider — `app/provider/requests/page.tsx` (spec 017/018 inbox, extended) | **Success** | Per request: **Messages** (same thread component, provider route); an incoming change request shows the note and proposed price; **Send revised offer** reuses spec 018's send-offer form pre-filled from the head (and the proposed price), sending a fresh `Idempotency-Key` per submission; revision count "n of 5" |
| | **Error** | `OFFER_SUPERSEDED`, `REVISION_UNCHANGED`, `REVISION_LIMIT_REACHED`, `REQUEST_NOT_ACTIONABLE`, `THREAD_CLOSED` each show their specific `Alert`; row refetched |

The thread component shared by both surfaces lives in `app/_components/RequestMessageThread.tsx`,
following the spec 018 precedent of `app/_components/OfferCountdown.tsx`. The per-page wrappers
supply the route.

**Refresh without a real-time layer.** As in spec 018 §5, architecture §6.1's WebSocket layer does
not exist. An open thread or comparison refetches every **10 seconds** (reusing
`OFFER_REFRESH_INTERVAL_MS`), on window focus, and when any displayed countdown reaches 0. Each
refetch replaces local state. Countdowns stay cosmetic (spec 018): no action is enabled or disabled
by them.

**Accessibility.** Keyboard-operable composer and table. The thread list is not an `aria-live` region
per message; only a send result and a new incoming message count are announced. Table headers are
proper `th` scopes. Top Match and badges carry text, not colour alone. `prefers-reduced-motion` is
respected.

---

## 6. Test plan

**Vitest only.** There is no Playwright/Cypress, no `apps/web-e2e`, and no `apps/api`, so the draft's
`apps/*` rows are replaced. Integration tests run only against the isolated `<name>_test` database
(`vitest.config.ts` rewrites `DATABASE_URL`; `test/db-reset.ts` refuses any other name). They use
`describe.skipIf(!dbReachable)` and call `resetRateLimitState()` in `beforeEach`. They never mock the
database clock: timing fixtures shift windows relative to `clock_timestamp()` using spec 018's
`shiftOfferWindow` pattern (`lib/offers/offers-test-support.ts`), and the anti-spam window is tested
by seeding `created_at` relative to `clock_timestamp()`. Concurrency tests use **real separate
connections**, following `lib/offers/accept-race.integration.test.ts`. New fixtures extend
`seedOfferScenario` in `lib/negotiation/negotiation-test-support.ts` rather than faking match rows.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | contact redaction (positive and must-pass-through fixtures, Unicode digits); why-this-provider rules and order; canonical comparison ordering, Top Match and selection validation (pure functions); body/query validation; revision-unchanged comparison | `lib/negotiation/contact-redaction.test.ts`, `lib/negotiation/why-this-provider.test.ts`, `lib/negotiation/comparison.test.ts`, `lib/negotiation/validation.test.ts` |
| **Integration** | message authorization, thread visibility, closure, anti-spam, idempotency; change requests; revision rules, timer, audit row, triggers; superseded accept/decline/withdraw; comparison reads | `lib/negotiation/messages.integration.test.ts`, `lib/negotiation/change-requests.integration.test.ts`, `lib/negotiation/revise.integration.test.ts`, `lib/negotiation/accept-revision.integration.test.ts`, `lib/negotiation/comparison.integration.test.ts` |
| **Concurrency** | AC-9 across two real connections | `lib/negotiation/revise-race.integration.test.ts` |
| **API** | every new route's auth, mode, CSRF, 404/403 rules, rate-limit domains, envelopes, `Retry-After` | `app/api/v1/requests/negotiation.integration.test.ts`, `app/api/v1/providers/messages.integration.test.ts`, `app/api/v1/offers/negotiation.integration.test.ts` |
| **Regression (spec 018)** | spec 018 suites stay green unchanged: creation still works under the immutability trigger, sweep ignores `revised` | existing `lib/offers/*.integration.test.ts`, `app/api/v1/offers/offers.integration.test.ts` |
| **Component** | offers panel grouping/request change/compare entry; comparison page table/stacked/empty; thread states; provider revise form (Testing Library, jsdom) | `app/requests/[id]/OffersPanel.test.tsx`, `app/requests/[id]/compare/page.test.tsx`, `app/_components/RequestMessageThread.test.tsx`, `app/provider/requests/page.test.tsx` |
| **Privacy** | export `negotiation` section scoping and field allowlist; deletion redacts only the deleted user's bodies | `lib/privacy/export.integration.test.ts`, `lib/privacy/deletion.integration.test.ts` |
| **Schema / contract** | no new jsonb, FK index coverage, money-column lint, OpenAPI drift | `lib/db/schema-lint.test.ts`, `lib/db/schema-coverage.test.ts`; `npm run check:openapi-drift` |

**Traceability** — every acceptance criterion:

| AC | Test |
|---|---|
| AC-1 | `lib/negotiation/messages.integration.test.ts::stores a message against the (request, provider) thread only`, `::a provider distributed into the request can ask before sending an offer`, `::another provider and another customer cannot read or post (404/403)`, `::rejects the 6th message in 10 minutes with 429 and a database Retry-After, writing nothing`, `::change requests count toward the thread limit`, `::same Idempotency-Key and body replays one row`; `app/api/v1/requests/negotiation.integration.test.ts::thread DTOs carry senderRole and never a user id, name, phone or email`, `::message routes use the messaging rate-limit domain` |
| AC-2 | `lib/negotiation/comparison.integration.test.ts::returns 2–3 comparable offers with every required field`, `::previousPriceAmountMinorUnits and revisionNumber reflect the revision chain`, `::rating is null and verified badge follows lifecycle_status`; `app/api/v1/requests/negotiation.integration.test.ts::comparison payload contains no score, weight, breakdown, rank number or exclusion reason`; `app/requests/[id]/compare/page.test.tsx::renders a table of up to 3 offers with required rows`, `::renders stacked OfferCards below md`, `::Top Match conveyed by icon and text` |
| AC-3 | `lib/negotiation/change-requests.integration.test.ts::records a change_request with note and proposed price`, `::leaves the offer price, status, expires_at and version unchanged`, `::allowed on an expired head`, `::409 CHANGE_ALREADY_REQUESTED on a second request for the same row`, `::409 OFFER_SUPERSEDED on a non-head row`, `::409 OFFER_ALREADY_DECIDED on accepted/declined/withdrawn`; `app/provider/requests/page.test.tsx::shows the change request and pre-fills the revision form with the proposed price` |
| AC-4 | `lib/negotiation/revise.integration.test.ts::creates a new row with expires_at = sent_at + 2 minutes from the database clock`, `::moves a live source to revised with a provider history row`, `::an expired source stays expired and is still linked`, `::never modifies the source sent_at, expires_at or price`, `::writes exactly one offer_revisions row with previous/new price, actor, number and time`, `::links the source's change request`, `::the offers terms-immutability trigger rejects a price update on a non-draft row`, `::offer_revisions rows cannot be updated or deleted` |
| AC-5 | `lib/negotiation/accept-revision.integration.test.ts::accepting the new row stores that row's exact price`, `::accepting a revised row returns 409 OFFER_SUPERSEDED with currentOfferId and writes nothing`, `::decline and withdraw on a revised row return 409 OFFER_SUPERSEDED`, `::a superseded row is never reported as OFFER_EXPIRED`; `app/requests/[id]/OffersPanel.test.tsx::on OFFER_SUPERSEDED shows the revised-price alert and refetches` |
| AC-6 | `lib/negotiation/comparison.integration.test.ts::available false with fewer_than_two_comparable_offers for 0 and 1 live offers`, `::available false with request_not_open_for_offers after selection`, `::available false with pricing_model_not_offer_based`; `app/requests/[id]/OffersPanel.test.tsx::hides Compare offers when unavailable`; `app/requests/[id]/compare/page.test.tsx::shows EmptyState when unavailable` |
| AC-7 | `lib/negotiation/contact-redaction.test.ts::redacts emails`, `::redacts 10+ digit phone runs with spaces, dashes, dots, parentheses and +`, `::redacts Urdu/Arabic-Indic digit phone runs`, `::leaves prices, ranges, dates, times, addresses and quantities unchanged`; `lib/negotiation/messages.integration.test.ts::stores only the redacted body with contactRedacted true and still delivers it`, `::never logs the unredacted input`; `lib/negotiation/revise.integration.test.ts::redacts providerMessage and includedItems on revisions`; `app/api/v1/offers/negotiation.integration.test.ts::POST /offers redacts providerMessage and includedItems while idempotent replay still matches` |
| AC-8 | `lib/negotiation/messages.integration.test.ts::422 THREAD_CLOSED once the request is provider_selected`, `::422 THREAD_CLOSED after the provider declined the request`, `::422 THREAD_CLOSED after the customer declined that provider's offer`, `::a closed thread remains readable by both parties`; `app/_components/RequestMessageThread.test.tsx::hides the composer when closed and keeps drafted text on send failure` |
| AC-9 | `lib/negotiation/revise-race.integration.test.ts::revise vs accept — exactly one commits, never an accepted revised row`, `::two revisions of one source — one 201, one 409 OFFER_SUPERSEDED`, `::same-key concurrent revisions — both return the identical new offer`, `::revise vs expiry sweep — never both revised and expired, never two live offers`, `::revise vs withdraw and vs decline — one outcome`, `::concurrent messages never exceed the thread limit` |
| AC-10 | `lib/negotiation/comparison.test.ts::more than 3 offerIds is COMPARISON_LIMIT_EXCEEDED`, `::fewer than 2, duplicates or malformed ids are VALIDATION_ERROR`, `::canonical order is rank, sent_at, id`, `::exactly one Top Match chosen from all comparable offers regardless of selection`; `lib/negotiation/comparison.integration.test.ts::422 OFFER_NOT_COMPARABLE for expired, revised or another request's offer, listing only supplied ids`, `::comparison read marks returned sent offers viewed` |
| AC-11 | `lib/negotiation/why-this-provider.test.ts::emits top_match, available_at_requested_time and nearby in fixed order`, `::nearby only at normalized >= 0.8`, `::unavailable factors, null breakdown and constant factors emit nothing`, `::same inputs always produce the same output`; `lib/negotiation/comparison.integration.test.ts::whyThisProvider derives from the stored score_breakdown, not recomputation` |
| AC-12 | `lib/privacy/export.integration.test.ts::negotiation section includes own threads and revisions with no idempotency data or user ids`, `::a provider never exports another provider's thread`; `lib/privacy/deletion.integration.test.ts::redacts only the deleted user's message bodies and keeps revisions and counterparty messages` |
| AC-13 | `lib/negotiation/revise.integration.test.ts::400 on currency different from the source`, `::422 REVISION_UNCHANGED for identical terms`, `::422 REVISION_LIMIT_REACHED after 5 revisions on the request`, `::422 REQUEST_NOT_ACTIONABLE after a customer decline or provider decline`, `::409 OFFER_SUPERSEDED for a non-head source`, `::same key and body returns 200 with the original revision`, `::same key different body is 409 IDEMPOTENCY_KEY_CONFLICT`, `::a POST /offers key reused for a revision conflicts` |

**Coverage:** ≥ 80% on new code, the repository's established standard. The AC-9 concurrency suite
and the AC-7 redaction fixtures are mandatory (master §132.4, §132.13, §132.15).

**Not covered, deliberately:** exact UI copy and animation; notification delivery (spec 026); MCP
tool behaviour (spec 036 must call `lib/negotiation/*` and inherits these guarantees, tested there);
post-selection conversations (spec 025).

---

## 7. Out of scope

- **Booking creation** from an accepted offer, `provider_selected → booking_created`, and any payment
  (**spec 020**, spec 021). Spec 020 reads the accepted row's immutable price; this spec never writes
  `bookings`.
- **Post-selection / booking conversations**, message attachments, read receipts, retention windows
  and purge, and admin conversation access (**spec 025**; audit spec 039).
- **Notification delivery** for new messages, change requests or revisions (**spec 026**). Polling
  only (§5).
- **Deeper off-platform contact detection**, fraud-signal records and enforcement (**spec 038**). This
  spec only redacts obvious emails/phone numbers and logs a signal.
- **Ratings data** (**spec 029**) and any "why" reason for factors without a data source (**spec 017**
  owners, per §3 BOUNDARY).
- A "reject change request" provider action, customer counter-offers on price beyond a change
  request's proposed price, and multi-party (group) threads.
- AI-drafted messages or AI-changed prices (master §36: AI cannot secretly change the agreed amount).
  Any AI/MCP path must use these same functions (**spec 033/036**).
- Real-time WebSocket delivery (architecture §6.1).
- Admin surfaces for negotiation; runtime configuration of the anti-spam and revision limits (spec 041).

---

## 8. Risks and open questions

### Decisions resolved in this review

| # | Question | Resolution | Basis |
|---|---|---|---|
| D-1 | Revision timer (draft: "resets 2-minute timer per spec 017") | **DECIDED:** no timer is ever reset or extended; a revision is a new offer row with its own database-computed window; the source becomes `revised` (if live) or stays `expired` | Spec 018 timing rules, `offers_two_minute_window_ck`, spec 018 §8 risk 2, master §32 |
| D-2 | How a customer accepts a specific revision / exact price | **DECIDED:** accept the row id (spec 018 route); terms immutable by trigger; superseded rows → `409 OFFER_SUPERSEDED` | Master §36, §132.15 |
| D-3 | Where messages live; request- vs. offer-scoped | **DECIDED:** `offer_messages`, keyed by (request, provider) with `offer_id` only for change requests; providers may ask before offering | Master §33 ("tied to request"), §124 `OfferMessage`; `conversations`/`messages` are spec 025's |
| D-4 | Anti-spam threshold (draft risk #1, Open) | **DECIDED:** 5 per sender per thread per rolling 10 min (DB-enforced) + existing `messaging` domain 30/min | §3 "Anti-spam limit" |
| D-5 | "Why this provider" generation (draft risk #2, Open) | **DECIDED:** fixed reason codes from stored, available spec 017 factors plus Top Match; no AI, no numbers | Master §132.9, §132.16; spec 017 AC-6 |
| D-6 | Contact stripping precision | **DECIDED:** email regex + ≥ 10-digit phone runs, placeholder replacement, never block, never store original | Master §54 |
| D-7 | `requests.top_match_offer_id` | **DECIDED: removed** — derived at read time | §4 |
| D-8 | Comparison limit, eligibility, order, < 2 offers | **DECIDED:** live offers only, max 3, order rank → sent_at → id, `available: false` envelope when < 2 | Master §34–§35 |
| D-9 | Provider "Accept" of a change request | **DECIDED:** expressed as a revision with the requested terms; customer still accepts that row | Master §36 "final price confirmed by both sides" |
| D-10 | Revision cap | **DECIDED:** 5 per (request, provider) | Anti-spam; bounded notification volume for spec 026 |
| D-11 | Idempotency scope | **DECIDED:** required on message, change-request and revision POSTs | `lib/api/idempotency.ts`; spec 036 action tools |

### Non-blocking risks

| # | Risk | Owner | Resolution |
|---|---|---|---|
| 1 | `docs/specs/INDEX.md` and `README.md` say 019 "reuses `OfferMessage`/`OfferRevision` stubbed in spec 018" | Docs | **Reported, not edited** — they are spec 003 baselines |
| 2 | Draft spec 025 says "Spec 018 provides limited pre-booking, request-scoped chat" and that its `Chat` "extends spec 018's request-scoped component" | Spec 025 owner | **Reported, not edited** — pre-selection threads are spec 019's, built on `offer_messages`, and no `Chat` DS primitive exists |
| 3 | Spec 017 AC-6 admin-only explainability vs. master §34's customer-facing Top Match / "why" | Spec 017 owner | **Reviewed, compatible** — no score, weight, breakdown number, rank number or exclusion reason is exposed (§3 compatibility note); spec 017 not edited |
| 4 | `availabilityFit` and "why" reasons reflect the distribution-time snapshot, not current availability | Product | **Accepted** — master §132.16 forbids silently re-ranking; spec 020 revalidates availability at booking |
| 5 | Redaction may miss obfuscated contact details | Trust & Safety | **Accepted** — deeper detection is spec 038's; over-blocking is forbidden by master §54 |
| 6 | Live offers from other providers keep counting as comparable only while live; a comparison can shrink below 2 while open | Product | **Accepted** — the page refetches and shows the `available: false` state (§5) |
| 7 | Rollback deletes all negotiation rows (see §4 Migration) | Platform | **Accepted** — the same column-dropping rollback precedent as `0014` |

No blocking open question remains.

---

## 9. Rollout

- **Feature flag:** none — negotiation completes spec 018's offer flow, and `feature_flags` is still
  spec 003's column-less baseline (spec 041).
- **Migration order:** `0015_add_offer_negotiation_comparison` ships with the code in one deploy.
  Spec 018's code keeps working if the migration runs first, because no spec 018 write path violates
  the new triggers.
- **Rollback:** revert the deploy and apply `0015_add_offer_negotiation_comparison_down.sql`
  (`npm run db:rollback` pattern). Any `revised` rows remain valid and read as terminal.
- **Observability:** structured `console` JSON through the existing correlation-id logging, the same
  convention as spec 018. The events are `negotiation.message_sent` (no body),
  `negotiation.thread_rate_limited`, `negotiation.contact_redacted` (no content),
  `negotiation.revision_created` (`revisionNumber`, price delta sign only),
  `negotiation.superseded_action_rejected`, and `negotiation.comparison_viewed` (`available`,
  `unavailableReason`, offer count). Spikes in superseded-accept rejections point to a UI refresh
  bug. Negotiation-to-acceptance conversion and redaction rates are consumed by spec 040 and spec 038.
