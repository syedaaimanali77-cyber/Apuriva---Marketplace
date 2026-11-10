# Spec: Admin Moderation & Fraud/Abuse

**File:** `docs/specs/2026-08-28-038-admin-moderation-fraud-abuse.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §66, §67, §68, §69, §70, §79, §132 rule 11, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §9.2, [docs/workflow.md](../workflow.md); specs 003 (schema conventions), 004 (API envelope, error taxonomy, idempotency), 005 (sessions), 006/008 (lifecycle columns, deletion), 009 (RBAC, `AdminAction` approval), 015/018/019/020 (marketplace entry points), 017 (matching eligibility), 023 (cancellation), 024 (payouts, `PayoutHoldGate`), 026 (notifications), 027 (file assets and contexts), 030 (safety reports, `SafetyRestrictionGate`), 031 (appeal pattern), 033 (AI, flag idiom). **Draft specs, not required:** 039 (audit storage), 041 (feature flags). See §8.

---

## 1. Problem statement

**Today:** Both lifecycle columns already exist:

- `users.lifecycle_status` (spec 008): `active|restricted|suspended|banned|deletion_pending|deleted`.
- `provider_profiles.lifecycle_status` (spec 006): `draft|pending_verification|active|paused|restricted|suspended|banned`.

**Nothing in the repository writes `restricted`, `suspended` or `banned` to either column, and
nothing reads those values for the account.** Only spec 017's matching eligibility and spec 016's
availability summary read the provider column, and they treat only `active` as eligible.

Three shipped specs hold a slot open for this spec:

- **Spec 030** ships `SafetyRestrictionGate` (`lib/safety/restriction-gate.ts`). It is unregistered,
  so it refuses with `422 RESTRICTION_UNAVAILABLE`. Its column
  `safety_reports.restriction_moderation_action_id` has no foreign key.
- **Spec 024** ships `PayoutHoldGate` (`lib/payouts/ports.ts`). Its inert default never holds, and
  its comment says it is "spec 038's".
- **Spec 009** ships `authorizeAndInitiate()` / `decideAction()` / `executeApprovedAction()` and
  seeds no moderation `permissions` rows. Per its schema comment, each domain spec
  "(022 refunds, 038 moderation, ...) owns and inserts its own rows".

A spec 008 defect also lets moderation be evaded: `cancelDeletion()` unconditionally writes
`active`. So an account could leave a sanction by requesting deletion and then cancelling it.

Master §68 requires, for every moderation action:

- a reason;
- evidence where appropriate;
- an audit record;
- approval for high-impact actions;
- an appeal.

§79 requires rule-based safeguards and human review for serious enforcement. §79 and §132 rule 11
forbid a permanent ban based solely on an AI prediction.

**Who is affected:** Customers and providers subject to moderation. Trust & Safety, Operations and
Finance admins.

**Why it matters now:** Real marketplace activity exists. Admins resolving safety reports cannot
restrict anyone, and spec 024's fraud hold is inert.

**Success looks like:** A Trust & Safety admin can:

- warn, restrict, suspend or ban an account or a provider profile;
- cancel a booking for fraud;
- freeze a provider's payouts.

Every action:

- carries a reason and optional private evidence;
- goes through spec 009's four-eyes approval when it is high or critical risk;
- changes state only through the owning domain's authoritative path;
- is enforced at defined points (§3.5).

Beyond individual actions:

- A sanctioned account can leave that state **only** through Spec 038's reversal path.
- Rule-based fraud signals only feed a human review queue.
- The affected user can appeal, and a different admin decides the appeal.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a user (scope `account`) or a provider profile (scope `provider_profile`) **When** an authorized admin applies a `warning`, `restriction`, `suspension` or `ban` **Then**: (a) a non-empty `reason` is required, otherwise `400 VALIDATION_ERROR`; (b) private evidence can be attached (§3.8); (c) the lifecycle state changes **only** through `lib/moderation/lifecycle.ts` per §3.4, and the previous standing is recorded on the action; (d) the resulting standing is enforced at the §3.5 enforcement points; (e) no API route writes a lifecycle column. |
| AC-2 | **Given** a `suspension`, `ban`, `booking_intervention`, `payout_freeze` or any reversal **When** it is initiated **Then**: (a) spec 009's `authorizeAndInitiate()` creates a `Pending` `AdminAction`; (b) the moderation action is `pending_approval` and has no effect; (c) it takes effect only after a **different** authorized admin approves on spec 009's existing `POST /api/v1/admin/approvals/{actionId}/approve`, **and** the §3.2 execute route runs, which calls `executeApprovedAction()` first; (d) any initiation outcome other than `pending_approval` fails closed with `422 APPROVAL_REQUIRED`. |
| AC-3 | **Given** a fraud signal (rule-based sweep, or the AI seam when its flag is on) **When** it is recorded **Then**: (a) it creates only a `pending_review` `fraud_signals` row; (b) the signal modules cannot reach the action service or the lifecycle module (asserted at source level); (c) every moderation action has a human `initiated_by_admin_id` (`NOT NULL` FK); (d) a `ban` also needs a second admin (AC-2). No ban or suspension can result from a signal alone. |
| AC-4 | **Given** any moderation operation (§3.10 event list) **When** it succeeds **Then** an audit event is written through the existing `recordAdminAuditEvent()` (persisted to `security_events`). It carries: actor, actor roles, event type, target, reason, evidence file-asset ids, lifecycle before and after, and the spec 009 approval chain. No spec 039 capability is assumed. |
| AC-5 | **Given** an `active` `warning`, `restriction`, `suspension`, `ban` or `payout_freeze` **When** the target user files an appeal (reachable even while suspended or banned, §3.5) **Then**: (a) exactly one appeal per action is accepted; (b) it is decided by an admin holding `moderation/review_appeal` who is **neither the initiator nor the spec 009 approver**, otherwise `403 APPEAL_REQUIRES_DIFFERENT_ADMIN`; (c) `upheld` reverses the action through the §3.4 reversal service; (d) `denied` leaves it `active`. |
| AC-6 | **Given** an approved `booking_intervention` **When** it is executed **Then**: (a) Spec 038 calls spec 023's `cancelBooking()` with `actorRole: 'admin'`, idempotency key `moderation-<actionId>` and the approved `refundTreatment`; (b) specs 020/022/023 perform the transition, the cancellation record, the refund hand-off and the notifications; (c) no Spec 038 module issues `UPDATE bookings`; (d) a non-cancellable booking surfaces spec 023's own `422 BOOKING_NOT_CANCELLABLE`. |
| AC-7 | **Given** an approved, executed `payout_freeze` **When** spec 024's sweep reaches Pass C for that provider **Then**: (a) the registered `PayoutHoldGate` reports `{ held: true }`; (b) the `pending` batch does not close, and nothing is transferred or forfeited (spec 024 AC-15); (c) the earnings summary shows `payoutOnHold: true`; (d) reversing the freeze releases the hold on the next sweep. Payouts already `eligible`/`processing`, and failed-payout retries, are normatively **outside** the MVP freeze (§3.7). |
| AC-8 | **Given** spec 030's resolve route with `requestRestriction: true` **When** Spec 038 is installed **Then**: (a) the registered `SafetyRestrictionGate` creates exactly one account-scope `restriction` with `origin_safety_report_id` = that report, or returns it on retry; (b) the requesting admin must hold `moderation/restrict`, otherwise `403` and the report stays open; (c) its id is returned for spec 030 to store; (d) spec 030 is unmodified. |
| AC-9 | **Given** moderation evidence **When** anyone requests it **Then** it is served only through spec 027's file routes under the private context `moderation_evidence`. Only admins with `moderation/read` can read it, and each read is audited before disclosure. The target can never read it. It is never public, and it is under `legal_hold`. |
| AC-10 | **Given** any Spec 038 admin route **When** the caller lacks the §3.9 permission **Then** `403 FORBIDDEN`. Every mutating `POST` requires a session, CSRF and an `Idempotency-Key` header, otherwise `400 VALIDATION_ERROR`. |
| AC-11 | **Given** an account whose standing is `restricted`, `suspended` or `banned` **When** its owner requests account deletion and then cancels it **Then** the account returns to its moderation standing, **never** to `active`. Only Spec 038's reversal restores `active`. |

### 2.1 AC implementation matrix

| AC | Authoritative owner | API / service path | Data persisted | Approval | Audit | Named test |
|---|---|---|---|---|---|---|
| AC-1 | Spec 038 (`lib/moderation/lifecycle.ts`); enforcement points per §3.5 | M1 `POST /api/v1/admin/moderation-actions` → `initiateModerationAction()` → `applyLifecycleAction()` | `moderation_actions` row; `users.lifecycle_status` / `provider_profiles.lifecycle_status` | none for `warning`/`restriction` (medium) | `moderation.action_applied` with before/after | `lib/moderation/lifecycle.integration.test.ts`, `lib/moderation/standing-enforcement.integration.test.ts` |
| AC-2 | Spec 009 approval; Spec 038 execution | M1 → `authorizeAndInitiate()`; spec 009 approve route; M4 `…/{id}/execute` → `executeApprovedAction()` → effect | `admin_actions`, `admin_action_approvals`, `moderation_actions.admin_action_id` | four-eyes (high/critical) | spec 009 `admin_rbac.*` + `moderation.action_pending` / `moderation.action_executed` | `lib/moderation/approval.integration.test.ts` |
| AC-3 | Spec 038 (`lib/moderation/fraud-signals.ts`, `rules.ts`) | C1 `GET /api/v1/cron/fraud-signal-sweep` → `recordFraudSignal()`; triage F2/F3 | `fraud_signals` only | none; enforcement needs an M1 action by a human | `fraud_signal.*` | `lib/moderation/ai-safeguard.integration.test.ts`, `lib/moderation/boundary.test.ts` |
| AC-4 | Spec 009 helper `recordAdminAuditEvent()` | called from every Spec 038 service | `security_events` rows | — | all §3.10 events | `lib/moderation/audit.integration.test.ts` |
| AC-5 | Spec 038 (`lib/moderation/appeals.ts`) | U2 `POST /api/v1/moderation-actions/{id}/appeals`; A2 `POST /api/v1/admin/moderation-appeals/{id}/decide` → `reverseModerationAction()` | `moderation_appeals`; the reversal on `moderation_actions` | different-admin rule (initiator and approver excluded) | `moderation.appeal_filed`, `moderation.appeal_decided`, `moderation.action_reversed` | `lib/moderation/appeal.integration.test.ts` |
| AC-6 | Spec 023 `cancelBooking()` (effect); Spec 038 (decision) | M1 + M4 → `cancelBooking({ actorRole: 'admin', … })` | `moderation_actions` (`booking_id`, `refund_treatment`); spec 023's `booking_cancellations`; spec 020 history | four-eyes (`intervene_booking`, high) | `moderation.action_executed` + spec 009 events | `lib/moderation/booking-intervention.integration.test.ts` |
| AC-7 | Spec 024 sweep and summary (effect); Spec 038 gate | M1 + M4; `registerPayoutHoldGate()` from `registerModerationIntegration()` | `moderation_actions` (`payout_freeze`, `active`); no payout column | four-eyes (`freeze_payout`, high) | `moderation.action_executed` / `moderation.action_reversed` | `lib/moderation/payout-freeze.integration.test.ts` |
| AC-8 | Spec 038 gate; spec 030 caller | spec 030 S10 → `restrictFromSafetyReport()` | `moderation_actions.origin_safety_report_id`; spec 030's own cross-reference column | none (medium) | `moderation.action_applied` + spec 030's `safety.restriction_requested` | `lib/moderation/restriction-gate.integration.test.ts` |
| AC-9 | Spec 038 policy in spec 027 registry | spec 027 file routes, context `moderation_evidence` | `file_assets` (`legal_hold = true`) | — | `moderation.evidence_read` | `lib/moderation/evidence.integration.test.ts` |
| AC-10 | Spec 038 routes | all M/F/A/U routes | — | — | — | `lib/moderation/rbac.integration.test.ts`, `lib/moderation/routes.integration.test.ts` |
| AC-11 | Spec 008 `cancelDeletion()` (changed per X-6), reading Spec 038 `getAccountStanding()` | `POST /api/v1/users/me/deletion/cancel` | `users.lifecycle_status` | — | spec 008's existing events | `lib/moderation/deletion-loophole.integration.test.ts` |

---

## 3. API contract

### 3.1 Ownership and seams (verified against the repository)

| Concern | Owner | How Spec 038 uses it |
|---|---|---|
| Approval workflow (`admin_actions`, `admin_action_approvals`, approve/reject routes, self-approval refusal) | spec 009 | Reused unchanged. **Spec 009 is not modified.** |
| Durable moderation record | **Spec 038** | `moderation_actions` (§4). `AdminAction` is only the approval record of one step. |
| Lifecycle values | specs 006/008 (shape) | Values unchanged. Sanction values are written only by `lib/moderation/lifecycle.ts`. |
| Standing semantics and the standing read | **Spec 038** | `lib/moderation/standing.ts` (§3.5) |
| Enforcement points | specs 005, 008, 015, 018, 019, 020, 026 (their code) | Authorized cross-spec changes X-1…X-6 (§3.17) |
| Session revocation | spec 005 `revokeSession()` | Called as it ships. No change. |
| Booking cancellation | spec 023 `cancelBooking()` / spec 020 / spec 022 | Called, never re-implemented |
| Payout hold | spec 024 port `PayoutHoldGate` | Registered by Spec 038 |
| Safety restriction | spec 030 port `SafetyRestrictionGate` | Registered by Spec 038. Spec 030 stays the caller. |
| Evidence storage | spec 027 registry | New closed-vocabulary value `moderation_evidence` (spec 029/030/032 precedent) |
| Audit | spec 009 helper; spec 039 later | `recordAdminAuditEvent()` only |
| Notifications | spec 026 `notify()` | Two catalogue types (spec 030–032 precedent) |
| AI | spec 033 | Not called in MVP. The seam is behind a flag. |

### 3.2 How an approved action takes effect

`executeApprovedAction()` only moves `Approved → Executed`. Spec 038 therefore uses the two-phase
idiom that spec 024 ships in `lib/payouts/admin.ts`:

1. **Initiate** (M1).
   - Pre-generate the moderation action id.
   - Call `authorizeAndInitiate({ resource: 'moderation', action: <§3.9>, targetType: 'moderation_action', targetId: id, reason })`.
   - `permitted` (low/medium: `warning`, `restriction`): insert the row and apply the effect in one
     transaction, reaching `active`. Response `201`. `admin_action_id` stays null.
   - `pending_approval`: insert the row as `pending_approval` with `admin_action_id`. Response `202`.
   - For a type whose §3.9 tier is high/critical, any other outcome fails closed with
     `422 APPROVAL_REQUIRED`.
   - `emergencyBypass` is never passed.
2. **Approve/reject:** spec 009's existing routes and `app/admin/approvals`, unchanged.
3. **Execute** (M4). The caller must hold the same `moderation/<action>`.
   - If the `AdminAction` is already `Executed` but the row is still `pending_approval`, complete
     the crashed execution (spec 024's recovery rule).
   - Otherwise call `executeApprovedAction()`: `422 APPROVAL_REQUIRED` while `Pending`,
     `409 APPROVAL_NOT_ELIGIBLE` once `Rejected`/`Executed`.
   - Then apply the effect with `UPDATE … WHERE status = 'pending_approval'`. A second execution
     writes nothing and returns `409 MODERATION_STATUS_CONFLICT`.
4. **Rejection reconciliation.** Whenever the service touches a `pending_approval` row (execute,
   read, or a new initiation for the same target), it sets the row to `rejected` if the linked
   `AdminAction` is `Rejected`. This happens under the per-target lock.

Reversal follows the same two phases with spec 009 action `reverse`, recorded in
`reversal_admin_action_id` (M5/M6). An **upheld appeal** reverses directly (§3.12). The appeal
decision is itself the second-admin review.

### 3.3 Action catalogue (MVP) — normative

| `actionType` | Scope / target | Effect | Effect state | Appealable | Reversible |
|---|---|---|---|---|---|
| `warning` | `account` / `provider_profile` | record + notification; no lifecycle change | `active` | yes | yes |
| `restriction` | `account` / `provider_profile` | standing `restricted` | `active` | yes | yes |
| `suspension` | `account` / `provider_profile` | standing `suspended` (+ session revocation for `account`) | `active` | yes | yes |
| `ban` | `account` / `provider_profile` | standing `banned` (+ session revocation for `account`) | `active` | yes | yes |
| `booking_intervention` | `booking` | spec 023 cancellation | `executed` (one-shot) | no | no |
| `payout_freeze` | `provider_profile` | `PayoutHoldGate` holds | `active` | yes | yes |

**Content removal/hiding is deferred from the Spec 038 MVP (decided, not open).**

- The only authoritative content-removal path in the repository is spec 029's review moderation
  (`POST /api/v1/admin/reviews/{id}/resolve`), and it stays spec 029's.
- No other content entity (`provider_services`, portfolio `file_assets`) has a hidden or removed
  state or an owning removal path.
- Spec 038 does not create a second content-removal system.
- A future spec that owns listing/portfolio visibility will define it.

Master §68's escalation items:

- **Fraud escalation** is the signal `escalated` state (§3.6).
- **Safety escalation** already exists in spec 030 (`…/safety-reports/{id}/escalate`) and spec 031
  (`escalate-safety`).

### 3.4 Lifecycle transitions — `lib/moderation/lifecycle.ts`

This is the only module that writes `restricted`, `suspended` or `banned`. It exports
`applyLifecycleAction(tx, action)` and `reverseLifecycleAction(tx, action)`, which only
`lib/moderation/actions.ts` calls (boundary-tested).

**Severity:** `restricted` < `suspended` < `banned`.

**One lifecycle action per scope target.** Under `pg_advisory_xact_lock(hashtext('moderation:<scope>:<id>'))`:

- A new `restriction`/`suspension`/`ban` must be strictly more severe than the target's current
  active lifecycle action, otherwise `409 MODERATION_ACTION_CONFLICT`.
- A still-pending lifecycle action for that target (after reconciliation) also gives `409`.
- When the more severe action activates, the older one becomes `superseded`, with
  `superseded_by_moderation_action_id` set.

**Scope `provider_profile`**

- Writes `provider_profiles.lifecycle_status`. The account is untouched (spec 008 schema comment).
- Refused with `409 TARGET_NOT_MODERATABLE` when the profile is already `banned`.
- Records `previous_provider_lifecycle_status`.

**Scope `account`**

- Refused with `409 TARGET_NOT_MODERATABLE` when `users.lifecycle_status = 'deleted'`, or when the
  user holds an `AdminProfile`. Admin access is withdrawn through spec 009 role revocation, never
  by locking an admin's sessions (assumption A-3).
- Records `previous_user_standing`: the standing before this action (`active`, or the superseded
  action's standing), computed by `getAccountStanding()`.
- If `users.lifecycle_status` is one of `active|restricted|suspended|banned`, the new standing is
  written to it.
- If it is `deletion_pending`, the column is **not written**. The deletion flow keeps its state, and
  the standing is carried by the active action (§3.5, `getAccountStanding`).
- **Cascade:** if the user has a provider profile, the same standing is written to
  `provider_profiles.lifecycle_status` in the same transaction, recording its previous value.
  Matching reads only the profile.
- A `suspension` or `ban` becoming `active` **revokes every unrevoked session of the user** with
  spec 005's `revokeSession(id, 'moderation_suspension' | 'moderation_ban')`, after the transaction
  commits. The §3.5 session gate already refuses them from the commit onward, so revocation is
  defence in depth, not the enforcement.

**`warning`** writes nothing.

**Reversal** (appeal `upheld`, or M5/M6) applies only to `active` actions:

- Account column:
  - if it is `deletion_pending`, only the action row changes;
  - otherwise `UPDATE … SET lifecycle_status = previous_user_standing WHERE lifecycle_status = <this action's standing>`.
