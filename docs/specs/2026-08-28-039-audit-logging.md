# Spec: Audit Logging

**File:** `docs/specs/2026-08-28-039-audit-logging.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §72, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §9.4, §15, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Nearly every spec so far (009, 016, 021–024, 030, 031, 034–038) references "this is
audited" as if a shared audit mechanism already exists, but no `AuditLog` implementation has
been built — only the entity was stubbed in spec 003. Master spec §72 requires audit logs to
record actor, role, action, target, timestamp, before/after values, reason, approval, and
correlation ID, and to be a system distinct from ordinary application logs.

**Who is affected:** Every admin action across the platform; compliance/legal reviewing
platform history; engineers debugging "who changed this and when."

**Why it matters now:** It is specified once, late (per `docs/workflow.md`'s dependency notes),
because it's genuinely one shared mechanism every earlier admin-facing spec's acceptance
criteria already assume exists — this spec makes that assumption real and retroactively
satisfiable.

**Success looks like:** Every sensitive/admin action across the platform (provider approval,
commission change, refund, dispute resolution, booking intervention, permission change, service-
rule change, moderation, payout intervention) writes a structured, immutable audit entry,
queryable by admins with appropriate access, kept architecturally separate from operational
logs.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any sensitive/admin action listed in master spec §72's examples **When** it executes **Then** an `AuditLog` entry is written with actor, role, action, target, timestamp, before/after values (where applicable), reason, approval reference, and correlation ID |
| AC-2 | **Given** an audit log entry **When** written **Then** it is immutable — no API or admin role can edit or delete an existing entry |
| AC-3 | **Given** the audit log **When** compared to ordinary application logs **Then** it is a structurally separate store/table, not commingled with debug/operational logging |
| AC-4 | **Given** an admin querying audit logs **When** they lack sufficient role scope **Then** they see only entries relevant to their permission scope, never the full unrestricted log |
| AC-5 | **Given** every earlier spec's "this is audited" acceptance criterion (009 AC-4, 016 AC-uses, 021+ financial actions, 030 AC-3, 031 AC-3, 038 AC-4, etc.) **When** exercised end to end **Then** each produces a real, retrievable `AuditLog` entry through this shared mechanism |
| AC-6 | **Given** a correlation ID from an API request (spec 004) **When** an admin action within that request writes an audit entry **Then** the same correlation ID links the audit entry back to the originating request/trace |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/audit-logs` | admin (scoped by role) | `200` `PagedResponse<AuditLogDto>` | filterable by actor, action, target, date range |
| `GET` | `/api/v1/admin/audit-logs/{id}` | admin (scoped) | `200` `ApiResponse<AuditLogDto>` | |

### Request and response types

```typescript
// packages/types/src/audit.ts
export interface AuditLogDto {
  id: string;
  actorType: 'admin' | 'system' | 'ai';
  actorId: string;
  actorRole?: string;
  action: string;
  targetType: string;
  targetId: string;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string;
  approvalRef?: string; // links to AdminActionApproval (spec 009) where applicable
  correlationId: string;
  createdAt: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | admin queries outside their role's audit scope |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `AuditLog` | fully implement (stubbed spec 003) | `id uuid pk`, `actor_type text`, `actor_id uuid`, `actor_role text nullable`, `action text`, `target_type text`, `target_id uuid`, `before_value jsonb nullable`, `after_value jsonb nullable`, `reason text nullable`, `approval_ref uuid nullable`, `correlation_id text`, `created_at timestamptz` |

`AuditLog` is append-only at the database level (no `UPDATE`/`DELETE` grants on this table for
the application's normal database role — only `INSERT`/`SELECT`), enforced beyond
application-layer discipline (AC-2).

A shared `packages/database` helper (`writeAuditLog(...)`) is the single call path every prior
spec's "audited" acceptance criteria route through, rather than each module hand-rolling its
own audit insert.

### Migration

- **Name:** `ImplementAuditLogTable`
- **Reversible:** yes (pre-launch only — an audit table should never be dropped once real data
  exists)
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR; includes the restricted grants (no UPDATE/DELETE)

### Retention and privacy

Audit logs are retained per legal/compliance policy, independent of the underlying record's own
deletion (e.g. an audit entry about a since-deleted user's account survives, referencing the
anonymized user per spec 008).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | audit log table skeleton |
| **Empty** | "No matching audit entries" for a filtered, empty result |
| **Error** | query failure shows retry, preserves filter state |
| **Success** | entries shown with before/after diff rendering where applicable |

**Route(s):** `apps/web/app/admin/settings/audit-log`
**Shared components used/added:** `packages/ui` `Table`, `DiffView` (new, before/after JSON
rendering)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | `writeAuditLog` helper correctness, correlation-ID propagation | `packages/database/audit/**/*.test.ts` |
| **Integration** | representative sensitive actions from prior specs (refund, ban, dispute resolution, matching-weight change) each produce a correct audit entry | `apps/api/audit/*.integration.test.ts` |
| **Architecture** | database grants prevent UPDATE/DELETE on `audit_log` for the application role | CI schema-lint / migration-review check |
| **Security/permission** | admin audit-log query is scoped by role | `apps/api/audit/access.integration.test.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/audit/coverage.integration.test.ts::sensitive actions produce entries` |
| AC-2 | `packages/database/audit/immutability.test.ts::no update/delete grant` |
| AC-3 | schema review confirms `audit_log` is a distinct table, not mixed into request logs |
| AC-6 | `apps/api/audit/correlation.integration.test.ts::links back to originating request` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Ordinary application/operational logging (spec 046's
observability concern — explicitly a separate system per master spec §72).

---

## 7. Out of scope

- Structured application/operational logging infrastructure (spec 046).
- Analytics on audit data beyond basic filtering (spec 040, if ever needed — audit logs are a
  compliance record first, not an analytics source).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Audit log retention period for legal/compliance purposes | Legal | Open |
| 2 | Whether audit logs need write-once storage beyond DB grants (e.g. an external append-only log/WORM store) for stronger tamper-evidence | Security | Open — DB-level grant restriction is the MVP baseline |

---

## 9. Rollout

- **Feature flag:** none — required for every admin-facing spec's compliance guarantee.
- **Migration order:** schema ships with code; retroactively, every prior spec's admin
  endpoints must be updated to call `writeAuditLog` if not already wired (tracked as a
  cross-cutting follow-up during implementation of this spec).
- **Rollback:** revert deploy; existing audit entries are immutable and unaffected.
- **Observability:** audit-write failure rate is itself a critical alert (a failed audit write
  on a sensitive action should be treated as a p1, per master spec §117).
