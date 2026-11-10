# Spec: Security Sessions & Privacy Center

**File:** `docs/specs/2026-08-28-008-security-sessions-privacy-center.md`
**Status:** Approved
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

**Success looks like:** A user can view active sessions and log out a single device or all other
devices, toggle MFA on/off from one control (enrollment mechanics remain owned by spec 005),
export their permitted personal data asynchronously, and request account deletion that goes
through a grace period (blocked while active bookings remain unresolved), after which personal
data is anonymized while required financial/audit records are preserved.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a logged-in user **When** they view Security Sessions **Then** they see all of their own active sessions with a coarse/approximate device and location label (never precise GPS, street-level location, or raw IP) and can log out any single device or all other devices |
| AC-2 | **Given** a user logs out "all devices" **When** confirmed **Then** every session belonging to the user other than the current one is invalidated server-side immediately; the current session is never revoked by this action |
| AC-3 | **Given** a user requests data export **When** submitted **Then** an asynchronous job generates an export containing only their own profile, bookings, reviews, messages they are authorized to access, preferences, and receipts — never another user's data, internal ranking/fraud/risk signals, moderation/internal notes, credentials, tokens, or secrets |
| AC-4 | **Given** a user requests account deletion **When** confirmed (with fresh step-up re-authentication) **Then**, if the user has any active booking, the request is rejected with `422 ACTIVE_BOOKING_BLOCKS_DELETION` and no pending-deletion state is entered; otherwise the account enters "Deletion Pending" with a grace period, and after the grace period elapses personal data is deleted/anonymized while required financial/audit records are retained |
| AC-5 | **Given** a sensitive action (payout method change, deletion request, enabling/disabling MFA) **When** attempted **Then** fresh step-up re-authentication (the mechanism defined by spec 005) is required regardless of normal session freshness, and a missing, stale, or invalid step-up credential returns `403 STEP_UP_REQUIRED` |
| AC-6 | **Given** an admin **When** accessing another user's export or deletion request **Then** this spec exposes no admin-facing endpoint for that access — any such access is governed by, and audited under, spec 039 |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/users/me/sessions` | session | `200` `ApiResponse<SessionSummaryDto[]>` | only the caller's own sessions |
| `DELETE` | `/api/v1/users/me/sessions/{id}` | session | `204` | revokes one device belonging to the caller; an `{id}` that doesn't belong to the caller (including another user's session) returns `404`, never another user's session state |
| `DELETE` | `/api/v1/users/me/sessions` | session + step-up | `204` | revokes every session belonging to the caller **except the current one**; the current session is never revoked by this endpoint |
| `POST` | `/api/v1/users/me/data-export` | session + step-up | `202` `ApiResponse<{ exportRequestId }>` | async job scoped to the caller's own permitted records; if a non-terminal (`pending`/`processing`) export already exists for the caller, returns the existing `exportRequestId` instead of starting a duplicate job |
| `GET` | `/api/v1/users/me/data-export/{id}` | session | `200` `ApiResponse<DataExportStatusDto>` | `id` must belong to the caller; an export request belonging to another user returns `404`, never that user's status or `downloadUrl` |
| `POST` | `/api/v1/users/me/deletion` | session + step-up | `202` `ApiResponse<{ gracePeriodEndsAt }>` | starts deletion-pending state; rejected with `422 ACTIVE_BOOKING_BLOCKS_DELETION` if the caller has an active booking; rejected with `409 DELETION_ALREADY_PENDING` if the caller already has a pending deletion (no duplicate workflow is created) |
| `POST` | `/api/v1/users/me/deletion/cancel` | session | `200` `ApiResponse<{ lifecycleStatus: 'active' }>` | cancels the caller's own pending deletion; only valid while still within the grace period (before anonymization has started) |
| `PATCH` | `/api/v1/users/me/mfa` | session + step-up | `200` `ApiResponse<{ mfaEnabled: boolean }>` | toggles the Security Center's MFA on/off control only; enrollment (e.g. TOTP secret setup) is performed via spec 005's authentication surface, not this endpoint |

