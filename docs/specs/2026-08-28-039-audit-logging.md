# Spec: Audit Logging

**File:** `docs/specs/2026-08-28-039-audit-logging.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §69, §70, §72, §73, §75, §117, §124, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §9.4, §9.5, §15, [docs/workflow.md](../workflow.md); specs 003 (schema conventions, `audit_logs` stub), 004 (API envelope, correlation id), 005 (`security_events`), 008 (deletion/anonymization), 009 (RBAC, `AdminAction`, `recordAdminAuditEvent()`), 035 (`McpAuditSink` port), and the specs whose audit obligations AC-5 lists (§2.2). **Not required:** 040 (analytics), 041 (feature flags), 046 (operational logging). See §8.

---

## 1. Problem statement

**Today:** Master spec §72 requires every sensitive/admin action to be audited with actor, role,
action, target, timestamp, before/after values, reason, approval and request/correlation id, in a
system distinct from ordinary application logs. Master §124 lists `AuditLog` and `SecurityEvent`
as two separate entities.

The repository already has the audit **hook**, but no audit **store**:

- **`recordAdminAuditEvent()`** (`lib/admin-rbac/audit.ts`, spec 009) is the single call path used
  by every admin-facing module (§3.3). It already carries actor, actor roles, event type,
  resource/action, target, reason, approval chain, the emergency-bypass marker, and optionally
  `correlationId` and `before`/`after`. Its own comments say storage "stays spec 039's".
- It persists into **spec 005's `security_events`** table as a `metadata` blob. That table is
  mutable, and it is shared with authentication and privacy events. It therefore meets neither
  §72's immutability nor its separation requirement.
- **Spec 035** ships the `McpAuditSink` port (`lib/mcp/audit.ts`). Its default sink writes only to
  stdout and says "spec 039 registers the durable sink".
- **Spec 003's `audit_logs` table exists but is an empty stub.** It has `baseColumns()` plus a
  nullable `actor_user_id`. Nothing reads or writes it.

**Who is affected:**

- Every admin action across the platform.
- Compliance and legal teams reviewing platform history.
- Engineers answering "who changed this, when, under which approval, from which request".

**Why it matters now:** Approved specs 009, 010, 023, 025, 029, 030, 031, 032, 035, 037 and 038
make audit acceptance criteria that point at this spec, or at the hook this spec makes durable.

**Success looks like:**

- `recordAdminAuditEvent()` keeps its signature and every caller. It writes one immutable row to
  the real `audit_logs` table, not to `security_events`.
- Spec 035's MCP port gets its durable sink.
- Every entry is linked to its originating request by correlation id.
- Admins read only the entries within their own domain.

This spec does **not** create a second audit system. It completes the one the repository already
routes through.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any action that calls `recordAdminAuditEvent()` (§3.3) **When** it succeeds **Then** exactly one `audit_logs` row is written. It carries: actor type and user id, actor roles, event type, resource, action, target (when given), reason (when given), before/after values (when given), approval chain, approval reference (when the action has a spec 009 `AdminAction`), emergency-bypass marker, correlation id (§3.5) and `created_at`. |
| AC-2 | **Given** an existing `audit_logs` row **When** anyone issues `UPDATE`, `DELETE` or `TRUNCATE` against the table, through the application or directly in SQL as the application's database role **Then** the database rejects it (`23514`). No API route or admin role can edit or delete an entry. |
| AC-3 | **Given** the audit log **When** compared with `security_events` and with operational stdout logging **Then** it is a structurally separate table. `recordAdminAuditEvent()` writes nothing to `security_events`. The events that remain security events (§3.4) never reach `audit_logs`. |
| AC-4 | **Given** an admin querying `GET /api/v1/admin/audit-logs[/{id}]` **When** they lack `audit_logs/read` **Then** `403 FORBIDDEN`. **When** they hold it **Then** they see only entries whose `resource` falls within their scope (§3.7). `super_admin` sees every entry. An out-of-scope detail id is `404 NOT_FOUND`. A `resource` filter outside scope is `403 FORBIDDEN`. |
| AC-5 | **Given** each earlier audit obligation listed in §2.2 **When** it is exercised end to end **Then** it produces a retrievable `audit_logs` row through the shared mechanism, with the fields that obligation names. |
| AC-6 | **Given** an audited action that runs inside an API request handled by `withApiRoute` **When** it writes an audit entry **Then** `audit_logs.correlation_id` equals that request's correlation id: the caller's valid `x-correlation-id`, or the generated one returned in the response envelope. An action with no originating API request records `correlation_id = null` (§3.5). |

### 2.1 AC implementation matrix

| AC | Owner | Path | Data | Named test |
|---|---|---|---|---|
| AC-1 | Spec 039 writer; spec 009 hook | `recordAdminAuditEvent()` → `lib/audit/write.ts` `writeAuditEntry()` | `audit_logs` | `lib/audit/write.test.ts`, `lib/audit/record-admin-audit-event.integration.test.ts` |
| AC-2 | Spec 039 migration | `0034` triggers | — | `lib/audit/immutability.integration.test.ts` |
| AC-3 | Spec 039 | writer + §3.4 split | `audit_logs` vs `security_events` | `lib/audit/separation.integration.test.ts`, `lib/audit/boundary.test.ts` |
| AC-4 | Spec 039 | `lib/audit/scope.ts`, `lib/audit/read.ts`, the two routes | `permissions` rows (`audit_logs/read`) | `app/api/v1/admin/audit-logs/access.integration.test.ts` |
| AC-5 | the owning specs (actions); Spec 039 (storage) | existing callers, unchanged except X-2/X-3 | `audit_logs` | `lib/audit/coverage.integration.test.ts`, `lib/audit/mcp-sink.integration.test.ts`, plus the re-pointed X-6 suites |
| AC-6 | Spec 004 handler (X-1); Spec 039 context | `lib/audit/request-context.ts` | `audit_logs.correlation_id` | `lib/audit/correlation.integration.test.ts`, `lib/audit/request-context.test.ts` |

### 2.2 AC-5 traceability: real earlier audit obligations

Only acceptance criteria that exist in the approved spec documents **and** name an audit write are
listed. Specs 016, 021, 022, 024, 034 and 036 have **no audit acceptance criterion**, so they are not
listed. Their admin actions are still audited through spec 009's action events. Spec 022 refund
overrides and spec 024 payout retries/adjustments are covered that way (row 1). Spec 011's service
FAQ and field writes (`lib/service-page/{faqs,fields}.ts`) also call the hook, and so move with it,
but spec 011 states no audit acceptance criterion.

| Spec / AC | Obligation (as written) | Where it happens today | Covered by |
|---|---|---|---|
| 009 AC-4 | every admin action audited with actor, role, action, target, reason, approval chain, emergency-bypass marker | `lib/admin-rbac/actions.ts` (`admin_rbac.action_*`, `emergency_bypass_executed`) | writer + X-3 (`approval_ref`) |
| 009 AC-5 | role assignment/revocation audited | `lib/admin-rbac/role-assignment.ts` (`admin_rbac.role_assigned` / `role_revoked`) | writer |
| 010 AC-2 | catalog create/edit/retire audited | `lib/catalog/*.ts` | writer |
| 023 AC-9 | no-show resolution: admin, outcome, reason | `lib/no-show/resolution.ts` | writer |
| 025 AC-5 | admin conversation reads: actor, roles, action, target, reason, correlation id | `lib/messaging/admin.ts`, `lib/files/contexts/policies.ts` | writer |
| 029 AC-8 | review removal: actor, roles, target, reason | `lib/reviews/moderation.ts`, `app/api/v1/admin/reviews/[id]/resolve/route.ts` | writer |
| 030 AC-3 | safety report and evidence reads: actor, roles, target, correlation id | `lib/safety/reports.ts` | writer |
| 031 AC-3 | dispute resolution: actor, roles, target, reason, correlation id | `lib/disputes/{read,appeal,resolve}.ts` (`auditDispute`) | writer |
| 032 AC-4, AC-6 | ticket admin actions; priority change old/new | `lib/support/audit.ts` | writer |
| 035 AC-1 (check 8) | an MCP tool call cannot execute without its audit write | `lib/mcp/authorize.ts` → `McpAuditSink` | durable sink (§3.6) |
| 037 AC-5 | configuration changes with before/after | `lib/matching/admin.ts`, `lib/cancellation/admin.ts` | writer |
| 038 AC-4, AC-9 | moderation operations (13 event types); evidence reads audited before disclosure | `lib/moderation/audit.ts` → `recordAdminAuditEvent()` | writer (derived `approval_ref`) |

**Master §72 examples with no code path in this repository:**

| §72 example | Status |
|---|---|
| Provider approval | **No admin provider-approval flow exists.** `provider_profiles.lifecycle_status` has `pending_verification`, but no route moves it. Not auditable until a spec builds the flow; that spec then calls `recordAdminAuditEvent()`. |
| Commission change | **No admin write path exists.** Commission is deployment configuration (`lib/payouts/fees.ts`, env). Not auditable here; a future spec that makes it admin-editable calls the hook. |
| Refund, payout intervention | Covered through spec 009 action events (022 `refunds/override`, 024 `payouts/retry|adjust`). |
| Dispute resolution, booking intervention, permission change, service rule change, moderation | Covered (rows above: 031, 038, 009 AC-5, 010/037, 038). |

Spec 039 does **not** implement the two missing flows.

---

## 3. API contract

### 3.1 Ownership and seams (verified against the repository)

| Concern | Owner | Spec 039's use |
|---|---|---|
| Audit hook `recordAdminAuditEvent()` and its callers | spec 009 (hook); each domain spec (calls) | Signature kept; storage re-pointed (X-2); one additive optional field |
| Audit store `audit_logs` | **Spec 039** (stub from spec 003) | Altered by `0034`, never recreated |
| Writer `writeAuditEntry()` | **Spec 039**, `lib/audit/write.ts` | Internal to the hook and the MCP sink; not a second public audit API (boundary-tested) |
| `security_events`, `recordSecurityEvent()` | spec 005 | Unchanged; keeps the §3.4 security events |
| `McpAuditSink` port | spec 035 | Spec 039 registers the durable sink from outside `lib/mcp` (spec 035's boundary test forbids `audit_log` names inside `lib/mcp`) |
| Correlation id | spec 004 `withApiRoute` | Additive request context (X-1) |
| Approval records | spec 009 `admin_actions`, `admin_action_approvals` | Referenced by FK, never duplicated |
| Permissions | spec 009 `permissions` | New `audit_logs/read` rows seeded by `0034` |
| Operational logging | spec 046 (stdout JSON) | Untouched; separate by construction |

### 3.2 The single write path

```
domain module ──► recordAdminAuditEvent(input)   (lib/admin-rbac/audit.ts, spec 009 hook)
                        │
MCP authorize ──► getMcpAuditSink().record(entry) (spec 035 port) ──► durableMcpAuditSink (lib/audit/mcp-sink.ts)
                        │                                                     │
                        └──────────────► writeAuditEntry(row)  (lib/audit/write.ts) ◄──┘
                                              │  INSERT INTO audit_logs … (only writer)
```

`writeAuditEntry()` is the only code that inserts into `audit_logs`. It is called only by
`lib/admin-rbac/audit.ts` and `lib/audit/mcp-sink.ts` (boundary test).

**Mapping from `AdminAuditEventInput` (unchanged fields):**

| Input | Column |
|---|---|
| `actorUserId` | `actor_user_id` |
| `actorRoles` (non-empty ⇒ `admin`, empty ⇒ `user`, e.g. a spec 038 appellant) | `actor_roles`, `actor_type` |
| `eventType`, `resource`, `action` | `event_type`, `resource`, `action` |
| `targetType`, `targetId` | `target_type`, `target_id` (text; e.g. spec 030's `'queue'`) |
| `reason` | `reason` |
| `before`, `after` | `before_value`, `after_value` (null when not provided) |
| `approvalChain` | `approval_chain` (stored as given) |
| `approvalRef` (**new, optional**), else `approvalChain.adminActionId` when it is a UUID | `approval_ref` → `admin_actions.id` |
| `isEmergencyBypass` | `is_emergency_bypass` |
| `correlationId`, else request context (§3.5), else `null` | `correlation_id` |

`actor_type = 'system'` (with `actor_user_id` null) is supported by the table and the writer for a
future system-initiated audited action. No current caller produces one.

There is **no `ai` actor type.** The AI never acts on its own authority: an MCP tool call is the
signed-in user's action, taken through the assistant under that user's authorization (spec 035;
master §73 "MCP tools inherit backend authorization"). It is recorded as `actor_type = 'user'` with
`event_type = 'mcp.tool_call'`, which is what identifies AI mediation.

### 3.3 Existing callers (all keep calling the hook; production code unchanged except X-2/X-3)

`lib/admin-rbac/{actions,role-assignment}.ts`, `lib/cancellation/admin.ts`, `lib/catalog/{categories,services,subcategories,suggestions}.ts`,
`lib/service-page/{faqs,fields}.ts`, `lib/matching/admin.ts`, `lib/messaging/admin.ts`,
`lib/files/contexts/policies.ts`, `lib/no-show/resolution.ts`, `lib/reviews/{moderation,media-policy}.ts`,
`app/api/v1/admin/reviews/[id]/resolve/route.ts`, `lib/safety/reports.ts`, `lib/disputes/{read,appeal}.ts`,
`lib/support/audit.ts`, `lib/moderation/audit.ts`. Spec 022/024 admin actions reach the hook through
spec 009's `authorizeAndInitiate` / `decideAction` / `executeApprovedAction`.

### 3.4 What moves and what stays (AC-3)

| Event source | Store after Spec 039 |
|---|---|
| **Everything** written through `recordAdminAuditEvent()`. Observed namespaces: `admin_rbac.*` (including matching, cancellation-policy and no-show events), `catalog.*`, `service_page.*`, `no_show.*`, `messaging.*`, `files.*`, `review(s).*`, `safety.*`, `disputes.*`, `support.*`, `moderation.*`, `fraud_signal.*` | **`audit_logs` only** |
| MCP tool calls (spec 035 sink) | **`audit_logs`** (`mcp.tool_call`) |
| Direct `recordSecurityEvent()` callers: `auth.*` (spec 005), `privacy.*` (spec 008), `notification(s).*` consent (spec 026), `ai.abuse_signal` / `ai.cost_alert` (spec 033), `payout_method.*` (spec 024, the user's own account security) | **`security_events`, unchanged** |
| `lib/api/security-log.ts` (`api.forbidden`), `mcp_tools.tool_call`, every other stdout line | **stdout only, unchanged** (spec 046) |

**Existing rows are not moved.** Admin events already in `security_events` stay there as history:
no copy and no deletion, because the repository is pre-launch. From deployment onward,
`recordAdminAuditEvent()` no longer writes to `security_events`.

**Supersession of storage wording in approved specs.** Two approved documents say the hook
persists "to `security_events`": spec 038 AC-4 and spec 032 AC-6. The obligation in each, an audit
event "through the existing `recordAdminAuditEvent()`", is preserved unchanged. Spec 039 supersedes
**only the storage location** named there. Those spec documents are **not edited**; this paragraph
is the record.

### 3.5 Correlation id (AC-6) — repository behaviour and the rule

**How it works today (spec 004):**

- `withApiRoute` (`lib/api/handler.ts`) derives one id per request through `getOrCreateCorrelationId`
  (`lib/api/correlation-id.ts`). It keeps a caller's `x-correlation-id` if that matches
  `^[A-Za-z0-9_-]{1,100}$`; otherwise it generates `crypto.randomUUID()`.
- That id is returned in every envelope and passed to the handler as its second argument.
- It is **not** ambient. There is no AsyncLocalStorage, so a service sees it only if the route
  passes it explicitly. The audit writers of specs 025, 027, 029, 030, 031, 032 and 038 do. Those of
  specs 009, 010/011, 017 and 023 do not, and that includes the matching and cancellation-policy
  writers that spec 037 AC-5 relies on.
- Cron routes (`app/api/v1/cron/**`) do not use `withApiRoute` and have no correlation id.
- MCP calls carry a `sessionId`. They run inside the spec 034 assistant routes
  (`app/api/v1/ai/**`, all `withApiRoute`), which do have a correlation id.

**Spec 039 rule:**

1. **X-1:** `withApiRoute` runs the handler inside an AsyncLocalStorage request context
   (`lib/audit/request-context.ts`, `node:async_hooks`, Node runtime) holding the correlation id. The
   handler signature is unchanged.
2. The writer resolves `correlation_id` in this order:
   1. the caller's explicit `correlationId`;
   2. `getRequestCorrelationId()` from the request context;
   3. `null`.
3. `null` means **there was no originating API request** (cron, script, future system actor). No
   placeholder id is invented. AC-6 applies to request-originated actions only.
4. MCP entries get the assistant request's correlation id from the context. `sessionId` goes into
   `after_value`.
5. The column CHECK mirrors spec 004's format: `correlation_id is null or correlation_id ~ '^[A-Za-z0-9_-]{1,100}$'`.

This makes AC-6 hold for every existing caller, including 009/010/011/017/023 and spec 037's
configuration writers, with **no signature change in any domain module**.

### 3.6 MCP durable sink (spec 035)

`lib/audit/mcp-sink.ts` exports `durableMcpAuditSink: McpAuditSink`. `record(entry)` does the following:

- It calls `writeAuditEntry()` with:
  - `actor_type 'user'`, `actor_user_id = entry.userId`, `actor_roles []`;
  - `event_type 'mcp.tool_call'`, `resource 'mcp'`, `action 'tool_call'`;
  - `target_type 'mcp_tool'`, `target_id = entry.toolName`;
  - `after_value = { riskTier, confirmed, reversible, sessionId }`;
  - correlation id per §3.5.
- It returns the new row's `id` as `auditId`.
- A failed write **throws**, so spec 035's existing audit-first rule still blocks the tool.
- No tool input is recorded, which is spec 035's rule.

`lib/audit/register.ts` exports `registerAuditIntegration()`. It calls `registerMcpAuditSink(durableMcpAuditSink)`,
is called from `instrumentation.ts` (X-4), and is idempotent. `lib/mcp/**` is not modified.

### 3.7 Read scope (AC-4) — normative

**Permission.** Migration `0034` seeds `audit_logs/read`, risk tier `low`, for **all seven existing
roles**: super_admin, operations_admin, support_admin, finance_admin, trust_safety_admin,
content_admin, analytics_admin. This was decided by the product owner (D-2). Holding it only
opens the log; what each role sees is scoped below.

**Scope map** (`lib/audit/scope.ts`, `AUDIT_RESOURCE_READ_PERMISSION`). An entry is visible when the
viewer holds `audit_logs/read` **and** either:

- is `super_admin`; or
- holds the read-level permission mapped to the entry's `resource`.

| Entry `resource` | Required read-level permission |
|---|---|
| `cancellation_policy` | `cancellation_policy/read` |
| `catalog.category` | `catalog.category/view` |
| `catalog.subcategory` | `catalog.subcategory/view` |
| `catalog.service`, `catalog.service_faq`, `catalog.service_field` | `catalog.service/view` |
| `catalog.suggestion` | `catalog.suggestion/view` |
| `disputes` | `disputes/read` |
| `fraud_signal` (spec 038 event prefix) | `fraud_signals/read` |
| `matching.config` | `matching.config/read` |
| `messaging` | `messaging/read_conversation` |
| `moderation` | `moderation/read` |
| `no_show_reports` | `no_show_reports/read` |
| `payouts` | `payouts/read` |
| `refunds` | `refunds/read` |
| `reviews` | `reviews/read_moderation_queue` |
| `safety_reports` | `safety_reports/read` |
| `support` | `support/read` |
| `admin_rbac.role`, `mcp`, and **any unmapped resource** | none: **super_admin only** (default deny) |

A read-level permission, rather than "any permission on the resource", is required on purpose. For
example, finance_admin holds `moderation/freeze_payout` but deliberately lacks `moderation/read`
(spec 038 §3.9 least privilege), so it must not see moderation reasons through the audit log.

**Resulting matrix, derived from the currently seeded permissions:**

| Role | Visible entries | Allowed |
|---|---|---|
| super_admin | all | list, detail |
| trust_safety_admin | disputes, fraud_signal, messaging, moderation, no_show_reports, reviews, safety_reports | list, detail |
| operations_admin | cancellation_policy, disputes, matching.config, moderation, support | list, detail |
| finance_admin | payouts, refunds | list, detail |
| support_admin | messaging, support | list, detail |
| content_admin | catalog.* (all six resources above) | list, detail |
| analytics_admin | none today (it holds only `ai/read_usage`, and no audited resource maps to it) | list returns empty |
| non-admin / no `audit_logs/read` | — | `403 FORBIDDEN` |

No role, including super_admin, can update or delete an entry (AC-2). A new audited resource is
invisible to everyone but super_admin until it is added to the scope map.

### 3.8 Endpoints

Both routes are `app/api/v1/admin/audit-logs/**/route.ts` using `withApiRoute` and
`requireSession()`. They are read-only (`GET`), so they need no CSRF check and no `Idempotency-Key`.
They are rate-limited with the existing `default` bucket (`checkRateLimit('default', userId)`, 100/60s),
so no new domain is added. Both are registered in `lib/api/openapi-registry.ts`
(`npm run check:openapi-drift`).

| # | Method | Route | Permission | Success |
|---|---|---|---|---|
| L1 | `GET` | `/api/v1/admin/audit-logs` | `audit_logs/read` + scope | `200 PagedResponse<AuditLogDto>` |
| L2 | `GET` | `/api/v1/admin/audit-logs/{id}` | `audit_logs/read` + scope | `200 ApiResponse<AuditLogDto>` |

**L1 query parameters** (all optional; combined with AND):

- `actorUserId` (uuid), `resource`, `eventType`, `targetType`, `targetId`, `correlationId`
  (spec 004 format);
- `from`, `to` (ISO-8601 instants; `from` inclusive, `to` exclusive);
- `limit` / `offset` through spec 004's `parsePageParams` (default 20, max 100).

Results are ordered `created_at desc, id desc` and paged with `buildPage` (`limit`, `offset`,
`total`, `nextOffset`). Out-of-scope entries are excluded in SQL, so `total` counts only visible rows.

**Behaviour:**

- Every response carries spec 004's `correlationId` envelope field and header.
- A malformed uuid, correlation id or instant, or `from >= to`, is `400 VALIDATION_ERROR` with `field`.
- A `resource` filter outside the caller's scope is `403 FORBIDDEN`, logged by spec 004's
  `logForbiddenAttempt`.
- L2 with an unknown id, or an id outside the caller's scope, is `404 NOT_FOUND`. The two are
  indistinguishable, so ids cannot be probed (the spec 015/031 idiom).
- No session is `401 UNAUTHENTICATED`.

### 3.9 Types — `lib/types/audit.ts`

```typescript
export const AUDIT_ACTOR_TYPES = ['admin', 'user', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditLogDto {
  id: string;
  actorType: AuditActorType;
  actorUserId: string | null;        // null only for 'system'; an anonymized user keeps its id (spec 008)
  actorRoles: string[];              // every admin role held at the time; [] for a non-admin user
  eventType: string;                 // e.g. 'moderation.action_executed'
  resource: string;                  // scope key (§3.7)
  action: string;
  targetType: string | null;
  targetId: string | null;           // text: not always a uuid (e.g. 'queue')
  beforeValue: unknown | null;
  afterValue: unknown | null;
  reason: string | null;
  approvalRef: string | null;        // admin_actions.id (spec 009 AdminAction)
  approvalChain: unknown;            // as recorded by the caller (spec 009 AC-4 shape)
  isEmergencyBypass: boolean;
  correlationId: string | null;      // null ⇔ no originating API request (§3.5)
  createdAt: string;
}

export interface AuditLogQuery {
  actorUserId?: string; resource?: string; eventType?: string;
  targetType?: string; targetId?: string; correlationId?: string;
  from?: string; to?: string; limit?: number; offset?: number;
}
```

### 3.10 Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | malformed filter; `from >= to` |
| `401` | `UNAUTHENTICATED` | no session |
| `403` | `FORBIDDEN` | lacks `audit_logs/read`; `resource` filter outside scope |
| `404` | `NOT_FOUND` | unknown id, or id outside scope (L2) |
| `429` | `RATE_LIMITED` | `default` bucket |
| `500` | `INTERNAL_ERROR` | an audit **write** failed during an audited action (§3.11) |

### 3.11 Audit-write failure — MVP behaviour (decided)

**Today:**

- Domain modules commit their own transaction first and call `recordAdminAuditEvent()` afterwards,
  on a separate connection (`getDb()`).
- A failed audit write therefore surfaces as a `500`, but the domain change has already committed.
- The only exception is spec 035's MCP path, which audits **before** executing and blocks the tool
  on failure.

**Spec 039 preserves this ordering and changes none of those transactions.** Making every audit
write transactional would require each of the roughly 15 calling modules to pass its transaction
into the hook. That is a cross-spec change to every domain spec, out of scope here and recorded as
R-1.

Within that ordering, Spec 039 guarantees the following:

1. **Never swallowed.** `writeAuditEntry()` rethrows every failure, so the request fails with `500`
   exactly as it does today (specs 030/038 rely on this).
2. **Critical signal.** Before rethrowing, it emits one structured stdout line:
   `{"event":"audit.write_failed","severity":"critical","eventType",…,"correlationId",…}`. It
   contains no before/after values or reason. It is the p1 alert of master §117, collected by
   spec 046's pipeline.
3. **MCP stays audit-first:** a failed durable write blocks the tool (§3.6).

### Breaking-change check

- [x] No route or DTO changes shape.
- `recordAdminAuditEvent()` keeps its signature. It gains one optional field (`approvalRef`).
- Behaviour change: admin audit events are stored in `audit_logs` instead of `security_events`
  (§3.4). Consumers that read `security_events` for admin events are only the tests listed in X-6.

---

## 4. Data model changes

### Entity: `audit_logs` (spec 003 stub, **altered** by `0034` — never recreated)

The existing columns are kept: `baseColumns()` (`id`, `created_at`, `updated_at`, `version`, all required
by spec 003's schema-lint) and `actor_user_id uuid null` (FK → `users.id` `restrict`, indexed).
`updated_at`/`version` never change, because the triggers forbid `UPDATE`.

| Column (added) | Type | Notes |
|---|---|---|
| `actor_type` | `text not null` | CHECK `admin\|user\|system` |
| `actor_roles` | `jsonb not null default '[]'` | JSON array of role names. The repository has no `text[]` columns; jsonb follows `security_events.metadata`'s existing idiom |
| `event_type` | `text not null` | CHECK length 1..128 |
| `resource` | `text not null` | CHECK length 1..64 |
| `action` | `text not null` | CHECK length 1..64 |
| `target_type` | `text null` | |
| `target_id` | `text null` | CHECK `target_id is null or target_type is not null` |
| `reason` | `text null` | |
| `before_value` | `jsonb null` | |
| `after_value` | `jsonb null` | |
| `approval_ref` | `uuid null` | FK → `admin_actions.id` `restrict`, indexed |
| `approval_chain` | `jsonb not null default '[]'` | |
| `is_emergency_bypass` | `boolean not null default false` | |
| `correlation_id` | `text null` | CHECK `correlation_id is null or correlation_id ~ '^[A-Za-z0-9_-]{1,100}$'` |

**Constraints:**

- `audit_logs_actor_pairing_ck`: `(actor_type = 'system') = (actor_user_id is null)`.

**Indexes (in addition to the existing `actor_user_id` index):**

- `(created_at desc, id desc)`
- `(resource, created_at desc)`
- `(target_type, target_id)`
- `(correlation_id)`
- `(event_type, created_at desc)`
- `(approval_ref)` (the spec 003 FK-index rule)

No money columns. All timestamps are `timestamptz`.

**jsonb:** `actor_roles`, `before_value`, `after_value` and `approval_chain` must be registered in
spec 003's `ALLOWED_JSONB_COLUMNS` (`lib/db/schema-lint.test.ts`). That is X-5, authorized.

**Declaration:** `auditLogs` in `lib/db/schema.ts` is updated to match. `lib/db/schema-coverage.test.ts`
already lists `audit_logs`, so it needs no change.

### Immutability (AC-2) — triggers, not grants

**Why grants cannot work.** The application, the migrator (`lib/db/migrate.ts`) and the tests all
connect as one role, `apuriva`. That role is a PostgreSQL **superuser** and owns every table. No
migration contains a `GRANT` or `REVOKE`. Privileges are not checked for a superuser, so revoking
`UPDATE`/`DELETE` would have no effect. Introducing a separate application role is a
deployment-architecture change, out of scope, and recorded as S-2.

**The mechanism.** It follows the repository's established convention of `BEFORE UPDATE OR DELETE`
triggers raising `23514`: the existing `*_append_only_trg` / `*_immutable_trg` family, e.g.
`payments_status_history_append_only_trg` and `payment_attempts_append_only_trg` in `0017`.

```sql
CREATE OR REPLACE FUNCTION enforce_audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs rows are append-only (% rejected)', TG_OP USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_append_only_trg
  BEFORE UPDATE OR DELETE ON "audit_logs" FOR EACH ROW EXECUTE FUNCTION enforce_audit_logs_append_only();
CREATE TRIGGER audit_logs_no_truncate_trg
  BEFORE TRUNCATE ON "audit_logs" FOR EACH STATEMENT EXECUTE FUNCTION enforce_audit_logs_append_only();
```

The `TRUNCATE` trigger is added because row triggers do not fire on `TRUNCATE`. The test harness
(`test/db-reset.ts`) drops and recreates the database and never truncates, so it is unaffected.

**Documented limitation.** This is tamper-*resistant*, not tamper-*evident*. A superuser can still
`ALTER TABLE … DISABLE TRIGGER`, set `session_replication_role = replica`, or drop the table. Stronger
tamper evidence (hash chaining, external WORM storage) is a Security decision (S-1) and is not
built here.

### Migration

- **Files:**
  - `drizzle/0034_implement_audit_log.sql`;
  - hand-written `drizzle/0034_implement_audit_log_down.sql`;
  - journal entry index 34 in `drizzle/meta/_journal.json`, following the `0016`–`0033` pattern.
  - `0033_add_admin_moderation_fraud` is the latest shipped migration.
- **Up:**
  1. `ALTER TABLE audit_logs ADD COLUMN …` (the table above), then constraints, FK and indexes.
  2. The trigger function and both triggers.
  3. Seed the seven `audit_logs/read` rows with the `INSERT … SELECT … FROM (VALUES …)` idiom of `0028`/`0033`.
- **Safety:** nothing writes to `audit_logs` before this migration, so `NOT NULL` columns are added
  to an empty table. If rows unexpectedly exist, the migration fails loudly instead of inventing
  values. `0001_baseline` is not touched, which `npm run check:schema-checksum` confirms.
- **Backfill:** none. Existing admin events in `security_events` are neither copied nor deleted (§3.4).
- **Down (pre-launch only):**
  1. drop both triggers and the function;
  2. drop the added indexes, FK, constraints and columns, which returns the table to the spec 003 stub;
  3. delete exactly the seven `audit_logs/read` rows.

  Role assignments are untouched. **Running it destroys stored audit content**, so it must never run
  once real audit data exists. The file states this in its header.
- **Downtime:** none.
- **Checks:** `npm run check:schema-baseline`, `lib/db/schema-lint.test.ts` (with X-5),
  `lib/db/schema-coverage.test.ts` (unchanged).

### Retention, privacy and anonymized users

- **Retention:** entries have **no deletion path at all** in the MVP. No API, job or migration
  removes them. The retention period is a Legal decision (L-1). Master §75: "never delete required
  financial/audit records indiscriminately".
- **Deleted users:** spec 008 anonymizes a user **in place**. `users.id` survives; email, phone and
  password are cleared and the lifecycle becomes `deleted`. Because `actor_user_id` is a `restrict`
  FK, entries survive, still referencing the anonymized user id. The DTO exposes the id only, never
  contact fields.
- **PII in `before_value` / `after_value` / `reason`:** these hold whatever the calling module
  records. Today that is configuration values, lifecycle states, ids and admin-written reasons, and
  no caller records message bodies or contact data. Spec 039 adds **no redaction path**; the triggers
  forbid it. Whether an audit entry may ever be redacted, for example on a legal erasure request, is
  a Legal decision (L-2). If Legal requires it, a follow-up migration adds a narrowly allowed
  redaction write, as `messages_append_only_trg` permits one retention write.
- **Access:** scope-limited reads only (§3.7). Entries are never public and never part of a user's
  data export (spec 008 exports the user's own data, not the admin audit log).

---

## 5. UI states

**Route:** `app/admin/settings/audit-log/page.tsx`. It is linked from the settings hub
`app/admin/settings/page.tsx` (X-7), following the `ai-usage` and `mcp-tools` precedent.

**Components:** everything comes from `@/components`:

- `Table`, `Select`, `Input`, `FormField`, `Button`, `Badge`, `Card`, `Skeleton`, `EmptyState`,
  `ErrorState`, `Alert`.
- Styling uses tokens only (`app/styles/apuriva-tokens.css`).

**No new design-system component is created.** The design system has no diff or JSON component.
Before/after values are rendered as formatted JSON (`JSON.stringify(value, null, 2)`) in two labelled
`Card` panels ("Before" / "After") using a tokenized monospace style. A dedicated `DiffView` is
deliberately not added; if one is wanted later, it belongs to spec 002's design system first.

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` table rows |
| **Empty** | `EmptyState` "No matching audit entries" |
| **Error** | `ErrorState` with retry; filter values are preserved |
| **Forbidden** | `403`: `Alert` "You don't have access to the audit log" |
| **Success** | `Table` columns: time, actor (type badge + id), roles, event, target, correlation id. Selecting a row loads L2 into a detail `Card` showing reason, approval reference and chain, and the before/after panels. Pagination is "Next"/"Previous" driven by `nextOffset`. |

The page offers no edit or delete control. Filters: resource, event type, actor user id, target
type/id, correlation id, from/to. Every filter is a text/date `Input`.

**Implementation note:** resource is a text `Input`, not a `Select` limited to the caller's visible
resources. L1/L2 are the only endpoints this spec defines, and spec 004's paged envelope carries no
scope. The server enforces scope: an out-of-scope resource returns `403`, which the page shows as an
"Outside your scope" alert while keeping every filter as typed.

The design system has no monospace token, so the before/after JSON uses the tokenized sans face in
a `pre` block that preserves the indentation.

---

## 6. Test plan

Tests are colocated under `lib/audit/` and `app/api/v1/admin/audit-logs/`. Integration tests run on the
isolated `*_test` database (`vitest.config.ts`, `test/db-reset.ts`). Suites that register the MCP
sink restore the default with `resetMcpAuditSinkForTests()` in `afterEach`.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | input→row mapping; `actor_type` derivation; `approval_ref` from `approvalRef` / `approvalChain.adminActionId`; correlation precedence (explicit > context > null); failure emits `audit.write_failed` and rethrows | `lib/audit/write.test.ts` |
| **Unit** | request context set by `withApiRoute`; absent outside a request | `lib/audit/request-context.test.ts` |
| **Unit** | scope map: every audited resource maps to a seeded read permission; unmapped → super_admin only | `lib/audit/scope.test.ts` |
| **Boundary** | only `lib/audit/write.ts` inserts into `audit_logs`; only the hook and the MCP sink call it; no module issues `UPDATE`/`DELETE audit_logs`; `lib/admin-rbac/audit.ts` no longer imports `recordSecurityEvent`; nothing under `lib/mcp` names the audit table | `lib/audit/boundary.test.ts` |
| **Hook (AC-1)** | `recordAdminAuditEvent()` writes one complete row; spec 009 flow sets `approval_ref`; emergency bypass flagged | `lib/audit/record-admin-audit-event.integration.test.ts` |
| **Immutability (AC-2)** | `UPDATE`, `DELETE`, `TRUNCATE` all rejected with `23514`; no write verb exists on either route | `lib/audit/immutability.integration.test.ts` |
| **Separation (AC-3)** | an admin action writes an `audit_logs` row and **no** `security_events` row; an auth/privacy event writes `security_events` only | `lib/audit/separation.integration.test.ts` |
| **Access (AC-4)** | every role in the §3.7 matrix; `403` without permission or for an out-of-scope `resource` filter; `404` for an out-of-scope id; analytics_admin sees an empty list | `app/api/v1/admin/audit-logs/access.integration.test.ts` |
| **Coverage (AC-5)** | representative obligations end to end: 009 AC-4 (refund override: created → approved → executed, `approval_ref`); 009 AC-5 (role assignment); 023 AC-9 (no-show resolution); 030 AC-3 (safety evidence read, correlation id); 031 AC-3 (dispute resolution); 032 AC-4 (priority old/new); 037 AC-5 (matching weights before/after); 038 AC-4 (ban with approval chain) | `lib/audit/coverage.integration.test.ts` |
| **MCP (AC-5, 035 AC-1)** | durable sink registered by `registerAuditIntegration()`; returns the row id as `auditId`; a failing write blocks the tool; no tool input stored | `lib/audit/mcp-sink.integration.test.ts` |
| **Correlation (AC-6)** | through a real route: caller `x-correlation-id` stored verbatim; generated id equals the response envelope's; a call outside any request stores `null` | `lib/audit/correlation.integration.test.ts` |
| **Routes** | envelopes, pagination (`limit`/`offset`/`nextOffset`), every filter, `400`s, ordering, rate limit, OpenAPI registration | `app/api/v1/admin/audit-logs/routes.integration.test.ts` |
| **Migration** | up/down file checks; columns, constraints, triggers; seven seeded permissions; baseline untouched | `lib/audit/migration.integration.test.ts` |
| **Page** | loading, empty, error-with-retry (filters kept), forbidden, success, detail with before/after | `app/admin/settings/audit-log/page.test.tsx` |
| **Regression (X-6)** | the re-pointed suites pass with unchanged assertions | the X-6 files |

**Traceability:** §2.1. **Coverage:** ≥80% statements, branches, functions and lines on new code
under `lib/audit/**`.

**Static checks:** `npm run typecheck`, `npm run check:env` (no new env vars), `npm run check:schema-baseline`,
`npm run check:openapi-drift`.

**Not covered, deliberately:** operational/stdout logging (spec 046).

---

## 7. Out of scope

- Operational/structured application logging (spec 046). Stdout lines stay as they are.
- Analytics on audit data (spec 040).
- Transactional audit writes inside each domain transaction (R-1).
- A separate least-privilege database role (S-2); external WORM or hash-chained tamper evidence (S-1).
- Moving or deleting historical admin events already in `security_events` (§3.4).
- Auditing admin **reads of the audit log itself**. No acceptance criterion requires it.
- Persisting spec 004's `api.forbidden` attempts (they stay stdout).
- Building the admin provider-approval flow or an admin-editable commission (§2.2).

---

## 8. Dependencies, decisions, risks

### Dependencies

| Class | Items |
|---|---|
| **Approved and shipped, used as-is** | 003, 004, 005, 008, 009, 010, 017, 022, 023, 024, 025, 027, 029, 030, 031, 032, 035, 037, 038 |
| **Draft, not required** | 040, 041, 046 |
| **Authorized cross-spec changes** | X-1 … X-8 (below) |
| **Blocking** | none |

### Authorized cross-spec implementation changes (X-list)

These are the only edits Spec 039 may make outside its own new files. Each is additive or a pure
storage re-point, and each owning spec keeps ownership of its file.

| # | Owning spec | File | Exact change |
|---|---|---|---|
| X-1 | 004 | `lib/api/handler.ts` `withApiRoute` | Run `handler(request, correlationId)` inside `runWithRequestContext({ correlationId }, …)` from `lib/audit/request-context.ts`. No other change; signature unchanged. |
| X-2 | 009 | `lib/admin-rbac/audit.ts` `recordAdminAuditEvent()` | Replace the `recordSecurityEvent(...)` call with `writeAuditEntry(...)` per §3.2. Add optional `approvalRef?: string \| null` to `AdminAuditEventInput`. The existing fields and signature are unchanged. |
| X-3 | 009 | `lib/admin-rbac/actions.ts` | Pass `approvalRef: <admin_actions.id>` on `admin_rbac.action_created`, `action_approved`, `action_rejected`, `action_executed` and `emergency_bypass_executed`. No logic change. |
| X-4 | 035 (integration) | `instrumentation.ts` | Call `registerAuditIntegration()` from `lib/audit/register.ts`. `lib/mcp/**` is **not** modified. |
| X-5 | 003 | `lib/db/schema-lint.test.ts` `ALLOWED_JSONB_COLUMNS` | Register `audit_logs: ['actor_roles', 'before_value', 'after_value', 'approval_chain']` with a spec 039 comment. |
| X-6 | 009, 010, 023, 025, 027, 029, 030, 031, 032, 037, 038 | the test files below | Re-point audit-event queries from `security_events` (`event_type`, `metadata->>…`) to `audit_logs` (`event_type` and the corresponding columns). **Assertions keep their meaning.** No test is weakened, deleted or skipped. |
| X-7 | admin settings hub | `app/admin/settings/page.tsx` | Add one link `{ href: '/admin/settings/audit-log', label: 'Audit log' }`. |
| X-8 | 038 | `lib/moderation/migration.integration.test.ts` | **Approved by the product owner during implementation.** The "is the next journal entry after 0032" assertion checked that `0033` was the *last* journal entry, which `0034` necessarily breaks. It now checks by position that `0033` immediately follows `0032`. Same meaning, not weakened. |

**X-6 files** (decided by the product owner, D-1: move, not dual-write):

- `app/api/v1/admin/audit.integration.test.ts` (009)
- `app/api/v1/catalog/audit.integration.test.ts` (010)
- `lib/no-show/no-show.integration.test.ts` (023)
- `lib/messaging/admin-access.integration.test.ts` (025)
- `lib/files/message-attachment.integration.test.ts` (025/027)
- `lib/reviews/media-authorization.integration.test.ts` (029)
- `lib/reviews/moderation.integration.test.ts` (029)
- `lib/safety/safety-test-support.ts` (030, audit-count helper)
- `lib/disputes/disputes-test-support.ts` (031, audit-count helper)
- `lib/support/lifecycle.integration.test.ts` (032)
- `lib/support/sla.integration.test.ts` (032)
- `lib/admin-dashboard/audit.integration.test.ts` (037)
- `lib/moderation/audit.integration.test.ts` (038)
- `lib/moderation/moderation-test-support.ts` (038)
- `e2e/admin-dashboard.spec.ts` (037) and `e2e/support.spec.ts` (032): **added and approved by the
  product owner during implementation**. The audit's search covered `*.test.ts` only, which missed
  these `e2e/*.spec.ts` files. Same query-source-only change.

Tests that read `security_events` for **security** events (`lib/ai/*`, `lib/notifications/marketing`,
`lib/payouts/payout-method-security`, `app/api/v1/auth/otp`, `lib/disputes/migration`) stay untouched,
because those events stay in `security_events` (§3.4).

**Not changed:**

- Every other spec's production code: all callers keep calling the hook (§3.3).
- `lib/mcp/**` and `lib/auth/security-event.ts`.
- Spec 030/031/037/038 code: their events move automatically through X-2. Where they pass no
  explicit correlation id, X-1's request context supplies it.
- Any other spec document (see §3.4 "Supersession").

**Shared registries Spec 039 appends to**, as every spec does:

- `lib/db/schema.ts` (the `auditLogs` declaration);
- `lib/api/openapi-registry.ts`;
- `drizzle/meta/_journal.json`.

### Decisions

| # | Decision |
|---|---|
| D-1 | **Move, not dual-write** (product owner). Admin events go only to `audit_logs`; the X-6 test re-pointing is authorized. |
| D-2 | **`audit_logs/read` for all seven roles, domain-scoped** (product owner). Scope per §3.7; `admin_rbac.role`, `mcp` and unmapped resources are super_admin only. |
| D-3 | Immutability by trigger (UPDATE, DELETE, TRUNCATE), because grants cannot work with the single superuser role (§4). |
| D-4 | `target_id` is nullable `text` (existing non-uuid targets); `actor_user_id` is nullable only for `system`; `actor_roles` is a jsonb array (the multi-role model). |
| D-5 | `approval_ref` → `admin_actions.id` (spec 009's `AdminAction` is the approval record; the decisions stay in `admin_action_approvals` and in `approval_chain`). |
| D-6 | Correlation: an AsyncLocalStorage request context set by `withApiRoute`; explicit > context > `null`; `null` means no originating API request. |
| D-7 | No `ai` actor type; MCP calls are the user's actions (`mcp.tool_call`). |
| D-8 | Audit-write failure: existing post-commit ordering preserved; never swallowed; `audit.write_failed` critical signal; MCP stays audit-first. |
| D-9 | The existing `recordAdminAuditEvent()` is the shared write path; no second public writer. |
| D-10 | UI uses existing components only; before/after as formatted JSON; no `DiffView`. |
| D-11 | No backfill; historical admin events stay in `security_events`. |

### Legal / Security decisions this spec cannot make (documented dependencies)

These do not block implementation, because the MVP behaviour is defined for each.

| # | Question | Owner | MVP behaviour until decided |
|---|---|---|---|
| L-1 | Audit retention period | Legal | Retained indefinitely; no deletion path exists |
| L-2 | Whether an audit entry may ever be redacted (e.g. an erasure request covering `reason`/`before`/`after`) | Legal | No redaction; the triggers forbid it |
| S-1 | Tamper evidence beyond triggers (hash chain, external WORM store) | Security | Triggers only; the superuser bypass is documented |
| S-2 | A separate, non-superuser application database role so that grants also apply | Security / Platform | Single `apuriva` role, as today |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | A domain change commits and its audit write then fails: the action happened but is unaudited | Pre-existing architecture, unchanged (D-8). Failure is never swallowed (`500`) and raises the `audit.write_failed` critical signal. Full transactional auditing would need every calling module to pass its transaction: a future cross-spec change. |
| R-2 | A superuser disables the triggers | Documented limitation; S-1/S-2 |
| R-3 | A new audited resource is invisible to its domain admins | Default-deny is intended; `scope.test.ts` fails when an audited resource has no mapping |
| R-4 | X-6 re-pointing accidentally weakens an assertion | X-6 permits only the query source to change; the review compares assertion counts before and after |
| R-5 | Approved specs 032/038 still say "`security_events`" | §3.4 records the supersession of storage location only; the documents are not edited |
| R-6 | Implementation touches files carrying unrelated uncommitted work (`instrumentation.ts`, `lib/db/schema-lint.test.ts`, `app/admin/settings/page.tsx`) | Only Spec 039's hunks are staged at commit |
| R-7 | Spec 009's `admin_rbac.post_action_reviewed` event is not in X-3's list, so its row has `approval_ref = null`. Its `approval_chain` does not carry an `adminActionId` either, so the link to the emergency-bypass `AdminAction` is only by target. | Implemented exactly as X-3 lists. Adding it is a one-line follow-up if wanted. |

---

## 9. Rollout

- **Feature flag:** none. The audit store is a compliance guarantee, not an optional feature.
- **Environment variables:** none added.
- **Order:**
  1. `0034` ships with the code.
  2. `registerAuditIntegration()` runs from `instrumentation.ts`.
  3. From deployment, `recordAdminAuditEvent()` writes to `audit_logs`.
- **Rollback:**
  1. Revert the deploy. The hook writes to `security_events` again and the MCP sink returns to stdout.
  2. Run `0034_…_down.sql` **only pre-launch**, because it destroys audit content.
- **Observability:**
  - `audit.write_failed` (severity `critical`, p1 per master §117);
  - write volume by `resource`;
  - L1/L2 latency.
