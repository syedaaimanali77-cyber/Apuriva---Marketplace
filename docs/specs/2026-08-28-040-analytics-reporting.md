# Spec: Analytics & Reporting

**File:** `docs/specs/2026-08-28-040-analytics-reporting.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §69 (admin roles), §76 (export exclusions), §117 (observability), §122 (Phase 2), §123 (Analytics nav), §124 (`AnalyticsEvent`), [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, §10, [docs/workflow.md](../workflow.md); specs 001 (background-job decision), 003 (schema conventions, `analytics_events` stub), 004 (API envelope, pagination), 009 (RBAC), 013 (search), 015 (requests), 017 (matching and fairness), 018 (offers), 020/028 (bookings, completion), 024 (earnings ledger), 029 (reviews), 033 (AI usage), 034 (AI conversations), 037 (admin overview). **Draft, not required:** 041, 046. See §8.

---

## 1. Problem statement

**Today:** Master §123 defines the admin **Analytics** section: funnel, revenue, supply/demand,
provider performance, retention, service trends and AI usage. None of it exists.

- `app/admin/analytics/page.tsx` is spec 014's placeholder.
- `analytics_events` is spec 003's column-less stub: `baseColumns()` plus a nullable
  `actor_user_id`. Nothing writes it.
- Several shipped modules wait on this spec:
  - `lib/admin-dashboard/overview.ts` (spec 037) leaves "platform-fee revenue and net revenue" to
    spec 040;
  - `lib/matching/fairness.ts` (spec 017) keeps organic scores intact "so spec 040 can compare";
  - `lib/types/ai.ts` (spec 033) says spec 040 reuses `AiUsageSummaryDto`.

**Who is affected:**

- Analytics Admins.
- Finance and Operations Admins, for their slices.
- Product, when making data-informed decisions.

**Success looks like:**

- Six tracked user actions are recorded as analytics events without ever blocking or failing the
  request that caused them.
- Authorized admins read the seven §123 reports as aggregates computed from real data.
- Nobody needs direct database access to see them.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** one of the six tracked actions (§3.4): a search, a request submitted, an offer accepted, a booking completed, a review submitted, an AI conversation started **When** it succeeds **Then** one `analytics_events` row is recorded **after** the action. The action's response is never delayed by the database write, and never changed or failed by it. An idempotent replay records nothing. |
| AC-2 | **Given** the Analytics page **When** an admin with the relevant permission opens it **Then** it shows funnel, revenue, supply/demand, provider performance (with the matching-fairness metric), retention, service trends and AI usage. Each section uses the §3.6 formulas over a chosen date range. |
| AC-3 | **Given** any analytics report **When** it is read **Then** it contains aggregates only. It never contains a user id, a name, contact data, search text, ranking scores or fraud signals (master §76), and each report is served only to the roles in §3.7. |
| AC-4 | **Given** spec 017 AC-3's new-provider exposure guarantee **When** an Operations or Analytics admin reads `GET /api/v1/admin/analytics/matching-fairness` **Then** they see a figure computed from spec 017's persisted `request_provider_matches` rows, not a manual figure. |
| AC-5 | **Given** a spike of tracked actions **When** pending events exceed the in-process bound (§3.3) **Then** the excess is dropped and counted. Insert failures are dropped and logged. No tracked action's latency or outcome depends on analytics. |

### 2.1 AC implementation matrix

| AC | Path | Named test |
|---|---|---|
| AC-1 | six emitters (X-1…X-6) → `recordAnalyticsEvent()` → post-response flush | `lib/analytics/emitters.integration.test.ts`, `lib/analytics/ingest.test.ts` |
| AC-2 | `lib/analytics/reports.ts` + seven routes + page | `lib/analytics/reports.integration.test.ts`, `app/admin/analytics/page.test.tsx` |
| AC-3 | event property allow-list; aggregate-only DTOs; §3.7 permissions | `lib/analytics/events.test.ts`, `app/api/v1/admin/analytics/access.integration.test.ts`, `lib/analytics/privacy.integration.test.ts` |
| AC-4 | `matchingFairness()` over `request_provider_matches` | `lib/analytics/reports.integration.test.ts` (fairness block) |
| AC-5 | bounded buffer, drop and count, no retry | `lib/analytics/ingest.test.ts` (spike, failure, disabled) |

---

## 3. Architecture and API contract

### 3.1 Repository reality

This is a single Next.js application. There is no `apps/*` or `packages/*`.

- **Code:** `lib/analytics/**`, `lib/types/analytics.ts`
- **Routes:** `app/api/v1/admin/analytics/**/route.ts`
- **Page:** `app/admin/analytics/page.tsx`
- **Migration:** `drizzle/0035_implement_analytics_events.sql`
- **Tests:** colocated `*.test.ts(x)` / `*.integration.test.ts`, run by Vitest (`npm test`)

### 3.2 Why there is no queue

Architecture §10 describes a worker app and job queue. **Neither exists.** Approved spec 001 §8
decided against them: "Vercel Cron calling internal Next.js API routes (no separate hosted
scheduler/queue service)". Spec 046 is Draft and assumes the same.

So this spec **does not assume a queue or worker**. The draft's open question 1 ("reuse spec 046's
queue") is closed.

### 3.3 Ingestion — in-process bounded buffer, flushed after the response (AC-1, AC-5)

`lib/analytics/ingest.ts` exports `recordAnalyticsEvent(input): void`. It is **synchronous**,
returns nothing, and **never throws**; every internal error is caught.

1. **Disabled switch.** When `ANALYTICS_INGESTION_ENABLED` is exactly `false`, the event is ignored.
   This is how ingestion is paused and resumed; the default is enabled.
2. **Validation.** The event is checked against §3.4. An invalid event is not recorded, and one
   `analytics.event_rejected` line is logged.
3. **Buffering.** The event is appended to a module-level buffer bounded at
   `MAX_PENDING_ANALYTICS_EVENTS = 1000`. When the buffer is full, **the new event is dropped** and
   counted.
4. **Scheduling the flush.**
   - Inside a request, the flush is scheduled with Next.js's `after()` (Next 16.3,
     `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`: "tasks … that should
     not block the response, such as logging and analytics"). It runs after the response is sent,
     and the platform keeps the function alive until it finishes.
   - Outside a request scope (cron, scripts, tests), `after()` throws. The flush is then scheduled
     with `setTimeout(…, 0)`.
5. **Flushing.** The flush drains the buffer in batches of `ANALYTICS_FLUSH_BATCH_SIZE = 200`, one
   multi-row `INSERT` each.
   - **A failed batch is dropped, not retried.** Retrying would amplify load exactly when the
     database is struggling.
   - The failure is logged as one `analytics.flush_failed` line.
   - Drops are reported once per flush as `analytics.events_dropped` with the count (master §117
     structured logs; there is no new observability platform).

**Delivery policy (normative):** at most once, best effort. Analytics may lose events under
overload or failure. A tracked action never waits for, or fails because of, analytics.

**Transactional isolation.** Every emitter calls `recordAnalyticsEvent` **after** its own
transaction has committed and only on the non-replay path. The call cannot throw, so no tracked
action's success, failure or response body changes.

`drainAnalyticsForTests()` awaits the in-flight flush. It is test-only.

### 3.4 Event vocabulary and properties (closed; AC-1, AC-3)

`properties` holds only ids, enums, booleans and counts: **never free text, names, contact data or
search text.** Each type has an exact key allow-list; any other key rejects the event.

| `event_type` | Emitted from (X-list) | `actor_user_id` | `properties` (exact keys) |
|---|---|---|---|
| `search_performed` | `app/api/v1/search/route.ts` (spec 013), first page only (`offset = 0`) | session user, or `null` for a guest | `serviceId?` uuid, `categoryId?` uuid, `hasQuery` boolean, `hasLocation` boolean, `resultCount` integer ≥ 0 |
| `request_submitted` | `createRequest()` `lib/requests/create.ts` (spec 015), non-replay | customer | `requestId` uuid, `serviceId` uuid |
| `offer_accepted` | `acceptOffer()` `lib/offers/decide.ts` (spec 018), only when this call accepted | customer | `offerId` uuid, `requestId` uuid |
| `booking_completed` | `completeBooking()` `lib/bookings/complete.ts` (specs 020/028), only when this call applied the transition | completing participant | `bookingId` uuid, `actingAs` `customer\|provider` |
| `review_submitted` | `createReview()` `lib/reviews/create.ts` (spec 029), non-replay | author | `reviewId` uuid, `bookingId` uuid, `rating` integer 1–5 |
| `ai_conversation_started` | `createConversation()` `lib/ai-assistant/conversations.ts` (spec 034), non-replay | user | `conversationId` uuid |

Only `search_performed` is used by a report (the funnel's *discover* stage). The other five are
recorded for event-based analysis going forward. The reports read those facts from the
authoritative transactional tables (§3.6), which already hold complete history. No business logic is
duplicated.

### 3.5 Endpoints

All seven routes are `GET` handlers under `app/api/v1/admin/analytics/**/route.ts`. Each uses:

- `withApiRoute` and `requireSession`;
- the `default` rate-limit bucket;
- no CSRF or `Idempotency-Key` (read-only);
- a registration in `lib/api/openapi-registry.ts`.

**Query parameters:**

- `from` and `to`, ISO-8601 instants. `from` is inclusive, `to` is exclusive.
- Defaults: `to` = now, `from` = `to` − 30 days.
- `from < to` and a span of at most 366 days are required; otherwise `400 VALIDATION_ERROR`.
- `provider-performance` also takes spec 004's `limit`/`offset`.

| # | Route | Permission (§3.7) | Response |
|---|---|---|---|
| R1 | `/api/v1/admin/analytics/funnel` | `analytics/read` | `ApiResponse<FunnelReportDto>` |
| R2 | `/api/v1/admin/analytics/revenue` | `analytics/read_revenue` | `ApiResponse<RevenueReportDto>` |
| R3 | `/api/v1/admin/analytics/supply-demand` | `analytics/read` | `ApiResponse<SupplyDemandReportDto>` |
| R4 | `/api/v1/admin/analytics/provider-performance` | `analytics/read_provider_performance` | `PagedResponse<ProviderPerformanceDto>` |
| R5 | `/api/v1/admin/analytics/matching-fairness` | `analytics/read_provider_performance` | `ApiResponse<MatchingFairnessDto>` |
| R6 | `/api/v1/admin/analytics/retention` | `analytics/read` | `ApiResponse<RetentionReportDto>` |
| R7 | `/api/v1/admin/analytics/service-trends` | `analytics/read` | `ApiResponse<ServiceTrendsReportDto>` |

**AI usage** reuses spec 033's existing `GET /api/v1/admin/ai/usage` (`ai/read_usage`,
`AiUsageSummaryDto`, `getAiUsageSummary()`), called directly by the page. No duplicate endpoint or
aggregation is created.

**No `POST /api/v1/analytics/events`.** All six events are server-side facts, so internal modules
call `recordAnalyticsEvent()` in-process. An HTTP endpoint would only add a browser-reachable write
surface that no acceptance criterion needs.

**Errors:**

- `400 VALIDATION_ERROR`: bad range or paging.
- `401 UNAUTHENTICATED`: no session.
- `403 FORBIDDEN`: a non-admin, or an admin without the route's permission.
- `429 RATE_LIMITED`.

### 3.6 Report definitions (normative formulas; window W = [`from`, `to`))

**Funnel (R1).** Period counts, **not a cohort**. Each stage counts events in W, so
`conversionFromPrevious` can exceed 1, and the page says so.

| Stage | Count |
|---|---|
| discover | `analytics_events` rows with `event_type = 'search_performed'` and `occurred_at` in W. These start accumulating at this spec's deployment; there is no backfill. |
| request | `requests` rows with `created_at` in W |
| offer | `offers` rows with `sent_at` in W |
| booking | `bookings` rows with `created_at` in W |
| complete | `bookings_status_history` rows with `to_status = 'completed'` and `occurred_at` in W |

`conversionFromPrevious` = count ÷ previous stage's count, rounded to 4 decimals. It is `null` for
*discover*, and `null` when the previous count is 0.

**Revenue (R2), per currency and never summed across currencies.** Source: spec 024's
`provider_earnings_lines` with `created_at` in W, grouped by `gross_currency_code`. Every line's five
currency columns are equal by `provider_earnings_lines_currency_uniform_ck`.

- `grossMinorUnits` = Σ `gross_amount_minor_units`
- `refundsMinorUnits` = Σ `refunded_amount_minor_units`
- `feeMinorUnits` = Σ `fee_amount_minor_units` (the platform fee on gross)
- `feeReversalMinorUnits` = Σ `fee_reversal_amount_minor_units`
- `netFeeMinorUnits` = `feeMinorUnits − feeReversalMinorUnits` (platform fee revenue after reversals)
- `providerNetMinorUnits` = Σ `net_amount_minor_units`. This equals gross − refunds − fee + fee
  reversal, by `provider_earnings_lines_net_identity_ck`.

The response is `currencies: RevenueCurrencyTotalsDto[]`, sorted by currency code. It follows spec
037's `MoneyAmountDto[]` convention: no single `currencyCode` and no FX. Refunds applied later
update their line, so a period reflects the *current* state of the lines created in it.

**Supply/demand (R3), per service; up to 50 services, ordered by demand descending, then name.**

- `demand` = `requests` created in W for the service.
- `supply` = distinct provider profiles with `lifecycle_status = 'active'` that have a
  `provider_services` row for the service. This is a current snapshot, not per-period.
- `demandPerProvider` = demand ÷ supply, rounded to 2 decimals; `null` when supply is 0.
- Only services with `demand > 0` or `supply > 0` are listed.

**Provider performance (R4), per provider profile; paged, ordered by notifications descending,
then provider id.** A provider is listed when it received at least one match notification in W, or
has at least one booking created in W.

- `notifications` = `request_provider_matches` rows with `notified_at` in W.
- `exposureShare` = `notifications` ÷ all notifications in W, rounded to 4 decimals.
- `responseTimeMinutes` = mean of (`responded_at − notified_at`) in minutes, over rows notified in W
  with `responded_at` set, rounded to 1 decimal. `null` when there are none.
- `completionRate` = over bookings created in W, *completed* ÷ *resolved*, rounded to 4 decimals;
  `null` when *resolved* = 0.
  - *completed* = bookings with a `to_status = 'completed'` history row.
  - *resolved* = *completed* plus bookings with status `cancelled` or `failed` that never completed.
- `averageRating` and `ratingCount` come from spec 029's `getProviderRatingAggregates()` (visible
  reviews, all time, 1 decimal). Both are `null` when unrated.

The DTO carries `providerProfileId` only: no name, no contact data, and **no ranking score**
(`score_micros` and `score_breakdown` are internal ranking signals, master §76).

**Matching fairness (R5, AC-4).** Spec 017 AC-3 reserves up to `EXPLORATION_SHARE` (0.2,
`lib/matching/fairness.ts`) of each distribution pool for new providers, and persists
`request_provider_matches.exploration_boosted`. Over rows with `notified_at` in W:

- `notifications` and `boostedNotifications` (`exploration_boosted = true`);
- `boostedShare` = boosted ÷ notifications, rounded to 4 decimals; `null` when 0;
- `configuredExplorationCap` = `EXPLORATION_SHARE`;
- `distinctProvidersNotified`;
- `topDecileExposureShare` = the share of notifications received by the top ⌈10%⌉ of notified
  providers by notification count, rounded to 4 decimals; `null` when 0. This measures how
  concentrated exposure is.

**Retention (R6), customer period-over-period.** Let P = [`from` − (`to` − `from`), `from`).

- `previousActiveCustomers` = distinct `customer_profile_id` with a request created in P.
- `currentActiveCustomers` = distinct `customer_profile_id` with a request created in W.
- `retainedCustomers` = the size of the intersection.
- `retentionRate` = retained ÷ previous, rounded to 4 decimals; `null` when previous is 0.

**Service trends (R7), per service; up to 20, ordered by current count descending, then name.**

- `currentRequests` = requests created in W.
- `previousRequests` = requests created in P.
- `changeRate` = (current − previous) ÷ previous, rounded to 4 decimals; `null` when previous is 0.
- Services with `currentRequests > 0` are listed.

**AI usage.** Spec 033's `AiUsageSummaryDto`, unchanged.

### 3.7 RBAC (master §69; seeded by `0035`)

These are the seven existing roles only. The holders follow the draft's own endpoint table and
master §69:

- Analytics: "Reporting/analytics".
- Finance: "Payments, refunds, payouts".
- Operations: "Requests, bookings, providers".

| resource | action | tier | roles |
|---|---|---|---|
| `analytics` | `read` | low | analytics_admin, super_admin |
| `analytics` | `read_revenue` | low | analytics_admin, finance_admin, super_admin |
| `analytics` | `read_provider_performance` | low | analytics_admin, operations_admin, super_admin |

AI usage stays behind spec 033's existing `ai/read_usage` (analytics_admin, finance_admin,
super_admin). Support, Content and Trust & Safety admins get no analytics report.

The page renders only the sections the caller may read. A `403` section shows "You don't have access
to this report". Authorization is always decided server-side through spec 009's `resolvePermission`.

### 3.8 Types — `lib/types/analytics.ts`

```typescript
export const ANALYTICS_EVENT_TYPES = ['search_performed','request_submitted','offer_accepted','booking_completed','review_submitted','ai_conversation_started'] as const;
export interface ReportPeriodDto { periodStart: string; periodEnd: string }
export interface FunnelReportDto extends ReportPeriodDto {
  stages: { stage: 'discover' | 'request' | 'offer' | 'booking' | 'complete'; count: number; conversionFromPrevious: number | null }[];
}
export interface RevenueCurrencyTotalsDto {
  currencyCode: string; lineCount: number;
  grossMinorUnits: number; refundsMinorUnits: number; feeMinorUnits: number;
  feeReversalMinorUnits: number; netFeeMinorUnits: number; providerNetMinorUnits: number;
}
export interface RevenueReportDto extends ReportPeriodDto { currencies: RevenueCurrencyTotalsDto[] }
export interface SupplyDemandRowDto { serviceId: string; serviceName: string; demand: number; supply: number; demandPerProvider: number | null }
export interface SupplyDemandReportDto extends ReportPeriodDto { services: SupplyDemandRowDto[] }
export interface ProviderPerformanceDto {
  providerProfileId: string; notifications: number; exposureShare: number;
  responseTimeMinutes: number | null; completionRate: number | null;
  averageRating: number | null; ratingCount: number | null;
}
export interface MatchingFairnessDto extends ReportPeriodDto {
  notifications: number; boostedNotifications: number; boostedShare: number | null;
  configuredExplorationCap: number; distinctProvidersNotified: number; topDecileExposureShare: number | null;
}
export interface RetentionReportDto extends ReportPeriodDto {
  previousPeriodStart: string; previousActiveCustomers: number; currentActiveCustomers: number;
  retainedCustomers: number; retentionRate: number | null;
}
export interface ServiceTrendRowDto { serviceId: string; serviceName: string; currentRequests: number; previousRequests: number; changeRate: number | null }
export interface ServiceTrendsReportDto extends ReportPeriodDto { previousPeriodStart: string; services: ServiceTrendRowDto[] }
```

### Breaking-change check

- [x] No existing route or DTO changes shape.
- The six emitters gain one non-throwing call after success, so their behaviour is unchanged.

---

## 4. Data model changes

### `analytics_events` — spec 003 stub, **altered** by `0035` (never recreated)

The existing `baseColumns()` (`id`, `created_at`, `updated_at`, `version`, required by spec 003's
schema-lint) and `actor_user_id uuid null` (the user reference; FK → `users` RESTRICT, indexed) are
kept. The draft's `user_id` is this existing column.

| Added column | Type | Notes |
|---|---|---|
| `event_type` | `text not null` | CHECK in `ANALYTICS_EVENT_TYPES` |
| `occurred_at` | `timestamptz not null` | when the action happened (the app clock at emission). `created_at` is when the row was flushed. |
| `properties` | `jsonb not null default '{}'` | CHECK `jsonb_typeof(properties) = 'object'`; key allow-list enforced by `lib/analytics/events.ts` |

**Indexes:** `(event_type, occurred_at)` and `(occurred_at)`, in addition to the existing
`actor_user_id` index.

**jsonb:** `properties` must be registered in spec 003's schema-lint allow-list (X-7).

### Migration

- **Files:** `drizzle/0035_implement_analytics_events.sql`, a hand-written `_down.sql`, and journal
  index 35.
- **Up:**
  - `ALTER TABLE analytics_events ADD COLUMN …`, CHECKs and indexes. The table is empty, so the NOT
    NULL columns are added safely; unexpected rows make it fail loudly.
  - Seed the three §3.7 `permissions` rows with the `0033`/`0034` `INSERT … SELECT … FROM (VALUES …)`
    idiom.
- **Down:** drop the indexes, constraints and columns (back to the spec 003 stub), and delete exactly
  the seeded permission rows. It is reversible, and destroys recorded events.
- **Backfill:** none. **Downtime:** none.

### Retention and privacy (resolves draft open question 2)

- **Raw events are kept for `ANALYTICS_EVENT_RETENTION_DAYS`, default 90.** This uses the repository's
  existing precedent for event data, spec 033's `AI_USAGE_RETENTION_DAYS=90` with its sweep. It is a
  positive integer; anything else falls back to 90.
- **There are no rollup tables in the MVP.** Every report except the funnel's *discover* stage reads
  authoritative transactional tables, which keep their own history. *Discover* is therefore
  limited to the retention window.
- **Sweep.** `GET /api/v1/cron/analytics-retention-sweep` runs daily in `vercel.json`, with bearer
  `CRON_SECRET`, following the `ai-usage-sweep` idiom. It is not in OpenAPI. It:
  - deletes rows with `occurred_at` older than the window, 500 per run;
  - sets `actor_user_id = NULL` on rows whose user is `deleted` (spec 008's anonymization), so no
    event stays attributable to a closed account.
- **Export.** Events are **never** part of a user's data export. Spec 008's export is unchanged,
  because analytics are internal signals (master §76). No report returns an actor id.

---

## 5. UI states

**Route:** `app/admin/analytics/page.tsx`, replacing spec 014's placeholder (X-8). It keeps the dense
admin layout (`data-density="dense"`, `app/admin/admin.module.css`).

**Components:**

- `Table`, `Button`, `Input`, `Card`, `Alert`, `Skeleton`, `EmptyState` and `ErrorState` from
  `@/components`, and `StatBlock` from `@/components/StatBlock` (the spec 033 precedent).
- **There are no charts.** The design system has no chart primitive, so figures are tables and stat
  blocks. A chart component belongs to spec 002's design system first.

**Behaviour:**

- The date range uses two `Input type="date"` fields. There is no date-picker component, and the
  native input is the accessible default. The range is shared by every section and kept on retry.

| State | Behaviour |
|---|---|
| **Loading** | a `Skeleton` per section |
| **Empty** | "No activity in this period" per section with no data |
| **Error** | `ErrorState` with retry, per section; the range is kept |
| **Forbidden** | a `403` section shows "You don't have access to this report" |
| **Success** | tables and stat blocks |

**CSV:** "Export CSV" on **provider performance only**. It is the one per-row list an admin is likely
to take into a spreadsheet. The file is built client-side from the rows already returned to that
authorized caller, so nothing new is exposed.

---

## 6. Test plan

Integration tests run on the isolated `*_test` database (`vitest.config.ts`, `test/db-reset.ts`).
Report tests run inside spec 037's `withSnapshot` (a REPEATABLE READ transaction, always rolled back)
with fixture rows dated in a private far-past window, so the numbers are exact despite parallel files.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | property allow-lists; event validation | `lib/analytics/events.test.ts` |
| **Unit** | buffer bound and drop count; batch flush; failure drops and logs; never throws; disabled switch; `after()` fallback | `lib/analytics/ingest.test.ts` |
| **Unit** | range parsing; rounding helpers | `lib/analytics/range.test.ts` |
| **Integration** | each of the six emitters records exactly one event, with no event on replay or failure; tracked outcomes unchanged when the analytics insert fails | `lib/analytics/emitters.integration.test.ts` |
| **Integration** | every §3.6 formula against seeded data, including multi-currency revenue and fairness | `lib/analytics/reports.integration.test.ts` |
| **Integration** | retention sweep deletes old rows and de-attributes deleted users; no actor id in any report | `lib/analytics/privacy.integration.test.ts` |
| **Integration** | migration up/down files, columns, seeded permissions | `lib/analytics/migration.integration.test.ts` |
| **Security** | every role × route matrix; `403`/`401`; validation `400` | `app/api/v1/admin/analytics/access.integration.test.ts` |
| **Routes** | envelopes, paging, OpenAPI registration, cron secret | `app/api/v1/admin/analytics/routes.integration.test.ts` |
| **Boundary** | only `lib/analytics/ingest.ts` inserts events; emitters never await analytics; no ranking score or actor id in reports | `lib/analytics/boundary.test.ts` |
| **Page** | loading, empty, error-retry, forbidden and success states; CSV | `app/admin/analytics/page.test.tsx` |

**Coverage:** ≥80% statements, branches, functions and lines on `lib/analytics/**`:

`npx vitest run lib/analytics app/api/v1/admin/analytics app/admin/analytics --coverage.enabled --coverage.provider=v8 --coverage.include=lib/analytics/**`

---

## 7. Out of scope

- Deep BI and cohort analytics (master §122 Phase 2).
- Rollup tables.
- A queue or worker (§3.2).
- Charts (no design-system primitive).
- Instrumenting interactions beyond the six AC-1 actions. Owning specs add their own events later
  through `recordAnalyticsEvent()`.
- A browser-facing ingestion endpoint.
- Changing spec 037's Overview or spec 033's AI usage.

---

## 8. Dependencies, decisions, risks

### Authorized cross-spec changes (X-list)

| # | Owning spec | File | Exact change |
|---|---|---|---|
| X-1 | 013 | `app/api/v1/search/route.ts` | After results, for `offset = 0`: `recordAnalyticsEvent({ type: 'search_performed', … })`. |
| X-2 | 015 | `lib/requests/create.ts` `createRequest()` | Emit `request_submitted` on the non-replay return. |
| X-3 | 018 | `lib/offers/decide.ts` `acceptOffer()` | Emit `offer_accepted` after the transaction, only when this call accepted. |
| X-4 | 020/028 | `lib/bookings/complete.ts` `completeBooking()` | Emit `booking_completed` after the transaction, only when this call applied the transition. |
| X-5 | 029 | `lib/reviews/create.ts` `createReview()` | Emit `review_submitted` when not replayed. |
| X-6 | 034 | `lib/ai-assistant/conversations.ts` `createConversation()` | Emit `ai_conversation_started` on the non-replay insert. |
| X-7 | 003 | `lib/db/schema-lint.test.ts` | Register `analytics_events: ['properties']` in `ALLOWED_JSONB_COLUMNS`. |
| X-8 | 014 | `app/admin/analytics/page.tsx` | Replace the placeholder with this spec's page. |

**Shared registries:**

- `lib/db/schema.ts` (the `analyticsEvents` declaration);
- `drizzle/meta/_journal.json`;
- `lib/api/openapi-registry.ts`;
- `vercel.json` (one cron entry);
- `.env.example` (two variables).

### Decisions

| # | Decision |
|---|---|
| D-1 | Ingestion is an in-process bounded buffer flushed with `after()` (§3.3), because spec 001 rules out a queue or worker. |
| D-2 | Delivery is at most once and best effort; overflow and failures are dropped and counted. |
| D-3 | There is no ingestion HTTP endpoint (§3.5). |
| D-4 | Revenue is per currency, with no cross-currency arithmetic. |
| D-5 | The fairness reference is **spec 017 AC-3**; the draft's "spec 016 AC-3" (service-area eligibility) was wrong. |
| D-6 | The export-exclusion reference is **master §76**; the draft's "spec 076" does not exist. |
| D-7 | AI usage reuses spec 033's route and DTO. |
| D-8 | Permissions follow §3.7, derived from the draft's endpoint table and master §69. |
| D-9 | Retention is 90 days, following the `AI_USAGE_RETENTION_DAYS` precedent, with no rollups. |
| D-10 | The funnel uses period counts, not cohorts, with the stage sources in §3.6. |
| D-11 | There are no charts; CSV is provided for provider performance only. |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | An instance can be recycled before its flush runs, losing events | `after()` keeps the instance alive until the flush ends; otherwise loss is within D-2 |
| R-2 | Funnel ratios above 1 are misread as cohort conversion | The DTO is documented and the page notes it |
| R-3 | *Discover* covers only 90 days and only from deployment | Documented; rollups are Phase 2 |

---

## 9. Rollout

- **Feature flag:** none. `ANALYTICS_INGESTION_ENABLED=false` pauses ingestion without a deploy.
- **Order:** `0035` ships with the code; the retention cron is added to `vercel.json`.
- **Rollback:** revert the deploy, then run `0035_…_down.sql`, which discards recorded events.
- **Observability:** the `analytics.events_dropped`, `analytics.flush_failed` and
  `analytics.event_rejected` structured lines (master §117). This replaces the draft's "queue
  depth", since there is no queue.
