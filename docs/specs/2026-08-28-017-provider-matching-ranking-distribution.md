# Spec: Provider Matching, Ranking & Distribution

**File:** `docs/specs/2026-08-28-017-provider-matching-ranking-distribution.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §23–§25, §26, §29–§30, §132.16, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (baseline `request_provider_matches`), spec 004 (envelope, error codes,
rate limiting, OpenAPI registry), spec 006 (`provider_profiles`, active-mode checks), spec 009
(admin RBAC roles + risk tiers), spec 010 (`services`, `pricing_model`, and the
`catalog_suggestions` review workflow this spec's AI-suggestion flow mirrors), spec 012
(`lib/location/*` distance), **spec 015** (the submitted request), **spec 016** (availability and
service-area eligibility — *approved and implemented*).
**Feeds:** spec 018 (offer creation), spec 026 (notification delivery), spec 040 (fairness/exposure
analytics). Established order is unchanged: **015 → 016 → 017 → 018 → 019 → 020**, exactly as
`docs/specs/INDEX.md` and `docs/specs/README.md` record it.

> **Numbering note.** This document's `**File:**` line previously read `...-016-provider-matching-...`,
> a leftover from the pre-shift draft numbering in which matching was 016. The repository's
> authoritative numbering — `docs/specs/INDEX.md`, `docs/specs/README.md`, and the **approved**
> spec 016 (which names *this* spec as 017 in its own AC-3 and §7) — is **016 = Provider
> Availability & Service Areas, 017 = this spec, 018 = Offer System & Timer, 019 = Offer
> Negotiation**. Two internal self-references that read "spec 017" where they meant the *offer*
> spec have been corrected to **spec 018** (§1 "Why it matters now" and §7). No other spec is
> renumbered, and nothing in spec 016 is altered by this document.

---

## 1. Problem statement

**Today:** No matching engine exists. The `request_provider_matches` table **already exists** in
`lib/db/schema.ts` as spec 003's baseline skeleton — identity, audit, `version`, a `request_id` FK,
a `provider_profile_id` FK, covering indexes on both, and **already a unique index on
`(request_id, provider_profile_id)`** — with no rank, score, eligibility or response columns.
Spec 015 ships requests that reach `submitted`; its `lib/requests/cancellation-notification.ts`
already reads `request_provider_matches` and explicitly waits for this spec to populate it. Spec
016 ships the availability and service-area eligibility this spec consumes.

Master spec §23 requires a transparent rule-based engine: hard eligibility rules first, then
weighted ranking, with admin-configurable weights per service. §24 requires fair exposure so new
providers aren't permanently buried. §29–§30 require distributing the request to a bounded,
relevant provider pool (never blasting every provider) and giving providers the correct action set
(Accept/Send Offer/Decline) based on pricing model.

**Who is affected:** Every provider who wants fair access to requests; every customer who depends
on relevant, high-quality matches; admins who tune ranking weights.

**Why it matters now:** It's the second Milestone-4 spec, directly consuming submitted requests
from spec 015, eligibility data from spec 016, and feeding offers (**spec 018**).

**Success looks like:** A submitted request is filtered through hard eligibility rules, ranked by a
transparent weighted formula, distributed to a configurably-sized relevant pool (not everyone), and
each notified provider sees the correct available action for that request's pricing model.

> **Product decisions resolved.** The four decisions this spec depended on — the capacity model,
> default ranking weights, default pool size, and the new-provider exploration share — had no
> authoritative source in the master specification, the approved spec chain, or the repository.
> Product has now answered all four; they are recorded as **DECIDED-1 … DECIDED-4** in §8 and
> specified in full in §3. Nothing in this spec is left to implementer judgement.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a submitted request **When** matching runs **Then** providers failing any hard eligibility rule (service match, service area, availability, verification status, capacity) are excluded before ranking ever runs — each exclusion recorded with its machine-readable reason on the provider's `request_provider_matches` row, and no excluded provider contributes to or appears in any ranking calculation |
| AC-2 | **Given** eligible providers **When** ranked **Then** the ranking uses the documented weighted factors (service match, availability, location, rating, reliability, price fit, experience, verification, historical performance) with weights configurable per service by an admin — evaluated by a deterministic, pure scoring function whose per-factor breakdown is persisted |
| AC-3 | **Given** a newly-joined provider with no history **When** eligible for a request **Then** they receive limited exploration exposure rather than being permanently ranked last by lack-of-history alone — deterministically, affecting distribution only, never hard eligibility |
| AC-4 | **Given** the ranked eligible pool **When** distributed **Then** only a configurable-sized subset of top-ranked providers is notified, never the entire eligible set — and re-running matching for the same request is idempotent, never widening or duplicating the notified set |
| AC-5 | **Given** a fixed/instant-pricing-model service **When** a provider views the request **Then** their available action is "Accept"; **given** a quote-based service **Then** their action is "Send Offer"; **given** unsuitability **Then** "Decline" is always available |
| AC-6 | **Given** an admin **When** viewing ranking behavior for a request **Then** they can see which providers were excluded and why (explainability, master spec §2.3) — through an admin-only endpoint that no provider or customer surface exposes |
| AC-7 | **Given** the ranking weights **When** the AI suggests an improvement **Then** the suggestion is recorded for admin review and never silently applied (master spec §23, §132.16) — with no code path through which a suggestion can alter live weights without an explicit admin review action |

---

## 3. API contract

Routes live under `app/api/v1/**/route.ts` (Next.js App Router — this repository is a single
Next.js app, **not** the `apps/web` + `apps/api` + `packages/ui` + `packages/types` layout the
template prose assumes). Every route is `withApiRoute` (`lib/api/handler.ts`) wrapping a call into
`lib/matching/*`; every mutation calls `requireSession` + `requireCsrf`
(`lib/auth/require-session.ts`) and, for provider routes, `requireActiveMode(session, 'provider')`
(`lib/auth/require-mode.ts`). Admin routes authorize through spec 009's
`lib/admin-rbac/permissions.ts`, never by an ad-hoc role string check.

**OpenAPI:** every route below must be added to `OPENAPI_ROUTES` in `lib/api/openapi-registry.ts`
in the same PR — `scripts/check-openapi-drift.ts` fails CI otherwise.

**Rate limiting:** a new `matching` domain is added to `RateLimitDomain` / `RATE_LIMIT_DEFAULTS`
(`lib/api/rate-limit.ts`) at `30 / 60_000` — a provider write surface, the same budget spec 015
chose for `requests`.

### Endpoints

| Method | Route | Auth | Success | Errors |
|---|---|---|---|---|
| `GET` | `/api/v1/requests/{id}/matches` | admin: `operations_admin` or `super_admin` (spec 009) | `200` `ApiResponse<MatchExplainabilityDto>` | `401`, `403 FORBIDDEN`, `404 NOT_FOUND` |
| `GET` | `/api/v1/providers/me/requests` | session, provider mode | `200` `PagedResponse<IncomingRequestDto>` | `401`, `403`, `404` (no provider profile) |
| `GET` | `/api/v1/providers/me/requests/{id}` | session, provider mode, distributed-to-only | `200` `ApiResponse<IncomingRequestDto>` | `403 NOT_DISTRIBUTED_TO_PROVIDER`, `404` |
| `POST` | `/api/v1/providers/me/requests/{id}/accept` | session, provider mode, CSRF | `200` `ApiResponse<ProviderResponseDto>` | `403 NOT_DISTRIBUTED_TO_PROVIDER`, `409 REQUEST_ALREADY_CLAIMED`, `422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL`, `422 REQUEST_NOT_ACTIONABLE` |
| `POST` | `/api/v1/providers/me/requests/{id}/decline` | session, provider mode, CSRF | `200` `ApiResponse<ProviderResponseDto>` | `403 NOT_DISTRIBUTED_TO_PROVIDER`, `422 REQUEST_NOT_ACTIONABLE` |
| `PATCH` | `/api/v1/admin/services/{id}/matching-weights` | admin, risk-tier **medium** (spec 009) | `200` `ApiResponse<MatchingWeightsDto>` | `403`, `404`, `409 CONFLICT` (stale `expectedVersion`), `422 INVALID_MATCHING_WEIGHTS` |
| `GET` | `/api/v1/admin/matching/suggestions` | admin: `operations_admin` or `super_admin` | `200` `PagedResponse<MatchingSuggestionDto>` | `401`, `403` |
| `POST` | `/api/v1/admin/matching/suggestions/{id}/approve` | admin, risk-tier **medium**, CSRF | `200` `ApiResponse<MatchingSuggestionDto>` | `403`, `404`, `409 SUGGESTION_ALREADY_REVIEWED` |
| `POST` | `/api/v1/admin/matching/suggestions/{id}/reject` | admin, risk-tier **medium**, CSRF | `200` `ApiResponse<MatchingSuggestionDto>` | `403`, `404`, `409 SUGGESTION_ALREADY_REVIEWED` |

**Four endpoints were added to the draft's five, each required by an acceptance criterion, none
for convenience:**

- `GET /providers/me/requests/{id}` — AC-5 requires a provider to *view* a request and see its
  correct action. The list endpoint alone cannot carry a single request's detail, and no other
  route lets a distributed provider read a request they do not own.
- The three `/admin/matching/suggestions*` routes — **AC-7's "recorded for admin review" is
  untestable and unenforceable without a review surface.** They deliberately mirror spec 010's
  already-shipped `catalog_suggestions` workflow (`app/api/v1/admin/catalog/pending-review/**`), so
  this introduces a second instance of an existing pattern, not a new one.

**Deliberately NOT added: a "send offer" endpoint.** Investigated per §10 of the review brief. The
repository's `offers` table is still spec 003's baseline skeleton (`request_id`,
`provider_profile_id`, `status`, no price), and spec 018 ("Offer System & 2-Minute Timer") owns
offer creation and its server-authoritative timer. Answer **B**: this spec exposes only the
*action state* — `availableAction: 'send_offer'` on `IncomingRequestDto` — and spec 018 ships
`POST /api/v1/offers`. A `send_offer` endpoint here would pre-empt spec 018's timer semantics, so
`POST .../accept` returns `422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL` for a quote-based service
rather than silently creating an offer.

### Request and response types

```typescript
// lib/types/matching.ts  (this repository has no packages/types)

/** The nine master-spec §23 ranking factors, as a closed union — never a loose string key. */
export type RankingFactor =
  | 'serviceMatch' | 'availability' | 'location' | 'rating' | 'reliability'
  | 'priceFit' | 'experience' | 'verification' | 'historicalPerformance';

