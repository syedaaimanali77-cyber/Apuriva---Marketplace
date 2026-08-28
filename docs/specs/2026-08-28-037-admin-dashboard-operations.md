# Spec: Admin Dashboard & Operations

**File:** `docs/specs/2026-08-28-037-admin-dashboard-operations.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §61, §71, §123, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 014 fixed the admin navigation IA (Overview, Operations, Users, Marketplace,
Analytics, Settings) but no actual dashboard content or operations workspace exists. Master
spec §71 requires admins to configure approved business features (service/category availability,
urgent service, promotions, matching weights, cancellation policies, etc.) while developers
retain control of security/infrastructure/payment-credential/MCP-authorization concerns.

**Who is affected:** Operations, Content/Marketplace, and Super Admins running day-to-day
marketplace operations.

**Why it matters now:** By Milestone 11, enough real marketplace activity exists (requests,
offers, bookings, disputes, support) for an operations workspace to be meaningful, rather than
an empty shell built prematurely.

**Success looks like:** Admins have a real-time Overview (marketplace health, alerts), an
Operations view unifying requests/bookings/disputes/support/safety, and a Marketplace
configuration surface for business-level rules — with a clear, enforced boundary between what
business admins can change and what remains developer-only.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** the Overview screen **When** loaded **Then** it shows marketplace health (active requests, bookings in progress, revenue snapshot) and current alerts, sourced from real data, not placeholders |
| AC-2 | **Given** the Operations screen **When** viewed **Then** it surfaces requests, bookings, disputes, support tickets, and safety reports needing attention, each linking to its detailed workflow (specs 015, 020, 031, 032, 030) |
| AC-3 | **Given** the Marketplace configuration screen **When** a Content/Marketplace or Operations admin edits a business-level setting (matching weights, cancellation policy, urgent-service toggle) **Then** it's scoped to their role (spec 009) and takes effect without a code deploy |
| AC-4 | **Given** a security/infrastructure/payment-credential/MCP-authorization setting **When** an admin without developer access attempts to view/change it **Then** it is not exposed in this admin surface at all |
| AC-5 | **Given** any configuration change made here **When** applied **Then** it is audited (spec 039) with actor, before/after values, and reason where required |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/overview` | admin (any role, scoped view) | `200` `ApiResponse<AdminOverviewDto>` | |
| `GET` | `/api/v1/admin/operations/queue` | admin (Operations/Support/Trust&Safety, scoped) | `200` `PagedResponse<OperationsQueueItemDto>` | unified queue across requests/bookings/disputes/support/safety |
| `GET` | `/api/v1/admin/marketplace/config` | admin (Content/Marketplace, Operations) | `200` `ApiResponse<MarketplaceConfigDto>` | |
| `PATCH` | `/api/v1/admin/marketplace/config` | admin (scoped per field) | `200` | |

### Request and response types

```typescript
// packages/types/src/admin-dashboard.ts
export interface AdminOverviewDto {
  activeRequests: number;
  activeBookings: number;
  revenueToday: { amountMinorUnits: number; currencyCode: string };
  alerts: Array<{ severity: 'info' | 'warning' | 'critical'; message: string; linkTo?: string }>;
}

export interface OperationsQueueItemDto {
  type: 'request' | 'booking' | 'dispute' | 'support_ticket' | 'safety_report';
  id: string;
  priority: string;
  summary: string;
}

export interface MarketplaceConfigDto {
  matchingWeights: Record<string, number>;
  cancellationPolicyDefaults: unknown; // spec 023's PolicyVersion.config shape
  urgentServiceEnabled: boolean;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | admin role lacks scope for the requested config field |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

No new core entity — this spec is a **read/aggregation and configuration-write surface** over
already-specified entities (`Request`, `Booking`, `Dispute`, `SupportTicket`, `SafetyReport`,
`Policy`/`PolicyVersion` from spec 023, `Service.matching_weights` from spec 016). It may add a
materialized/aggregated view for dashboard performance:

| Entity | Change | Fields |
|---|---|---|
| `AnalyticsEvent` | reuse | overview figures may be sourced from pre-aggregated analytics (spec 040) rather than live-querying transactional tables directly, for performance |

### Migration

- **Name:** `AddAdminOverviewAggregates` (if a materialized view/summary table is used)
- **Reversible:** yes
- **Backfill required:** yes, for historical aggregates
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

No new personal data; aggregates must not leak individual user data beyond what an admin's role
already permits.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | dashboard skeleton per widget, independently loaded (a slow revenue query never blocks the alerts panel) |
| **Empty** | "No items need attention" for a clear operations queue |
| **Error** | per-widget error/retry, not a full-page failure for one broken data source |
| **Success** | live-updating figures (polling or WebSocket) with clear timestamps ("as of...") |

Information-dense layout per master spec §3.7; every config change requires explicit save/
confirm, never auto-save on a business-critical field like matching weights.

**Route(s):** `apps/web/app/admin/overview`, `apps/web/app/admin/operations`,
`apps/web/app/admin/marketplace`
**Shared components used/added:** `packages/ui` `StatBlock`, `AlertList`, `Table`, `ConfigForm`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | config-field role-scoping resolution | `apps/api/admin/**/*.test.ts` |
| **Integration** | overview/operations aggregation correctness; config write respects RBAC scope; security/infra fields never exposed | `apps/api/admin/*.integration.test.ts` |
| **E2E** | Operations admin views queue and resolves an item via its detail link; Content admin edits matching weights | `apps/web-e2e/admin-dashboard.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/admin/overview.integration.test.ts::real data, not placeholders` |
| AC-3 | `apps/api/admin/config.integration.test.ts::role-scoped write, no deploy required` |
| AC-4 | `apps/api/admin/config.integration.test.ts::infra fields never exposed` |
| AC-5 | `apps/api/admin/config.integration.test.ts::change audited` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The detailed workflows each queue item links to (specs 015, 020,
031, 032, 030 — already tested there).

---

## 7. Out of scope

- Full analytics/reporting (spec 040) — Overview shows a snapshot, not deep analytics.
- Moderation/fraud actions (spec 038).
- Feature-flag management UI specifically (spec 041), though this spec's config surface is
  closely related.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Real-time vs. polling update strategy for the overview dashboard | — | Open — recommend short-interval polling for MVP, WebSocket upgrade later if needed |

---

## 9. Rollout

- **Feature flag:** none — core admin tooling.
- **Migration order:** any aggregate table ships with code, backfilled on deploy.
- **Rollback:** revert deploy.
- **Observability:** dashboard load time and config-change frequency monitored (master spec
  §117).
