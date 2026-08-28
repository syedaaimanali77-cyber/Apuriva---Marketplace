# Spec: Security Sessions & Privacy Center

**File:** `docs/specs/2026-08-28-008-security-sessions-privacy-center.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §74–§77, §132.12, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §9.5, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 005 issues sessions but there is no user-facing way to view/manage them, no
account-deletion flow, and no data-export flow. Master spec §74–§77 requires users to control
profile visibility, sessions, security, and be able to export or delete their data, with
deletion never discarding legally/operationally required financial or audit records.

**Who is affected:** Every user exercising privacy rights; support/legal handling deletion or
export requests; finance/audit needing certain records retained regardless of a deletion
request.

**Why it matters now:** Needed early (Milestone 2) because every later transactional spec
(payments, disputes, audit) must respect "retain required records" as a constraint from day one,
not bolt it on retroactively.

**Success looks like:** A user can view active sessions and log any/all of them out, enable 2FA,
export their permitted personal data asynchronously, and request account deletion that goes
through a grace period, resolves active bookings, and anonymizes personal data while preserving
required financial/audit records.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a logged-in user **When** they view Security Sessions **Then** they see all active sessions with approximate device/location and can log out any single device or all devices |
| AC-2 | **Given** a user logs out "all devices" **When** confirmed **Then** every session except (optionally) the current one is invalidated server-side immediately |
| AC-3 | **Given** a user requests data export **When** submitted **Then** an asynchronous job generates an export containing only their own profile, bookings, reviews, permitted messages, preferences, and receipts — never other users' data or internal ranking/fraud signals |
| AC-4 | **Given** a user requests account deletion **When** confirmed (with re-authentication) **Then** the account enters "Deletion Pending" with a grace period, active bookings are resolved or flagged, and after the grace period personal data is deleted/anonymized while required financial/audit records are retained |
| AC-5 | **Given** a sensitive action (payout method change, deletion, disabling 2FA) **When** attempted **Then** step-up re-authentication (from spec 005) is required regardless of session freshness |
| AC-6 | **Given** an admin **When** accessing another user's export/deletion request **Then** the access itself is audited (spec 039) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/users/me/sessions` | session | `200` `ApiResponse<SessionSummaryDto[]>` | |
| `DELETE` | `/api/v1/users/me/sessions/{id}` | session | `204` | logs out one device |
| `DELETE` | `/api/v1/users/me/sessions` | session + step-up | `204` | logs out all devices |
| `POST` | `/api/v1/users/me/data-export` | session + step-up | `202` `ApiResponse<{ exportRequestId }>` | async job |
| `GET` | `/api/v1/users/me/data-export/{id}` | session | `200` `ApiResponse<{ status, downloadUrl? }>` | signed, time-limited URL when ready |
| `POST` | `/api/v1/users/me/deletion` | session + step-up | `202` `ApiResponse<{ gracePeriodEndsAt }>` | starts deletion pending state |
| `POST` | `/api/v1/users/me/deletion/cancel` | session | `200` | cancels pending deletion within grace period |
| `PATCH` | `/api/v1/users/me/mfa` | session + step-up | `200` | enable/disable 2FA |

### Request and response types

```typescript
// packages/types/src/privacy.ts
export interface SessionSummaryDto {
  id: string;
  deviceLabel: string;
  approxLocation: string | null;
  lastActiveAt: string;
  isCurrent: boolean;
}

export interface DataExportStatusDto {
  status: 'pending' | 'processing' | 'ready' | 'failed';
  downloadUrl?: string;
  expiresAt?: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `STEP_UP_REQUIRED` | sensitive action attempted without fresh re-authentication |
| `409` | `DELETION_ALREADY_PENDING` | duplicate deletion request |
| `422` | `ACTIVE_BOOKING_BLOCKS_DELETION` | deletion requires booking resolution first |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Session` | reuse (spec 005) | add `revoked_reason text nullable` |
| `User` | extend | `lifecycle_status text` (Active/Restricted/Suspended/Banned/Deletion Pending, master spec §67), `deletion_requested_at timestamptz nullable`, `deletion_grace_ends_at timestamptz nullable` |
| `FileAsset` | reuse (spec 027) | export files stored as private, signed-URL, time-limited assets |

A new background job (`packages/database` + `apps/worker`) handles export generation and the
deletion grace-period sweep — deletion itself is enforced server-side on a schedule, never
purely client-triggered.

### Migration

- **Name:** `AddDeletionAndExportFields`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

This spec **is** the retention/privacy mechanism. Deletion anonymizes personally identifying
fields on `User`/`CustomerProfile`/`ProviderProfile` but retains `Payment`, `Payout`, `Refund`,
`AuditLog` records required for financial/legal purposes, keyed to an anonymized user reference
rather than deleted outright (master spec §75).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | sessions list skeleton; export/deletion status polls with a spinner + "this may take a few minutes" copy |
| **Empty** | N/A (always at least the current session) |
| **Error** | export failure shows retry; deletion blocked by active booking shows which booking and a link to resolve it |
| **Success** | session logout confirms inline; deletion request shows grace-period end date and a cancel option |

Deletion and "log out all devices" are destructive/high-risk actions requiring explicit
confirmation dialogs (master spec §87) with the consequence stated plainly before confirming.

**Route(s):** `apps/web/app/account/privacy-security`
**Shared components used/added:** `packages/ui` `ConfirmDialog`, `Table` (sessions list)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | export scoping (excludes other users' data, internal signals) | `apps/api/privacy/**/*.test.ts` |
| **Integration** | full deletion lifecycle: request → grace period → sweep → anonymization, financial records retained | `apps/api/privacy/*.integration.test.ts` |
| **Component** | sessions list, deletion confirmation flow | `apps/web` (Testing Library) |
| **E2E** | user exports data, downloads it; user requests deletion, cancels within grace period | `apps/web-e2e/privacy-center.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-2 | `apps/api/privacy/sessions.integration.test.ts::logs out all devices` |
| AC-3 | `apps/api/privacy/export.integration.test.ts::excludes other users data` |
| AC-4 | `apps/api/privacy/deletion.integration.test.ts::retains financial records after anonymization` |
| AC-5 | `apps/api/privacy/step-up.integration.test.ts::blocks without fresh reauth` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The specific legal retention periods per record type — those are
a policy input (§8) not hard-coded logic invented here.

---

## 7. Out of scope

- 2FA/MFA *setup* mechanics beyond enable/disable toggle (TOTP enrollment UX detail is part of
  spec 005's authentication surface).
- Marketing-preference management (spec 026's notification-preferences scope, not this spec's).
- Profile-visibility granularity beyond what's needed for privacy center controls (detailed
  visibility rules belong to the profile specs themselves, e.g. 006, 019).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact grace-period length before deletion executes | Legal/Product | Open — default recommendation 14 days, confirm |
| 2 | Which record types are legally required to survive deletion in Pakistan and future markets | Legal | Open — must be confirmed before AC-4 ships to production |

---

## 9. Rollout

- **Feature flag:** none — privacy rights are not optional to expose.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; in-flight deletion sweeps are idempotent and safe to pause/resume.
- **Observability:** deletion/export request volume and failure rate alerted (master spec §117).
