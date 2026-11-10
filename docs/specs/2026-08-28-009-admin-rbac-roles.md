# Spec: Admin RBAC & Roles

**File:** `docs/specs/2026-08-28-009-admin-rbac-roles.md`
**Status:** Approved
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
review. This spec owns the RBAC authorization/approval **framework** — role assignment, server-side
permission resolution, the risk-tiered approval lifecycle, and the emergency-bypass contract.
It does not implement any business operation (refunds, bans, payouts, etc.); those remain owned
by their domain specs, which declare a `(resource, action, risk_tier)` and call into this
framework before executing.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** an admin with only the Support role **When** they attempt a Finance-scoped action (e.g. issue a refund) **Then** the backend returns `403 FORBIDDEN`, regardless of any frontend menu visibility |
| AC-2 | **Given** a high- or critical-risk action **When** one admin initiates it **Then** the framework creates an `AdminAction` in `Pending` status, the owning domain action does not execute, and it remains pending until a second, different, authorized admin approves it |
| AC-3 | **Given** a critical action executed via the emergency-bypass path (only where the owning domain has declared that action bypass-eligible) **When** it executes without waiting for the normal second-admin approval **Then** it enters a persistent `PostActionReviewRequired` state and cannot transition to a closed/terminal state until the required review is recorded |
| AC-4 | **Given** any admin action **When** performed **Then** it is recorded to the audit log (spec 039) with actor, role, action, target, reason, and approval chain — where "approval chain" means: no approval records for actions that did not require approval; the initiator plus every approval/rejection decision for actions that did; and the emergency-bypass marker plus post-action-review outcome where applicable |
| AC-5 | **Given** the Super Admin role **When** assigning or revoking roles for other admins, including `super_admin` itself **Then** the operation is permission-scoped and audited (not universally available to every admin), and the system prevents an admin from revoking their own last `super_admin` assignment or otherwise leaving zero remaining Super Admins, absent a separately defined recovery mechanism |

---

## 3. API contract

