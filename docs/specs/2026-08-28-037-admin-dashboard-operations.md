# Spec: Admin Dashboard & Operations

**File:** `docs/specs/2026-08-28-037-admin-dashboard-operations.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §61, §65, §69, §70, §71, §72, §117, §123, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md); specs 009 (admin RBAC, audit helper), 014 (admin navigation), 015 (requests), 017 (matching weights), 020 (bookings), 021 (payments), 023 (cancellation policies), 030 (safety), 031 (disputes), 032 (support), 033 (AI); specs 038, 039, 040, 041 (Draft — boundaries only, §8)

> **Review note (2026-09-25).** This draft was verified against the repository and against the
> approved specs it touches, then finalized through platform-owner decisions (§8, D-1 – D-20).
> APURIVA is a **single Next.js application**: there is no `apps/web`, `apps/api`, `packages/types`,
> `packages/ui` or `apps/web-e2e`. Every path below was checked against the tree.
>
> Summary of the corrections: the RBAC matrix is the one specs 017/023 actually seeded (no
> Content-admin configuration access, no new role); the Marketplace screen **reads** configuration
> and links to the existing editors — spec 017's and spec 023's write paths remain the only writers;
> AC-5 is met by adding before/after values to spec 009's audit helper and emitting them from the
> three existing configuration writers (four small, explicitly listed cross-spec code changes — the
> owning specs keep ownership of their modules); `urgentServiceEnabled` is removed;
> the Overview reads live transactional data; revenue, active bookings, alerts, the queue and
> polling are defined exactly; no migration is required.

---

## 1. Problem statement

**Today:** Spec 014 fixed the admin navigation IA (Overview, Operations, Users, Marketplace,
Analytics, Settings), but the Overview (`app/admin/page.tsx`) and Operations
(`app/admin/operations/page.tsx`) destinations are still `PlaceholderPage`s. Each operational
workspace exists on its own — disputes (031), support (032), safety (030), refunds (022), payouts
(024) — and each business setting has its own owner: per-service matching weights (spec 017,
`PATCH /api/v1/admin/services/{id}/matching-weights`) and cancellation policies (spec 023,
`POST /api/v1/admin/cancellation-policies`). No screen shows marketplace health, no single queue
shows what needs attention, and no screen summarises the business configuration.

Two audit gaps also exist on those write paths: spec 017's two matching-weight writers (the weights
`PATCH` and suggestion approval) record **no** audit event, and spec 023's publish event carries no
before/after values (master spec §72: "Audit
all sensitive/admin actions").

Master spec §71 separates what business admins configure from what **developers retain control
of**: authentication/security, infrastructure, payment credentials, database infrastructure, MCP
authorization and safety-critical technical controls.

**Who is affected:** Operations, Support, Trust & Safety and Super Admins (master spec §69).

**Why it matters now:** Real marketplace activity exists (requests, bookings, payments, disputes,
support, safety), so the dashboard can show real figures instead of an empty shell.

**Success looks like:** An Overview of marketplace health and alerts from live data; one Operations
queue of the disputes, support tickets and safety reports needing attention, each linking to its
existing workflow; a read-only Marketplace configuration summary linking to the existing editors;
every configuration change reachable from it audited with actor, before, after and reason; and no
developer-controlled setting anywhere in this surface.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** an admin holding any spec 009 role **When** the Overview loads **Then** it shows `activeRequests`, `activeBookings` and `revenueToday` computed from live transactional data by the exact rules of §3 "Overview figures", plus the §3 "Alert rules" alerts the admin is permitted to see, with the server time they were computed at — never a placeholder or hard-coded value |
| AC-2 | **Given** the Operations screen **When** viewed **Then** it lists, in one paged queue, the disputes, support tickets and safety reports not in their terminal state (§3 "Operations queue") — each source only for admins holding that source's existing read permission — ordered by priority then age, each item linking to its existing detail workflow (specs 031, 032, 030) |
| AC-3 | **Given** the Marketplace configuration screen **When** opened by an admin holding `matching.config`/`read` and/or `cancellation_policy`/`read` — today exactly `operations_admin` and `super_admin` **Then** it shows, per permission held, the platform-default matching weights with the count of per-service overrides, and the active platform cancellation policy, and links to the existing editor where one exists. Spec 037 exposes no configuration write: every change goes through its single owning write path (spec 017 or spec 023), which already takes effect without a code deploy. Any other admin receives `403 FORBIDDEN` |
| AC-4 | **Given** any spec 037 API response or screen **When** returned to any admin, including `super_admin` **Then** it contains only the closed allow-list of fields defined in §3, so no developer-controlled setting (master spec §71: authentication/security, infrastructure, payment credentials, database infrastructure, MCP authorization, safety-critical technical controls), environment variable or secret is exposed or accepted |
| AC-5 | **Given** a configuration change made through any of the three existing writers of the settings this surface shows — spec 017's `updateMatchingWeights`, spec 017's `approveMatchingSuggestion` (when it writes a service's weights) and spec 023's `publishCancellationPolicy` **When** it succeeds **Then** exactly one audit event is recorded through spec 009's `recordAdminAuditEvent`, carrying actor, actor roles, action, target, the **before** and **after** values, and the reason (the publish's `note` for a cancellation policy; `null` for matching weights, whose medium risk tier requires none — spec 009); a rejected or failed change records none |
| AC-6 | **Given** a caller holding no spec 009 admin role **When** calling any spec 037 endpoint **Then** it receives `403 FORBIDDEN` and no figure, item or setting; with no session, `401 UNAUTHENTICATED` |

### AC traceability

| AC | API behaviour | UI behaviour | Authorization | Audit | Tests |
|---|---|---|---|---|---|
| AC-1 | `GET /api/v1/admin/overview` → `AdminOverviewDto` | `/admin`: three `StatBlock`s + alerts, polled | any admin role; alerts per read permission | none (read) | `lib/admin-dashboard/overview.integration.test.ts`, `app/admin/page.test.tsx` |
| AC-2 | `GET /api/v1/admin/operations/queue` → `PagedResponse<OperationsQueueItemDto>` | `/admin/operations`: `Table` + links, empty/error states, polled | any admin role; per-source read permission | none (read) | `lib/admin-dashboard/queue.test.ts`, `lib/admin-dashboard/queue.integration.test.ts`, `app/admin/operations/page.test.tsx` |
| AC-3 | `GET /api/v1/admin/marketplace/config` → `MarketplaceConfigDto`; no write route | `/admin/marketplace/config`: read-only sections + editor links | `matching.config`/`read` or `cancellation_policy`/`read` | none (read) | `lib/admin-dashboard/config.integration.test.ts`, `app/admin/marketplace/config/page.test.tsx` |
| AC-4 | DTOs are the closed allow-list; no `process.env` read | nothing beyond the DTOs rendered | every role, super_admin included | — | `lib/admin-dashboard/boundary.test.ts` |
| AC-5 | the owning write paths emit the event | — (editing happens in the owning screens) | unchanged (017/023 permissions) | `recordAdminAuditEvent` with `before`/`after` | `lib/admin-dashboard/audit.integration.test.ts` |
| AC-6 | `403`/`401` from all three routes | admin pages already sit behind the admin shell | spec 009 roles | — | `app/api/v1/admin/dashboard.integration.test.ts` |

---

## 3. API contract

### Endpoints

All three are **read-only** and follow the existing admin-route idiom: `withApiRoute`,
`requireSession`, `getAdminRoleNames`/`resolvePermission` (`lib/admin-rbac/permissions.ts`),
`apiSuccess`/`apiPaged` (`lib/api/response.ts`), `forbiddenError` (`lib/api/errors.ts`). Each is
registered in `lib/api/openapi-registry.ts` (`npm run check:openapi-drift`).

| Method | Route | File | Auth | Success |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/overview` | `app/api/v1/admin/overview/route.ts` | any admin (≥1 spec 009 role) | `200` `ApiResponse<AdminOverviewDto>` |
| `GET` | `/api/v1/admin/operations/queue?limit&offset` | `app/api/v1/admin/operations/queue/route.ts` | any admin; each source filtered by its read permission | `200` `PagedResponse<OperationsQueueItemDto>` |
| `GET` | `/api/v1/admin/marketplace/config` | `app/api/v1/admin/marketplace/config/route.ts` | `matching.config`/`read` **or** `cancellation_policy`/`read` | `200` `ApiResponse<MarketplaceConfigDto>` |