- The provider column is handled the same way against `previous_provider_lifecycle_status`.
- A mismatch returns `409 LIFECYCLE_STATE_CHANGED` and writes nothing.
- If this action had superseded another, that one returns to `active`, and its standing is what gets
  restored.
- **This is the only path by which a sanctioned account or profile returns to `active`.**

### 3.5 Account standing — authoritative semantics and enforcement (resolves OQ-1, OQ-2)

`lib/moderation/standing.ts` is a leaf module. It imports only `@/lib/db` and Spec 038's errors,
so `lib/auth` can import it without a cycle. It exports:

- `getAccountStanding(executor, userId): 'good' | 'restricted' | 'suspended' | 'banned'`
  - `users.lifecycle_status` in `restricted|suspended|banned` → that value.
  - `deletion_pending` → the most severe **active** account-scope lifecycle action's standing, or
    `good` if there is none.
  - `active` → `good`.
  - `deleted` → `good`. Spec 008 owns deleted accounts; no marketplace path reaches them.
- `getProviderStanding(executor, providerProfileId)` → `restricted|suspended|banned` from
  `provider_profiles.lifecycle_status`, otherwise `good`.
- `assertAccountMayTransact(executor, userId)` → throws `403 ACCOUNT_RESTRICTED`,
  `ACCOUNT_SUSPENDED` or `ACCOUNT_BANNED` unless the standing is `good`.