This spec owns role-management and approval-decision endpoints, plus the framework contract that
domain-owned business-action endpoints must call into. It does not define a generic business-action
endpoint — each domain spec (e.g. 022 refunds, 024 payouts, 038 moderation) owns its own endpoint
and invokes the framework described in §3.1 before executing.

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/roles` | admin (Super Admin) | `200` `ApiResponse<AdminRoleDto[]>` | lists the seven canonical roles |
| `POST` | `/api/v1/admin/users/{userId}/roles` | admin (Super Admin) | `200` | role-management: assigns a role to an admin |
| `DELETE` | `/api/v1/admin/users/{userId}/roles/{role}` | admin (Super Admin) | `204` | role-management: revokes a role; rejects if this would leave the target as, or the platform with, zero remaining `super_admin` holders where the target is the last one |
| `POST` | `/api/v1/admin/approvals/{actionId}/approve` | admin (second, distinct, authorized approver) | `200` `ApiResponse<ApprovalDto>` | operates on an existing `AdminAction`; rejects if same admin who initiated, if the approver lacks the required scope, or if the action is not in `Pending` status |
| `POST` | `/api/v1/admin/approvals/{actionId}/reject` | admin (second, distinct, authorized approver) | `200` | operates on an existing `AdminAction`; same eligibility rules as approve |
| `GET` | `/api/v1/admin/approvals/pending` | admin (scoped to their role) | `200` `PagedResponse<PendingApprovalDto>` | |
| `POST` | `/api/v1/admin/actions/{actionId}/post-action-review` | admin (authorized per the owning domain's declared review scope) | `200` | records the mandatory post-action review for an emergency-bypass action; transitions `PostActionReviewRequired` → `PostActionReviewed` |
| `GET` | `/api/v1/admin/actions/pending-review` | admin (scoped to their role) | `200` `PagedResponse<PendingReviewDto>` | lists `AdminAction`s in `PostActionReviewRequired` |

### 3.1 Framework contract: authorization, initiation, and execution

Every domain action that touches an admin-gated `(resource, action)` pair calls into this
framework rather than checking role membership itself:

1. **Resolve permission.** The framework resolves whether the authenticated admin holds a
   `Permission` matching `(resource, action)` and reads its declared `risk_tier`. If no matching
   permission exists for any of the admin's roles, the call fails `403 FORBIDDEN` (AC-1) — this
   check is always server-side; the frontend may hide menu items for out-of-scope actions but is
   never authoritative.
2. **Low/medium risk.** If authorized, the framework permits the owning domain action to proceed
   immediately. No `AdminAction`/`AdminActionApproval` rows are created unless the owning domain
   explicitly declares otherwise; an audit event is still emitted per §3.1.4 with an empty
   approval chain.
3. **High/critical risk.** If authorized, the framework creates an `AdminAction` in `Pending`
   status instead of permitting execution. The owning domain action MUST NOT execute until that
   `AdminAction` reaches `Approved` and is then transitioned to `Executed` by the domain action
   completing (§4). Attempting to perform a high/critical action directly, without going through
   this flow, fails `422 APPROVAL_REQUIRED`.
4. **Audit emission.** Every resolution outcome (permitted, denied, pending-approval created,
   approved, rejected, executed, emergency-bypassed, post-action-reviewed) emits the audit event
   data spec 039 requires (actor, role, action, target, reason, approval chain). This spec is
   responsible for producing that data; spec 039 owns the audit-log implementation, storage,
   retention, and admin access to it.

Effective permissions after a role change (assignment or revocation) apply to subsequent
authorization checks according to the application's existing session/cache invalidation
mechanism; this spec does not prescribe a specific caching implementation.

### 3.2 Emergency-bypass contract

- Emergency bypass is available only for a critical action that its owning domain spec has
  explicitly declared bypass-eligible. This spec does not make any action bypass-eligible by
  default.
- Invocation requires: an authenticated admin authorized for the `(resource, action)` per §3.1
  step 1, an explicit `reason`, and an explicit emergency-bypass marker on the request.
- On invocation, the framework creates the `AdminAction` directly in `PostActionReviewRequired`
  status (skipping `Pending`/`Approved`) and permits the domain action to execute without waiting
  for a second admin's approval.
- The `AdminAction` remains in `PostActionReviewRequired` until a `post-action-review` is
  recorded (§3, `POST /admin/actions/{actionId}/post-action-review`); it cannot be silently closed
  or reach a terminal state before that.
- Which roles may invoke bypass for a given action, how the bypass window is time-boxed, and any
  other business conditions remain Security/Product/domain-owned and must be declared by the
  owning domain spec before that domain's actions may use this path. This spec defines only the
  mechanics above.

### Request and response types

```typescript
// lib/types/admin-rbac.ts
export type AdminRole =
  | 'super_admin' | 'operations_admin' | 'support_admin'
  | 'finance_admin' | 'trust_safety_admin' | 'content_admin' | 'analytics_admin';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export type AdminActionStatus =
  | 'Pending' | 'Approved' | 'Rejected' | 'Executed'
  | 'PostActionReviewRequired' | 'PostActionReviewed';

export type ApprovalDecision = 'approved' | 'rejected';

export interface PendingApprovalDto {
  id: string;
  resource: string;
  actionType: string;
  riskTier: RiskTier;
  initiatedBy: string;
  initiatedAt: string;
  targetSummary: string;
  reason: string;
}