/** Every factor's normalized contribution. Strongly typed, replacing the draft's
 *  `Record<string, number>`: the factor set is closed and known at compile time. */
export type ScoreBreakdown = Record<RankingFactor, FactorScore>;

export interface FactorScore {
  /** Normalized 0.000–1.000, 3 decimal places. */
  normalized: number;
  /** The weight applied, from the service override or the platform default. */
  weight: number;
  /** false when no data source exists yet for this factor — see §3 "Missing data". */
  available: boolean;
}

export type MatchingWeights = Record<RankingFactor, number>;

export interface MatchingWeightsDto {
  serviceId: string;
  /** null = this service uses the platform defaults; no row of its own. */
  weights: MatchingWeights | null;
  effectiveWeights: MatchingWeights;
  version: number;
}

export type ExclusionReason =
  | 'service_not_offered' | 'outside_service_area' | 'unavailable'
  | 'not_verified'
  /** Reserved (DECIDED-1). E5 is a documented no-op this release, so no code path emits this. */
  | 'at_capacity';

export type ProviderResponse = 'none' | 'accepted' | 'declined' | 'offer_sent';

export type AvailableAction = 'accept' | 'send_offer' | 'decline_only';

/** ADMIN-ONLY (AC-6). Never returned by a provider- or customer-facing route. */
export interface MatchExplainabilityDto {
  requestId: string;
  rankedAt: string | null;
  eligiblePool: Array<{
    providerProfileId: string;
    businessName: string | null;
    rank: number;
    score: number;
    scoreBreakdown: ScoreBreakdown;
    explorationBoosted: boolean;
    notified: boolean;
    providerResponse: ProviderResponse;
  }>;
  excluded: Array<{ providerProfileId: string; businessName: string | null; reason: ExclusionReason }>;
  notifiedProviderProfileIds: string[];
  poolSize: number;
  effectiveWeights: MatchingWeights;
}