The draft's `PATCH /api/v1/admin/marketplace/config` is **removed** (D-3). Domain logic lives in a
new module `lib/admin-dashboard/` (`overview.ts`, `queue.ts`, `config.ts`); routes stay thin.

### Request and response types

```typescript
// lib/types/admin-dashboard.ts — every DTO in this repository lives under lib/types/
export interface MoneyAmountDto {
  amountMinorUnits: number;
  currencyCode: string; // ISO 4217, taken from the source row — never assumed
}

export type AdminAlertSeverity = 'info' | 'warning' | 'critical';

export interface AdminAlertDto {
  rule: 'critical_safety_reports';   // closed set (§3 "Alert rules")
  severity: AdminAlertSeverity;
  count: number;
  message: string;                   // fixed text per rule, never user content
  linkTo: string;                    // an existing admin route
}

export interface AdminOverviewDto {
  activeRequests: number;
  activeBookings: number;
  /**
   * GROSS CAPTURED customer payment amount for the current UTC calendar day, one entry per
   * currency (sorted by currencyCode); [] when nothing was captured. Refunds are NOT subtracted.
   * Not platform-fee revenue, not net revenue (§3 "revenueToday").
   */
  revenueToday: MoneyAmountDto[];
  alerts: AdminAlertDto[];
  /** ISO 8601 server instant the figures were computed at — the UI's "as of". */
  generatedAt: string;
}

export interface OperationsQueueItemDto {
  type: 'dispute' | 'support_ticket' | 'safety_report';
  id: string;
  status: string;                                          // the source's own status value
  priority: 'low' | 'medium' | 'high' | 'critical' | null; // disputes have no priority → null
  createdAt: string;                                       // ISO 8601
  linkTo: string;                                          // the existing detail route
}

export interface MarketplaceConfigDto {
  /** Present only when the caller holds matching.config/read. */
  matching?: {
    /** Spec 017's DEFAULT_MATCHING_WEIGHTS (lib/matching/weights.ts) — a code constant. */
    platformDefaultWeights: Record<string, number>;
    /** Count of services whose services.matching_weights override is non-null. */
    serviceOverrideCount: number;
    linkTo: '/admin/marketplace/matching';
  };
  /** Present only when the caller holds cancellation_policy/read. */
  cancellation?: {
    /** The active platform-scope policy's open version (spec 023), or null if none exists. */
    activePlatformPolicy: { policyId: string; effectiveFrom: string; config: unknown } | null;
    /** Spec 023 assigns the configuration UI to spec 041 (Draft); no editor page exists yet. */
    linkTo: null;
  };
  generatedAt: string;
}
```

