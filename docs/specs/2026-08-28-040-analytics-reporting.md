# Spec: Analytics & Reporting

**File:** `docs/specs/2026-08-28-040-analytics-reporting.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §123 (Analytics nav), §124 (AnalyticsEvent), [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Nearly every prior spec references "tracked via spec 040's analytics" for its own
metrics (funnel conversion, matching fairness, review flag rates, AI usage, etc.), but no
analytics ingestion or reporting surface exists — only the `AnalyticsEvent` entity was stubbed
in spec 003. Master spec §123 defines the Analytics nav section: funnel, revenue, supply/demand,
provider performance, retention, service trends, AI usage.

**Who is affected:** Analytics Admins and Product making data-informed decisions; every prior
spec whose acceptance criteria assumed this exists.

**Why it matters now:** Sequenced late because it aggregates data every earlier domain spec
produces — building it first would mean building against fake data.

**Success looks like:** A real event-ingestion pipeline captures the funnel/revenue/supply-
demand/provider-performance/retention/service-trend/AI-usage events every prior spec already
references, and Analytics Admins can view them without needing direct database access to
production transactional tables.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a tracked user action (search, request submitted, offer accepted, booking completed, review submitted, AI conversation) **When** it occurs **Then** a corresponding `AnalyticsEvent` is recorded asynchronously, never blocking the triggering request |
| AC-2 | **Given** the Analytics dashboard **When** an Analytics Admin views it **Then** they see funnel (discover→request→offer→booking→complete), revenue, supply/demand (requests vs. available providers), provider performance, retention, service trends, and AI usage sections |
| AC-3 | **Given** an Analytics Admin **When** viewing any report **Then** they see aggregated figures, never raw per-user PII beyond what their role permits (ties to spec 076's export-exclusion rule for internal signals) |
| AC-4 | **Given** the matching-fairness metric (spec 016 AC-3's exposure guarantee) **When** viewed **Then** it's visible to Operations/Analytics admins as a real computed metric, not a manual spreadsheet |
| AC-5 | **Given** event-ingestion volume **When** it spikes **Then** the pipeline degrades gracefully (drops/queues) rather than impacting transactional API latency |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/analytics/events` (internal, called by other backend modules, not the browser directly for sensitive events) | internal/session | `202` | fire-and-forget, queued |
| `GET` | `/api/v1/admin/analytics/funnel` | admin (Analytics) | `200` `ApiResponse<FunnelReportDto>` | |
| `GET` | `/api/v1/admin/analytics/revenue` | admin (Analytics/Finance) | `200` `ApiResponse<RevenueReportDto>` | |
| `GET` | `/api/v1/admin/analytics/provider-performance` | admin (Analytics/Operations) | `200` `PagedResponse<ProviderPerformanceDto>` | |
| `GET` | `/api/v1/admin/analytics/ai-usage` | admin (Analytics) | `200` — reuses spec 033's `AiUsageSummaryDto` | |

### Request and response types

```typescript
// packages/types/src/analytics.ts
export interface FunnelReportDto {
  stages: Array<{ stage: 'discover' | 'request' | 'offer' | 'booking' | 'complete'; count: number; conversionFromPrevious: number }>;
  periodStart: string;
  periodEnd: string;
}

export interface RevenueReportDto {
  grossMinorUnits: number;
  feeMinorUnits: number;
  refundsMinorUnits: number;
  netMinorUnits: number;
  currencyCode: string;
}

export interface ProviderPerformanceDto {
  providerId: string;
  completionRate: number;
  averageRating: number;
  responseTimeMinutes: number;
  exposureShare: number; // fairness metric, spec 016
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | non-Analytics-scoped admin requests a restricted report |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `AnalyticsEvent` | fully implement (stubbed spec 003) | `id uuid pk`, `event_type text`, `user_id uuid nullable`, `properties jsonb`, `occurred_at timestamptz` |

Reporting endpoints aggregate over `AnalyticsEvent` plus read-only queries against
transactional tables (`Booking`, `Payment`, `Review`, etc.) — this spec does not duplicate
transactional data, only event-stream and derived aggregates.

### Migration

- **Name:** `ImplementAnalyticsEventTable`
- **Reversible:** yes
- **Backfill required:** no (historical data starts accumulating from this spec's deployment
  forward; no retroactive backfill of past events that were never captured)
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

`AnalyticsEvent.properties` must not carry raw PII beyond a `user_id` reference; aggregated
reports never expose individual user behavior to admins without the appropriate role scope,
consistent with master spec §76's export-exclusion rule for internal ranking/fraud signals.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | report skeleton per chart/table |
| **Empty** | a period with no data shows "No activity in this period" rather than a broken chart |
| **Error** | report load failure shows retry, preserves selected date range/filters |
| **Success** | charts/tables with export-to-CSV where useful |

**Route(s):** `apps/web/app/admin/analytics`
**Shared components used/added:** `packages/ui` chart primitives (per the project's dataviz
conventions), `Table`, date-range picker

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | event-schema validation, funnel-stage conversion math | `apps/api/analytics/**/*.test.ts` |
| **Integration** | event ingestion doesn't block triggering requests; report aggregation correctness against seeded data | `apps/api/analytics/*.integration.test.ts` |
| **Background job** | event-queue processing under load degrades gracefully | `apps/worker/analytics-ingestion.test.ts` |
| **E2E** | Analytics admin views the funnel and revenue reports | `apps/web-e2e/analytics.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/analytics/ingestion.integration.test.ts::async, non-blocking` |
| AC-3 | `apps/api/analytics/privacy.integration.test.ts::no raw PII in aggregate reports` |
| AC-4 | `apps/api/analytics/provider-performance.integration.test.ts::real fairness metric` |
| AC-5 | `apps/worker/analytics-ingestion.test.ts::degrades gracefully under spike` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Deep BI / advanced analytics (explicitly Phase 2, master spec
§122) — this spec covers the MVP reporting surfaces named in master spec §123 only.

---

## 7. Out of scope

- Deep BI analytics tooling (Phase 2, master spec §122).
- Per-event instrumentation for every conceivable interaction — this spec defines the pipeline
  and the §123-named reports; individual owning specs are responsible for emitting their own
  relevant events (already referenced throughout 010–038) but this spec doesn't enumerate every
  single one exhaustively.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Event-queue technology (reuse the background job queue from spec 046/architecture §10, or a dedicated event pipeline) | — | Open — recommend reusing the existing job queue for MVP simplicity |
| 2 | Exact retention window for raw events vs. pre-aggregated rollups | — | Open |

---

## 9. Rollout

- **Feature flag:** none — but individual report sections can be hidden if their underlying
  data source isn't ready yet (progressive rollout, not a security flag).
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; event ingestion is additive and safe to pause/resume.
- **Observability:** ingestion lag and queue depth monitored — this spec is itself part of the
  platform's observability story (master spec §117).