/** Returned to a provider ONLY for a request they were distributed into. */
export interface IncomingRequestDto {
  requestId: string;
  serviceId: string;
  serviceName: string;
  availableAction: AvailableAction;
  /** Coarse distance band, never exact coordinates (spec 012 privacy). */
  approxDistanceKm: number | null;
  approxAreaLabel: string;
  description: string;
  urgency: 'normal' | 'urgent';
  budget: RequestBudget | null;
  preferredAt: string | null;
  distributedAt: string;
  providerResponse: ProviderResponse;
}

export interface ProviderResponseDto {
  requestId: string;
  providerResponse: ProviderResponse;
  respondedAt: string;
}

export interface MatchingSuggestionDto {
  id: string;
  serviceId: string | null;
  suggestedWeights: MatchingWeights;
  rationale: string | null;
  source: string;
  status: 'pending_review' | 'approved' | 'rejected';
  reviewedAt: string | null;
  createdAt: string;
}
```

`IncomingRequestDto` deliberately drops the draft's free-text `distance: string` and `summary` in
favour of typed, privacy-bounded fields: spec 012 forbids exposing a customer's exact coordinates
before booking, so a provider receives a coarse `approxDistanceKm` plus the `approxAreaLabel`
(`lib/location/privacy.ts`) that spec 012 already computes — never the request's `addressId` or
`locations` row.

### Hard eligibility rules (AC-1)

Evaluated in this order, short-circuiting on the first failure, **before any score is computed**.
Each rule names its real data source in this repository.

| # | Rule | Data source (verified to exist) | Eligible when | `ExclusionReason` |
|---|---|---|---|---|
| E1 | Service match | `provider_services` (spec 003 + spec 016 columns); `providerOffersService()` in `lib/availability/service-areas.ts` | a `provider_services` row exists for `(provider, request.serviceId)` | `service_not_offered` |
| E2 | Service area | **spec 016** `isProviderEligibleForLocation(providerProfileId, serviceId, candidate)` with `candidateForRequest(requestId)` | returns `true` (S2: no configured area = unrestricted) | `outside_service_area` |
| E3 | Availability | **spec 016** — see "Availability eligibility" below | see below | `unavailable` |
| E4 | Verification status | `provider_profiles.lifecycle_status` (spec 006) | `= 'active'`. `draft`, `pending_verification`, `paused`, `restricted`, `suspended`, `banned` are all excluded | `not_verified` |
| E5 | Capacity | **none — documented no-op this release (DECIDED-1)** | always eligible; the rule never excludes anyone | `at_capacity` *(reserved, never emitted this release)* |

**E2/E3 reuse spec 016 directly and duplicate none of its logic.** Spec 016 §7 already records this
split: "Matching's use of availability as a ranking *weight* (spec 017) — the hard eligibility check
is this spec's concern; the ranking weight is spec 017's."

**E5 — capacity is a documented no-op this release (DECIDED-1).** The repository has **no capacity
concept at all**: no column, table or setting bounds how much work a provider may hold. Rather than
invent one, E5 ships as an explicit, named no-op:

- **No capacity field or table is added**, here or anywhere. Nothing in §4 stores a capacity limit.
- **No provider is ever excluded for capacity.** `evaluateCapacity()` in
  `lib/matching/eligibility.ts` exists as a single named function that returns "eligible"
  unconditionally, so the rule is a real, testable seam rather than a silent omission — AC-1's five
  rules all have a home, and a reader can see exactly where the sixth behaviour would land.
- **`at_capacity` stays in the `ExclusionReason` union as a reserved value**, never produced by any
  code path this release. Keeping it reserved means a future capacity model adds a rule
  implementation without changing the DTO contract, the persisted vocabulary, or the admin UI.
- **Capacity eligibility is therefore NOT ENFORCED** until a dedicated capacity model exists in its
  own spec. That is a deliberate, recorded scope boundary, not an oversight: a provider who is
  fully booked is already excluded by E3 (availability) whenever the request names a time, so the
  practical gap is narrower than it first appears — it is requests with no `preferred_at`, where no
  time-based signal exists to apply.

**E4 note.** The repository has **no separate verification entity** — no `verified` boolean, no
verification documents table. `provider_profiles.lifecycle_status` is the only status, and its
`pending_verification` value is what "not yet verified" means today. AC-1's "verification status"
is therefore satisfied by E4 as written; if Product later wants document-level verification, that
is a new spec, not a silent addition here.

**Availability eligibility (E3), precisely.** A request's scheduled time is
`requests.preferred_at` + `requests.preferred_timezone`, **both nullable** (spec 015 §4 — a
customer need not state a time).

- **When `preferred_at` is set:** the provider is eligible if the requested interval
  `[preferred_at, preferred_at + provider_services.duration_minutes)` falls inside a resolved
  availability window and collides with no buffered busy interval. This is computed by composing
  spec 016's **existing exported pieces** — `loadWeeklyEntries`, `loadOverrides`,
  `loadServiceBuffers` (`lib/availability/repository.ts`) and `generateSlots` /
  `findConflictingInterval` (`lib/availability/slots.ts`) — in a new **read-only** helper
  `lib/matching/availability-eligibility.ts`. It must **not** call `reserveProviderSlot()`:
  that takes a `SELECT … FOR UPDATE` row lock and is spec 016's write-path primitive for spec 020's
  booking transaction. Taking a lock per candidate provider during a read-only ranking pass would
  serialize matching against every concurrent booking.
- **When `preferred_at` is null:** the provider is eligible if `getAvailabilitySummary()`
  (`lib/availability/summary.ts`) returns a state other than `unavailable`. A `busy` provider stays
  eligible — master spec §42 keeps them discoverable, and the customer has stated no time.

### Ranking (AC-2)

The scoring function is **pure and deterministic**: `scoreProvider(inputs, weights): FactorScore[]`
in `lib/matching/ranking.ts`, taking already-loaded values and returning the breakdown. It performs
no I/O, so every rule below is unit-testable without a database.

`score = Σ (factor.normalized × factor.weight)`, over available factors only (see "Missing data").

| Factor | Definition | Input source | Status in this repository |
|---|---|---|---|
| `serviceMatch` | Exact service offered = 1.0. Reserved for future partial/adjacent-service matching | `provider_services` | **Available** — constant 1.0 for every eligible provider today (E1 already guarantees an exact match), so it is a no-op differentiator until adjacent-service matching exists |
| `availability` | 1.0 if available at the requested time; 0.5 if available that local day but not the exact slot; 0.0 otherwise | spec 016 resolution (same composition as E3) | **Available** |
| `location` | `1 − min(distanceMeters / 50_000, 1)` — linear decay to 0 at 50 km | `distanceMeters()` (`lib/location/geo.ts`) between the request address's `locations` point and the provider's service-area centre address | **Available** for `mode='radius'` providers. **Not available** for `cities`/`remote` providers (no centre point) → `available: false` |
| `rating` | Mean review rating, normalized to 0–1 | `reviews` | **NO DATA** — `reviews` is still spec 003's baseline skeleton (`booking_id`, `author_user_id` only). **There is no rating column.** Spec 029 owns it |
| `reliability` | Accept/decline response rate and median response latency | `request_provider_matches` (this spec's own rows) | **NO DATA at launch** — bootstraps empty by construction; becomes meaningful only after this spec has been live |
| `priceFit` | Provider's typical price vs the request's budget band | `offers` | **NO DATA** — `offers` is baseline-only (`request_id`, `provider_profile_id`, `status`); **no price column**. Spec 018 owns it |
| `experience` | Completed bookings for this service | `bookings` | **NO DATA** — `bookings` is baseline-only (`offer_id`, `status`). Specs 020/028 own completion |
| `verification` | Verification depth beyond the E4 binary gate | `provider_profiles` | **NO DATA** — only `lifecycle_status` exists, which E4 already consumes as a hard gate. Constant for every eligible provider |
| `historicalPerformance` | Completion rate, dispute rate, cancellation rate | `bookings`, `disputes` | **NO DATA** — both baseline-only. Specs 020/028/031 own them |

**This is the single most important finding of this review: 6 of the 9 factors have no data source
in this repository today**, because the specs that own their columns (018, 020, 028, 029, 031) have
not shipped. The ranking engine is still implementable and valuable — but only with the
missing-data rule below made explicit, which the draft did not do.

- **Missing data.** A factor whose source has not shipped returns `available: false` and is
  **excluded from both the numerator and the denominator**. The score is renormalized over
  available weights: `score = Σ(available: normalized × weight) / Σ(available: weight)`. A provider
  is therefore never penalised for a factor nobody can measure, and adding a factor's data source
  later changes ranking without any code change here. If **no** factor is available, every eligible
  provider scores exactly `0.5` and tie-breaking alone orders the pool.
- **Normalization.** Every `normalized` is clamped to `[0, 1]` and rounded **half-up to 3 decimal
  places** before weighting, so scoring is reproducible across platforms and floating-point orders.
- **Score precision and storage.** The final `score` is stored as `score_micros integer`
  (score × 1,000,000, range 0–1,000,000) — **never a float**: `lib/db/schema-lint.test.ts` (spec
  003 AC-1) fails any `numeric`/`real`/`double precision` column schema-wide. The same fixed-point
  approach `locations` uses for coordinates.
- **Deterministic tie-breaking.** Equal `score_micros` → order by `exploration_boosted DESC`
  (AC-3's reserved slots win a tie), then `provider_profiles.created_at ASC` (longest-registered
  first), then `provider_profiles.id ASC`. The final key is a primary key, so the order is **total
  and stable** — no random, no clock, no insertion-order dependence.
- **Platform default weights (DECIDED-2).** Defined once as `DEFAULT_MATCHING_WEIGHTS` in
  `lib/matching/weights.ts`, summing to exactly 100:

  | Factor | Default weight | Has a data source today? |
  |---|---:|---|
  | `serviceMatch` | 25 | Yes (constant 1.0 — E1 guarantees an exact match) |
  | `availability` | 20 | Yes (spec 016) |
  | `location` | 15 | Yes for `radius` providers; unavailable for `cities`/`remote` |
  | `rating` | 10 | No — spec 029 |
  | `reliability` | 10 | No at launch — self-populates from this spec's own rows |
  | `priceFit` | 5 | No — spec 018 |
  | `experience` | 5 | No — specs 020/028 |
  | `verification` | 5 | No beyond E4's binary gate |
  | `historicalPerformance` | 5 | No — specs 020/028/031 |
  | **Total** | **100** | |

  **What these defaults mean in practice at launch.** Because six factors have no data source yet
  (§3 "Missing data"), only `serviceMatch` (25), `availability` (20) and `location` (15) are
  available, and the renormalization rule divides by their weight sum of 60. So a launch-day score
  is effectively `(0.417 × serviceMatch) + (0.333 × availability) + (0.250 × location)`. Since
  `serviceMatch` is constant 1.0 for every eligible provider, **availability and location are what
  actually order the pool at launch** — with the remaining 40 points of weight activating on their
  own as specs 018/020/028/029/031 ship, with no code change here. This is stated explicitly so
  nobody later reads the 25-point `serviceMatch` as a bug when it differentiates nothing.

- **Weights: source and validation.** Effective weights = `services.matching_weights` (jsonb, this
  spec's addition) when set, else `DEFAULT_MATCHING_WEIGHTS` above. Validation on
  `PATCH .../matching-weights`: every one of the nine `RankingFactor` keys present exactly once;
  each an integer `0–100`; **the nine must sum to exactly 100**. Integers summing to 100 avoid the
  floating-point drift a "must sum to 1.0" invariant would invite, and make the admin UI
  self-explanatory. Anything else → `422 INVALID_MATCHING_WEIGHTS` naming each offending key.

### New-provider exploration (AC-3)

Deterministic by construction — no randomness, no hidden state, no per-provider counters.

- **"New provider" definition.** A provider with **zero terminal responses** in
  `request_provider_matches` — no row with `provider_response` in (`accepted`, `declined`,
  `offer_sent`). This is computable from this spec's own table, needs no new schema, and cannot be
  gamed by creating a profile and idling. (An age-based definition was rejected: it would expire
  exposure for a provider who has never actually been given a chance.)
- **Mechanism — reserved slots, not a score boost (DECIDED-4).** `EXPLORATION_SHARE = 0.20` —
  **20% of the distribution pool**, defined as `EXPLORATION_SHARE` in `lib/matching/fairness.ts`.
  Of the pool of size `N`, `explorationSlots = floor(N × 0.20)` are reserved for the highest-ranked
  *new* providers who did not already place in the organic top-`N`. Organic ranking fills the
  remaining `N − explorationSlots`. Reserved slots are filled by the same deterministic ordering
  used everywhere else, so the result is reproducible.

- **Rounding, stated explicitly.** `floor` — always rounded **down**, never up, never to nearest.
  20% is a **cap**, so rounding up could exceed it; `floor` cannot. The consequence is concrete and
  intended:

  | Pool size `N` | `N × 0.20` | Reserved slots | Organic slots |
  |---:|---:|---:|---:|
  | 1 | 0.2 | 0 | 1 |
  | 4 | 0.8 | 0 | 4 |
  | 5 | 1.0 | 1 | 4 |
  | **10 (default)** | **2.0** | **2** | **8** |
  | 12 | 2.4 | 2 | 10 |
  | 50 (max) | 10.0 | 10 | 40 |

  Pools smaller than 5 therefore reserve **no** slot. That is deliberate: in a pool of 1–4 a single
  reserved slot would be 25–100% of all exposure for that request, far past the 20% cap Product
  set, and would displace the single most relevant provider. New providers still compete organically
  in those pools — they are not excluded, merely not additionally boosted.

- **Exploration can never become a permanent ranking advantage.** Three independent guarantees:
  (a) a provider stops being "new" the moment they record their **first** terminal response, so the
  status is self-extinguishing and cannot be held indefinitely; (b) exploration never touches the
  persisted `score_micros`, which stays purely organic, so a boosted provider accrues no lasting
  score benefit and spec 040 can compare the boosted and organic populations honestly; (c) the
  reserved share is a hard ceiling of 20% of one request's pool — it confers no cross-request
  memory, no accumulating credit, and no carry-over when a slot goes unused.
- **Why reserved slots rather than a weight bonus.** A bonus added to the score would interact
  unpredictably with admin-configured weights — an admin lowering every weight would silently
  amplify it — and would make AC-2's "documented weighted factors" untrue. Reserved slots keep
  quality/relevance primary for the organic majority (master spec §24) while guaranteeing a bounded,
  auditable exposure share. `explorationBoosted` is persisted per row so AC-6 can show exactly which
  providers entered by this route.
- **Bounds.** Exploration affects **distribution only** — never hard eligibility (an ineligible new
  provider is still excluded) and never the persisted `score`, which stays purely organic so
  fairness analytics (spec 040) can compare the two populations honestly.
- **Persistent state:** none required beyond `request_provider_matches` rows this spec already
  writes.

### Distribution (AC-4)

- **Pool size `N` (DECIDED-3): platform default `10`**, defined as `DEFAULT_MATCHING_POOL_SIZE` in
  `lib/matching/weights.ts`. Resolution order: `services.matching_pool_size` (per-service override,
  nullable — the existing admin mechanism, set through
  `PATCH /api/v1/admin/services/{id}/matching-weights`) → the platform default. Bounded
  **`1 ≤ N ≤ 50`**, enforced both by the route's validation (`422 INVALID_MATCHING_WEIGHTS`) and by
  the `services.matching_pool_size` CHECK constraint in §4, so no path can persist an out-of-range
  value.
- **Fewer eligible providers than `N`:** all eligible providers are notified. This is not an error
  and not a warning — it is the normal case in a young marketplace. With the default `N = 10`: 6
  eligible providers → all 6 notified.
- **Never the entire eligible set once it exceeds `N`:** with more than `N` eligible providers,
  exactly `N` are notified — 40 eligible at the default → 10 notified (8 organic + 2 exploration),
  30 ranked but not distributed. Master spec §29's "do not blast every provider" is therefore
  enforced by construction, not by convention.
- **Idempotency.** `request_provider_matches` **already carries a unique index on
  `(request_id, provider_profile_id)`** (spec 003 baseline, verified in `lib/db/schema.ts`). The
  whole matching pass runs in one transaction and writes rows with `ON CONFLICT DO NOTHING` on that
  index, so re-running matching for the same request **cannot** create a duplicate row or widen the
  notified set. Re-running is explicitly safe and is the documented recovery action.
- **Notification state** is `notified_at timestamptz` (null = ranked but not distributed) rather
  than a boolean, so the distribution instant is auditable. Actual delivery is **spec 026's**; this
  spec records the intent, exactly as spec 016 did for availability notifications.
- **Status transition.** Matching moves the request `submitted → matching`. **That transition is
  NOT currently seeded** in `requests_status_transitions` — `drizzle/0011_add_request_columns.sql`
  seeds only `draft→submitted`, `submitted→cancelled`, `matching→cancelled`, `offers_open→cancelled`,
  deliberately leaving unimplemented transitions to fail loudly at the database. **This spec's
  migration must seed `('submitted','matching')`**, or the spec-003 DB trigger will reject the
  write. Seeding `matching→offers_open` is **spec 018's**, not this spec's.

### Provider actions and pricing model (AC-5)

Master spec §26 and the repository's `PRICING_MODELS` define **five** models —
`fixed`, `package`, `hourly`, `quote`, `custom` — not the two AC-5 names. The draft left three
unmapped. Mapping, preserving AC-5's intent exactly:

| `services.pricing_model` | `availableAction` | Rationale |
|---|---|---|
| `fixed` | `accept` | AC-5's "fixed/instant" — the price is already determined |
| `package` | `accept` | A package is a pre-priced bundle; nothing is left to quote |
| `hourly` | `accept` | The rate is pre-set; the total follows from actual hours at completion |
| `quote` | `send_offer` | AC-5's "quote-based" |
| `custom` | `send_offer` | Bespoke work cannot be accepted at a pre-set price |

`decline_only` is returned when the provider has already responded or the request is no longer
actionable; **Decline itself is always available** while the request is actionable, per AC-5.

**Authorization and state rules, all enforced server-side:**

- The provider must have a `request_provider_matches` row for the request with `notified_at` set.
  Otherwise `403 NOT_DISTRIBUTED_TO_PROVIDER` — checked before anything else, so a provider cannot
  probe request ids.
- `requireActiveMode(session, 'provider')` plus ownership via
  `findProviderProfileForUser(session.userId)` (spec 016's helper) — the route never accepts a
  provider id from the client.
- The request must be in `matching` or `offers_open`. A `cancelled`, `expired`, `provider_selected`,
  `booking_created` or `completed` request → `422 REQUEST_NOT_ACTIONABLE`.
- `accept` on a `quote`/`custom` service → `422 ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL`.
- **Duplicate actions are idempotent, not errors:** repeating the same action returns `200` with
  the existing `ProviderResponseDto`. A *different* second action → `422 REQUEST_NOT_ACTIONABLE`.

### Concurrency and the claim invariant

**The invariant: at most one provider may hold `provider_response = 'accepted'` for a given
request.** Enforced by two independent layers, following the repository's established idioms:

1. **Application, inside one transaction** — `SELECT id FROM requests WHERE id = $1 FOR UPDATE`
   taken *before* reading any response state, then the conflict check, then the write. This is the
   exact pattern spec 016's `reserveProviderSlot()` uses on `provider_profiles`, and spec 003 AC-6's
   optimistic-concurrency convention backs it (`lib/db/concurrency.integration.test.ts`).
2. **Database** — a partial unique index
   `unique (request_id) where provider_response = 'accepted'`, so even a code path that skipped the
   lock cannot produce two accepted providers. The same partial-unique technique spec 016 used for
   its pending-notification idempotency.

A losing concurrent accept receives `409 REQUEST_ALREADY_CLAIMED` (never a generic 500, and never
silent success). Distribution duplication is prevented by the existing
`(request_id, provider_profile_id)` unique index; duplicate provider responses by the
idempotency rule above.

### Error codes

Extends spec 004's `API_ERROR_CODES` table in the established SCREAMING_SNAKE_CASE + stability way.
Codes outside the baseline map pass `options.status` explicitly, as spec 005/016 already do.

| HTTP | `code` | When |
|---|---|---|
| `403` | `NOT_DISTRIBUTED_TO_PROVIDER` | provider acts on a request they were not distributed into |
| `409` | `REQUEST_ALREADY_CLAIMED` | another provider already accepted this request |
| `409` | `SUGGESTION_ALREADY_REVIEWED` | approve/reject on a suggestion not in `pending_review` |
| `409` | `CONFLICT` | stale `expectedVersion` on a weights update (spec 003 AC-6) |
| `422` | `ACTION_NOT_AVAILABLE_FOR_PRICING_MODEL` | "Accept" attempted on a `quote`/`custom` service |
| `422` | `REQUEST_NOT_ACTIONABLE` | request cancelled/expired/already progressed, or a conflicting second action |
| `422` | `INVALID_MATCHING_WEIGHTS` | weights missing a factor, out of range, not summing to 100, or an out-of-bounds pool size |
| `403` | `FORBIDDEN` | wrong active mode, or admin lacking the required role/risk tier |
| `404` | `NOT_FOUND` | unknown request/service/suggestion, or session user has no provider profile |

### Breaking-change check

- [x] N/A — new spec. No existing route's path, auth or response shape changes.

---

## 4. Data model changes

Drizzle ORM (`lib/db/schema.ts`), not Prisma. Schema constraints that apply (enforced by
`lib/db/schema-lint.test.ts`): no `numeric`/`real`/`double precision` anywhere — hence
`score_micros integer`; every timestamp `timestamptz`; every FK `onDelete: 'restrict'` with its own
covering index.

### Entities

| Entity | Change | Fields |
|---|---|---|
| `request_provider_matches` | **extend** (exists as spec 003 baseline: `id`, audit, `version`, `request_id`, `provider_profile_id`, both indexed, **plus an existing unique index on `(request_id, provider_profile_id)`**) | `eligible boolean not null`, `exclusion_reason text null` (the 5 `ExclusionReason` values), `rank integer null`, `score_micros integer null`, `score_breakdown jsonb null`, `exploration_boosted boolean not null default false`, `notified_at timestamptz null`, `provider_response text not null default 'none'` (`none`/`accepted`/`declined`/`offer_sent`), `responded_at timestamptz null`; CHECKs pairing `eligible = false` with a non-null `exclusion_reason` and null rank/score, and `provider_response <> 'none'` with a non-null `responded_at`; partial unique index `(request_id) where provider_response = 'accepted'`; index `(request_id, rank)` for the ranked read and `(provider_profile_id, notified_at)` for the provider's own inbox |
| `services` | **extend** (spec 010) | `matching_weights jsonb null` (per-service override; null = platform defaults), `matching_pool_size integer null` (per-service override; CHECK `between 1 and 50`) |
| `matching_suggestions` | **new** | `...baseColumns()`, `service_id uuid null references services.id restrict`, `suggested_weights jsonb not null`, `rationale text`, `source text not null`, `status text not null default 'pending_review'` (`pending_review`/`approved`/`rejected`), `reviewed_at timestamptz null`, `reviewed_by uuid null references users.id restrict`; covering index on each FK plus `status`; CHECK on `status`. **Deliberately shaped to match the already-shipped `catalog_suggestions` table** (spec 010) field-for-field where the concepts align, so the review workflow, audit fields and admin UI follow one pattern rather than two |

`provider_response` is **`text` + a CHECK constraint**, not a Postgres enum — matching every other
status column in this schema (`requests.status`, `catalog_suggestions.status`,
`provider_service_areas.mode`). It is a **provider-response vocabulary, not a state machine**, so it
correctly does **not** get a `*_status_history`/`*_status_transitions` pair: spec 003 AC-3 reserves
those for the five state-machine entities (Request, Offer, Booking, Payment, Payout), and
`request_provider_matches` is none of them.

`matching_suggestions` must also be added to `EXPECTED_TABLES` in `lib/db/schema-coverage.test.ts`,
and `services.matching_weights` / `matching_suggestions.suggested_weights` to the documented jsonb
allowlist in `lib/db/schema-lint.test.ts` (AC-5), in the same PR — the same two registrations spec
016 made.

**Deliberately unchanged:** `requests` (spec 015 owns it — this spec only transitions its status
through the existing mechanism), `offers` and `bookings` (specs 018/020), and every spec 016 table.

### Migration

- **Name:** `0013_add_matching_ranking_distribution`
- **Generated by:** `npm run db:generate` (drizzle-kit); applied by `npm run db:migrate`. The spec
  003 baseline (`drizzle/0001_baseline_schema.sql`) and its `.sha256` are **not** touched.
- **Also seeds:** `INSERT INTO requests_status_transitions VALUES ('submitted','matching') ON
  CONFLICT DO NOTHING` — required, per §3 "Status transition", and idempotent in the same style as
  `0011`.
- **Reversible:** yes — a hand-written `_down.sql`, as `0012` shipped.
- **Backfill required:** no. Every added column is nullable or defaulted.
- **Downtime:** none.

### Retention and privacy

Integrates with **spec 008's existing** export/deletion mechanism; no new privacy path:

- **Export** (`lib/privacy/export.ts`): a customer exports the *existence and outcome* of matching
  on their own requests — `requestId`, `rank`, `providerResponse`, `notifiedAt` — via the same
  explicit column allowlist and ownership-scoped join every existing section uses. A **provider**
  exports the rows where they are the `provider_profile_id`. **Neither party ever exports the other
  party's `score_breakdown`, `score_micros` or `exclusion_reason`** — those are admin-only (AC-6),
  and a provider learning *why a competitor was excluded* is a competitive-intelligence leak.
  `matching_suggestions` is platform configuration data, not personal data, and is **not** exported
  to any user.
- **Deletion** (`lib/privacy/deletion.ts`): `request_provider_matches` rows are retained keyed to
  the anonymized user, like every other provider-owned row — they carry no PII of their own once
  `provider_profiles.business_name` is nulled by the existing sweep, and every FK is `restrict`.
- **Never exposed:** exclusion reasons, scores and breakdowns appear **only** on
  `GET /api/v1/requests/{id}/matches` (admin role-gated). No provider- or customer-facing DTO in §3
  carries them. A provider is never told their own rank or score either — publishing rank invites
  gaming and reveals the competitive set.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | provider's incoming-requests list renders the DS `Skeleton` while `GET /providers/me/requests` resolves |
| **Empty** | the DS `EmptyState`: "No new requests right now", with next steps (broaden service areas, check availability) linking to `/provider/schedule` (spec 016) — never a dead end (master spec §22) |
| **Error** | an accept that lost the race shows the DS `Alert` with the specific "another provider has already taken this request" message, not a generic error, and the row updates in place |
| **Success** | accepted/declined state reflected immediately; the admin matching view renders exclusion reasons per provider |

**Route(s) (this repo, not the template's `apps/web`):** `app/provider/requests/page.tsx` —
replaces the existing spec-014 `PlaceholderPage`, whose own copy already names specs 015/017.
`app/admin/marketplace/matching/page.tsx` — a new page under the **existing** `app/admin/marketplace/`
directory, alongside the shipped `catalog/` page.

**Shared components:** all from the existing APURIVA Design System via `@/components`, styled only
with `app/styles/apuriva-tokens.css` tokens. Already exported and used as-is: `Card`, `Button`,
`Badge`, `Table`, `Alert`, `Toast`, `EmptyState`, `ErrorState`, `Skeleton`, `ConfirmDialog`, `Tag`,
`PriceDisplay`, `ListRow`.

The draft's new admin-only `ScoreBreakdown` component is **not** introduced as a design-system
primitive: the breakdown is rendered with the existing `Table` in
`app/admin/marketplace/matching/_components/`, the same way spec 016 built its weekly editor from
existing primitives. **No new design-system primitive, no token override, and no redesign of any
shipped screen.**

---

## 6. Test plan

**Vitest only.** This repository has **no Playwright or Cypress** — `package.json` installs neither,
and `vitest.config.ts` runs `e2e/*.spec.ts` as ordinary Vitest files. The draft's
`apps/web-e2e/matching.spec.ts` row is removed rather than promised, exactly as approved specs 015
and 016 did.

Integration tests run against the isolated `<name>_test` database only (`vitest.config.ts` rewrites
`DATABASE_URL`; `test/db-reset.ts` refuses any other name) and follow the existing
`describe.skipIf(!dbReachable)` pattern. The claim-race test follows the **two-connection** pattern
established in `lib/db/concurrency.integration.test.ts` and reused in
`lib/availability/reserve.integration.test.ts`.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | each eligibility rule in isolation; the pure scoring function incl. normalization, renormalization over missing factors, clamping, rounding and tie-breaking; weight validation; exploration-slot selection; pricing-model → action mapping | `lib/matching/*.test.ts` |
| **Integration** | full pass: submitted request → eligibility → ranking → bounded distribution → provider action; idempotent re-run; ownership and active-mode enforcement; admin role gating | `app/api/v1/providers/matching.integration.test.ts`, `app/api/v1/requests/matches.integration.test.ts` |
| **Concurrency** | two providers accepting the same request across two real connections — exactly one wins | `lib/matching/claim.integration.test.ts` |
| **Component** | incoming-requests list states; action button per pricing model | `app/provider/requests/**/*.test.tsx` (Testing Library, jsdom) |
| **Admin** | explainability payload contents and role gating; suggestion approve/reject | `app/api/v1/admin/matching/*.integration.test.ts` |
| **Privacy** | export includes own rows and excludes the counterparty's scores/exclusion reasons | `lib/privacy/export.integration.test.ts` |

**Traceability** — every AC covered, including AC-5 and AC-6 which the draft omitted.

| AC | Test |
|---|---|
| AC-1 | `lib/matching/eligibility.test.ts::excludes on each rule with the right reason`, `::E1–E4 each independently exclude`, `::E5 capacity is a no-op — no provider is ever excluded for capacity and `at_capacity` is never emitted` (DECIDED-1), and `app/api/v1/requests/matches.integration.test.ts::no excluded provider appears in the ranked pool or contributes to any score` |
| AC-2 | `lib/matching/ranking.test.ts::applies the weighted formula deterministically`, `::a per-service weight override changes the order`, `::renormalizes over factors whose data source has not shipped`, `::breaks ties by explorationBoosted, then created_at, then id`, `::DEFAULT_MATCHING_WEIGHTS sums to exactly 100`, and `app/api/v1/admin/matching/weights.integration.test.ts::rejects weights that do not sum to 100` |
| AC-3 | `lib/matching/fairness.test.ts::a provider with no terminal response is treated as new`, `::reserved slots go to the highest-ranked new providers only`, `::floor rounding — pools of 1–4 reserve no slot, 10 reserves 2, 50 reserves 10`, `::exploration never affects hard eligibility and never alters the persisted organic score`, `::a provider stops being new after their first terminal response` |
| AC-4 | `app/api/v1/requests/matches.integration.test.ts::notifies at most the configured pool size (default 10)`, `::notifies all eligible when fewer than the pool size exist`, `::never notifies the whole eligible set when more than 10 are eligible`, `::re-running matching creates no duplicate rows and does not widen the notified set` |
| AC-5 | `lib/matching/actions.test.ts::maps each of the five pricing models to its action` and `app/api/v1/providers/matching.integration.test.ts::accept on a quote service returns 422`, `::a provider not distributed into the request gets 403`, `::repeating the same action is idempotent` |
| AC-6 | `app/api/v1/requests/matches.integration.test.ts::returns exclusions with reasons to an operations admin`, `::rejects a non-admin with 403`, `::no provider- or customer-facing endpoint exposes any score, breakdown or exclusion reason` |
| AC-7 | `app/api/v1/admin/matching/suggestions.integration.test.ts::a recorded suggestion never alters live weights`, `::approval requires an explicit admin action and is audited`, `::approve/reject on an already-reviewed suggestion returns 409` |

**Coverage:** ≥80% on new code — the repository's established standard.

**Not covered, deliberately:** long-run ranking-quality/relevance tuning — functional correctness of
the pipeline is tested, not subjective match quality (a product-iteration concern, not an
acceptance criterion here).

---

## 7. Out of scope

- Offer creation itself once a provider chooses "Send Offer" (**spec 018**) — this spec exposes the
  action *state* only and adds no offer endpoint or column.
- Notification **delivery** to the distributed pool (**spec 026**) — this spec records `notified_at`;
  the channel, template and preferences are spec 026's, exactly as spec 016 left its availability
  notifications.
- Any change to spec 016's availability or service-area logic — this spec **consumes** its exported
  functions and adds nothing to `lib/availability/*`.
- Any change to spec 015's request lifecycle beyond seeding and performing the
  `submitted → matching` transition through the existing mechanism.
- Sponsored placements (explicitly Phase 2, master spec §25, §122).
- Advanced ML ranking (explicitly Phase 2, master spec §122) — this spec is the rule-based engine
  only, and AC-7 records AI *suggestions* for humans, never an ML ranker.

---

## 8. Risks and open questions

### Product decisions — all four resolved

None of these four could be derived from the master specification, the approved spec chain, or the
repository; each was escalated rather than invented. Product has answered all four, and each answer
is specified in full in §3.

| # | Decision | Answer | Specified in |
|---|---|---|---|
| **DECIDED-1** | Capacity model (AC-1, rule E5) | **No capacity model this release.** E5 is a documented no-op: no capacity field or table is added, no provider is ever excluded for capacity, `at_capacity` stays reserved in the `ExclusionReason` union but is never emitted, and capacity eligibility is **not enforced** until a dedicated capacity model ships in its own spec. Kept as a named extension point (`evaluateCapacity()`), not a silent omission | §3 "E5 — capacity is a documented no-op" |
| **DECIDED-2** | Default ranking weights | `serviceMatch` 25, `availability` 20, `location` 15, `rating` 10, `reliability` 10, `priceFit` 5, `experience` 5, `verification` 5, `historicalPerformance` 5 — **total exactly 100**. Per-service admin override retained; the sum-to-100 validation, normalization, missing-data renormalization, rounding and tie-breaking rules are unchanged | §3 "Platform default weights" |
| **DECIDED-3** | Default distribution pool size | **10**, configurable per service through the existing admin mechanism, bounded `1 ≤ N ≤ 50`. Fewer than 10 eligible → notify all eligible; more than 10 eligible → exactly 10, never the whole set | §3 "Distribution" |
| **DECIDED-4** | New-provider exploration share | **20% of the pool**, applied only after hard eligibility, never bypassing any hard rule, deterministic (never random), rounded **down** (`floor`), with quality/relevance remaining primary and three guarantees that it can never become a permanent advantage | §3 "New-provider exploration" |

### Non-blocking risks

| # | Risk | Owner | Resolution |
|---|---|---|---|
| 5 | 6 of 9 ranking factors have no data source until specs 018/020/028/029/031 ship | Platform | **Resolved by design** — §3's renormalization rule means unavailable factors are excluded from both numerator and denominator, so each source can be switched on later with no code change here and no penalty in the meantime |
| 6 | `reliability` is computed from this spec's own table and is therefore empty at launch | Platform | **Accepted** — it self-populates as the engine runs; the renormalization rule covers the empty period |
| 7 | The `matching-fairness-exposure` feature flag named in the draft's §9 has no mechanism | Platform | **Resolved** — `feature_flags` is still spec 003's column-less baseline table and **spec 041 owns making it real**. This spec therefore ships the exploration share as configuration (DECIDED-4's 20%), not as a runtime flag, and §9 no longer promises one. Inventing a parallel flag system would duplicate spec 041 |
| 8 | `serviceMatch` and `verification` are constant across every eligible provider today | Platform | **Accepted and documented** — both are already enforced as hard gates (E1/E4), so as ranking factors they are no-op differentiators until adjacent-service matching and richer verification exist. They remain in the breakdown for explainability and forward compatibility |

---

## 9. Rollout

- **Feature flag:** none. The `matching-fairness-exposure` flag the draft named cannot exist yet —
  `feature_flags` is a column-less spec-003 baseline table and spec 041 owns the runtime
  configuration mechanism (§8 risk #7). The exploration share is plain configuration
  (`EXPLORATION_SHARE = 0.20`, DECIDED-4); setting it to `0` disables new-provider exposure without
  a flag system.
- **Migration order:** `0013_add_matching_ranking_distribution` ships with the code in the same
  deploy; every added column is nullable or defaulted, and the transition seed is idempotent.
- **Rollback:** revert the deploy and apply the migration's `_down.sql` (`npm run db:rollback`
  pattern). `services.matching_weights` is configuration data and is preserved by a revert, not
  destroyed.
- **Observability:** match-to-offer conversion rate, provider exposure distribution (the fairness
  metric master spec §24 requires monitoring), pool-fill rate (how often fewer than `N` providers
  are eligible — the early-marketplace health signal), and matching latency, emitted through the
  existing correlation-id-tagged API logging (spec 004) and consumed by spec 040.