Queue items carry no free-text summary (D-10): identifiers, status and priority only. The linked
detail page — already permission-checked by its own spec — shows the content.

### Overview figures (AC-1) — live transactional queries

Spec 040's `analytics_events` is a column-less skeleton, so no aggregate exists to read (D-6). Each
figure is one live aggregate query at request time, under the database's existing indexes.

| Figure | Exact rule | Authoritative source |
|---|---|---|
| `activeRequests` | `count(*)` of `requests` whose `status` is in spec 015's `ACTIVE_REQUEST_STATUSES` (`submitted`, `matching`, `offers_open`, `provider_selected`, `booking_created`) | `requests.status`; the constant in `lib/types/requests.ts` is imported, not copied |
| `activeBookings` | `count(*)` of `bookings` whose `status` is in `('pending','confirmed','provider_en_route','arrived','in_progress')` (D-8) | `bookings.status` (spec 020); a named constant `ACTIVE_BOOKING_STATUSES` in `lib/admin-dashboard/overview.ts` |
| `revenueToday` | see below | `payments`, `payments_status_history` (spec 021) |
| `alerts` | §3 "Alert rules" | as listed there |

**`revenueToday` — the MVP definition (D-7):**

> `revenueToday` = the **gross captured customer payment amount for the current UTC calendar day,
> grouped by currency.**

- **Query:** for each distinct `payments.charge_currency_code`, the sum of
  `payments.charge_amount_minor_units` over every payment that has a `payments_status_history` row
  with `to_status = 'captured'` whose `occurred_at` lies in the current UTC calendar day.
- **Only successfully captured payments count.** Membership is decided by the `captured` transition
  in `payments_status_history` (spec 021, written by `lib/payments/state-machine.ts`).
- **`created`, `requires_action`, `authorized` and `failed` payments do not count** — none of them
  has a `captured` transition.
- **Each capture is counted once.** A payment captures at most once (spec 021: one payment per
  booking, `payments_booking_id_uq`, and its status-transition trigger), and the query sums each
  qualifying payment once.
- **Refunds and partial refunds are NOT subtracted.** A payment captured today counts its full
  charge even if it is `refunded` or `partially_refunded` later the same day.
