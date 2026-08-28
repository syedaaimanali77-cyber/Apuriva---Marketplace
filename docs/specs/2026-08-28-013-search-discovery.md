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
| `GET` | `/api/v1/search` | none | `200` `PagedResponse<SearchResultDto>` | keyword params: `q`, `serviceId`, `categoryId`, `lat/lng`, `radiusKm`, `budgetMaxMinorUnits`, `date`, `sort` |
| `POST` | `/api/v1/search/interpret` | none | `200` `ApiResponse<SearchIntentDto>` | NL/voice-transcribed text → structured intent (AI-assisted, read-only, low-risk per spec 034 autonomy tiers) |
| `GET` | `/api/v1/search/autocomplete` | none | `200` `ApiResponse<AutocompleteSuggestionDto[]>` | |
| `POST` | `/api/v1/search/recent` | session | `204` | records a search to the user's recent-searches list |

### Request and response types

```typescript
// packages/types/src/search.ts
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
  approxDistance?: string;
  rating: number;
  priceDisplay: { type: string; amountMinorUnits?: number };
  badges: string[];
}
```

`SearchIntentDto` is a *suggestion* the frontend pre-fills into real filter parameters — it is
never sent directly to a results-rendering step without going through `/api/v1/search`'s
authoritative query.

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
| `AnalyticsEvent` | reuse (spec 003 stub, populated here) | search-query and result-click events for ranking/analytics feedback |
| (no new core entity) | — | search reads from `Service`, `ProviderService`, `ProviderProfile`, `ProviderAvailability`, `Location` (specs 010–012, 019) via a dedicated read/query layer, not a new source of truth |

Full-text and optional vector/embedding indexes are added to `Service`/`ProviderProfile`
text fields (name, description) — a database-level concern (`packages/database`), not a new
entity.

### Migration

- **Name:** `AddSearchIndexes`
- **Reversible:** yes (drop indexes)
- **Backfill required:** yes — build initial full-text/vector index over existing seed data
- **Downtime:** none (index creation can run concurrently)
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Recent-search history is personal data tied to `User`; included in export/deletion (spec 008).
Search-query analytics events are retained per analytics policy (spec 040), aggregated where
possible rather than kept per-user indefinitely.

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

**Route(s):** `apps/web/app/search`, search bar embedded in `apps/web/app/(home)` and
`apps/web/app/explore/*`
**Shared components used/added:** `packages/ui` `SearchBar`, `ResultCard`, `EmptyState`
(reused), new `IntentChip` (shows interpreted filters as removable chips)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | intent-extraction prompt/response parsing, filter-param serialization | `apps/api/search/**/*.test.ts`, `packages/ai/**/*.test.ts` |
| **Integration** | search returns only real, authoritative provider/service data; empty-result suggestions; autocomplete sourcing | `apps/api/search/*.integration.test.ts` |
| **Component** | infinite scroll (mobile) vs. pagination (desktop) behavior, filter persistence | `apps/web` (Testing Library) |
| **E2E** | full NL query → interpreted intent shown → real results → empty-result fallback path | `apps/web-e2e/search.spec.ts` |
| **Accessibility** | search bar and voice-input control keyboard/screen-reader tested | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/search/interpret.integration.test.ts::extracts intent, never fabricates results` |
| AC-3 | `apps/web-e2e/search.spec.ts::empty results show actionable suggestions` |
| AC-4 | `apps/web/SearchResults.test.tsx::infinite scroll mobile, pagination desktop` |
| AC-5 | `apps/api/search/voice.integration.test.ts::transcription treated as untrusted input` |
| AC-6 | `apps/api/search/determinism.integration.test.ts::identical params return identical results` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Voice transcription accuracy itself (external ASR dependency,
covered by provider SLA and a sandbox adapter for tests).

---

## 7. Out of scope

- Provider ranking algorithm internals (spec 016 — search returns eligible/ranked results, but
  the ranking engine itself is specified separately since it's shared with request matching).
- Semantic/vector search infrastructure choice — "optional" per master spec §97; this spec
  requires the query interface to support it later without a contract change, not that it ships
  in the first version.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | AI provider for NL interpretation and voice transcription — depends on spec 033's AI abstraction existing; this spec's `/search/interpret` is built against that abstraction, not a direct vendor call | — | Sequencing dependency, noted in `docs/workflow.md` |
| 2 | Whether autocomplete "AI suggestions" are needed for MVP or keyword-based suggestions suffice initially | Product | Open |

---

## 9. Rollout

- **Feature flag:** `search-nl-interpretation` (default on) — allows falling back to keyword-only
  search if AI interpretation misbehaves in production.
- **Migration order:** search indexes ship with code, backfilled before flag is enabled.
- **Rollback:** disable NL-interpretation flag; plain keyword/filter search remains functional
  independently.
- **Observability:** search latency, zero-result rate, and intent-confidence distribution
  monitored (master spec §108, §117).