- `assertProviderMayTransact(executor, providerProfileId)` → throws `403 PROVIDER_NOT_IN_GOOD_STANDING`
  (`details.standing`) unless `good`.

The read is fresh on every call, with no caching. A reversal takes effect on the next request.

**Semantics (normative):**

| Standing | Sign-in / session | New marketplace activity (requests, offers, offer revisions/change requests, offer acceptance, bookings) | Existing obligations | Sessions on activation |
|---|---|---|---|---|
| `restricted` | normal | **blocked** (`403 ACCOUNT_RESTRICTED`) | Continue: existing bookings, messaging, payments, disputes, support, reviews are unaffected | kept |
| `suspended` | Sign-in still issues a session, but it can reach **only** the allow-list below (`403 ACCOUNT_SUSPENDED` elsewhere) | blocked | Not operable by the user. Counterparties and admins proceed through their own specs; a booking in flight can be cancelled by admin intervention (AC-6) | **all revoked** |
| `banned` | As `suspended`: no full session is ever usable. Only the allow-list (`403 ACCOUNT_BANNED` elsewhere) | blocked | as `suspended` | **all revoked** |

Why sign-in is not refused outright: the appeal (U2) and the account-recovery/privacy flows are
session-authenticated. A literal sign-in refusal would make master §67's "appeal/support paths"
unreachable. So a suspended or banned user can sign in, but every session route outside the
allow-list refuses them.

**Session allow-list** (routes that opt in with `allowModeratedAccount: true`):

- `POST /api/v1/auth/logout`
- `GET /api/v1/users/me`
- `GET /api/v1/users/me/notifications`
- `GET /api/v1/users/me/notifications/unread-count`
- `POST /api/v1/users/me/notifications/{id}/read`
- `POST /api/v1/users/me/notifications/read-all`
- `GET|POST /api/v1/users/me/data-export`
- `GET /api/v1/users/me/data-export/{id}`
- `GET /api/v1/users/me/data-export/{id}/download`
- `GET|POST /api/v1/users/me/deletion`
- `POST /api/v1/users/me/deletion/cancel`
- U1 `GET /api/v1/moderation-actions`
- U2 `POST /api/v1/moderation-actions/{id}/appeals`

Nothing else is on the list. Support tickets (spec 032) are excluded: the appeal is the recovery
path. `getOptionalSession()` returns `null` for a suspended or banned user, so guest-or-session
routes treat them as a guest.

**Provider scope.** `provider_profiles.lifecycle_status ≠ active` already removes the provider from
matching (specs 016/017). In addition, `createOffer`, `reviseOffer` and `createBooking` call
`assertProviderMayTransact` for the offering or booked provider. An in-flight negotiation therefore
cannot turn into new commitments.

**Deletion interplay (OQ-2), normative:**

- `requestDeletion` stays available to sanctioned accounts. Deletion is a privacy right, and it sits
  on the allow-list. The column becomes `deletion_pending`, but `getAccountStanding` keeps enforcing
  the sanction through the active action.
- `cancelDeletion` must set `users.lifecycle_status` to
  `standingToLifecycle(getAccountStanding())` instead of the hard-coded `'active'`. `good` maps to
  `active`; any sanction maps to itself. This is done in the same conditional update, under the
  same `WHERE lifecycle_status = 'deletion_pending'`.
- The sweep's `deleted` outcome is unchanged. Moderation rows are retained through `restrict` FKs.
- **No path other than §3.4 reversal can produce `active` from a sanction.** AC-11 and the
  `deletion-loophole` test assert this.

**Reversal** runs only through §3.4. Enforcement points never write lifecycle values; they only
read standing.

### 3.6 Fraud and abuse signals — MVP boundary

Spec 033 has `completeAi()` but no anomaly-detection capability. **The MVP is rule-based.**