export interface PendingReviewDto {
  id: string;
  resource: string;
  actionType: string;
  initiatedBy: string;
  executedAt: string;
  targetSummary: string;
  reason: string;
  isEmergencyBypass: true;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | admin lacks the required role/permission for this `(resource, action)` |
| `409` | `SELF_APPROVAL_NOT_ALLOWED` | the same admin who initiated attempts to approve/reject |
| `409` | `APPROVAL_NOT_ELIGIBLE` | approver lacks the required scope, or the `AdminAction` is not in `Pending` status (already approved, rejected, executed, or otherwise terminal) |
| `409` | `LAST_SUPER_ADMIN` | a role revocation would leave zero remaining `super_admin` holders |
| `422` | `APPROVAL_REQUIRED` | a high/critical-risk action was attempted directly instead of via the approval (or declared emergency-bypass) flow |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `AdminProfile` | new | `id uuid pk`, `user_id uuid fk->User unique`, `created_at`, `updated_at`, `version` |
| `Role` | new | `id uuid pk`, `name text unique` (one of the seven canonical roles, §4.1) |
| `Permission` | new | `id uuid pk`, `role_id uuid fk->Role`, `resource text`, `action text`, `risk_tier text` (low/medium/high/critical) |
| `AdminAction` | new | `id uuid pk`, `admin_id uuid fk->AdminProfile` (initiator), `resource text`, `action_type text`, `risk_tier text` (high/critical only — low/medium actions do not create a row, §3.1), `status text` (Pending/Approved/Rejected/Executed/PostActionReviewRequired/PostActionReviewed), `reason text`, `target_type text`, `target_id text`, `is_emergency_bypass boolean default false`, `post_action_review_by uuid fk->AdminProfile nullable`, `post_action_reviewed_at timestamptz nullable`, `post_action_review_notes text nullable`, `created_at`, `updated_at`, `version` |
| `AdminActionApproval` | new | `id uuid pk`, `admin_action_id uuid fk->AdminAction`, `approver_admin_id uuid fk->AdminProfile`, `decision text` (approved/rejected), `decided_at timestamptz` |

Every later admin-override endpoint (refunds, bans, payout intervention) routes through this
framework when its declared `risk_tier` is `high` or `critical`, per master spec §70; the
`AdminAction` created for it is scoped to that domain's `(resource, action_type)`.

### 4.1 Enums (canonical values)

| Enum | Values |
|---|---|
| `AdminRole` | `super_admin`, `operations_admin`, `support_admin`, `finance_admin`, `trust_safety_admin`, `content_admin`, `analytics_admin` |
| Risk tier | `low`, `medium`, `high`, `critical` |
| `AdminAction.status` | `Pending`, `Approved`, `Rejected`, `Executed`, `PostActionReviewRequired`, `PostActionReviewed` |
| `AdminActionApproval.decision` | `approved`, `rejected` |

### 4.2 `AdminAction` status transitions

```
Pending          -> Approved              (second, distinct, authorized admin approves)
Pending          -> Rejected              (second, distinct, authorized admin rejects)
Approved         -> Executed              (owning domain action completes execution)
(created directly in PostActionReviewRequired for an emergency-bypass action, per §3.2)
PostActionReviewRequired -> PostActionReviewed   (mandatory post-action review recorded)
```

`Rejected`, `Executed`, and `PostActionReviewed` are terminal. No further approval, rejection, or
execution may be recorded against an `AdminAction` once it is terminal (`409 APPROVAL_NOT_ELIGIBLE`
on `Pending`-only operations attempted against a non-`Pending` action). A domain spec that needs
additional terminal or error states for its own workflow may define them, provided these
invariants — single approval decision, no execution before approval (or declared bypass), no
silent close of a review-required action — are preserved.

### 4.3 Role seed data

The seven canonical roles are seeded exactly once, as data accompanying the schema migration:
`super_admin`, `operations_admin`, `support_admin`, `finance_admin`, `trust_safety_admin`,
`content_admin`, `analytics_admin`. `Role.name` is unique, so re-running the seed is a no-op.
This spec does not define the `Permission` rows mapping every business action to a role/risk-tier
— each domain spec declares its own `(resource, action, risk_tier)` mapping against this
framework (§7).

### Migration

- **Name:** `AddAdminRbacTables`
- **Reversible:** yes
- **Backfill required:** no (seed the 7 roles per §4.3)
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

`AdminAction`/`AdminActionApproval` (including emergency-bypass and post-action-review fields) are
audit-adjacent records, retained per audit-log policy (spec 039), never deleted on admin account
deletion.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | pending-approvals / pending-review list skeleton |
| **Empty** | "No approvals pending" / "No reviews pending" with context (not a dead end) |
| **Error** | approval action failure shows why (e.g. self-approval blocked, action no longer pending) and does not silently retry |
| **Success** | approval/rejection/review confirmed inline; the originating admin is notified of the outcome |
| **Post-action review pending** | emergency-bypass actions surface distinctly from normal approvals and cannot be dismissed without recording a review |

Admin UI is information-dense per master spec §3.7; role-gated menu items are hidden for
out-of-scope actions rather than shown-disabled with no explanation, except where showing the
existence of the action itself is useful context.

**Route(s):** `app/admin/roles`, `app/admin/approvals`, `app/admin/actions/review`
**Shared components used/added:** `components` `Table`, `Badge` (risk tier), `ConfirmDialog`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | permission resolution for `(resource, action)`; risk-tier classification; status-transition guards | `app/api/v1/admin-rbac/**/*.test.ts` |
| **Integration** | role-scoped 403s; two-admin approval flow; self-approval rejection; unauthorized-approver rejection; duplicate/terminal-action decision rejection; emergency-bypass creates `PostActionReviewRequired`; post-action review closes it; role assignment/revocation safeguards including last-super-admin protection | `app/api/v1/admin-rbac/*.integration.test.ts` |
| **Security/permission** | matrix test: every (role × action) pair produces the expected allow/deny | `app/api/v1/admin-rbac/matrix.integration.test.ts` |
| **E2E** | Support admin blocked from Finance action; two admins complete a high-risk approval; emergency bypass followed by mandatory review | `e2e/admin-rbac.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/admin-rbac/matrix.integration.test.ts` — role × action allow/deny matrix, incl. server-side permission resolution regardless of frontend menu state |
| AC-2 | `app/api/v1/admin-rbac/approvals.integration.test.ts::high/critical action becomes Pending and requires a second distinct authorized admin` |
| AC-3 | `app/api/v1/admin-rbac/emergency.integration.test.ts::emergency bypass executes then enters PostActionReviewRequired; cannot close without review` |
| AC-4 | `app/api/v1/admin-rbac/audit.integration.test.ts::emits actor/role/action/target/reason and correct approval chain for no-approval, approved, and emergency-bypass cases` |
| AC-5 | `app/api/v1/admin-rbac/roles.integration.test.ts::role assignment/revocation is Super-Admin-only, audited, and blocks removing the last super_admin` |

Additional integration coverage: unauthorized approver rejected (`APPROVAL_NOT_ELIGIBLE`);
duplicate/terminal approval attempts rejected; self-approval rejected (`SELF_APPROVAL_NOT_ALLOWED`).

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The specific business rules of what each domain spec classifies
as high/critical risk, and which of its critical actions (if any) are bypass-eligible — each
owning spec (022 refunds, 038 moderation, 024 payouts) declares its own `risk_tier` mapping and
bypass eligibility against this framework.

---

## 7. Out of scope

- The admin operations workspaces themselves (dashboards, queues) — spec 037.
- Business-level configuration UI (matching weights, fees) — spec 041.
- The audit-log implementation, storage, retention, and admin audit-log access itself — spec 039;
  this spec only produces the required audit-event data (§3.1.4).
- The specific `(resource, action, risk_tier)` mapping and bypass eligibility for any business
  operation (refunds, moderation, payouts, bans, etc.) — each domain spec declares its own against
  this framework and is responsible for invoking it before executing.
- Non-admin customer/provider account lifecycle states — owned by their respective
  domain/account-lifecycle specs, not this spec.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact mapping of which actions are low/medium/high/critical risk — master spec gives examples (§70) but not an exhaustive table | Product/Security | Open — each domain spec must declare its own risk tier per action in its §3 |
| 2 | Emergency-bypass eligibility, eligible roles, and time-boxing for any *specific* critical action | Security | This spec now defines the bypass mechanics (§3.2, invariants) — open item is narrowed to: each domain spec must explicitly declare which of its critical actions are bypass-eligible, by whom, and under what conditions, before using this path |
| 3 | Recovery mechanism for the "zero remaining Super Admins" case (e.g. break-glass process) | Security/Ops | Open — deliberately not defined by this spec; §4.2/AC-5 only require that normal role revocation cannot itself cause this state |

---

## 9. Rollout

- **Feature flag:** none — RBAC is required infrastructure, not optional.
- **Migration order:** schema + role seed data ships with code.
- **Rollback:** revert deploy; existing `AdminAction`/`AdminActionApproval` records remain valid.
- **Observability:** every admin action, approval decision, emergency bypass, and post-action
  review logged to audit (spec 039); alert on unusual approval-rejection rates and on any
  `AdminAction` remaining in `PostActionReviewRequired` beyond an operational SLA.
