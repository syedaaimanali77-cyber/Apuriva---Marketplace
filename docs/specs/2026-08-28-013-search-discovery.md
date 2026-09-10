# Spec: Search & Discovery

**File:** `docs/specs/2026-08-28-013-search-discovery.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §19–§22, §97, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §13, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No search exists. Master spec §19 calls search a major differentiator: keyword, NL,
and voice input, with AI interpreting intent but never inventing results — actual results must
always come from authoritative backend search infrastructure (master spec §97, §132.9).

**Who is affected:** Every customer discovering services/providers; the AI assistant (spec 034),
which must call this search infrastructure rather than fabricate answers.

**Why it matters now:** It is the primary discovery entry point in the customer journey
(`docs/workflow.md` §1) and a hard dependency for request creation (015).

**Success looks like:** A customer can type or speak a natural-language query, see it correctly
interpreted (service/time/area/budget), and get real, ranked, authoritative results with
working autocomplete, sensible loading behavior, and a non-dead-end empty state.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** the query "Need an electrician tomorrow around DHA, preferably under Rs. 3,000" **When** submitted **Then** the interpreted intent (service=Electrician, time=tomorrow, area=DHA, budget<=3000) is shown to the user before/alongside results, and results come from real backend search, never AI-fabricated listings |
| AC-2 | **Given** a partial query **When** typed **Then** autocomplete suggests recent searches, popular services, categories, service names, and location suggestions |
| AC-3 | **Given** a search with no matching providers **When** results are empty **Then** the user sees actionable next steps (expand area, change date/time, adjust budget, browse nearby, post a request) — never a dead end |
| AC-4 | **Given** mobile **When** scrolling results **Then** loading is continuous/infinite; **given** desktop **When** paging **Then** load-more/pagination is used, and filters/sort/location persist across either |
| AC-5 | **Given** a voice input **When** transcribed **Then** the transcription is treated as untrusted text input like any typed query — subject to the same interpretation and validation, never given elevated trust |
| AC-6 | **Given** identical search parameters **When** repeated **Then** results are deterministic from the authoritative data store (no AI randomness in what counts as a match) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/search` | none | `200` `PagedResponse<SearchResultDto>` | keyword params: `q`, `serviceId`, `categoryId`, `lat/lng`, `radiusKm`, `budgetMaxMinorUnits`, `date`, `sort` — see below |
| `POST` | `/api/v1/search/interpret` | none | `200` `ApiResponse<SearchIntentDto>` | NL/voice-transcribed text → structured intent (AI-assisted, read-only, low-risk per spec 034's autonomy-tier model, called through the `lib/ai` abstraction spec 033 establishes — never a direct vendor call) |
| `GET` | `/api/v1/search/autocomplete` | session or guest | `200` `ApiResponse<AutocompleteSuggestionDto[]>` | session (via `lib/auth/require-session.ts`'s `getOptionalSession`, the same optional-session pattern spec 012 introduced) includes the caller's own recent searches in the suggestion mix; a guest gets popular/category/service/location suggestions only — see below |
| `POST` | `/api/v1/search/recent` | session | `204` | records a search to the caller's own recent-searches list (see `RecordRecentSearchRequest` below); no separate `GET` is needed — `/search/autocomplete` is the one read path that sources from it |

**Eligibility/visibility filter (AC-6, determinism):** `/api/v1/search` returns only `services`
with `status = 'published'` from a `providerServices` row whose `providerProfiles.lifecycleStatus
= 'active'` — the same visibility rule spec 010's `listCategoriesPublic`/`getCategoryPublic`
already apply to categories/services. A draft, pending-review, retired, or provider-suspended
listing must never appear in search results. **Tie-breaking:** when `sort` produces equal values
(e.g. two results at the same distance or price), ties are broken by `id` ascending, so identical
parameters always return identically ordered results (AC-6) even across ties.

**`sort` enum:** `'relevance' | 'distance' | 'price_asc' | 'price_desc'` (default `'relevance'`).
A `'rating'` sort is deliberately not included in this version — `providerProfiles` has no rating
column yet; that aggregate is spec 029's (reviews & ratings) to add, currently unimplemented (see
§8). `lat/lng` follow `lib/location/geo.ts`'s existing `GeoPoint`/`isValidLatitude`/
`isValidLongitude` conventions rather than inventing new coordinate validation, and `radiusKm` is
evaluated via that module's `distanceMeters` — this is a simple query-side radius filter on the
provider's own location, a separate mechanism from a provider's *declared service area*
(spec 016/017's eligibility concern, not this spec's).

**Pagination, rate limiting, OpenAPI:** `/api/v1/search` uses the existing `parsePageParams`/
`buildPage` convention (`lib/api/pagination.ts`, `DEFAULT_PAGE_LIMIT = 20`, `MAX_PAGE_LIMIT =
100`), not a new pagination scheme. All four routes rate-limit under the `'search'`
`RateLimitDomain`, which already exists in `lib/api/rate-limit.ts` (60/60s) — no new domain is
needed. All four must be added to `OPENAPI_ROUTES` in `lib/api/openapi-registry.ts` in the same
PR (enforced by `scripts/check-openapi-drift.ts`).

**Autocomplete contract details (AC-2):** triggers at 2+ characters; returns at most 10
suggestions, deduplicated by `(type, label)`; "popular services/categories" rank by the existing
`categories.sortOrder`/an equivalent service ordering until spec 040's usage analytics exist to
rank by actual popularity.

### Request and response types

```typescript
// lib/types/search.ts
import type { PriceDisplay } from '@/lib/types/service-page'; // reuse, not redefine (§6 UI reuses the same component)

export interface SearchIntentDto {
  serviceId?: string;
  serviceNameRaw?: string;
  area?: string;
  date?: string;
  budgetMaxMinorUnits?: number;
  currencyCode?: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface SearchResultDto {
  providerId: string;
  serviceId: string;
  displayName: string;
  /** A coarse, bucketed label ("Under 1 km", "1-5 km", "5-10 km", "10+ km") — deliberately never
   * a precise figure computed straight from exact coordinates. A precise distance repeated across
   * several queries from different points would let a client triangulate a provider's exact
   * location before booking, which master spec §8/spec 012 AC-3 forbid. */
  approxDistance?: string;
  /** Absent until the provider has at least one rating — spec 029 (reviews & ratings, not yet
   * implemented) owns this aggregate; `providerProfiles` has no rating column today. Search must
   * not fabricate a rating for a provider with none. */
  rating?: number;
  priceDisplay: PriceDisplay;
  badges: string[];
}

/** §3 `GET /api/v1/search/autocomplete`. */
export interface AutocompleteSuggestionDto {
  type: 'recent_search' | 'popular_service' | 'category' | 'service' | 'location';
  label: string;
  /** What re-running this suggestion means: the raw query text for `recent_search`, or an
   * id (`serviceId`/`categoryId`) for the others — `/api/v1/search` accepts either shape via its
   * existing `q`/`serviceId`/`categoryId` params, no new param is introduced for this. */
  value: string;
}

/** §3 `POST /api/v1/search/recent`. Identifies the search being recorded by its resolved filter
 * parameters (not a free-form blob), so a recorded entry can be replayed directly as `/search`
 * query params later. */
export interface RecordRecentSearchRequest {
  q?: string;
  serviceId?: string;
  categoryId?: string;
}
```

`SearchIntentDto` is a *suggestion* the frontend pre-fills into real filter parameters — it is
never sent directly to a results-rendering step without going through `/api/v1/search`'s
authoritative query. Structurally, nothing in this contract carries an "this came from voice"
flag anywhere — `/search/interpret` and `/search` both take plain text/params with no such field,
so a voice transcription cannot be given elevated trust by construction (AC-5), not merely by
convention.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | malformed filter parameters |
| `422` | `INTERPRETATION_LOW_CONFIDENCE` | AI could not confidently extract intent; frontend falls back to plain keyword search |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `RecentSearch` | new | `id uuid pk`, `user_id uuid fk->User (restrict)`, `q text`, `service_id uuid fk->Service (restrict, nullable)`, `category_id uuid fk->Category (restrict, nullable)`, `created_at` |
| `AnalyticsEvent` | reuse (spec 003 stub) | spec 013 *emits* search-query and result-click events; spec 040 owns adding `AnalyticsEvent`'s real columns (`event_type`, `payload`, `occurred_at`) and its persistence/retention — this spec does not add columns to `analytics_events` itself, the same boundary spec 010 already draws around audit logging (spec 039) |
| (no new core entity beyond `RecentSearch`) | — | search reads from `Service`, `ProviderService`, `ProviderProfile`, `Location` (specs 010–012) via a dedicated read/query layer, not a new source of truth. `ProviderAvailability`/`ProviderServiceArea` (spec 016) are still bare baseline tables with no day/time/radius/city columns — until spec 016 adds them, `/api/v1/search` cannot filter by availability or a provider's *declared* service area (only by the query-side `radiusKm` primitive above); this is a real, currently-unfillable gap, not an oversight |

`RecentSearch` is why AC-2's "recent searches" source has anywhere to actually read from —
`analytics_events` is not it: it's still column-less (§4 above), and even once spec 040 adds
columns, an analytics log is the wrong shape for a low-latency, per-user, autocomplete-facing read
path. Add it to `schema-coverage.test.ts`'s `EXPECTED_TABLES` and give each of its three FKs
(`user_id`, `service_id`, `category_id`) their own covering index per the existing "every FK gets
one" convention.

Full-text search is added to `services.name`/`providerProfiles.businessName` — the only two text
columns that actually exist on those tables today. Neither table has a `description` column yet
(that would be spec 010/011's to add); full-text search over a future description field is out of
scope until one exists. Vector/embedding search is **not** part of this migration at all — §7
already correctly scopes it as "optional, later, without a contract change," so §4 must not
contradict that by adding a vector index now. No `pgvector` extension exists in this schema today.

### Migration

- **Name:** `AddSearchIndexes` (adds `RecentSearch` as a table plus the FTS index — despite the
  name, per the same "name the columns/indexes added" convention as `AddLocationAddressColumns`)
- **Reversible:** yes (drop the table and indexes)
- **Backfill required:** no — a GIN/full-text index is computed from `name`/`businessName`'s
  existing values directly; there is no new column whose historical values need populating
- **Downtime:** the project's migration runner (`lib/db/migrate.ts`, via
  `drizzle-orm/node-postgres/migrator`) wraps every pending migration in a single transaction, and
  Postgres refuses `CREATE INDEX CONCURRENTLY` inside a transaction — so, unlike the claim in an
  earlier draft of this section, the index cannot actually be built concurrently through
  `npm run db:migrate` as this project's tooling stands. Given the target tables are small at this
  stage, a brief write-lock during migration is accepted rather than standing up a separate
  out-of-band concurrent-index script; revisit if `services`/`provider_profiles` grow large enough
  for that lock to matter in practice.
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

`RecentSearch` rows are personal data tied to `User`; included in export/deletion (spec 008) the
same way spec 012's `Address` is. Search-query analytics events (once spec 040 exists) are
retained per analytics policy (spec 040 §8, itself still an open question there), aggregated
where possible rather than kept per-user indefinitely.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | skeleton result cards; autocomplete shows a lightweight inline loading indicator, not a full skeleton |
| **Empty** | non-dead-end suggestions per AC-3, plus a direct "Post a request" CTA |
| **Error** | "We couldn't load results. Your filters are saved." with retry; never silently drops entered filters |
| **Success** | results list/grid with badges, price display (reusing spec 011's `PriceDisplay`), and a visible "why these results" affordance where AI interpretation influenced them (master spec §84 — AI suggestions clearly labeled as suggestions, not system facts) |

Voice input control is fully keyboard/screen-reader accessible (a visible text alternative
always available, never voice-only). RTL layout for Urdu queries; Roman Urdu input accepted
without requiring script switching.

**Route(s):** `app/search` (new), search bar embedded in `app/(home)` and `app/explore/*`.
`app/explore/[category]/page.tsx` already carries the exact hook this spec fills in — its own
code comment reads "Real search/filter logic (spec 013) ... are out of this spec's scope (§7);
those sections render as honest placeholders rather than fabricated data," with a disabled
`Input type="search"` standing in for it. This spec replaces that placeholder, not a
freshly-invented integration point.
**Shared components used/added:** `components` `EmptyState` (reused, its existing `suggestions`
prop fits AC-3 directly), new `SearchBar`, `ResultCard`, `IntentChip` (shows interpreted filters
as removable chips) — none of these three exist in `components/` yet.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | intent-extraction prompt/response parsing, filter-param serialization | `app/api/v1/search/**/*.test.ts`, `lib/ai/**/*.test.ts` |
| **Integration** | search returns only real, authoritative provider/service data; empty-result suggestions; autocomplete sourcing | `app/api/v1/search/*.integration.test.ts` |
| **Component** | infinite scroll (mobile) vs. pagination (desktop) behavior, filter persistence | the application (Testing Library) |
| **E2E** | full NL query → interpreted intent shown → real results → empty-result fallback path | `e2e/search.spec.ts` |
| **Accessibility** | search bar and voice-input control keyboard/screen-reader tested | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/search/interpret.integration.test.ts::extracts intent, never fabricates results` |
| AC-2 | `app/api/v1/search/autocomplete.integration.test.ts::sources recent/popular/category/service/location suggestions; guest omits recent` |
| AC-3 | `e2e/search.spec.ts::empty results show actionable suggestions` |
| AC-4 | `SearchResults.test.tsx::infinite scroll mobile, pagination desktop` |
| AC-5 | `app/api/v1/search/voice.integration.test.ts::transcription treated as untrusted input` |
| AC-6 | `app/api/v1/search/determinism.integration.test.ts::identical params return identical results` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Voice transcription accuracy itself (external ASR dependency,
covered by provider SLA and a sandbox adapter for tests).

---

## 7. Out of scope

- Provider ranking algorithm internals (spec 017 — search returns eligible/ranked results, but
  the ranking engine itself is specified separately since it's shared with request matching).
  Until spec 017 ships, `/api/v1/search`'s `sort` values are the only ordering available —
  no weighted quality-ranking, fair-exposure/exploration, or bounded-distribution logic.
- Provider availability and declared-service-area filtering (spec 016 — `ProviderAvailability`
  and `ProviderServiceArea` are still bare baseline tables with no day/time/radius/city columns;
  search cannot filter on either until spec 016 adds them).
- Provider rating aggregation (spec 029, reviews & ratings — not yet implemented;
  `SearchResultDto.rating` stays absent until then, see §3).
- Semantic/vector search infrastructure choice — "optional" per master spec §97; this spec
  requires the query interface to support it later without a contract change, not that it ships
  in the first version. This migration adds no vector index or `pgvector` dependency.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | AI provider for NL interpretation and voice transcription — depends on spec 033's `lib/ai` abstraction existing; this spec's `/search/interpret` is built against that abstraction, not a direct vendor call | — | Sequencing dependency, noted in `docs/workflow.md` |
| 2 | Whether autocomplete "AI suggestions" are needed for MVP or keyword-based suggestions suffice initially | Product | Open |
| 3 | §9's `search-nl-interpretation` feature flag has no runtime infrastructure to live in yet — `feature_flags` is still a bare baseline table (spec 041, not implemented) | — | Interim: an environment variable/hardcoded constant serves as the flag until spec 041 ships; see §9 |
| 4 | `AnalyticsEvent`'s real columns (needed for search-query/result-click analytics) are spec 040's to add, not yet implemented | — | Sequencing dependency; `RecentSearch` (§4) does not depend on this and can ship without it |

---

## 9. Rollout

- **Feature flag:** `search-nl-interpretation` (default on) — allows falling back to keyword-only
  search if AI interpretation misbehaves in production. No feature-flag read/write mechanism
  exists yet (spec 041 is unimplemented; `feature_flags` is still a bare baseline table — §8
  risk #3), so this ships as an environment variable/hardcoded constant until spec 041's real
  infrastructure exists, then migrates to it without a contract change.
- **Migration order:** the `AddSearchIndexes` migration (§4) ships with code; no backfill step
  is required (§4).
- **Rollback:** disable NL-interpretation flag; plain keyword/filter search remains functional
  independently.
- **Observability:** search latency, zero-result rate, and intent-confidence distribution
  monitored (master spec §108, §117).