- **C1** `GET /api/v1/cron/fraud-signal-sweep`:
  - bearer `CRON_SECRET`, the idiom of `app/api/v1/cron/dispute-appeal-sweep/route.ts`;
  - registered in `vercel.json`;
  - excluded from OpenAPI by `scripts/check-openapi-drift.ts`;
  - evaluates rules **read-only** over other specs' tables:
    - `R1 repeated_safety_reports`: distinct `reporter_user_id` in `safety_reports` against one
      `target_user_id` within the window.
    - `R2 repeated_no_show_fault`: `no_show_reports` resolved `no_show_confirmed_customer`
      (attributed to the booking's customer) or `no_show_confirmed_provider` (attributed to the
      provider's user) within the window.
- **Thresholds are implementation-time configuration, not spec values.**
  - Each rule uses `FRAUD_RULE_R1_THRESHOLD` / `FRAUD_RULE_R1_WINDOW_DAYS` and
    `FRAUD_RULE_R2_THRESHOLD` / `FRAUD_RULE_R2_WINDOW_DAYS` (positive integers).
  - An unset or invalid pair makes that rule inactive, and C1 reports `rulesActive`.
  - Trust & Safety sets the values at deployment. They are documented in `.env.example`.
- **Dedupe:** a partial unique index allows one open (`pending_review`/`escalated`) signal per
  `(rule_key, target_user_id)`.
- **AI seam.**
  - `recordFraudSignal()` is the only writer.
  - `source: 'ai_assisted'` is accepted only when `isAiFraudSignalsEnabled()` is true. That reads env
    `AI_FRAUD_SIGNALS_ENABLED`, default off, following the `lib/ai/feature-flags.ts` idiom until
    spec 041 exists.
  - **No AI producer ships.**
- **Signal statuses:**
  - `pending_review → escalated | dismissed | actioned`;
  - `escalated → dismissed | actioned`.
- `actioned` is set only when an admin initiates M1 with `originFraudSignalId`.
- `lib/moderation/fraud-signals.ts` and `lib/moderation/rules.ts` import neither `actions.ts` nor
  `lifecycle.ts`.

### 3.7 Payout freeze — normative MVP boundary (resolves OQ-3)

`getPayoutHoldGate()` is consulted in two places:

- Pass C batch close (`pending → eligible`, `lib/payouts/ledger.ts`);
- the earnings summary (`lib/payouts/read.ts`).

Spec 038 registers the gate from `registerModerationIntegration()`:

```typescript
// lib/moderation/payout-hold.ts
registerPayoutHoldGate(async (tx, providerProfileId) => ({
  held: /* EXISTS moderation_actions WHERE action_type = 'payout_freeze'
           AND provider_profile_id = $1 AND status = 'active' */,
}));
```

**The MVP freeze means, normatively:**

- From activation, no `pending` batch of that provider closes and nothing new is transferred.
- Nothing is forfeited.
- The provider sees `payoutOnHold: true`.
- Unfreezing (reversal) releases the hold on the next sweep.

**The MVP freeze does not affect:**

- **`processing`.** A transfer is already at the rail. Spec 024 deliberately never aborts one; an
  unknown outcome is escalated for manual finance review. Interrupting it could double-pay or lose
  the outcome.
- **`eligible`.** The batch has closed and is claimed by Pass D in the same sweep (≤ 5 minutes).
- **`reopenFailedPayout()`** (automatic retry and the admin retry). The admin retry is already a
  high-tier, four-eyes Finance action.

Covering `eligible` and retries would need spec 024 to consult the gate in Pass D and in
`reopenFailedPayout()`. That is a **future spec 024 change, not required and not made by Spec 038**.
No new payout state or column is added.

### 3.8 Evidence — `moderation_evidence` file context

- Add `'moderation_evidence'` to:
  - `FILE_CONTEXT_TYPES` (`lib/types/files.ts`);
  - the `file_assets_context_type_ck` declaration in `lib/db/schema.ts`;
  - the constraint, recreated in `0033` with the `0029` idiom (drop, re-add `NOT VALID`,
    `VALIDATE`).
- The policy lives in `lib/moderation/evidence-policy.ts` and is registered by
  `registerModerationIntegration()`, following the pattern of `lib/safety/evidence-policy.ts`:
  - `contextId` = `moderation_actions.id`;
  - `publicEligible: false`;
  - `allowedKinds: ['image','document','video']`;
  - `maxPerContext = MAX_MODERATION_EVIDENCE = 10`. This is the limit spec 030 ships as
    `MAX_SAFETY_EVIDENCE` for the same kind of material, and the MVP value.
- `canUpload`: an admin holding the `moderation/<action>` permission of that action's type, while the
  action is `pending_approval` or `active`.
- `canRead`: an admin holding `moderation/read`. `moderation.evidence_read` is audited **before**
  the policy returns true. There is no branch for the target or any non-admin.
- Linked assets get `legal_hold = true` (spec 031's `holdEvidenceFor()` precedent).
- **Flow:**
  1. The action is created first.
  2. The UI uploads through spec 027's routes, while the action is pending for high/critical types,
     so the approver sees the evidence.
  3. The detail DTO lists the evidence ids.
- The origin link (`origin_safety_report_id` / `origin_fraud_signal_id`) leaves the source evidence
  under its own spec's policy. Nothing is copied.

### 3.9 RBAC — `permissions` rows seeded by `0033` (normative; resolves OQ-5)

These are the seven existing roles only. The tiers follow master §70: "Permanent ban" and "Payout
intervention" are sensitive; high risk means "Second-admin approval". Roles follow master §69:

- Trust & Safety: "Reports, disputes, safety".
- Operations: "Requests, bookings, providers".
- Finance: "Payments, refunds, payouts".

| resource | action | tier | roles |
|---|---|---|---|
| `moderation` | `read` | low | trust_safety_admin, operations_admin, super_admin |
| `moderation` | `warn` | medium | trust_safety_admin, super_admin |
| `moderation` | `restrict` | medium | trust_safety_admin, super_admin |
| `moderation` | `suspend` | high | trust_safety_admin, super_admin |
| `moderation` | `ban` | critical | trust_safety_admin, super_admin |
| `moderation` | `intervene_booking` | high | trust_safety_admin, operations_admin, super_admin |
| `moderation` | `freeze_payout` | high | trust_safety_admin, finance_admin, super_admin |
| `moderation` | `reverse` | high | trust_safety_admin, super_admin |
| `moderation` | `review_appeal` | medium | trust_safety_admin, super_admin |
| `fraud_signals` | `read` | low | trust_safety_admin, super_admin |
| `fraud_signals` | `triage` | medium | trust_safety_admin, super_admin |

- **View signals:** `fraud_signals/read`.
- **Initiate:** the per-type action.
- **Approve:** a *different* admin holding the same `(moderation, action)`, enforced by spec 009's
  `decideAction()`.
- **Execute:** any holder of that action, including the initiator once another admin has approved.
- **Decide appeals:** `moderation/review_appeal`, and not the initiator or approver.

Finance admins deliberately lack `moderation/read`. They approve a freeze from spec 009's pending
approval summary, which shows the reason and target, without access to T&S evidence. This is least
privilege. Changing it is a data change to the seed, not a spec change.

### 3.10 Audit (AC-4)

Spec 039 is Draft and **not required**. Everything goes through the shipped
`recordAdminAuditEvent()`: actor, actor roles, event type, resource/action, target, reason,
`approvalChain`, `correlationId`, `before`/`after`.

- Spec 009 emits `admin_rbac.action_created|approved|rejected|executed`.
- Spec 038 emits:
  - `moderation.action_applied`, `moderation.action_pending`, `moderation.action_executed`;
  - `moderation.action_rejected_reconciled`, `moderation.reversal_requested`,
    `moderation.action_reversed`;
  - `moderation.sessions_revoked`;
  - `moderation.appeal_filed`, `moderation.appeal_decided`;
  - `moderation.evidence_read`;
  - `fraud_signal.dismissed`, `fraud_signal.escalated`, `fraud_signal.actioned`.
- Event contents:
  - `before`/`after` carry the lifecycle values of both columns on a cascade.
  - `after.evidenceFileAssetIds` carries evidence ids.
  - `approvalChain = { adminActionId, initiatedBy, decidedBy, decision, decidedAt }`, read from
    `admin_action_approvals`.
- An appellant's filing is audited with `actorRoles: []`.
- An audit failure is not swallowed (it surfaces as `500`), as in spec 030.
- Retrieval, retention and `audit_logs` storage are spec 039's and not assumed.

### 3.11 Notifications

Add `moderation_action_applied` and `moderation_appeal_decided` to spec 026's catalogue
(`lib/types/notifications.ts`, `lib/notifications/catalogue.ts`), category `security`.

- No migration is needed: type is not a DB CHECK. This is the spec 030–032 precedent.
- Content-free: the type, plus a link to `/account/moderation`.
- Event key: `<type>:<id>:<recipient>`.
- Fire-and-forget after commit.
- `booking_intervention` relies on spec 023's `booking_cancelled`.

### 3.12 Appeals

- **U2** (target only; `404` for anyone else):
  - one appeal per action (unique);
  - only while the action is `active` and appealable, otherwise `409 APPEAL_NOT_AVAILABLE`;
  - no time window is invented;
  - the appeal is open for as long as the action is active.
- **A2:**
  - the decider must not be `initiated_by_admin_id` or the spec 009 approver
    (`admin_action_approvals.approver_admin_id`), otherwise
    `403 APPEAL_REQUIRES_DIFFERENT_ADMIN`;
  - `upheld` runs `reverseModerationAction()` (§3.4) in the same transaction as the decision;
  - `denied` records the decision only;
  - a `LIFECYCLE_STATE_CHANGED` failure leaves the appeal `pending`.
- The original action row is changed only by the reversal columns.

### 3.13 Endpoints

All routes are `app/api/v1/**/route.ts` using `withApiRoute`, `requireSession`, and `requireCsrf`
on POST. They use a new `moderation` bucket in `lib/api/rate-limit.ts`
(`{ limit: 30, windowMs: 60_000 }`, the safety/disputes/support value). **Every non-cron route is
registered in `lib/api/openapi-registry.ts`** (`npm run check:openapi-drift`).

| # | Method | Route | Permission | Success | Idempotency |
|---|---|---|---|---|---|
| M1 | `POST` | `/api/v1/admin/moderation-actions` | per-type (§3.9) | `201 ApiResponse<ModerationActionDto>` applied; `202` pending; `200` replay | `Idempotency-Key` required; unique per initiating admin + fingerprint; different body → `409 IDEMPOTENCY_KEY_CONFLICT` |
| M2 | `GET` | `/api/v1/admin/moderation-actions` | `moderation/read` | `200 PagedResponse<ModerationActionDto>` (filters `targetUserId`, `status`, `actionType`) | — |
| M3 | `GET` | `/api/v1/admin/moderation-actions/{id}` | `moderation/read` | `200 ApiResponse<ModerationActionDetailDto>` | — |
| M4 | `POST` | `/api/v1/admin/moderation-actions/{id}/execute` | per-type | `200 ApiResponse<ModerationActionDto>` | header required; idempotent by state (second call `409`, no second effect) |
| M5 | `POST` | `/api/v1/admin/moderation-actions/{id}/reverse` | `moderation/reverse` | `202 ApiResponse<ModerationActionDto>` | header required; one open reversal per action (`409 MODERATION_STATUS_CONFLICT`) |
| M6 | `POST` | `/api/v1/admin/moderation-actions/{id}/reverse/execute` | `moderation/reverse` | `200 ApiResponse<ModerationActionDto>` | header required; idempotent by state |
| F1 | `GET` | `/api/v1/admin/fraud-signals` | `fraud_signals/read` | `200 PagedResponse<FraudSignalDto>` | — |
| F2 | `POST` | `/api/v1/admin/fraud-signals/{id}/dismiss` | `fraud_signals/triage` | `200 ApiResponse<FraudSignalDto>` | header required; conditional on `expectedStatus` |
| F3 | `POST` | `/api/v1/admin/fraud-signals/{id}/escalate` | `fraud_signals/triage` | `200 ApiResponse<FraudSignalDto>` | same |
| A1 | `GET` | `/api/v1/admin/moderation-appeals` | `moderation/review_appeal` | `200 PagedResponse<ModerationAppealDto>` | — |
| A2 | `POST` | `/api/v1/admin/moderation-appeals/{id}/decide` | `moderation/review_appeal` | `200 ApiResponse<ModerationAppealDto>` | header required; conditional on `status = 'pending'` |
| U1 | `GET` | `/api/v1/moderation-actions` | session, own; **allow-listed** | `200 PagedResponse<MyModerationActionDto>` | — |
| U2 | `POST` | `/api/v1/moderation-actions/{id}/appeals` | session, target only (`404` otherwise); **allow-listed** | `201 ApiResponse<ModerationAppealDto>`; `200` replay | header required; unique `(appellant_user_id, idempotency_key)` |
| C1 | `GET` | `/api/v1/cron/fraud-signal-sweep` | bearer `CRON_SECRET` | `200 { status, rulesActive, signalsCreated }` | natural (dedupe index); not in OpenAPI |

Acting on a signal is M1 with `originFraudSignalId`. U1 never returns `pending_approval` or
`rejected` actions.

### 3.14 Request and response types — `lib/types/moderation.ts`

```typescript
export const MODERATION_ACTION_TYPES = ['warning','restriction','suspension','ban','booking_intervention','payout_freeze'] as const;
export const MODERATION_SCOPES = ['account','provider_profile','booking'] as const;
export const MODERATION_ACTION_STATUSES = ['pending_approval','active','executed','superseded','reversed','rejected'] as const;
export const ACCOUNT_STANDINGS = ['good','restricted','suspended','banned'] as const;
export const FRAUD_SIGNAL_STATUSES = ['pending_review','escalated','dismissed','actioned'] as const;
export const MODERATION_APPEAL_STATUSES = ['pending','upheld','denied'] as const;

export interface CreateModerationActionRequest {
  actionType: ModerationActionType;
  scope: ModerationScope;              // 'booking' iff booking_intervention; 'provider_profile' required for payout_freeze
  targetUserId: string;                // always the affected user (users.id)
  providerProfileId?: string;          // required for scope 'provider_profile'; must belong to targetUserId
  bookingId?: string;                  // required for booking_intervention; targetUserId must be a participant
  refundTreatment?: 'policy' | 'full'; // booking_intervention only → spec 023 forceFullRefund false|true
  reason: string;                      // required, trimmed, 1..500 (spec 024 idiom); internal only
  userMessage?: string;                // optional, ≤500; shown to the target after the standard text
  originFraudSignalId?: string;        // marks that signal `actioned`
}

export interface ModerationActionDto {
  id: string;
  actionType: ModerationActionType;
  scope: ModerationScope;
  targetUserId: string;
  providerProfileId: string | null;
  bookingId: string | null;
  refundTreatment: 'policy' | 'full' | null;
  riskTier: 'low' | 'medium' | 'high' | 'critical';
  status: ModerationActionStatus;
  reason: string;
  userMessage: string | null;
  adminActionId: string | null;
  reversalAdminActionId: string | null;
  previousUserStanding: AccountStanding | null;
  previousProviderLifecycleStatus: string | null;
  originSafetyReportId: string | null;
  originFraudSignalId: string | null;
  initiatedByAdminUserId: string;
  createdAt: string;
  activatedAt: string | null;
  reversedAt: string | null;
}

export interface ModerationActionDetailDto extends ModerationActionDto {
  evidenceFileAssetIds: string[];
  approvalChain: { decision: 'approved' | 'rejected'; decidedByAdminUserId: string; decidedAt: string }[];
  appeal: ModerationAppealDto | null;
}

/** The moderated user's view: no internal reason, evidence, admin identity or origin. */
export interface MyModerationActionDto {
  id: string;
  actionType: ModerationActionType;
  scope: ModerationScope;
  status: 'active' | 'executed' | 'superseded' | 'reversed';
  userMessage: string | null;
  activatedAt: string;
  appealable: boolean;
  appeal: { status: ModerationAppealStatus; decidedAt: string | null } | null;
}

export interface ReverseModerationActionRequest { reason: string }   // 1..500

export interface FraudSignalDto {
  id: string;
  targetUserId: string;
  source: 'rule_based' | 'ai_assisted';
  ruleKey: string;
  observedCount: number;
  threshold: number;
  windowDays: number;
  status: FraudSignalStatus;
  createdAt: string;
  triagedByAdminUserId: string | null;
  triageReason: string | null;
  moderationActionId: string | null;
}
export interface TriageFraudSignalRequest { expectedStatus: FraudSignalStatus; reason: string }

export interface FileModerationAppealRequest { statement: string }   // 1..2000
export interface DecideModerationAppealRequest { decision: 'upheld' | 'denied'; reason: string }
export interface ModerationAppealDto {
  id: string;
  moderationActionId: string;
  status: ModerationAppealStatus;
  statement: string;
  decisionReason: string | null;          // admin views only
  decidedByAdminUserId: string | null;    // admin views only
  createdAt: string;
  decidedAt: string | null;
}
```

M4 has an empty body. It carries no effect parameters: every figure was fixed at initiation, so the
approved action is exactly what executes.

### 3.15 Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | missing/empty/too-long `reason`/`statement`/`Idempotency-Key`; bad enum; scope/target mismatch |
| `403` | `FORBIDDEN` | lacks the §3.9 permission, including the gate caller without `moderation/restrict` |
| `403` | `APPEAL_REQUIRES_DIFFERENT_ADMIN` | decider initiated or approved the action |
| `403` | `ACCOUNT_RESTRICTED` / `ACCOUNT_SUSPENDED` / `ACCOUNT_BANNED` | §3.5 enforcement (thrown by `lib/moderation/standing.ts`) |
| `403` | `PROVIDER_NOT_IN_GOOD_STANDING` | §3.5 provider enforcement (`details.standing`) |
| `404` | `NOT_FOUND` | unknown action/signal/appeal/target/booking; U2 by non-target |
| `409` | `MODERATION_ACTION_CONFLICT` | not strictly more severe; pending lifecycle action exists; active freeze exists; open intervention exists for the booking |
| `409` | `MODERATION_STATUS_CONFLICT` | execute/reverse from the wrong status; second execution |
| `409` | `TARGET_NOT_MODERATABLE` | account `deleted`; account holds an `AdminProfile`; provider profile already `banned` |
| `409` | `LIFECYCLE_STATE_CHANGED` | reversal found a column no longer at this action's value |
| `409` | `FRAUD_SIGNAL_STATUS_CONFLICT` | `expectedStatus` mismatch / invalid transition |
| `409` | `APPEAL_ALREADY_FILED` / `APPEAL_NOT_AVAILABLE` / `APPEAL_STATUS_CONFLICT` | §3.12 |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | re-exported from `lib/requests/errors.ts` |
| `409` | `APPROVAL_NOT_ELIGIBLE` | spec 009's, propagated |
| `409` | `SELF_APPROVAL_NOT_ALLOWED` | spec 009's approve route, unchanged |
| `422` | `APPROVAL_REQUIRED` | spec 009's (`422`, not the draft's `403`): execute while `Pending`; fail-closed initiation |
| `422` | `BOOKING_NOT_CANCELLABLE` / `BOOKING_ALREADY_CANCELLED` | spec 023's, propagated |
| `422` | `RESTRICTION_UNAVAILABLE` | spec 030's. No longer returned once Spec 038 registers the gate |
| `429` | `RATE_LIMITED` | `moderation` bucket |

The draft's `REASON_REQUIRED` is replaced by `400 VALIDATION_ERROR` (`field: 'reason'`), the
repository idiom.

### 3.16 Spec 030 gate — `lib/moderation/restriction-gate.ts` (resolves OQ-4)

`restrictFromSafetyReport(request)`:

1. Requires `moderation/restrict` for `requestedByAdminUserId`, otherwise `403`, and spec 030
   leaves the report open.
2. Under the target lock, returns the existing restriction for that `origin_safety_report_id`
   (partial unique index). This makes a retry idempotent.
3. Otherwise runs the M1 service with `actionType: 'restriction'`, `scope: 'account'`, the
   request's `reason` (empty → `400`), no `userMessage`, and `origin_safety_report_id` set.
4. Returns `{ moderationActionId }`.

**Decision OQ-4: no FK is added to `safety_reports.restriction_moderation_action_id`.** Integrity
is held on Spec 038's side:

- `moderation_actions.origin_safety_report_id` is an FK to `safety_reports`;
- a partial unique index allows one restriction per report;
- `restriction-gate.integration.test.ts` asserts that the id spec 030 stores equals that row's id.

This is the least cross-spec coupling that still preserves integrity. Spec 030's schema, code and
tests are untouched. If spec 030's conditional update loses a race after the gate committed, the
retry returns the same id (step 2).

### 3.17 Authorized cross-spec implementation changes (prerequisites X-1 … X-7)

These are **approved as part of Spec 038's implementation**. They are the only edits Spec 038 may
make outside its own files. Each is additive, and each owning spec keeps ownership of its file.
Existing tests of those specs use `active` users and must stay green unchanged.

| # | Owning spec | File / function | Exact change |
|---|---|---|---|
| X-1 | 005 | `lib/auth/require-session.ts` `requireSession()` | After session validation (and after the MFA check), read `getAccountStanding()`. If `suspended`/`banned` and `options.allowModeratedAccount !== true`, throw `403 ACCOUNT_SUSPENDED`/`ACCOUNT_BANNED`. `restricted`/`good` pass. `getOptionalSession()` returns `null` for suspended/banned. The new option is additive, and existing callers are unaffected. |
| X-2 | 005, 008, 026 | the allow-list route files (§3.5): `app/api/v1/auth/logout/route.ts`; `app/api/v1/users/me/route.ts`; `app/api/v1/users/me/notifications/**/route.ts` (4); `app/api/v1/users/me/data-export/**/route.ts` (3); `app/api/v1/users/me/deletion/route.ts`; `app/api/v1/users/me/deletion/cancel/route.ts` | Pass `{ allowModeratedAccount: true }` to `requireSession`. No other change. |
| X-3 | 015 | `lib/requests/create.ts` `createRequest()` | Call `assertAccountMayTransact(tx, customerUserId)` before inserting |
| X-4 | 018, 019 | `lib/offers/create.ts` `createOffer()`, `lib/offers/decide.ts` `acceptOffer()`, `lib/negotiation/revise.ts` `reviseOffer()`, `lib/negotiation/change-requests.ts` `createChangeRequest()` | `assertAccountMayTransact` for the acting user. `assertProviderMayTransact` for the offering provider in `createOffer`/`reviseOffer`. |
| X-5 | 020 | `lib/bookings/create.ts` `createBooking()` | `assertAccountMayTransact(customer)` and `assertProviderMayTransact(provider)` before the insert. This covers the spec 036 `create_booking` MCP tool, which calls this service. |
| X-6 | 008 | `lib/privacy/deletion.ts` `cancelDeletion()` | Replace the hard-coded `lifecycleStatus: 'active'` with the value from `getAccountStanding()` mapped to a lifecycle value (`good` → `active`), in the same conditional update. `requestDeletion()` is unchanged. |
| X-7 | 003 | `lib/db/schema-coverage.test.ts` `EXPECTED_TABLES` | Register `moderation_actions`, `fraud_signals`, `moderation_appeals` with a spec 038 comment. This test asserts the **exact** table set, so this edit is **authorized** as an intentional change (resolves P-1). |

Every X-3…X-6 call site imports the leaf `@/lib/moderation/standing`, never the `@/lib/moderation`
barrel, because the barrel imports payouts and safety for registration. Verified against the
existing source-level boundary tests:

- `lib/bookings/payment-boundary.test.ts` forbids import paths matching `/payments?`;
- `lib/bookings/execution-boundary.test.ts` forbids `@/lib/(payments|payouts|refunds|reviews)`.

Neither matches `@/lib/moderation/standing`.

**Pre-existing, not Spec 038's:** `lib/db/schema-coverage.test.ts` already omits spec 035's
`mcp_confirmations` and `mcp_confirmation_parameters`, so the exact-set assertion fails before Spec
038 starts. X-7 adds only Spec 038's three tables. The spec 035 omission is reported, not fixed.

Not part of this list and not required: Spec 009, 023, 024 and 030 code; any other spec document.

### 3.18 Composition root

`lib/moderation/index.ts` exports `registerModerationIntegration()`. `instrumentation.ts` calls it
after `registerPayoutIntegration()`, `registerFileIntegration()` and `registerSafetyIntegration()`.
It registers the `SafetyRestrictionGate`, the `PayoutHoldGate` and the `moderation_evidence`
policy. Rollback returns all three ports to their documented defaults.

### Breaking-change check

- [x] No shipped route or DTO changes shape. There are three behaviour changes:
  - spec 030's S10 stops returning `RESTRICTION_UNAVAILABLE`;
  - spec 024's gate can hold;
  - sanctioned accounts are refused by X-1…X-5, which is the intended new enforcement.
  Existing `active` users see no difference.

---

## 4. Data model changes

There are no `jsonb` columns, so spec 003's `schema-lint.test.ts` allow-list is untouched. There are
no money columns.

### Entities

**`moderation_actions`** (new)

| Column | Type | Notes |
|---|---|---|
| `id`, `created_at`, `updated_at`, `version` | `baseColumns()` | |
| `action_type` | `text not null` | CHECK §3.14 |
| `scope` | `text not null` | CHECK `account\|provider_profile\|booking` |
| `target_user_id` | `uuid not null` FK→`users.id` `restrict` | |
| `provider_profile_id` | `uuid null` FK→`provider_profiles.id` `restrict` | |
| `booking_id` | `uuid null` FK→`bookings.id` `restrict` | |
| `refund_treatment` | `text null` | CHECK `policy\|full`; non-null iff `booking_intervention` |
| `risk_tier` | `text not null` | CHECK low..critical |
| `status` | `text not null` | CHECK §3.14 |
| `reason` | `text not null` | CHECK length 1..500 |
| `user_message` | `text null` | CHECK ≤ 500 |
| `initiated_by_admin_id` | `uuid not null` FK→`admin_profiles.id` `restrict` | AC-3 |
| `admin_action_id` | `uuid null unique` FK→`admin_actions.id` `restrict` | |
| `reversal_admin_action_id` | `uuid null unique` FK→`admin_actions.id` `restrict` | |
| `previous_user_standing` | `text null` | CHECK `good\|restricted\|suspended\|banned` |
| `previous_provider_lifecycle_status` | `text null` | CHECK within spec 006's seven values |
| `superseded_by_moderation_action_id` | `uuid null` FK→`moderation_actions.id` `restrict` | |
| `origin_safety_report_id` | `uuid null` FK→`safety_reports.id` `restrict` | |
| `origin_fraud_signal_id` | `uuid null` FK→`fraud_signals.id` `restrict` | |
| `activated_at`, `reversed_at` | `timestamptz null` | |
| `reversed_by_admin_id` | `uuid null` FK→`admin_profiles.id` `restrict` | |
| `reversal_reason` | `text null` | CHECK ≤ 500 |
| `idempotency_key`, `idempotency_fingerprint` | `text null` | null only for gate-created rows |

**Constraints**

- `moderation_actions_scope_target_ck`:
  - `scope='booking'` ⇔ `booking_id is not null` ⇔ `action_type='booking_intervention'`;
  - `scope='provider_profile'` ⇒ `provider_profile_id is not null`;
  - `action_type='payout_freeze'` ⇒ `scope='provider_profile'`.
- `moderation_actions_active_pairing_ck`: status in (`active`,`executed`,`superseded`,`reversed`) ⇔
  `activated_at is not null`.
- `moderation_actions_reversal_pairing_ck`: `status='reversed'` ⇔ `reversed_at`,
  `reversed_by_admin_id` and `reversal_reason` are all non-null.
- `moderation_actions_approval_pairing_ck`: `risk_tier in ('high','critical')` ⇔
  `admin_action_id is not null`.

**Indexes**

- A btree index on every FK column (spec 003 AC-4).
- `(target_user_id, created_at desc)`.
- Partial unique `(provider_profile_id) where action_type='payout_freeze' and status in ('pending_approval','active')`.
- Partial unique `(booking_id) where action_type='booking_intervention' and status in ('pending_approval','executed')`.
- Partial unique `(origin_safety_report_id) where action_type='restriction'`.
- Unique `(initiated_by_admin_id, idempotency_key) where idempotency_key is not null`.
- Partial `(target_user_id) where scope='account' and status='active'`, for `getAccountStanding`.

**`fraud_signals`** (new)

- `baseColumns()`.
- `target_user_id uuid not null` FK→`users.id` `restrict`.
- `source text not null`, CHECK `rule_based|ai_assisted`.
- `rule_key text not null`, CHECK length 1..64.
- `observed_count`, `threshold`, `window_days`: `integer not null`, CHECK `> 0`.
- `status text not null default 'pending_review'`, CHECK §3.14.
- `triaged_by_admin_id uuid null` FK→`admin_profiles.id` `restrict`.
- `triage_reason text null`, CHECK ≤ 500.
- `triaged_at timestamptz null`.
- `fraud_signals_triage_pairing_ck`: status in (`dismissed`,`escalated`,`actioned`) ⇒
  `triaged_by_admin_id` and `triaged_at` are non-null.
- Partial unique `(rule_key, target_user_id) where status in ('pending_review','escalated')`.
- Index `(status, created_at)`, plus FK indexes.

**`moderation_appeals`** (new)

- `baseColumns()`.
- `moderation_action_id uuid not null unique` FK→`moderation_actions.id` `restrict`.
- `appellant_user_id uuid not null` FK→`users.id` `restrict`. Must equal the action's target, which
  the application checks.
- `statement text not null`, CHECK length 1..2000.
- `status text not null default 'pending'`, CHECK `pending|upheld|denied`.
- `decided_by_admin_id uuid null` FK→`admin_profiles.id` `restrict`.
- `decision_reason text null`, CHECK ≤ 500.
- `decided_at timestamptz null`.
- `idempotency_key`, `idempotency_fingerprint`: `text not null`.
- `moderation_appeals_decision_pairing_ck`: `status <> 'pending'` ⇔ `decided_by_admin_id`,
  `decision_reason` and `decided_at` are all non-null.
- Unique `(appellant_user_id, idempotency_key)`, plus FK indexes.

**Reused, unchanged:** `admin_actions`, `admin_action_approvals`, `users`, `provider_profiles`,
`sessions`, `safety_reports` (no FK added, per OQ-4), `payouts`.

**Altered:** only the closed vocabulary `file_assets_context_type_ck`, adding
`moderation_evidence`.

### Migration

- **Name:** `drizzle/0033_add_admin_moderation_fraud.sql` plus the hand-written
  `drizzle/0033_add_admin_moderation_fraud_down.sql`. `0032_extend_ai_tool_calls` is the latest
  shipped migration.
- Registered in `drizzle/meta/_journal.json` like `0016`–`0032`. Declarations go in
  `lib/db/schema.ts`.
- **Contents:**
  - the three tables, their CHECKs and indexes;
  - the recreated `file_assets_context_type_ck`;
  - the §3.9 `permissions` rows, using the `INSERT … SELECT … FROM (VALUES …)` idiom of `0028`.
- **Reversible:** yes. The down migration:
  - drops the three tables;
  - restores the previous context-type constraint;
  - deletes exactly the seeded permission rows.
  Role assignments are untouched.
- **Backfill:** none. No lifecycle value is rewritten.
- **Downtime:** none.
- **Checks:**
  - `npm run check:schema-baseline`;
  - `lib/db/schema-coverage.test.ts` (with X-7);
  - `lib/db/schema-lint.test.ts` (unaffected).

### Retention and privacy

- Evidence is private and under `legal_hold`.
- Actions and appeals use `restrict` FKs, so they are retained against an anonymized user after
  spec 008's sweep (spec 030 DECIDED-5 precedent).
- The target's views omit the internal reason, the evidence, admin identities and the origin.

---

## 5. UI states

Everything is built from `@/components`:

- `Table`, `Badge`, `Tag`, `Button`, `ConfirmDialog`, `FormField`, `Textarea`, `Select`;
- `Alert`, `EmptyState`, `ErrorState`, `Skeleton`, `ListRow`, `Toast`;
- plus the existing `app/_components/FileUpload.tsx`.

Styling uses design tokens only. No `EvidenceGallery` exists and none is created: evidence is a
`ListRow` list with links issued by spec 027.

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` rows for queues and history |
| **Empty** | "No signals pending review" / "No appeals waiting" (`EmptyState`, neutral) |
| **Error** | `ErrorState`; a failed submission keeps the reason, message and selected files |
| **Pending approval** | `Badge` "Awaiting second admin" linking to `/admin/approvals`; "Apply" (M4) enabled only once approved |
| **Success** | `Toast` plus the resulting standing; target notified (§3.11) |
| **Sanctioned user** | `/account/moderation` shows the standing, the standard explanation for the type, any `userMessage` and the appeal form. The user reaches it after sign-in via U1 |

Every action uses a `ConfirmDialog` with a mandatory reason (master §90 pattern). A ban is never
one click.

**Routes:**

- `app/admin/users/[id]/moderation/page.tsx`
- `app/admin/operations/fraud/page.tsx`
- `app/admin/operations/moderation-appeals/page.tsx`
- `app/account/moderation/page.tsx`

The `app/admin/users/page.tsx` placeholder is left unchanged.

---

## 6. Test plan

Tests are colocated under `lib/moderation/`. Integration tests run on the isolated `*_test`
database (`vitest.config.ts`, `test/db-reset.ts`). Suites that register ports reset them in
`afterEach`:

- `resetSafetyRestrictionGate`
- `resetPayoutHoldGate`
- `resetFileContextPolicies`

This keeps the default-port expectations of the spec 024 and 030 suites intact. Helpers live in
`lib/moderation/moderation-test-support.ts`. **Spec 038 edits no other spec's test file except
X-7.** Its enforcement tests drive the other specs' services from its own files.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | action-type→permission/tier map; validation; severity/supersede; standing derivation incl. `deletion_pending`; rules inactive when env unset/invalid | `lib/moderation/catalogue.test.ts`, `validation.test.ts`, `transitions.test.ts`, `standing.test.ts`, `rules.test.ts` |
| **Boundary** | Only `lifecycle.ts` writes `restricted\|suspended\|banned`. No `UPDATE bookings`/`payouts` in `lib/moderation`. `fraud-signals.ts`/`rules.ts` import neither `actions.ts` nor `lifecycle.ts`. `standing.ts` imports only `@/lib/db` and errors. X-3…X-6 import the leaf path, not the barrel. | `lib/moderation/boundary.test.ts` |
| **Lifecycle** | account/provider scopes; cascade; `previous_*` restored; supersede/restore; `LIFECYCLE_STATE_CHANGED`; `deletion_pending` target (column untouched, standing enforced); admin target refused | `lib/moderation/lifecycle.integration.test.ts` |
| **Standing enforcement** | X-1: suspended/banned refused on a non-allow-listed route, allowed on each allow-listed one, `getOptionalSession` → `null`. X-3…X-5: restricted/suspended/banned refused in `createRequest`, `createOffer`, `acceptOffer`, `reviseOffer`, `createChangeRequest`, `createBooking`; provider standing refused. Sessions revoked on suspension/ban activation, not on restriction. Reversal restores access on the next request. | `lib/moderation/standing-enforcement.integration.test.ts` |
| **Deletion loophole** (AC-11) | banned → request deletion → still refused during grace → cancel → `banned`, not `active`; reversal is the only route to `active` | `lib/moderation/deletion-loophole.integration.test.ts` |
| **Approval / four-eyes** | high/critical types go `pending_approval` with no effect; self-approval refused; execute before approval `422`; rejected → reconciled + `409`; crash recovery; fail-closed on a mis-seeded tier | `lib/moderation/approval.integration.test.ts` |
| **AI / human in loop** | sweep and `recordFraudSignal` create only signals; `ai_assisted` refused with the flag off; no action without an admin; signal-originated ban needs a second admin | `lib/moderation/ai-safeguard.integration.test.ts`, `fraud-signals.integration.test.ts` |
| **Booking intervention** | runs via `cancelBooking` (`cancelled_by_role='admin'`, spec 020 history, spec 022 hand-off per `refundTreatment`); non-cancellable `422`; replay makes no second cancellation | `lib/moderation/booking-intervention.integration.test.ts` |
| **Payout freeze** | Pass C held, `payoutOnHold` true; reversal releases; `eligible` not held (normative boundary asserted); one active freeze per provider | `lib/moderation/payout-freeze.integration.test.ts` |
| **Appeal** | one per action; target-only; initiator/approver refused; `upheld` reverses; `denied` keeps; non-appealable `409`; reachable while banned | `lib/moderation/appeal.integration.test.ts` |
| **Spec 030 gate** | creates and stores the id; retry idempotent; missing `moderation/restrict` → `403`, report open; stored id matches the origin row | `lib/moderation/restriction-gate.integration.test.ts` |
| **Security / permission** | each §3.9 grant per role; `403` otherwise; evidence refused to target/non-admin, audited for admin, not public, `legal_hold` | `lib/moderation/rbac.integration.test.ts`, `evidence.integration.test.ts` |
| **Audit** | every §3.10 event with roles, reason, target, evidence ids, before/after, approval chain | `lib/moderation/audit.integration.test.ts` |
| **Routes** | envelopes, statuses, CSRF, `Idempotency-Key` required/conflict, rate limit, OpenAPI registration | `lib/moderation/routes.integration.test.ts` |
| **Migration** | up/down reversibility, seeded permissions, context constraint | `lib/moderation/migration.integration.test.ts` |
| **Page** | the four pages' states | `app/admin/users/[id]/moderation/page.test.tsx`, `app/admin/operations/fraud/page.test.tsx`, `app/admin/operations/moderation-appeals/page.test.tsx`, `app/account/moderation/page.test.tsx` |
| **E2E** | admin A suspends, admin B approves, A executes; the target is refused elsewhere, sees `/account/moderation` and appeals; admin C upholds; access is restored | `e2e/moderation.spec.ts` |

**Traceability:** see §2.1. **Coverage:** ≥80% on new code under `lib/moderation/**`.

**Static checks at implementation:** TypeScript, `npm run check:schema-baseline` (checksum + money
lint), `npm run check:openapi-drift`.

**Not covered, deliberately:** how precise the detection rules are.

---

## 7. Out of scope

- Content removal/hiding (§3.3; spec 029 keeps review removal).
- Stopping `eligible`/`processing` payouts or retries (§3.7; a future spec 024 change).
- Any AI anomaly-detection producer (only the flag-gated seam ships).
- Emergency-bypass moderation. A single admin's immediate protective measure is the medium-tier
  `restriction`.
- Automatic expiry of actions. Reversal is always explicit.
- Appeals of `booking_intervention`. Those parties use spec 031 or spec 032.
- Adding fraud signals to spec 037's operations queue.
- The safety-report workflow (spec 030) and dispute resolution (spec 031).

---

## 8. Dependencies, decisions, risks

### Dependencies

| Class | Items |
|---|---|
| **Approved and shipped, used as-is** | 003, 004, 005 (`revokeSession`), 008, 009, 015, 016/017, 018, 019, 020, 021, 022, 023, 024, 026, 027, 029, 030, 031, 033, 036 |
| **Draft, NOT required** | 039 (audit storage: the shipped helper is used), 041 (flags: env var per the spec 033 idiom). "Spec 070", cited by the original draft, **does not exist** and is not referenced |
| **Cross-spec changes that MUST be made during implementation (authorized)** | X-1 … X-7 (§3.17) |
| **Blocking** | none |

### Decisions (formerly open questions)

| # | Decision |
|---|---|
| OQ-1 | Account standing semantics and enforcement points are defined in §3.5. The enforcement code changes are the authorized X-1…X-5. |
| OQ-2 | `cancelDeletion` restores moderation standing, never an unconditional `active` (X-6, AC-11). Only §3.4 reversal produces `active` from a sanction. |
| OQ-3 | The MVP freeze holds Pass C and the summary only. `eligible`/`processing`/retry are normatively excluded (§3.7). Wider coverage would be a future spec 024 change. |
| OQ-4 | No FK on `safety_reports.restriction_moderation_action_id`. Integrity comes from the Spec 038-side FK, the partial unique index and a test (§3.16). |
| OQ-5 | Evidence limit is 10 (spec 030's value). The §3.9 tier/role table is normative. Rule thresholds are implementation-time env configuration, and rules are inactive until set (§3.6). |
| OQ-6 | Content removal is deferred. Spec 029 remains the only removal path. No second system (§3.3). |
| P-1 | X-7 is authorized. The pre-existing spec 035 omission in the same test is reported, not fixed. |

### Non-blocking assumptions

| # | Assumption |
|---|---|
| A-1 | The allow-list in §3.5 is the full set of routes a suspended/banned user may reach. Adding support (spec 032) later is an allow-list change only. |
| A-2 | `restricted` blocks the five marketplace entry points in X-3…X-5 only. Existing obligations continue. |
| A-3 | Accounts holding an `AdminProfile` are not moderatable through Spec 038. Admin access is withdrawn through spec 009 role revocation. |
| A-4 | `getAccountStanding` adds one indexed read per session-authenticated request (X-1). This is accepted at MVP scale. |
| A-5 | Warnings and restrictions take effect immediately (medium tier). Four-eyes applies from suspension upward, per master §70. |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | A rejected `pending_approval` row lingers | Lazy reconciliation under the target lock (§3.2) |
| R-2 | Account cascade overrides a provider's self-set `paused` | The previous value is stored and restored on reversal |
| R-3 | A freeze is read as total while `eligible` payouts still move | Normative boundary in AC-7/§3.7, tested |
| R-4 | The gate commits and spec 030's update then races | The origin partial unique index returns the same id on retry |
| R-5 | An X-1…X-6 edit breaks another spec's suite | The edits are additive and gated on non-`good` standing. Those suites use `active` users. Any failure is reported as caused by Spec 038, never "fixed" by weakening a test |

---

## 9. Rollout

- **Feature flag:** `AI_FRAUD_SIGNALS_ENABLED` (env, default off) gates only `ai_assisted`
  signals. The moderation mechanics, the standing enforcement and the rule sweep have no flag. Rules
  are inactive until their thresholds are configured.
- **Migration order:**
  - `0033` ships with the code;
  - `registerModerationIntegration()` runs from `instrumentation.ts` after specs 024/027/030;
  - the `.env.example` entries for the rule and flag variables ship with the code.
- **Rollback:**
  1. Revert the deploy. This returns the ports to their defaults and removes X-1…X-6.
  2. Run `0033_…_down.sql`.
  Lifecycle values already written stay as they are and are reported. Nothing reverts them
  silently.
- **Observability:** structured `moderation.*` / `fraud_signal.*` log lines, in the spec 024 JSON
  idiom:
  - action volume by type and tier;
  - pending-approval age;
  - appeal rate and uphold rate;
  - standing-refusal count by code;
  - signal dismiss-vs-action ratio per rule (master §117).
