# Spec: Admin RBAC & Roles

**File:** `docs/specs/2026-08-28-009-admin-rbac-roles.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §69–§70, §132.11, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §9.2, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No admin permission model exists. Master spec §69 defines seven admin roles (Super
Admin, Operations, Support, Finance, Trust & Safety, Content/Marketplace, Analytics) with
least-privilege scope, and §70 requires risk-tiered approval — some actions need a second
admin's sign-off ("four-eyes").

**Who is affected:** Every admin-facing spec (037–041) and every domain spec with an
admin-override path (refunds, moderation, disputes, payouts).

**Why it matters now:** Built early (Milestone 2) so every later admin-configurable rule has a
permission model to sit behind, even though the admin *workspaces* themselves are built late
(Milestone 11) — see `docs/workflow.md` dependency notes.

**Success looks like:** Admin accounts are assigned one or more of the seven roles; every
admin action checks role scope server-side; high-risk/critical actions require a second admin's
approval before executing, with the emergency-bypass path requiring mandatory post-action
review.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** an admin with only the Support role **When** they attempt a Finance-scoped action (e.g. issue a refund) **Then** the backend returns `403 FORBIDDEN`, regardless of any frontend menu visibility |
| AC-2 | **Given** a high-risk action (e.g. large refund, permanent ban) **When** one admin initiates it **Then** it remains pending until a second, different admin approves it |
| AC-3 | **Given** a critical emergency action taken via the bypass path **When** executed **Then** it is flagged for mandatory post-action review and cannot be silently closed without that review |
| AC-4 | **Given** any admin action **When** performed **Then** it is recorded to the audit log (spec 039) with actor, role, action, target, reason, and approval chain |
| AC-5 | **Given** the Super Admin role **When** assigning roles to other admins **Then** the assignment itself is a permission-scoped, audited action — not universally available to every admin |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/roles` | admin (Super Admin) | `200` `ApiResponse<AdminRoleDto[]>` | |
| `POST` | `/api/v1/admin/users/{userId}/roles` | admin (Super Admin) | `200` | assigns a role |
| `DELETE` | `/api/v1/admin/users/{userId}/roles/{role}` | admin (Super Admin) | `204` | revokes a role |
| `POST` | `/api/v1/admin/approvals/{actionId}/approve` | admin (second, distinct approver) | `200` `ApiResponse<ApprovalDto>` | rejects if same admin who initiated |
| `POST` | `/api/v1/admin/approvals/{actionId}/reject` | admin | `200` | |
| `GET` | `/api/v1/admin/approvals/pending` | admin (scoped to their role) | `200` `PagedResponse<PendingApprovalDto>` | |

### Request and response types

```typescript
// packages/types/src/admin-rbac.ts
export type AdminRole =
  | 'super_admin' | 'operations_admin' | 'support_admin'
  | 'finance_admin' | 'trust_safety_admin' | 'content_admin' | 'analytics_admin';

export interface PendingApprovalDto {
  id: string;
  actionType: string;
  riskTier: 'low' | 'medium' | 'high' | 'critical';
  initiatedBy: string;
  initiatedAt: string;
  targetSummary: string;
  reason: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | admin lacks the required role for this action |
| `409` | `SELF_APPROVAL_NOT_ALLOWED` | the same admin who initiated attempts to approve |
| `422` | `APPROVAL_REQUIRED` | a high/critical-risk action was attempted directly instead of via the approval flow |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `AdminProfile` | new | `id uuid pk`, `user_id uuid fk->User unique`, `created_at`, `updated_at`, `version` |
| `Role` | new | `id uuid pk`, `name text unique` (the seven roles) |
| `Permission` | new | `id uuid pk`, `role_id uuid fk->Role`, `resource text`, `action text`, `risk_tier text` |
| `AdminAction` | new | `id uuid pk`, `admin_id uuid fk->AdminProfile`, `action_type text`, `risk_tier text`, `status text` (Pending/Approved/Rejected/Executed), `reason text`, `target_type text`, `target_id text`, `created_at` |
| `AdminActionApproval` | new | `id uuid pk`, `admin_action_id uuid fk->AdminAction`, `approver_admin_id uuid fk->AdminProfile`, `decision text`, `decided_at timestamptz` |

Every later admin-override endpoint (refunds, bans, payout intervention) routes through
`AdminAction` when its declared `risk_tier` is `high` or `critical`, per master spec §70.

### Migration

- **Name:** `AddAdminRbacTables`
- **Reversible:** yes
- **Backfill required:** no (seed the 7 roles as a data migration)
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

`AdminAction`/`AdminActionApproval` are audit-adjacent records, retained per audit-log policy
(spec 039), never deleted on admin account deletion.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | pending-approvals list skeleton |
| **Empty** | "No approvals pending" with context (not a dead end) |
| **Error** | approval action failure shows why (e.g. self-approval blocked) and does not silently retry |
| **Success** | approval/rejection confirmed inline; the originating admin is notified of the outcome |

Admin UI is information-dense per master spec §3.7; role-gated menu items are hidden for
out-of-scope actions rather than shown-disabled with no explanation, except where showing the
existence of the action itself is useful context.

**Route(s):** `apps/web/app/admin/roles`, `apps/web/app/admin/approvals`
**Shared components used/added:** `packages/ui` `Table`, `Badge` (risk tier), `ConfirmDialog`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | permission-check resolution, risk-tier classification | `apps/api/admin-rbac/**/*.test.ts` |
| **Integration** | role-scoped 403s; two-admin approval flow; self-approval rejection | `apps/api/admin-rbac/*.integration.test.ts` |
| **Security/permission** | matrix test: every (role × action) pair produces the expected allow/deny | `apps/api/admin-rbac/matrix.integration.test.ts` |
| **E2E** | Support admin blocked from Finance action; two admins complete a high-risk approval | `apps/web-e2e/admin-rbac.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/admin-rbac/matrix.integration.test.ts` |
| AC-2 | `apps/api/admin-rbac/approvals.integration.test.ts::requires second admin` |
| AC-3 | `apps/api/admin-rbac/emergency.integration.test.ts::flags for post-review` |
| AC-4 | `apps/api/admin-rbac/audit.integration.test.ts::records actor role action target` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The specific business rules of what each domain spec classifies
as high/critical risk — each owning spec (022 refunds, 038 moderation, 024 payouts) declares its
own `risk_tier` mapping against this framework.

---

## 7. Out of scope

- The admin operations workspaces themselves (dashboards, queues) — spec 037.
- Business-level configuration UI (matching weights, fees) — spec 041.
- Customer/provider account lifecycle states (Restricted/Suspended/Banned for non-admins) —
  covered in spec 008 (customer) and referenced in provider specs, not this spec.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact mapping of which actions are low/medium/high/critical risk — master spec gives examples (§70) but not an exhaustive table | Product/Security | Open — each domain spec must declare its own risk tier per action in its §3 |
| 2 | Emergency-bypass path mechanics (who can invoke it, how it's time-boxed) | Security | Open |

---

## 9. Rollout

- **Feature flag:** none — RBAC is required infrastructure, not optional.
- **Migration order:** schema + role seed data ships with code.
- **Rollback:** revert deploy; existing `AdminAction` records remain valid.
- **Observability:** every admin action and approval decision logged to audit (spec 039);
  alert on unusual approval-rejection rates.