- **This is NOT platform-fee revenue** (spec 024's `provider_earnings_lines.fee_amount_minor_units`).
- **This is NOT net revenue** (after refunds, fees or payouts).
- **Spec 040 owns** every future analytical, fee or net-revenue metric; spec 037 does not define one.
- **Day boundary:** UTC calendar day `[00:00:00Z, next 00:00:00Z)` — the boundary spec 033's cost
  alerts already use (`lib/ai/cost.ts`). The UI labels the figure "Captured today (UTC)".
- **Currency:** never converted or mixed; one `MoneyAmountDto` per currency, sorted by
  `currencyCode`. Nothing captured → `[]`.
- **Arithmetic:** integer `sum` in SQL, never float (spec 003's money rule).

### Alert rules (AC-1)

A closed set of exactly **one** rule; it reads an existing signal and adds no new threshold (D-9).

**Rule `critical_safety_reports`**

| Property | Definition |
|---|---|
| Data source | `safety_reports` (spec 030) — the `priority` and `status` columns only |
| Trigger condition | `count(*)` of rows with `priority = 'critical'` AND `status <> 'resolved'` (spec 030's open states: `submitted`, `under_review`, `escalated`) is **> 0** |
| Severity | `critical` |
| Message (exact) | count = 1: `"1 critical safety report needs attention."`; count ≥ 2: `"{count} critical safety reports need attention."` — `{count}` is the integer; no report content ever appears |
| Link / target | `/admin/operations/safety` (spec 030's existing admin queue) |
| Visibility / authorization | only admins for whom `resolvePermission(userId, 'safety_reports', 'read')` is allowed — today trust_safety_admin and super_admin; for everyone else the alert is omitted and not hinted at |
| Aggregation | **one aggregated alert** carrying `count`, never one alert per report |
| Persistence | **transient and derived**: recomputed on every Overview request; never stored, acknowledged or dismissed; absent on the next refresh after the condition clears |
| Absent when | the count is 0 (no "0 alerts" row) |

Reviewing and resolving the reports stays spec 030's workflow; no moderation or fraud logic (spec
038) is involved. Adding a rule is a spec change; support SLA breaches, dispute appeals and AI cost
alerts were considered and not adopted (D-9).

**Tests** (`lib/admin-dashboard/overview.integration.test.ts`): no critical open report → no alert;
one → exactly one alert with `count: 1`, the singular message and the link; three → one alert with
`count: 3` and the plural message; a critical report that is `resolved` and a `high` open report are
not counted; an operations_admin (no `safety_reports`/`read`) receives `alerts: []` while a
trust_safety_admin sees the alert for the same data.

### Operations queue (AC-2)

One read-only queue over three existing sources. "Needing attention" means **not in the source's
own terminal state(s)**:

| Source | Included when | Read permission (existing seed) | `priority` | `linkTo` |
|---|---|---|---|---|
| `disputes` (spec 031) | `status NOT IN ('resolved','closed')` | `disputes`/`read` — operations_admin, trust_safety_admin, super_admin | `null` (disputes have none) | `/admin/operations/disputes/{id}` |
| `support_tickets` (spec 032) | `status NOT IN ('resolved','closed')` | `support`/`read` — support_admin, operations_admin, super_admin | the ticket's `priority` | `/admin/operations/support/{id}` |
| `safety_reports` (spec 030) | `status <> 'resolved'` (spec 030's own queue rule) | `safety_reports`/`read` — trust_safety_admin, super_admin | the report's `priority` | `/admin/operations/safety` |

- **Implementation:** `lib/admin-dashboard/queue.ts` resolves the caller's three read permissions
  with `resolvePermission`, then runs one `UNION ALL` read over only the permitted sources' id,
  status, priority and created_at columns, ordered and paged in SQL. It reads rows directly (it does
  not call the per-queue listers, which each apply their own paging); it writes nothing and marks
  nothing as seen.
- **Ordering:** `priority` descending (`critical` > `high` > `medium` > `low` > `null`), then
  `createdAt` ascending — spec 030's queue order, with `null` last.
- **Paging:** the repository's `limit`/`offset` `PagedResponse` convention; `total` counts only the
  permitted sources.
- A source the caller cannot read contributes nothing and is not mentioned; an admin who can read
  none gets an empty page (the UI shows the empty state).
- **Requests and bookings are not in the queue** (D-11): no admin read permission or admin reader
  exists for them and "needing attention" is undefined for them (§8 DEP-2).

### Marketplace configuration (AC-3)

**What the screen is (D-3).** `/admin/marketplace/config` is a **configuration overview and
navigation screen**: it displays the current business configuration and routes the admin to the
authoritative editor. It is **not** a replacement for those editors: every value on it is
read-only, it has no form, and no spec 037 API writes or forwards a write. The removed `PATCH` is
not reintroduced.

| Displayed value | Source (read) | Editable here? | Authoritative mutation (owner) | How the admin reaches it | Permission to view | Permission to mutate (in the owner) |
|---|---|---|---|---|---|---|
| Platform-default matching weights (nine factors) | `DEFAULT_MATCHING_WEIGHTS`, `lib/matching/weights.ts` (spec 017) | read-only | **none** — a code constant, changed only by deployment (making it editable needs new storage; out of scope, §7) | — (shown as "Platform default") | `matching.config`/`read` | — |
| Number of services with a weights override | `count(*)` of `services` with non-null `matching_weights` (spec 017) | read-only | `PATCH /api/v1/admin/services/{id}/matching-weights` → `updateMatchingWeights`; `POST /api/v1/admin/matching/suggestions/{id}/approve` → `approveMatchingSuggestion` (both spec 017) | "Manage matching weights" link → `/admin/marketplace/matching` (spec 017's existing page, which hosts both) | `matching.config`/`read` | `matching.config`/`configure` |
| Active platform cancellation policy (effective-from, config) | the open `policy_versions` row of the active platform-scope `policies` row (spec 023) | read-only | `POST /api/v1/admin/cancellation-policies` → `publishCancellationPolicy` (spec 023; append-only versions) | **no link** — no editor page exists; spec 023 assigns the configuration UI to spec 041 (Draft). The section states "Managed separately" and `linkTo` is `null` | `cancellation_policy`/`read` | `cancellation_policy`/`configure` |

Each editor keeps all of its business rules (spec 017: weights total 100, pool size 1–50,
`expectedVersion` concurrency; spec 023: append-only versions, server-clock `effective_from`,
overlap refusal). Spec 037 re-implements none of them.

**RBAC (D-1)** — exactly the existing seeds (`drizzle/0013_add_matching_ranking_distribution.sql`,
`drizzle/0019_add_cancellation_policy_no_show.sql`); no role or permission is added:

| Section | Read permission | Write permission (owning path) | Roles holding it today |
|---|---|---|---|
| `matching` | `matching.config`/`read` (low) | `matching.config`/`configure` (medium), spec 017 | operations_admin, super_admin |
| `cancellation` | `cancellation_policy`/`read` (low) | `cancellation_policy`/`configure` (medium), spec 023 | operations_admin, super_admin |

`content_admin`, `support_admin`, `finance_admin`, `trust_safety_admin` and `analytics_admin` hold
neither read permission and receive `403 FORBIDDEN`. A caller holding one of the two sees only that
section.

**Urgent service is not part of this spec (D-4).** Master spec §65 makes urgency a per-service
"urgent-capable" property; nothing stores it, and spec 015 accepts `urgency = 'urgent'` for any
service. The draft's `urgentServiceEnabled` is removed; the per-request `requests.urgency` field is
untouched (§8 DEP-3).

### Developer-controlled boundary (AC-4)

There is no "developer" role and none is created: spec 009 has exactly the seven master spec §69
roles. Master spec §71's developer-controlled settings are **outside the Admin Dashboard API/UI
contract** — they live in environment variables, code and migrations and change only by
deployment:

| Master spec §71 area | Examples in this repository | Where it lives |
|---|---|---|
| Authentication/security | `AUTH_SECRET`, session, CSRF and rate-limit settings | env, `lib/auth`, `lib/api/rate-limit.ts` |
| Infrastructure / database infrastructure | `DATABASE_URL`, `CRON_SECRET` | env |
| Payment credentials | `PAYMENT_PROVIDER` and adapter credentials | env, `lib/payments/provider/` |
| MCP authorization | spec 035's pipeline and seeded permissions | code + migrations (`lib/mcp`) |
| Safety-critical technical controls | kill switches such as `AI_ASSISTANT_ENABLED` | env |

Enforcement is structural: spec 037's responses are the closed DTOs above, built field by field from
the named tables and constants; no spec 037 module reads `process.env` for a value it returns,
accepts a parameter naming a setting, or serialises anything else — for every role, super_admin
included. `lib/admin-dashboard/boundary.test.ts` asserts it at source level.

### Audit (AC-5)

**Ownership boundary.** Spec 037 does **not** become the owner of any audit, authorization or
configuration system:

| Concern | Owner | Spec 037's role |
|---|---|---|
| The Admin Dashboard requirement and **AC-5** | **Spec 037** | defines the requirement and its tests |
| Matching-weight **mutation** (`updateMatchingWeights`, `approveMatchingSuggestion`) | **Spec 017** | adds one audit call to each writer; changes no validation, concurrency, route or response |
| Cancellation-policy **mutation** (`publishCancellationPolicy`) | **Spec 023** | adds `before`/`after` to its existing audit call; changes nothing else |
| The shared admin authorization and audit **helper contract** (`resolvePermission`, `recordAdminAuditEvent`, `AdminAuditEventInput`) | **Spec 009** | adds two optional input fields; the contract stays spec 009's |
| Audit **storage, retention, querying/viewing** and the long-term audit system (`audit_logs`, still a column-less skeleton) | **Spec 039** (Draft) | none — nothing of it is implemented or assumed here |

Today every admin audit event goes through spec 009's `recordAdminAuditEvent`
(`lib/admin-rbac/audit.ts`) into spec 005's `security_events`; that is the seam spec 039 will read.
Spec 037 does not wait for spec 039.

**Exact cross-spec code changes required by spec 037 (D-5, D-19)** — four, and only these:

| # | Owning spec | File / function | Change |
|---|---|---|---|
| X-1 | 009 | `lib/admin-rbac/audit.ts` — `AdminAuditEventInput`, `recordAdminAuditEvent` | add optional `before?: unknown` and `after?: unknown`; copy each into the event `metadata` **only when provided**. Existing callers and their events are unchanged |
| X-2 | 017 | `lib/matching/admin.ts` — `updateMatchingWeights` | after the successful `UPDATE`, call `recordAdminAuditEvent` with `eventType: 'admin_rbac.matching_weights_updated'`, `resource: 'matching.config'`, `action: 'configure'`, `targetType: 'service'`, `targetId: serviceId`, `before`/`after` = `{ weights, poolSize }` as stored before and after (`null` = no override), `reason: null`, `approvalChain: []`, actor = the caller with `getAdminRoleNames` roles. A `422`/`409`/`404` records nothing |
| X-3 | 017 | `lib/matching/admin.ts` — `approveMatchingSuggestion` | only when it writes a service's `matching_weights` (a service-scoped suggestion), call `recordAdminAuditEvent` with `eventType: 'admin_rbac.matching_suggestion_approved'`, the same resource/action/target shape as X-2, `before`/`after` = `{ weights, poolSize }` before and after, `reason: null`, `approvalChain: []`. A suggestion with no `service_id` writes no weights and records nothing new |
| X-4 | 023 | `lib/cancellation/admin.ts` — `publishCancellationPolicy` | its existing `admin_rbac.cancellation_policy_published` call additionally passes `before` (the `config` of the version it closed, or `null` when none existed) and `after` (the published `config`). Event type, `reason = note`, versions and response unchanged |

No other file of specs 009, 017 or 023 changes. There are exactly three writers of these settings in
the repository (`updateMatchingWeights`, `approveMatchingSuggestion` at `lib/matching/admin.ts`, and
`publishCancellationPolicy`); every other reference is a read.

**Reason.** Spec 009 makes a reason mandatory for high/critical actions (the `AdminAction` approval
row). Both writes here are medium-tier `configure` actions, which record a reason when one is
supplied: spec 023's `note`; spec 017's request has no reason field, so `null` — its API is not
changed.

**Actor.** `actorUserId` and `actorRoles` (`getAdminRoleNames`), as every existing event.

Spec 037's own three routes are reads and emit no audit event.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `401` | `UNAUTHENTICATED` | no session (existing `requireSession`) |
| `403` | `FORBIDDEN` | the caller holds no admin role; or, for `/marketplace/config`, neither `matching.config`/`read` nor `cancellation_policy`/`read` |

No new error code.

### Breaking-change check

- [x] Additive only: three new `GET` routes.
- [x] Spec 017's and spec 023's routes, request/response types and validation are unchanged; their
      audit events gain `before`/`after` — spec 017's two writers gain events they did not emit
      before (X-2, X-3). Spec 009's helper gains two optional input fields (X-1). No new endpoint
      and no additional write path is introduced.

---

## 4. Data model changes

### Entities

**None.** Read-only aggregation over existing tables: `requests` (015), `bookings` (020),
`payments`/`payments_status_history` (021), `safety_reports` (030), `disputes` (031),
`support_tickets` (032), `services.matching_weights` (017), `policies`/`policy_versions` (023),
spec 009's `roles`/`permissions`/`admin_role_assignments`. Audit before/after values go into the
existing `security_events.metadata` jsonb through spec 009's helper.

### Migration

**None (D-12).** The draft's conditional `AddAdminOverviewAggregates` is removed: the Overview uses
live queries, no permission is seeded (existing seeds are reused), no setting is stored
(`urgentServiceEnabled` removed), and audit values use an existing column.

### Retention and privacy

No new personal data. Responses carry counts, sums, identifiers, statuses and priorities only — no
name, contact detail, address, message, description or report text. Overview figures are
platform-wide aggregates any admin may see (D-13); queue items and alerts are filtered by the
caller's existing read permissions, so no admin learns of an item their role could not already open.
Audit before/after values are configuration values (weights, policy config), never personal data.

---

## 5. UI states

Built only from the design system: tokens from `app/styles/apuriva-tokens.css` and primitives from
`@/components` (`components/index.ts`) — `StatBlock`, `Table`, `Alert`, `Badge`, `Card`,
`Skeleton`, `EmptyState`, `ErrorState`, `Button`. The draft's `AlertList` and `ConfigForm` are not
created: the alert list composes `Alert`, and there is no form (the configuration screen is
read-only). A genuine design-system gap is reported, not built in parallel.

| State | Behaviour |
|---|---|
| **Loading** | first load: `Skeleton` per section. The Overview figures and alerts arrive together in one `GET /api/v1/admin/overview` response, so they load together; the Operations queue is a separate, independent request (`GET /api/v1/admin/operations/queue`) |
| **Empty** | queue: `EmptyState` "No items need attention"; alerts: "No alerts"; revenue `[]`: "Nothing captured today" |
| **Error** | per-request `ErrorState` with a Retry `Button`; the Overview request and the queue request fail independently, so one never blanks the other. On a failed **poll**, the last good data stays visible with its original "as of" time and a small error notice; the next successful poll clears it |
| **Success** | figures with "As of {generatedAt}" (server time, shown in the viewer's locale) |

**Live updates — polling (D-14).** No WebSocket layer exists in this repository; live push is
future scope.

- **Interval:** 10 seconds — the repository's existing cadence (`BOOKING_POLL_MS` in
  `app/bookings/booking-client.ts`, `EARNINGS_POLL_MS` in `app/provider/earnings/earnings-client.ts`),
  as `ADMIN_DASHBOARD_POLL_MS = 10_000`.
- **What refreshes:** the Overview (`GET /admin/overview`, figures and alerts together in one
  response) and the Operations queue's current page (`GET /admin/operations/queue`). Each request
  polls independently on its own timer. The Marketplace configuration screen loads once and does
  not poll (configuration changes rarely and elsewhere).
- **Timestamp:** each response's `generatedAt`; it only advances on a successful response.
- **No overlap:** a poll is skipped while the previous request for that same endpoint is still in flight.
- **Inactive / unmounted:** polling pauses while `document.hidden` (a `visibilitychange` listener, as
  `app/bookings/_components/BookingConversation.tsx` and `app/_components/RequestMessageThread.tsx`
  already do) and resumes with an immediate refresh when visible; the interval and listener are
  cleared on unmount.

Information-dense layout per master spec §3.7 (`PlaceholderPage`'s `density="dense"` precedent).

**Route(s):**
- `/admin` — `app/admin/page.tsx`: the Overview (spec 014's nav entry `href: '/admin'`), replacing
  its `PlaceholderPage`.
- `/admin/operations` — `app/admin/operations/page.tsx`: the queue, replacing its `PlaceholderPage`
  and keeping its links to the existing workspaces (approvals, post-action review, refunds,
  payouts, disputes, support).
- `/admin/marketplace/config` — `app/admin/marketplace/config/page.tsx`: new, beside the existing
  `app/admin/marketplace/catalog` and `app/admin/marketplace/matching` pages, linked from the
  Overview. Spec 014's `app/components/nav-items.ts` is not changed.

**Shared components used/added:** used as listed; none added.

---

## 6. Test plan

Vitest, co-located beside the source (the repository convention), run against the isolated `*_test`
database. `e2e/*.spec.ts` is a configured Vitest pattern walking journeys through real route
handlers; there is no Playwright runner. Admin fixtures reuse the existing RBAC test support
(`app/api/v1/admin/admin-rbac-test-support.ts`).

| Area | What it covers | Where |
|---|---|---|
| **Authorization / RBAC** | a non-admin gets 403 and no session gets 401 on all three routes; each of the seven roles gets exactly its permitted queue sources, alerts and config sections; content_admin gets 403 on config | `app/api/v1/admin/dashboard.integration.test.ts` |
| **Overview calculations** | only `ACTIVE_REQUEST_STATUSES` counted; only the five in-flight booking statuses counted; revenue: today's UTC captures only (a capture just before 00:00Z excluded), per currency, refunded-after-capture still counted, created/authorized/failed never counted; alert present only when a critical unresolved report exists and only for safety readers; `generatedAt` present | `lib/admin-dashboard/overview.integration.test.ts` |
| **Queue aggregation — unit** | ordering (priority desc, null last, createdAt asc); per-source permission filtering; paging arithmetic | `lib/admin-dashboard/queue.test.ts` |
| **Queue aggregation — integration** | terminal-state exclusion per source; support_admin → support only, trust_safety_admin → disputes + safety, operations_admin → disputes + support; links point at existing routes; `total` over permitted sources only; no row changed | `lib/admin-dashboard/queue.integration.test.ts` |
| **Marketplace configuration reads** | real `DEFAULT_MATCHING_WEIGHTS`, correct override count, active platform policy (and `null` when none); sections per permission; spec 037 performs no write (row versions unchanged) | `lib/admin-dashboard/config.integration.test.ts` |
| **Marketplace configuration writes / audit** | through the owners' own routes: a weights `PATCH` records one `admin_rbac.matching_weights_updated` event (actor, roles, before, after, `reason: null`); a service-scoped suggestion approval records one `admin_rbac.matching_suggestion_approved` event with before/after, and a suggestion without a service records none; a cancellation publish records before (`null` for the first version) and after with the note as reason; a failed `422`/`409`/`404` records nothing | `lib/admin-dashboard/audit.integration.test.ts` |
| **Audit helper** | `before`/`after` appear in metadata only when provided; an existing caller's event is unchanged | `lib/admin-dashboard/audit.integration.test.ts` |
| **Boundary** | no `process.env` read, no insert/update/delete, no import of a write function (`updateMatchingWeights`, `publishCancellationPolicy`) in `lib/admin-dashboard/**`; DTO keys exactly the allow-list | `lib/admin-dashboard/boundary.test.ts` |
| **UI states** | per-section skeleton, empty, error + retry for each request; the Overview and queue requests fail independently; "As of" shown | `app/admin/page.test.tsx`, `app/admin/operations/page.test.tsx`, `app/admin/marketplace/config/page.test.tsx` |
| **Polling** | fake timers: refresh every 10 s; no overlapping requests; paused while hidden, immediate refresh on visible; cleared on unmount; failed poll keeps last data and old "as of"; config page never polls | `app/admin/page.test.tsx`, `app/admin/operations/page.test.tsx` |
| **E2E (Vitest)** | an operations_admin loads the Overview and the queue, follows a support item's link to its existing detail route, opens Marketplace configuration and follows the link to the matching editor, updates a weight there, and the audit event with before/after exists | `e2e/admin-dashboard.spec.ts` |
| **Urgent service** | not applicable — removed from this spec (D-4) | — |

**Traceability** — see §2 "AC traceability" for the full API/UI/authorization/audit/test mapping.

| AC | Named test |
|---|---|
| AC-1 | `lib/admin-dashboard/overview.integration.test.ts::real data, not placeholders`; `…::revenue counts only today's UTC captures, per currency`; `…::critical safety alert only for safety readers` |
| AC-2 | `lib/admin-dashboard/queue.integration.test.ts::each source only for its read permission`; `…::terminal items are excluded`; `lib/admin-dashboard/queue.test.ts::orders by priority then age` |
| AC-3 | `lib/admin-dashboard/config.integration.test.ts::operations admin sees the real configuration`; `…::nothing is written`; `app/api/v1/admin/dashboard.integration.test.ts::content admin is refused the configuration` |
| AC-4 | `lib/admin-dashboard/boundary.test.ts::DTOs are a closed allow-list and read no environment value` |
| AC-5 | `lib/admin-dashboard/audit.integration.test.ts::matching weight update is audited with before and after`; `…::service-scoped suggestion approval is audited with before and after`; `…::policy publish is audited with before and after`; `…::a rejected update records no event` |
| AC-6 | `app/api/v1/admin/dashboard.integration.test.ts::a non-admin gets 403 and no session gets 401 on every endpoint` |

**Coverage:** ≥80% on new spec 037 code — statements, branches, functions and lines — measured with
the installed `@vitest/coverage-v8` over `lib/admin-dashboard/**`, the three routes, the three pages,
and the lines spec 037 adds to `lib/admin-rbac/audit.ts`, `lib/matching/admin.ts` and
`lib/cancellation/admin.ts`.

**Not covered, deliberately:** the detailed workflows each item links to (specs 030, 031, 032) and
the owning write paths' business rules (specs 017, 023) — tested there.

**Other specs' tests.** None is edited. Specs 009, 017 and 023's existing tests must pass
unmodified; if one fails because of X-1 – X-4 it is reported to the platform owner, not edited. No
test asserts the two placeholder pages.

### Expected existing test impact

Checked before implementation (2026-09-25) by searching every `*.test.ts(x)` and `e2e/*.spec.ts`
for `security_events`, `recordAdminAuditEvent`, `admin_rbac.*`, the three writers and their routes.
**No existing test is expected to change.**

| Test file | Relevant assertion | Why it is not affected |
|---|---|---|
| `app/api/v1/admin/audit.integration.test.ts` (spec 009) | reads the latest event for an admin via `latestEventFor(userId, eventType)` and checks individual metadata fields (`actorRoles`, `resource`, `action`, `targetType`, `targetId`, `reason`, `approvalChain`) | X-1 adds `before`/`after` only when provided, and no metadata object is compared whole; the test's admins perform no matching or cancellation write, so no new event becomes their "latest" |
| `app/api/v1/admin/matching/weights.integration.test.ts` (spec 017) | weights validation, `422`/`409`, response DTO | asserts no audit or `security_events` row; X-2 does not change the response or validation |
| `lib/cancellation/routes.integration.test.ts` (spec 023) | publish/list behaviour and DTOs | asserts no audit or `security_events` row; X-4 only adds fields to an event it does not read |
| `app/api/v1/catalog/audit.integration.test.ts` (spec 010) | latest `catalog.*` event per content admin, field by field | content admins cannot perform the three writes (no permission), so no new event precedes theirs |
| `lib/notifications/marketing.integration.test.ts` (spec 026) | the only unfiltered `count(*)` of `security_events`, scoped to one ordinary user | the new events are recorded for the acting admin, never for that user |
| every other test reading `security_events` (e.g. `lib/no-show/no-show.integration.test.ts`, `lib/support/*.integration.test.ts`, `lib/reviews/*.integration.test.ts`) | filters by its own `event_type`/user | none of those event types or users is touched |

Suggestion approval (X-3) has no existing test that reads events. If any test nonetheless fails
after X-1 – X-4, it is reported, never edited.

---

## 7. Out of scope

- Any spec 037 configuration **write** or write-forwarding API, and editable platform-default
  matching weights (would need new storage).
- `urgentServiceEnabled` / urgent-capable services (D-4, §8 DEP-3).
- Requests and bookings in the Operations queue (D-11, §8 DEP-2).
- Alert rules beyond `critical_safety_reports`; persisted, acknowledged or dismissible alerts.
- WebSocket / server push (polling only, D-14).
- Spec 038 (moderation/fraud actions), spec 039 (audit storage, retention, views), spec 040
  (analytics, pre-aggregation, fee/net revenue), spec 041 (feature flags, platform configuration,
  the cancellation-policy editor UI).

---

## 8. Risks and open questions

### Decided in review

| # | Decision |
|---|---|
| D-1 | AC-3 RBAC is the existing seeds only: `matching.config` and `cancellation_policy` read/configure → operations_admin, super_admin. No role (no "Marketplace admin", no "Developer") and no permission is added |
| D-2 | Developer-controlled settings (master spec §71) are outside the Admin Dashboard API/UI contract for every role; enforced by closed DTOs and a boundary test |
| D-3 | Marketplace configuration **reads** existing sources and **links** to existing editors. Spec 017's and spec 023's paths remain the only writers; the draft's `PATCH` is removed |
| D-4 | `urgentServiceEnabled` is removed from this spec; `requests.urgency` is untouched |
| D-5 | AC-5 is met by X-1 – X-4 (§3 "Audit"): optional `before`/`after` on spec 009's helper; audit events from spec 017's two writers; `before`/`after` on spec 023's publish event. Specs 009/017/023 keep ownership of their modules; spec 039 owns storage/retention/views and is not implemented here |
| D-6 | Overview figures are live transactional queries; spec 040 aggregates do not exist |
| D-7 | `revenueToday` = gross `payments.charge_amount_minor_units` captured (per `payments_status_history`) in the current UTC day, per currency, refunds not netted, non-captured never counted |
| D-8 | `activeBookings` = bookings in `pending`, `confirmed`, `provider_en_route`, `arrived`, `in_progress` |
| D-9 | One alert rule: `critical_safety_reports` (critical), transient and derived per request |
| D-10 | Queue items carry no free-text summary |
| D-11 | The queue covers disputes, support tickets and safety reports only; "needing attention" = not in the source's terminal state |
| D-12 | No migration |
| D-13 | Overview aggregates are visible to any admin; alerts and queue items are filtered by existing read permissions |
| D-14 | Polling every 10 s with visibility pause, no overlap and unmount cleanup; WebSocket is future scope (resolves the draft's open question 1) |
| D-15 | Types `lib/types/admin-dashboard.ts`; logic `lib/admin-dashboard/`; routes `app/api/v1/admin/{overview,operations/queue,marketplace/config}/route.ts`; pages under `app/admin/`; primitives from `@/components` |
| D-16 | The Marketplace configuration page is `/admin/marketplace/config`, linked from the Overview; spec 014's navigation is unchanged |
| D-17 | Matching-weight audit `reason` is `null` (medium tier, spec 009 requires none; spec 017's API is not changed) |
| D-18 | Queue ordering: priority descending with `null` last, then oldest first |
| D-19 | Spec 017's second matching-weight writer, `approveMatchingSuggestion`, is audited too (X-3), so AC-5 covers every existing writer |
| D-20 | The single alert is aggregated (one alert with a count), with exact singular/plural messages |

### Open questions

None.

### Dependencies — interfaces and ownership

| # | Dependency | Contract / ownership | Blocks |
|---|---|---|---|
| DEP-1 | Specs 009, 017, 023 (Approved) — the four cross-spec edits X-1 – X-4 of §3 "Audit" | spec 037 makes exactly those edits; each spec keeps ownership of its module and behaviour | AC-5 |
| DEP-2 | Requests/bookings admin read access | needs new permissions and "needing attention" rules from a later spec | requests/bookings in the queue (out of scope) |
| DEP-3 | Urgent-capable services (master §65) | a later spec (or spec 041) defines storage and spec 015's enforcement | an urgent-service setting (out of scope) |
| DEP-4 | Spec 041 (Draft) | owns the cancellation-policy configuration UI (per spec 023); `cancellation.linkTo` stays `null` until it exists | the editor link only |
| DEP-5 | Spec 039 (Draft) | will read spec 009's events, now carrying before/after; owns storage, retention, views | nothing in this spec |
| DEP-6 | Spec 040 (Draft) | may later replace live queries with aggregates behind the same DTO | nothing in this spec |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Live counts over large tables slow the Overview | single aggregate queries; the Overview and queue are independent requests; pre-aggregation is spec 040's if ever needed |
| R-2 | `revenueToday` is gross, so it differs from money kept | fixed definition, labelled "Captured today (UTC)" |
| R-3 | An existing test is affected by X-1 – X-4 despite §6 "Expected existing test impact" finding none | reported to the platform owner, never edited |

---

## 9. Rollout

- **Feature flag:** none — core admin tooling; the dashboard is read-only.
- **Migration order:** no migration.
- **Rollback:** revert the deploy. Audit events already written keep their extra `before`/`after`
  metadata, which older code ignores.
- **Observability:** one structured stdout event per request, following the repository's
  `console.info(JSON.stringify({ event, … }))` convention — `admin_dashboard.overview_served`,
  `admin_dashboard.queue_served`, `admin_dashboard.config_served` — with `correlationId` and
  `durationMs` only (master spec §117 load time). Configuration-change frequency is observable from
  the `admin_rbac.matching_weights_updated`, `admin_rbac.matching_suggestion_approved` and
  `admin_rbac.cancellation_policy_published` audit events.