### Request and response types

```typescript
// lib/types/src/privacy.ts
export interface SessionSummaryDto {
  id: string;
  deviceLabel: string;
  /** Coarse only, e.g. "Karachi, Pakistan" derived server-side. Never a precise
   * GPS coordinate, street-level location, or the raw IP address. */
  approxLocation: string | null;
  lastActiveAt: string;
  isCurrent: boolean;
}

export interface DataExportStatusDto {
  status: 'pending' | 'processing' | 'ready' | 'failed';
  /** Private, signed, time-limited URL (spec 027 `FileAsset` contract). Present only
   * once `status` is `ready`, and only ever returned to the export's owner. */
  downloadUrl?: string;
  expiresAt?: string;
}
```

"Permitted messages" in an export means messages in conversations (spec 025) where the
requesting user is a participant — i.e. messages they are already authorized to read in the
product. Export generation must reuse the same authorization check as the messaging read path,
never a broader query.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `STEP_UP_REQUIRED` | sensitive action (logout-all, deletion, MFA toggle) attempted with a missing, stale, or invalid step-up credential |
| `404` | `NOT_FOUND` | session id, or data-export id, does not exist or does not belong to the authenticated user |
| `409` | `DELETION_ALREADY_PENDING` | deletion requested while the caller already has a pending deletion |
| `422` | `ACTIVE_BOOKING_BLOCKS_DELETION` | caller has at least one active booking; deletion is blocked until it's resolved (cancelled or completed) |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Session` | reuse (spec 005) | add `revoked_reason text nullable` |
| `User` | extend | `lifecycle_status text` (Active/Restricted/Suspended/Banned/Deletion Pending, master spec §67), `deletion_requested_at timestamptz nullable`, `deletion_grace_ends_at timestamptz nullable` |
| `FileAsset` | reuse (spec 027) — required dependency, not implemented here | export files stored as **private** assets, retrievable only through **signed, time-limited** URLs; this spec adds no storage fields of its own beyond referencing a `FileAsset` per export |

This spec adds no MFA/enrollment fields: the MFA on/off control (`PATCH /users/me/mfa`) reads
and writes the enrollment state owned and defined by spec 005 (e.g. its TOTP/`AdminProfile`-style
fields for the account type in question). Spec 008 does not define a second MFA mechanism or
its own MFA storage.

Export generation and the deletion grace-period sweep run as background jobs compatible with
the architecture's scheduled-job mechanism (Vercel Cron, per spec 001 §8). Required behavior,
not a specific implementation:

- Asynchronous and server-side only — never dependent on the client remaining open or on any
  client-triggered execution.
- Idempotent and retry-safe — re-running a job for the same export or deletion request must not
  produce duplicate artifacts, duplicate emails, or duplicate state transitions.
- Safe to pause and resume — a crashed or restarted job picks up outstanding work without
  re-doing already-completed steps or corrupting state.

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

### Audit

Two distinct kinds of events, both written through the platform's existing audit-logging
architecture (spec 039), not a bespoke mechanism of this spec's own:

- **User security/privacy actions** — a session revoked (single or all-other-devices), MFA
  toggled on/off, a data export requested, an account-deletion requested or cancelled — produce
  security/privacy audit events as required by that architecture, attributed to the acting user.
- **Admin access to another user's export/deletion request** — out of scope for this spec to
  expose (see §7 Out of scope) and, wherever such access exists in the admin surfaces defined by
  spec 039, it is explicitly and separately audited there, attributed to the accessing admin.

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
All session controls and confirmation dialogs must be fully keyboard-operable and expose
screen-reader-accessible names and state announcements (e.g. a session's revoked state, a
dialog's destructive intent, and loading/error/success transitions).

**Route(s):** `app/account/privacy-security`
**Shared components used/added:** `components` `ConfirmDialog`, `Table` (sessions list)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | export scoping (excludes other users' data, internal ranking/fraud/risk signals, moderation notes, credentials/tokens/secrets) | `app/api/v1/privacy/**/*.test.ts` |
| **Integration** | sessions list is scoped to the caller; single-session logout rejects another user's session id; logout-all revokes all but the current session; MFA enable/disable requires step-up and rejects without it; data-export ownership (`GET` on another user's export returns `404`) and retry/idempotency (repeat `POST` while pending returns the same `exportRequestId`); full deletion lifecycle: request → active-booking block → grace period → sweep → anonymization with financial records retained; deletion cancellation (own request only, only within grace period, rejected once anonymization has started); repeat deletion request while pending returns `409 DELETION_ALREADY_PENDING` | `app/api/v1/privacy/*.integration.test.ts` |
| **Component** | sessions list (incl. single/all-device logout controls), deletion confirmation flow, MFA toggle control, loading/error/success states | the application (Testing Library) |
| **E2E** | user exports data, downloads it; user requests deletion, cancels within grace period; user logs out all other devices and current session survives | `e2e/privacy-center.spec.ts` |
| **Accessibility** | session list and destructive confirmation dialogs (deletion, logout-all) are keyboard-operable with screen-reader-accessible names, and loading/error/success states are announced | `app/account/privacy-security/*.a11y.test.ts`, `e2e/privacy-center.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/privacy/sessions.integration.test.ts::lists only the caller's sessions with coarse location` |
| AC-2 | `app/api/v1/privacy/sessions.integration.test.ts::logs out all devices except current` |
| AC-3 | `app/api/v1/privacy/export.integration.test.ts::excludes other users data and internal signals` |
| AC-4 | `app/api/v1/privacy/deletion.integration.test.ts::retains financial records after anonymization` and `deletion.integration.test.ts::blocks deletion with active booking` |
| AC-5 | `app/api/v1/privacy/step-up.integration.test.ts::blocks without fresh reauth` |
| AC-6 | No test in this spec's own suite — AC-6 is specifically about *admin* access to another user's export/deletion request, and spec 008 exposes no admin-facing endpoint for that (§7 Out of scope). A user-vs-user ownership test (e.g. export/deletion `404` for another user's id) exercises this spec's own access control, not AC-6. Admin access to those records, and the audit event it must produce, is defined and tested entirely by spec 039's own test suite. |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The specific legal retention periods per record type — those are
a policy input (§8) not hard-coded logic invented here.

---

## 7. Out of scope

- MFA/2FA *enrollment* mechanics (TOTP setup, secret generation, recovery codes, MFA-pending
  login) — entirely owned by spec 005's authentication surface. This spec exposes only the
  Security Center's on/off toggle and its step-up-protected sensitive-action flow; it does not
  define, and must never grow into, a second MFA enrollment or authentication mechanism.
- Marketing/notification-preference management (spec 026's scope, not this spec's).
- Profile-visibility granularity (detailed visibility rules belong to the profile specs
  themselves — spec 006 user identity, spec 016 provider availability/service areas).
- An admin-facing endpoint for viewing or managing another user's export or deletion request.
  This spec is user-self-service only; any admin access to another user's export/deletion state
  is defined and audited by the admin/audit specifications, principally spec 039.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact grace-period length before deletion executes | Legal/Product | Implemented as a 14-day default, configurable server-side (not hardcoded in client logic). Legal/Product must confirm the final policy value before production launch; changing it is a config change, not a code change |
| 2 | Which record types are legally required to survive deletion in Pakistan and future markets | Legal | Open — must be confirmed before AC-4 ships to production |

---

## 9. Rollout

- **Feature flag:** none — privacy rights are not optional to expose.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; in-flight deletion sweeps are idempotent and safe to pause/resume.
- **Observability:** deletion/export request volume and failure rate alerted (master spec §117).
