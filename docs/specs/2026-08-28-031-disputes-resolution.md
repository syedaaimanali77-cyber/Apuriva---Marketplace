# Spec: Disputes & Resolution

**File:** `docs/specs/2026-08-28-031-disputes-resolution.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** — 
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §45, §47, §68, §69, §70, §72, §124 (Dispute entities), §132.17, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (the five `disputes*` baseline skeletons, `baseColumns()`, the
`bookings_status_transitions` trigger, the schema-lint rules), spec 004 (`withApiRoute`,
`apiSuccess`/`apiPaged`, `API_ERROR_CODES`, `RateLimitDomain`, `parsePageParams`, the OpenAPI
registry), spec 005 (`requireSession`, `requireCsrf`, `security_events`), spec 006
(`requireActiveMode`), spec 009 (`resolvePermission`, `recordAdminAuditEvent`, `authorizeAndInitiate`
— the last one only *indirectly*, through spec 022; see DECIDED-5), spec 020
(`requireBookingParticipant`, `applyBookingTransition`, `registerBookingTransitions`), spec 021
(`registerDisputeGate` — **the port this spec fills** — `setProtectionState`,
`nextProtectionState`, the protection window), spec 022 (`POST /api/v1/admin/refunds`, the
`refunds/override` high-tier four-eyes chain, `refunds.admin_action_id`), spec 023
(`escalated_to_dispute`, and the `RefundEligibilityGate` slot it already occupies), spec 024
(`evaluateEligibility`), spec 025 (`MESSAGE_BODY_MAX_LENGTH`, `applyContactPolicy`), spec 026
(`notify()`), spec 027 (`file_assets`, the `FileContextPolicy` registry and its already-reserved
`dispute_evidence` context), spec 029 (the `reviews/moderate` permission precedent), spec 030
(`safety_reports`, the escalation target), spec 033 (`completeAi`, `isAiDegradable`) — **all
verified in this repository while writing this document.**

**Feeds:** spec 038 (moderation actions arising from a dispute are its own, not this spec's), spec
039 (audit consolidation), spec 040 (dispute volume, resolution time and appeal-rate counters).

> **Repository-shape note (normative).** This repository is a **single Next.js application**. There
> is no `apps/web`, `apps/api`, `apps/web-e2e`, `packages/ui` or `packages/types`. API routes are
> `app/api/v1/**/route.ts`, domain logic is `lib/**`, DTOs are `lib/types/*.ts`, design-system
> primitives live in `ui/` and are re-exported through `@/components`, route-local components live
> in a `_components/` folder, and migrations are `drizzle/NNNN_*.sql` with a hand-written
> `_down.sql` sibling. The only test runner is **Vitest**, whose `include` is `**/*.test.{ts,tsx}`
> and `e2e/**/*.spec.{ts,tsx}`; there is no Playwright and no Cypress. The previous draft's
> `packages/types/src/disputes.ts`, `apps/api/disputes/**`, `apps/web/app/bookings/[id]/dispute`,
> `apps/web/app/admin/operations/disputes`, `apps/web-e2e/disputes.spec.ts` and the `packages/ui`
> `Timeline` / `EvidenceGallery` components **do not exist and are not created**; §3, §5 and §6 name
> their real counterparts.

> **Skeleton note (normative).** Unlike most specs, the five tables this spec needs **already
> exist**, seeded by `drizzle/0001_baseline_schema.sql` as spec 003 skeletons: `disputes`,
> `dispute_evidence`, `dispute_messages`, `dispute_resolutions` and `dispute_appeals`, each carrying
> `baseColumns()` (`id`, `created_at`, `updated_at`, `version`) plus its foreign keys and nothing
> else. Migration `0028` therefore **adds feature columns to existing tables**; it creates no table.
> The draft's column names were also wrong against the skeletons and are corrected here:
> `dispute_messages.sender_user_id` (not `sender_id`), `dispute_appeals.appellant_user_id` (not
> `filed_by_user_id`).

---

## 1. Problem statement

**Today:** No dispute workflow exists. Verified in this repository: the five `disputes*` tables are
spec 003 skeletons with no status, no reason, no decision and no linkage beyond their foreign keys;
`bookings.status` admits `disputed` and `lib/bookings/read.ts` already offers a `disputed` filter
that can never match a row; `payments.protection_state` admits `disputed` and
`lib/payments/protection-window.ts` already ships a **`DisputeGate` port** whose own comment says
"Spec 031 registers the real gate when it ships" and whose inert default answers "no booking is ever
disputed"; spec 027's `file_assets.context_type` already admits `dispute_evidence` but
`lib/files/contexts/policies.ts` deliberately leaves it unregistered, so an upload is `422
FILE_CONTEXT_NOT_AVAILABLE`; and spec 023's no-show resolution already has an
`escalated_to_dispute` outcome whose comment says "spec 031 owns whatever comes next". Five live
seams, all inert, all waiting for this spec.

**Who is affected:** Customers and providers in disagreement over a booking's outcome; Trust &
Safety admins, who master §69 makes the owner of "Reports, disputes, safety"; Operations admins, who
need visibility into a booking's dispute without the power to decide it; Finance admins, who own
every refund; and spec 024's payout pipeline, which must not pay out money that is under argument.

**Why it matters now:** It is the formal escalation path for every transactional disagreement the
shipped specs already produce — a cancellation fee (023), a confirmed-but-contested no-show (023),
a quality complaint after completion (028), a protection window about to release money (021). Each
of those specs stops at the point of disagreement and names this one.

**Success looks like:** Either participant can open a dispute on a booking that is still inside its
payment-protection window, attach evidence and exchange messages with the other side; the money
stops moving for exactly as long as the dispute is live; a named Trust & Safety admin decides it
with a recorded reason; any refund that follows goes through spec 022's existing four-eyes override
and nowhere else; a party who disagrees has one appeal to a different admin; and nothing automated —
least of all the AI assistant — ever decides an outcome or moves a cent.

### What this spec owns, and what it deliberately does not

**Owns:** the `Dispute` record and its five-state lifecycle; `DisputeEvidence`, `DisputeMessage`,
`DisputeResolution` and `DisputeAppeal`; the `dispute_evidence` file-context policy; the
registration of spec 021's `DisputeGate`; the two booking transitions `protected -> disputed` and
`disputed -> protected`; the three `disputes/*` permissions; the customer/provider dispute route and
the Trust & Safety dispute queue; and the **refund request** a resolution may carry — a proposal,
never an execution.

**Does not own, and does not modify:**

| Concern | Owner | How this spec relates to it |
|---|---|---|
| Booking lifecycle and the transition primitive | spec 020 | Reused verbatim. This spec registers **two** pairs through `registerBookingTransitions('spec 031 (disputes)', …)` and seeds them into `bookings_status_transitions`, exactly as specs 021/022/023 already do. It writes `bookings.status` only through `applyBookingTransition()`. |
| Payment state, capture, the protection window and its duration | spec 021 | Read-only except for **one** call: `setProtectionState()`, spec 021's own exported, version-guarded primitive, moving `held -> disputed` when a dispute opens and `disputed -> held` when it closes. No amount, no capture, no provider call, no new column. The window's length and start instant stay spec 021's. |
| Refund creation, amounts, provider calls, reconciliation, the financial invariants I-1..I-4 | spec 022 | **Untouched.** This spec creates no `refunds` row, calls no payment provider, and computes no amount arithmetic. A resolution records a *proposed* refund; a Finance Admin then initiates it through the existing `POST /api/v1/admin/refunds`, and a second admin approves it. See DECIDED-5. |
| The `RefundEligibilityGate` | spec 023 | **Already occupied.** `lib/cancellation/index.ts` registers it; the slot is single-valued. This spec never registers, replaces or wraps it, and therefore never reaches the automatic refund path at all. |
| Cancellation policy, fee tiers, the no-show workflow | spec 023 | Read-only. `escalated_to_dispute` is spec 023's outcome; this spec offers the route a party takes next, and spec 023's own comment confirms that outcome changes nothing financial. |
| Payout eligibility, earnings, transfers, the `PayoutHoldGate` | spec 024 | **Untouched, and this spec registers no payout gate.** The hold is achieved entirely through spec 021's protection state, which `evaluateEligibility()` already rejects as `protection_not_released`. `PayoutHoldGate` is spec 038's slot and stays empty here. See DECIDED-5. |
| Conversations, booking chat, message retention, admin conversation reads | spec 025 | Not extended. Dispute messages are a **separate, admin-visible-by-design record** (DECIDED-7), but they reuse spec 025's `MESSAGE_BODY_MAX_LENGTH` and `applyContactPolicy()` rather than inventing a second prose bound or a second contact filter. |
| Notification delivery, channels, preferences | spec 026 | Reused through `notify()`. Three content-free types are added to the existing catalogue; no new notification system, no new category, and no migration (notification *type* is not a database CHECK — only `category` is). |
| File upload, scanning, storage, signed URLs, deletion, retention sweeps | spec 027 | Reused wholesale. One context policy is registered for the already-reserved `dispute_evidence` value. **No** second storage system and no new media route. |
| Review content and its moderation queue | spec 029 | Not touched. A bad review is not a dispute; a dispute does not remove a review. |
| Blocking, safety reports, restrictions, bans | spec 030 / spec 038 | One-way escalation only (DECIDED-9). This spec files a safety report through spec 030's existing path and stops there. It applies no sanction, writes no `users.lifecycle_status`, and creates no appeal path for a *moderation action* — master §68's action appeal is spec 038's. |
| AI provider, prompts, quota, usage accounting | spec 033 | Consumed only through `completeAi()`, only for **non-binding** assistance (DECIDED-8). |
| Admin role/permission model, risk tiers, four-eyes approval, audit storage | spec 009 → 039 | Reused verbatim: three new `permissions` rows checked with `resolvePermission()`, and `recordAdminAuditEvent()` → `security_events`. Spec 039 has not shipped (there is no `lib/audit`), so this spec writes through spec 009's function exactly as specs 023/025/029/030 do. **No second RBAC and no second audit framework.** |

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a booking whose status is `protected` and whose payment protection state is `held` **When** either participant opens a dispute with a reason **Then** exactly one `disputes` row is created at status `open`, linked to that booking and to the opener, and a second concurrent attempt on the same booking is refused `409 DISPUTE_ALREADY_OPEN`; any other booking or protection state is refused `422 DISPUTE_NOT_ELIGIBLE` |
| AC-2 | **Given** a dispute that is not yet `closed` **When** spec 021's payment sweep or spec 024's payout eligibility runs **Then** the payment's protection state is `disputed`, `evaluateEligibility()` answers `protection_not_released`, and no payout is created — **without this spec writing a single payouts column** |
| AC-3 | **Given** a dispute with evidence and messages from both sides **When** a Trust & Safety admin resolves it **Then** a single `dispute_resolutions` row records the decision, the mandatory reasoning, the resolving admin and the instant, the dispute moves to `resolved`, and `recordAdminAuditEvent()` writes the actor, roles, target, reason and correlation id |
| AC-4 | **Given** a `resolved` dispute **When** a participant appeals within the appeal window **Then** at most one `dispute_appeals` row is created, the dispute moves to `appealed`, the money stays held, and the appeal can be decided **only** by an admin whose user id differs from the original resolver's — anyone else is refused `403 APPEAL_REQUIRES_DIFFERENT_ADMIN` |
| AC-5 | **Given** a resolution that calls for money to go back to the customer **When** it is recorded **Then** it stores a *proposed* refund amount and reason only; the refund itself is created **exclusively** by spec 022's `POST /api/v1/admin/refunds` override chain (Finance initiates, a second admin approves), and **no code in this spec ever inserts a `refunds` row, calls a payment provider, or writes a `payouts` column** |
| AC-6 | **Given** the AI assistant is used anywhere in this flow **When** it produces a summary of evidence or messages **Then** that output is advisory only, is stored in a clearly-labelled column no decision reads, never sets a status, a decision, an amount or an appeal outcome, and any AI failure changes nothing — resolution is reachable only through a human admin route |
| AC-7 | **Given** a dispute reaches `closed` **When** closure is applied **Then** the booking returns `disputed -> protected`, the payment returns `disputed -> held`, spec 021's sweep resumes normally, and `closed` is terminal — no transition leaves it and no second dispute may be opened on that booking |

> AC-1 is deliberately narrower than the previous draft's "a completed or in-progress booking".
> An `in_progress` booking has not produced an outcome to disagree about, and a `settled` booking's
> money has already been released. The one window in which a dispute can still do what AC-2 promises
> is the payment-protection window, which is exactly `status = 'protected'` and
> `protection_state = 'held'` (DECIDED-1).
>
> AC-5 is deliberately narrower than the previous draft's "any resulting refund/payout action".
> A Trust & Safety admin **cannot** initiate a refund in this repository: migration `0018` seeds
> `refunds/override` to `finance_admin` and `super_admin` only. The resolution therefore proposes;
> Finance disposes (DECIDED-5).

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing mechanism (verified in this repository) |
|---|---|
| Response envelope, correlation id, error mapping | `withApiRoute` + `apiSuccess`/`apiPaged`/`apiError` (`lib/api/handler.ts`, `lib/api/response.ts`) |
| Error taxonomy | `ApiRouteError` + `API_ERROR_CODES` (`lib/api/errors.ts`); domain codes pass an explicit `status` |
| Session / CSRF | `requireSession`, `requireCsrf` (`lib/auth/require-session.ts`, `lib/auth/csrf.ts`) |
| Active mode | `requireActiveMode(session, 'customer' \| 'provider')` (`lib/auth/require-mode.ts`) |
| Booking participation | `requireBookingParticipant(userId, bookingId, preferRole?, tx?)` (`lib/bookings/read.ts`) — which already answers `404` rather than `403` to a non-participant, the privacy behaviour §3 "Privacy" requires |
| Booking transitions | `applyBookingTransition()` + `registerBookingTransitions()` (`lib/bookings/state-machine.ts`), with the pairs seeded into `bookings_status_transitions` so spec 003's trigger is the independent second line of defence |
| Protection state | `setProtectionState(tx, { paymentId, from, to, expectedVersion })` (`lib/payments/record.ts`) — version-guarded, returns `false` on a lost race |
| The dispute port itself | `registerDisputeGate()` (`lib/payments/protection-window.ts`) — **already shipped, inert** |
| Idempotency | `requireIdempotencyKey` + `idempotencyFingerprint` (`lib/api/idempotency.ts`), stored per entity |
| Pagination | `parsePageParams` / `buildPage` (`lib/api/pagination.ts`) |
| Rate limiting | `checkRateLimit(domain, identifier)` (`lib/api/rate-limit.ts`) |
| Admin authorization | `resolvePermission(userId, resource, action)` (`lib/admin-rbac/permissions.ts`) behind `requireDispute*Permission()` helpers — the shape `lib/no-show/resolution.ts`, `lib/reviews/permissions.ts` and `lib/safety/permissions.ts` already use |
| Four-eyes approval for money | `authorizeAndInitiate()` / `executeApprovedAction()` (`lib/admin-rbac/actions.ts`) — reached **only** through spec 022's `POST /api/v1/admin/refunds`, never called by `lib/disputes/**` |
| Admin audit | `recordAdminAuditEvent()` (`lib/admin-rbac/audit.ts`) → `security_events` |
| Evidence | spec 027's whole pipeline: `POST /files/upload-url`, `POST /files/{id}/finalize`, `GET /files/{id}`, `GET /files/{id}/content`, `DELETE /files/{id}` |
| Prose bound and contact filtering | `MESSAGE_BODY_MAX_LENGTH` (`lib/messaging/limits.ts`) and `applyContactPolicy()` (`lib/messaging/contact-gate.ts`) |
| Notifications | `notify()` (`lib/notifications`), existing category `booking` |
| Safety escalation | `POST /api/v1/safety-reports` and spec 030's `safety_reports` record |
| AI | `completeAi()` from `@/lib/ai`, task `summarization` (already a member of `AI_TASKS`, already admitted by `ai_usage_events_task_ck`) |
| OpenAPI | every route added to `OPENAPI_ROUTES` (`lib/api/openapi-registry.ts`); `npm run check:openapi-drift` fails CI otherwise |

### Repository paths (normative)

| Draft said | Actual path |
|---|---|
| `packages/types/src/disputes.ts` | `lib/types/disputes.ts` |
| `apps/api/disputes/**` | `lib/disputes/**` + `app/api/v1/**/route.ts` |
| `apps/web/app/bookings/[id]/dispute` | `app/bookings/[id]/dispute` |
| `apps/web/app/admin/operations/disputes` | `app/admin/operations/disputes` |
| `apps/web-e2e/disputes.spec.ts` | `e2e/disputes.spec.ts` |
| `packages/ui` `Timeline`, `EvidenceGallery` | `@/components` — `RequestStatusTimeline`, `Card`, `Badge`, `Button`, `EmptyState`, `ErrorState`, `Skeleton`, `ListRow`. **No new design-system primitive is added.** |

New modules: `lib/disputes/{index,transitions,limits,permissions,errors,validation,create,read,messages,evidence,evidence-policy,resolve,appeal,close,gate,ai-assist,escalate,notifications,rows}.ts`.

> Two notes on that list, recorded at implementation time. There is no separate `eligibility.ts`:
> the pure predicate `evaluateDisputeEligibility()` lives in `create.ts` beside the only caller that
> can act on it, because eligibility must be evaluated **under the booking and payment row locks**
> and a module boundary there would invite a caller to read it unlocked. `evidence.ts` (the
> `dispute_evidence` linkage rows and the legal-hold stamp) is separate from `evidence-policy.ts`
> (the spec 027 `FileContextPolicy`), mirroring how spec 030 splits `evidence.ts` from
> `evidence-policy.ts`. `validation.ts` holds the request parsers, as in specs 029 and 030.

### Dispute eligibility (AC-1) — normative (DECIDED-1)

A dispute may be opened when **all** of the following hold, evaluated inside one transaction while
holding the booking row and then the payment row `FOR UPDATE`, in spec 022's established
`bookings -> payments` lock order:

1. the caller is a participant of the booking, per `requireBookingParticipant()` — the customer or
   the provider, in **either** active mode (a disagreement is not role-scoped, and forcing a mode
   switch at that moment is a barrier at exactly the wrong time);
2. `bookings.status = 'protected'`;
3. the booking's payment has `protection_state = 'held'`;
4. no non-`closed` dispute already exists for that booking.

Anything else is `422 DISPUTE_NOT_ELIGIBLE`; (4) failing is `409 DISPUTE_ALREADY_OPEN`.

**Why this window, and why it is not an invented number.** The draft left "how long after booking
completion can a dispute be opened" open. It does not need a new constant: the repository already
has exactly one deadline that separates "the money can still be stopped" from "the money is gone",
and it is spec 021's protection window — `DEFAULT_PROTECTION_WINDOW_HOURS = 48`, per-payment
configurable, bounded 1..720 by `isValidProtectionWindowHours()`, and started from the `occurred_at`
of the booking's `in_progress -> completed` history row rather than from a sweep's observation.
Binding dispute eligibility to it means:

- AC-2 is **always** satisfiable — a dispute can never be opened too late to hold the payout,
  because the moment it could be is the moment eligibility ends;
- there is no second deadline to configure, document, or drift out of sync with the first;
- the rule is checkable under a row lock, so the boundary is exact rather than approximately right.

`completed` is deliberately not eligible even though it precedes `protected`: it is transient (spec
021's sweep moves `completed -> protected` and opens the window in the same pass) and has no
`protection_state` to hold, so a dispute opened there would have nothing to freeze. `settled`,
`cancelled`, `refunded` and `failed` are not eligible because the money has already left, been
returned, or never arrived; those are support matters, not disputes. A party who misses the window
still has spec 030's safety path for a safety concern and spec 038's moderation path for misconduct.

**Duplicate disputes are impossible, at the database.** A partial unique index —
`disputes_booking_open_uq ON disputes (booking_id) WHERE status <> 'closed'` — means at most one
live dispute per booking regardless of concurrency, and `closed` being terminal (AC-7) means a
booking gets at most one dispute over its whole life, because after closure no booking state is ever
eligible again.

### Dispute lifecycle (AC-1, AC-3, AC-4, AC-7) — normative (DECIDED-3)

```
   open ──claim──▶ under_review ──resolve──▶ resolved ──appeal──▶ appealed
     │                   │                      │                     │
     └────resolve────────┘                      │                     │
                                          close │                     │ decide_appeal
                                                ▼                     ▼
                                             closed  ◀────────────  closed   (terminal)
```

| From | To | Who | Guard |
|---|---|---|---|
| `open` | `under_review` | admin with `disputes/resolve` | records `claimed_by_admin_user_id`; a second claimer is `409 CONFLICT` |
| `open` | `resolved` | admin with `disputes/resolve` | claiming is not mandatory; resolving directly is one step, not two |
| `under_review` | `resolved` | admin with `disputes/resolve` | writes the single `dispute_resolutions` row |
| `resolved` | `appealed` | either participant | within the appeal window; at most once |
| `resolved` | `closed` | the appeal-expiry sweep, or a participant waiving the appeal | only when the appeal window has elapsed or been waived **and** any proposed refund has reached a terminal state |
| `appealed` | `closed` | admin with `disputes/review_appeal`, different user from the resolver | the appeal decision is final |

Every other pair is refused. `closed` is **terminal**: it has no outgoing transition, a `closed`
dispute is never reopened, and — because eligibility requires `protected` + `held`, which closure
restores but which spec 021's sweep then releases — no second dispute can follow it. A genuinely new
problem after closure is a safety report (spec 030) or a moderation report (spec 038), both of which
are independently auditable and leave the original finding intact. This matches how the repository
already treats closed findings: spec 030's `resolved` and spec 023's `resolved`/`withdrawn` are
terminal for the same reason.

**`closed` is the single financially-final state.** The `DisputeGate` this spec registers answers
`{ open: true }` for `open`, `under_review`, `resolved` **and** `appealed`, and `{ open: false }`
only for `closed`. A resolution alone therefore releases nothing: the money stays held through the
whole appeal window, which is what makes AC-4's "the money stays held" true without a second
mechanism.

### Resolution ownership and authorization (AC-3, AC-4) — normative (DECIDED-2)

The draft left this "Open — recommend routing by dispute category". The master specification is
already decisive and no routing rule is needed: **§69 assigns "Reports, disputes, safety" to the
Trust & Safety Admin** and "Requests, bookings, providers" to the Operations Admin. Disputes are
named in the Trust & Safety line and absent from the Operations line, so Trust & Safety decides and
Operations watches.

Migration `0028` seeds exactly three permissions, following the `0019`/`0026`/`0027` shape:

| Resource | Action | Risk tier | Roles |
|---|---|---|---|
| `disputes` | `read` | `low` | `operations_admin`, `trust_safety_admin`, `super_admin` |
| `disputes` | `resolve` | `medium` | `trust_safety_admin`, `super_admin` |
| `disputes` | `review_appeal` | `medium` | `trust_safety_admin`, `super_admin` |

- **View:** `disputes/read`. Operations gets it because §2970 lists Disputes under the Operations
  nav and a booking's dispute is booking context they legitimately need; they cannot decide one.
  `finance_admin` is **not** granted `disputes/read` — Finance sees the refund request through spec
  022's own `refunds/read`, which already carries the amount, the reason and the approval chain, and
  does not need the evidence or the private messages.
- **Resolve:** `disputes/resolve`, Trust & Safety and Super Admin only. Both can resolve; there is
  no category routing, because there is no category to route on — a dispute is by definition a
  transactional disagreement (safety concerns leave through DECIDED-9).
- **Risk tier / approval:** `medium` — master §70's "Authorized admin + reason/audit". A reason is
  mandatory on every resolve and every appeal decision, and every one is audited. The resolution
  itself moves **no money**, so it does not meet §70's "high risk" bar; the money movement it may
  propose is spec 022's `refunds/override` at `high`, which already carries second-admin approval.
  Layering a second four-eyes flow on top of that would gate the same decision twice.
  `lib/disputes/**` therefore **never calls `authorizeAndInitiate()`**.
- **Resolver identity:** recorded on `dispute_resolutions.resolved_by_admin_user_id` (a `users.id`
  FK, not an `admin_profiles.id` — the draft's `fk->AdminProfile` is corrected, because
  `recordAdminAuditEvent()` and `resolvePermission()` both key on the user id, and every other
  admin-decision table in this repository does the same).
- **Self-dealing is refused.** An admin who is the booking's customer or provider, or who opened the
  dispute, or who filed the appeal, is refused `403 DISPUTE_PARTICIPANT_CONFLICT` on every admin
  route in this spec — read included. The check is a participation query on the booking, not a role
  check, so it holds however the admin acquired the role.
- **The appeal reviewer must be a different person.** Enforced by comparing the caller's user id to
  `dispute_resolutions.resolved_by_admin_user_id`; equal is `403
  APPEAL_REQUIRES_DIFFERENT_ADMIN`. This is the same rule spec 009's `decideAction()` applies as
  `SELF_APPROVAL_NOT_ALLOWED`, applied here to a decision spec 009 does not mediate.

### Appeal rules (AC-4) — normative (DECIDED-4)

| Question | Answer |
|---|---|
| Who may appeal | Either participant of the booking — **not only the dispute's opener**. A resolution can go against the party who did not open it. |
| Window | `DISPUTE_APPEAL_WINDOW_DAYS`, default **7**, bounds 1..30, read from the environment with a documented default — the idiom spec 029 (`DEFAULT_REVIEW_WINDOW_DAYS`), spec 021 (`PAYMENT_AUTHORIZATION_WINDOW_MINUTES`) and spec 008 (`DELETION_GRACE_PERIOD_DAYS`) already use. Not a feature-flag system; spec 041 owns that. Measured from `dispute_resolutions.resolved_at`. Expired is `422 APPEAL_WINDOW_CLOSED`. |
| How many | **Exactly one per dispute**, enforced by `dispute_appeals_dispute_uq UNIQUE (dispute_id)`. A second attempt is `409 APPEAL_ALREADY_FILED`, whoever files it. One appeal is master §68's "Appeal/review mechanism"; an unbounded chain is not. |
| The original resolution while an appeal is pending | **Stands and is unchanged.** `dispute_resolutions` is append-only and immutable once written. The appeal decision does not edit it — it records its own outcome on `dispute_appeals`, and the pair is the history. Financially, nothing is released while the dispute is `appealed`, because the gate still answers `open: true`. |
| Required reason / evidence | Reason is **required**, 10..2000 characters (the same bounds spec 030 uses for an admin reason). Evidence is optional and uses the same `dispute_evidence` context; the appellant may attach up to the same per-dispute cap. |
| Reviewer | An admin holding `disputes/review_appeal` whose user id differs from the resolver's, and who is not a participant. |
| Outcome | `dispute_appeals.outcome ∈ ('upheld','overturned','partially_upheld')` plus a mandatory reasoning. `upheld` means the original resolution stands. `overturned` and `partially_upheld` may carry a **new proposed refund** on the appeal row, handled exactly as a resolution's proposal is (DECIDED-5) — the appeal never moves money either. |
| Terminal state | Deciding the appeal moves the dispute straight to `closed`. There is no appeal of an appeal. |
| Audit | `disputes.appeal_filed`, `disputes.appeal_read`, `disputes.appeal_decided` — every one through `recordAdminAuditEvent()`, carrying actor, roles, target, reason and correlation id. |

### Financial ownership (AC-2, AC-5) — normative (DECIDED-5)

**This is the section that must not be got wrong, so it is stated as prohibitions first.**
`lib/disputes/**` must contain: no `INSERT INTO refunds`, no `INSERT INTO payouts`, no
`UPDATE payments SET status`, no call to `resolvePaymentProvider()` or any provider method, no
amount arithmetic beyond validating that a proposed amount is a positive integer in the booking's
currency, and no call to `registerRefundEligibilityGate` or `registerPayoutHoldGate`. A
source-level boundary test enforces this (§6), mirroring spec 022's `no-policy-leak.test.ts`.

**How a dispute blocks payout — a gate, not ownership.** The chain is entirely pre-existing and this
spec adds one link to it:

```
dispute not closed
  └─▶ DisputeGate answers { open: true }                     ← the ONE thing this spec registers
        └─▶ spec 021 nextProtectionState() → 'disputed'      ← spec 021's pure function, unchanged
              └─▶ payments.protection_state = 'disputed'     ← spec 021's setProtectionState()
                    └─▶ spec 024 evaluateEligibility()
                          → { eligible: false, reason: 'protection_not_released' }
                                └─▶ no payout row is created ← spec 024, untouched
```

This spec writes **no payouts column and no payouts row**, and registers **no** `PayoutHoldGate` —
that slot belongs to spec 038 and stays empty here. Verified: `evaluateEligibility()` rejects
anything whose `protectionState !== 'released'` before it looks at anything else, so the block is
structural rather than a rule this spec has to remember to apply.

Opening a dispute does not merely wait for the sweep: inside the opening transaction, under the
payment lock it already holds, it calls spec 021's `setProtectionState(tx, { from: 'held', to:
'disputed', expectedVersion })`. A `false` return means another writer won the race and the whole
transaction rolls back with `422 DISPUTE_NOT_ELIGIBLE` — which is the correct answer, because the
only writer that could have won is the sweep releasing the window. Closure performs the mirror call,
`disputed -> held`, and spec 021's sweep then releases and settles as it always would; if the window
has long since elapsed, that happens on the next tick, so a provider is paid promptly once the
argument ends.

**How a resolution reaches a refund — a proposal, then spec 022's existing chain.**
Migration `0018` seeds `refunds/override` to `finance_admin` and `super_admin` **only**, so a Trust
& Safety admin resolving a dispute is structurally incapable of creating a refund. The flow is
therefore three-eyes and uses no new mechanism:

1. **Propose (this spec).** The resolving T&S admin sets `decision = 'refund_customer'` or
   `'partial_refund_customer'` and supplies `proposed_refund_amount_minor_units` +
   `proposed_refund_currency_code` + the mandatory reasoning. A `dispute_resolutions` row is
   written. **No refund exists.** Validation here is shape-only: positive integer, ISO-4217
   three-letter uppercase code equal to the booking's currency, and not greater than the payment's
   captured amount — the last checked by reading spec 022's `readRefundablePosition()`, never by
   recomputing it.
2. **Initiate (spec 022).** A Finance Admin calls the existing
   `POST /api/v1/admin/refunds` with `{ bookingId, amountMinorUnits, currencyCode, reason }`. Spec
   022 routes it through `authorizeAndInitiate()` on `(refunds, override)` at tier `high` and
   answers `202` with an `adminActionId`. This spec stores that id on
   `dispute_resolutions.refund_admin_action_id` (FK → `admin_actions`), which is the only linkage it
   holds. The draft's `refund_id uuid fk->Refund` is **wrong and removed**: no `refunds` row exists
   at proposal time, and spec 022 creates none until approval executes.
3. **Approve and execute (spec 009 + spec 022).** A second, distinct Finance or Super Admin approves;
   spec 022's `executeApprovedRefund()` creates the `refunds` row, calls the provider and reconciles.
   The concrete refund is discoverable at any later time by joining
   `refunds ON refunds.admin_action_id = dispute_resolutions.refund_admin_action_id` — an existing,
   indexed column (`refunds_admin_action_id_idx`). **No column is added to `refunds`.**

Partial and full refunds are both expressible; the amount is **supplied** by the T&S resolver as a
proposal and **approved** by the two Finance/Super admins in spec 022's chain, so the person who
judges the dispute is never the person who authorizes the money.

**Refund provider outcomes.** Spec 022 already defines these and this spec adds no handling of its
own; it only refuses to close early:

| Refund status | Dispute behaviour |
|---|---|
| none proposed | closure proceeds as soon as the appeal window elapses |
| `requested` / `processing` (including spec 022's `unknown` provider result, which deliberately **stays** `processing`) | closure is refused `422 DISPUTE_REFUND_PENDING`; the dispute stays in `resolved`/`appealed`, the gate stays open, protection stays `disputed`, and spec 022's reconciliation sweep resolves it. Money never sits ambiguous *and* released at the same time. |
| `completed` | closure proceeds. If the refund was full, spec 022 has already moved the booking `-> refunded` on its own authority; the dispute then closes without attempting `disputed -> protected` (nothing to return), and the gate answering `closed` is the whole of closure. |
| `failed` | closure proceeds and the dispute closes, because the failure is spec 022's to retry or escalate and holding the dispute open would not help. A `disputes.refund_failed` audit event is written and Finance is notified through spec 022's existing `refund_failed` path. |
| proposed but never initiated by Finance | closure is refused `422 DISPUTE_REFUND_PENDING` until Finance either initiates it or the resolving admin records a superseding resolution decision. The dispute cannot close having promised money nobody sent. |

**Payout after resolution.** Nothing special happens: closure restores `protection_state = 'held'`,
spec 021's sweep releases it and moves `protected -> settled`, and spec 024's ordinary eligibility
then admits the payout — reduced automatically, because a partial refund leaves the payment
`partially_refunded` and spec 024 already computes earnings from the net captured position. A full
refund leaves the payment `refunded`, which `evaluateEligibility()` rejects as
`payment_not_payable`, so no payout is ever created for fully refunded money. **This spec does none
of that arithmetic.**

### Evidence (AC-3) — normative (DECIDED-6)

Spec 027 already reserves `dispute_evidence` in `file_assets_context_type_ck` and deliberately
leaves it unregistered, so uploads are `422 FILE_CONTEXT_NOT_AVAILABLE` today. This spec registers
one `FileContextPolicy` for it — in `lib/disputes/evidence-policy.ts`, **not** in `lib/files/`,
because `lib/files/boundaries.test.ts` forbids a consuming spec's business rules from entering spec
027's source. The pattern is spec 030's `lib/safety/evidence-policy.ts`, verbatim.

- **Context id** is the **dispute id**. The dispute is created first (one POST), then evidence is
  attached; the UI performs both behind one submit, exactly as spec 030 does.
- **`publicEligible: false`** — dispute evidence is never public, in any circumstance.
- **`allowedKinds: ['image','document','video']`** — whatever the party actually has.
- **`maxPerContext: MAX_DISPUTE_EVIDENCE = 10`**, per dispute across both parties, matching spec
  030's cap for the same reason: narrowing it discards evidence.
- **Upload authorization:** a participant of the dispute's booking, and only while the dispute's
  status is `open`, `under_review` or `appealed`. Evidence cannot be bolted onto a case after it is
  decided (`resolved`) or after it is over (`closed`) — except during `appealed`, which is precisely
  the stage that exists to admit new material.
- **Read authorization:** **both participants read each other's evidence.** This is the deliberate
  and load-bearing difference from spec 030, where the reported user never learns a report exists.
  A dispute is adversarial-but-mutual: master §2.3's explainability and basic fairness both require
  that a party can see what is being argued against them. A participant who cannot see the evidence
  cannot meaningfully appeal. An admin holding `disputes/read` also reads, and **that read is
  audited before the bytes are disclosed**, the pattern spec 025's `messageAttachmentPolicy` and
  spec 030's `safetyEvidencePolicy` established. Nobody else reads: not other users, not admins
  without the permission, and not an admin who is a participant.
- **Immutability and deletion:** a `dispute_evidence` row is never updated. Deletion is refused
  while the dispute is not `closed` — spec 027's `DELETE /files/{id}` consults the context policy,
  and this policy answers "no" for any asset whose dispute is live, so a party cannot withdraw
  evidence mid-argument. After closure, deletion follows spec 027's ordinary rules **subject to the
  legal hold below**.
- **Legal hold / retention.** Dispute evidence is financial-decision material. `disputes.legal_hold`
  (boolean, default `false`) may be set by an admin with `disputes/resolve`; while true, spec 027's
  deletion sweep and spec 008's account-deletion anonymization both skip the dispute's assets, and
  the existing `lib/privacy/file-asset-storage.ts` hold mechanism is reused rather than duplicated.
  With no hold, evidence follows spec 027's normal retention. This spec defines **no storage, no
  scanning, no signed-URL issuance and no sweep of its own.**

### Dispute messages (AC-3) — normative (DECIDED-7)

**Why they are separate from spec 025's booking chat, and not merely asserted to be.** Three
concrete, verifiable differences, any one of which would be a breaking change to spec 025:

1. **Admin visibility is the default here and the exception there.** Spec 025 gates admin
   conversation reads behind `messaging/read_conversation` *and* a 10–500 character justification
   query parameter, and audits each one, precisely because reading a private conversation is
   intrusive. A dispute message is written *to be read by the deciding admin* — that is its purpose.
   Putting it in a `conversations` row would either weaken spec 025's justification rule for
   everyone or force a per-conversation exception into spec 025's access resolver.
2. **Retention differs.** Spec 025 has a message-retention sweep
   (`app/api/v1/cron/message-retention-sweep`) that deletes old messages. Dispute messages are
   evidence in a financial decision and are retained with the dispute under the same legal-hold rule
   as evidence. Two retention policies cannot live on one table without giving spec 025's sweep a
   dispute-shaped special case.
3. **Lifecycle differs.** A conversation is tied to a booking and archives with it; dispute messages
   are tied to a dispute, open when it opens and freeze when it closes.

**What is reused rather than rebuilt:** `MESSAGE_BODY_MAX_LENGTH` (2000) as the body bound, and
`applyContactPolicy(body, contactSharingAllowed = true)` for contact-information handling. Because
a dispute only exists on a `protected` booking — long past `confirmed` — spec 025's own rule puts it
unambiguously in the **flag, never mask** branch: the body is stored verbatim and
`contact_flagged` is set as a Trust & Safety signal. Redacting evidence would be wrong. No second
detector, no second bound, no second sanitizer.

| Question | Answer |
|---|---|
| Participant access | Both participants read **all** dispute messages, including the other side's and including an admin's, and may post while the dispute is `open`, `under_review` or `appealed`. Posting in `resolved` or `closed` is `422 DISPUTE_NOT_OPEN`. |
| Admin access | An admin with `disputes/read` reads; an admin with `disputes/resolve` may also post, flagged `is_admin = true` so the parties can see an official message is official. **No justification parameter is required**, for the reason in (1) above — but every admin read and post is audited. |
| Limits | Body 1..`MESSAGE_BODY_MAX_LENGTH`. `MAX_DISPUTE_MESSAGES = 200` per dispute across all authors, refused `422 DISPUTE_MESSAGE_LIMIT_REACHED`. Rate limited on the new `disputes` domain (30 / 60 s), keyed by user id. |
| Contact filtering | `applyContactPolicy` in flag mode, per above. |
| Read behaviour | Paged with `parsePageParams`/`buildPage`, oldest first, so the thread reads as a record. **No read receipts and no unread counts** — those are spec 025's conversation features and are not reproduced. |
| Immutability | Append-only. No edit route, no delete route, no soft-delete column. A dispute message is a statement made in a proceeding. |
| Audit and retention | Participant posts are ordinary application data and are not individually audited (auditing every user utterance would drown spec 009's `security_events`); **admin reads and admin posts are audited** as `disputes.messages_read` / `disputes.admin_message_posted`. Retention follows the dispute and the legal hold. |
| After resolution and appeal | Frozen at `resolved` (read-only), reopened for posting at `appealed`, frozen permanently at `closed`. |

### AI boundary (AC-6) — normative (DECIDED-8)

Master §132.17 and §2097 ("Restricted — Human/admin: … Serious disputes") are satisfied
**structurally, not by policy text**, the way spec 030 satisfies them. `lib/disputes/ai-assist.ts`
exposes one function that takes a string and returns `string | null`. It has no database access, no
transaction, no status argument, no amount argument and no return path into any decision. The
resolution, appeal, transition and refund-proposal functions in this spec **take no AI-derived
parameter**, so there is no interface through which an AI verdict could reach one even by mistake.

| AI may | AI may **never** |
|---|---|
| Summarize the dispute's evidence filenames/kinds and message thread into a short advisory brief for the admin queue | Set or suggest a `status`, a `decision`, an appeal `outcome`, or any transition |
| Be stored in `disputes.ai_summary`, a column **no decision path reads** and which is never returned to a participant | Set, suggest, or influence `proposed_refund_amount_minor_units` or any currency value |
| Fail, be disabled, be rate-limited, be over quota, or time out — all of which produce `null` | Trigger a payout, a refund, an escalation, a restriction or any enforcement |
| | Appear in any participant-facing DTO |

It uses the existing `summarization` task — already in `AI_TASKS`, already admitted by
`ai_usage_events_task_ck` — so **no spec 033 migration is required** and no vocabulary is invented.
The call passes `subject: { kind: 'system', label: 'dispute_triage_summary' }`: it is
platform-initiated and must not consume a participant's quota for assistance they never asked for.
Degradation is total and silent, via `isAiDegradable()`; an AI outage never blocks opening,
resolving, appealing or closing a dispute.

### Safety boundary (AC-3) — normative (DECIDED-9)

Spec 030 §1 already states the direction: "a safety concern arising from a dispute escalates here,
not the reverse". This spec implements exactly that seam and nothing more.

`POST /api/v1/admin/disputes/{id}/escalate-safety` lets an admin holding **both** `disputes/resolve`
and spec 030's `safety_reports/read` file a safety report about a named participant, with a
mandatory reason. It calls spec 030's existing report-creation path; it does **not** insert into
`safety_reports` directly, does not set a priority, does not restrict anyone, does not write
`users.lifecycle_status`, and creates no moderation action. The dispute records
`disputes.escalated_safety_report_id` (nullable FK → `safety_reports`) purely as a cross-reference,
and the two records then proceed independently: closing the dispute does not close the safety
report, and resolving the safety report does not resolve the dispute. Escalation does **not** pause
the dispute — a safety concern and a money disagreement are answered by different people on
different timelines. The reverse direction does not exist: spec 030 opens no dispute, and this spec
adds no route by which it could.

### Routes added by this spec

All are `app/api/v1/**/route.ts`. Every one is registered in `OPENAPI_ROUTES`.

| Method | Path | Auth | Idempotency | Success | Notes |
|---|---|---|---|---|---|
| `POST` | `/api/v1/bookings/{id}/disputes` | session, participant, either mode | **required** | `201 ApiResponse<DisputeDto>` | AC-1. Opens the dispute, moves the booking `protected -> disputed` and the payment `held -> disputed` in one transaction |
| `GET` | `/api/v1/disputes/{id}` | session, participant | — | `200 ApiResponse<DisputeDto>` | Participant view. Non-participant gets `404`, never `403` |
| `GET` | `/api/v1/disputes` | session | — | `200` paged `DisputeSummaryDto[]` | The caller's own disputes; needed by the booking UI and the account view |
| `POST` | `/api/v1/disputes/{id}/evidence` | session, participant | **required** | `201 ApiResponse<DisputeEvidenceDto>` | Links an already-finalized spec 027 asset to the dispute. Bytes never pass through this route |
| `GET` | `/api/v1/disputes/{id}/evidence` | session participant, or admin `disputes/read` | — | `200` paged `DisputeEvidenceDto[]` | Admin reads audited |
| `POST` | `/api/v1/disputes/{id}/messages` | session participant, or admin `disputes/resolve` | **required** | `201 ApiResponse<DisputeMessageDto>` | Admin posts flagged `isAdmin` |
| `GET` | `/api/v1/disputes/{id}/messages` | session participant, or admin `disputes/read` | — | `200` paged `DisputeMessageDto[]` | Oldest first |
| `POST` | `/api/v1/disputes/{id}/appeal` | session, participant | **required** | `201 ApiResponse<DisputeAppealDto>` | AC-4. Only from `resolved`, only within the window, only once |
| `POST` | `/api/v1/disputes/{id}/waive-appeal` | session, participant | **required** | `200 ApiResponse<DisputeDto>` | Lets a party end it early rather than wait out the window. **Added by this review**: without it, closure depends solely on a sweep, and a participant who accepts the outcome has no way to release the provider's money sooner |
| `GET` | `/api/v1/admin/disputes` | admin `disputes/read` | — | `200` paged `AdminDisputeSummaryDto[]` | The queue: non-`closed` first, then `created_at ASC` (FIFO, the ordering spec 030's queue uses). Read is audited |
| `GET` | `/api/v1/admin/disputes/{id}` | admin `disputes/read` | — | `200 ApiResponse<AdminDisputeDto>` | Full detail incl. the advisory AI summary. Audited separately from the queue |
| `POST` | `/api/v1/admin/disputes/{id}/claim` | admin `disputes/resolve` | **required** | `200 ApiResponse<AdminDisputeDto>` | `open -> under_review`. No reason required — claiming changes no outcome |
| `POST` | `/api/v1/admin/disputes/{id}/resolve` | admin `disputes/resolve` | **required** | `200 ApiResponse<DisputeResolutionDto>` | AC-3, AC-5. Reason required. Records a refund **proposal** only |
| `POST` | `/api/v1/admin/disputes/{id}/link-refund` | admin `disputes/resolve` | **required** | `200 ApiResponse<DisputeResolutionDto>` | **Added by this review**: records the `adminActionId` that spec 022's `POST /admin/refunds` returned, closing the loop between proposal and execution. Without it the proposal could never be tied to its refund |
| `POST` | `/api/v1/admin/disputes/{id}/appeal-decision` | admin `disputes/review_appeal`, different user from the resolver | **required** | `200 ApiResponse<DisputeAppealDto>` | AC-4, AC-7. Reason required. Moves the dispute to `closed` |
| `POST` | `/api/v1/admin/disputes/{id}/legal-hold` | admin `disputes/resolve` | **required** | `200 ApiResponse<AdminDisputeDto>` | Sets/clears `legal_hold`. Reason required, audited |
| `POST` | `/api/v1/admin/disputes/{id}/escalate-safety` | admin `disputes/resolve` **and** `safety_reports/read` | **required** | `201 ApiResponse<{ safetyReportId: string }>` | DECIDED-9 |
| `POST` | `/api/v1/cron/dispute-appeal-sweep` | cron secret (the existing `app/api/v1/cron/*` shape) | — | `200` | Closes `resolved` disputes whose appeal window has elapsed and whose refund position is terminal. **Added by this review**: AC-7 needs a mover, and every other deadline in this repository has a sweep |

`GET /api/v1/bookings/{id}` gains a nullable `disputeId` and `disputeStatus` for participants — a
read-only addition to spec 020's DTO, so the booking UI can offer the dispute entry point without a
second round trip.

### Request and response types

```typescript
// lib/types/disputes.ts
import type { DISPUTE_STATUSES, DISPUTE_DECISIONS, DISPUTE_APPEAL_OUTCOMES } from '@/lib/db/schema';

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
// 'open' | 'under_review' | 'resolved' | 'appealed' | 'closed'
export type DisputeDecision = (typeof DISPUTE_DECISIONS)[number];
// 'no_action' | 'refund_customer' | 'partial_refund_customer' | 'favour_provider' | 'mutual_resolution'
export type DisputeAppealOutcome = (typeof DISPUTE_APPEAL_OUTCOMES)[number];
// 'upheld' | 'overturned' | 'partially_upheld'

/** The PARTICIPANT view. Deliberately carries no admin identity and no AI summary. */
export interface DisputeDto {
  id: string;
  bookingId: string;
  status: DisputeStatus;
  /** 'me' | 'counterparty' — never the other party's user id (see §3 "Privacy"). */
  openedBy: 'me' | 'counterparty';
  reason: string;
  createdAt: string;
  evidenceCount: number;
  messageCount: number;
  /** Present from `resolved` onward. */
  resolution: DisputeResolutionDto | null;
  appeal: DisputeAppealDto | null;
  /** Null unless `resolved`; the instant after which an appeal is refused. */
  appealWindowEndsAt: string | null;
  /** Whether THIS caller may still appeal (window open, none filed, not already waived). */
  canAppeal: boolean;
  canPostMessage: boolean;
  canSubmitEvidence: boolean;
}

export interface DisputeSummaryDto {
  id: string;
  bookingId: string;
  status: DisputeStatus;
  createdAt: string;
}

/** Shown to BOTH participants and to admins. Master §2.3: the reasoning, not just the outcome. */
export interface DisputeResolutionDto {
  disputeId: string;
  decision: DisputeDecision;
  reasoning: string;
  resolvedAt: string;
  /** The PROPOSED refund. Null when the decision proposes none. Never a refund id. */
  proposedRefundAmountMinorUnits: number | null;
  proposedRefundCurrencyCode: string | null;
  /** 'none' | 'proposed' | 'initiated' | 'completed' | 'failed' — derived, read from spec 022. */
  refundState: 'none' | 'proposed' | 'initiated' | 'completed' | 'failed';
}

export interface DisputeAppealDto {
  disputeId: string;
  filedBy: 'me' | 'counterparty';
  reason: string;
  filedAt: string;
  outcome: DisputeAppealOutcome | null;
  reasoning: string | null;
  decidedAt: string | null;
}

export interface DisputeEvidenceDto {
  id: string;
  fileAssetId: string;
  submittedBy: 'me' | 'counterparty' | 'admin';
  createdAt: string;
}

export interface DisputeMessageDto {
  id: string;
  body: string;
  authorRole: 'me' | 'counterparty' | 'admin';
  isAdmin: boolean;
  createdAt: string;
}

/** ADMIN-ONLY. The only shape that carries real identities, the AI summary and the approval chain. */
export interface AdminDisputeDto
  extends Omit<DisputeDto, 'openedBy' | 'canAppeal' | 'canPostMessage' | 'canSubmitEvidence'> {
  openedByUserId: string;
  customerUserId: string;
  providerUserId: string;
  claimedByAdminUserId: string | null;
  resolvedByAdminUserId: string | null;
  /** Advisory only. Never returned to a participant, never read by a decision. */
  aiSummary: string | null;
  refundAdminActionId: string | null;
  escalatedSafetyReportId: string | null;
  legalHold: boolean;
}

export interface AdminDisputeSummaryDto {
  id: string;
  bookingId: string;
  status: DisputeStatus;
  createdAt: string;
  claimedByAdminUserId: string | null;
  hasProposedRefund: boolean;
  legalHold: boolean;
}
```

### Privacy and data exposure — normative (DECIDED-10)

The rule, applied uniformly: **a participant never receives another user's id, and never receives an
admin's id.** The repository's precedent is spec 024's `lib/payouts/privacy.ts` and spec 029's
review DTOs; this spec follows it by projecting every actor to a relative role at the DTO boundary.

| Field | Participant (either side) | Admin `disputes/read` |
|---|---|---|
| Dispute id, booking id, status, reason, timestamps | yes | yes |
| Opener | `'me' \| 'counterparty'` | real `openedByUserId` |
| Other party's user id, name, email, phone | **never** | the ids; contact details only through the existing user-admin surfaces |
| Evidence list and bytes | **yes, both sides'** (DECIDED-6) | yes, each read audited |
| Message thread | yes, all of it | yes, each read audited |
| Resolution decision + **reasoning** | yes — master §2.3 requires the reasoning, not just the outcome | yes |
| Resolving / claiming / appeal-reviewing admin identity | **never** | yes |
| `aiSummary` | **never** | yes, labelled advisory |
| `refundAdminActionId`, the approval chain | **never** | yes |
| Proposed refund amount + currency | yes — it is a promise made to them about their own money | yes |
| `escalatedSafetyReportId`, `legalHold` | **never** — a party is not told they were escalated (spec 030 §3, master §64) | yes |
| A dispute they are not party to | `404`, never `403` — the existing `requireBookingParticipant()` behaviour, so a dispute's existence is not probeable | — |

### Idempotency and concurrency — normative

**Every state-changing `POST` in this spec requires an `Idempotency-Key` header** via
`requireIdempotencyKey()`, and stores `idempotency_key` + `idempotency_fingerprint` on the row it
creates, scoped per entity by a unique index — the per-entity pattern specs 015/020/021/022 use,
never a global key table. A replay with the same key and the same fingerprint returns the original
result; a same-key/different-fingerprint call is `409 CONFLICT`.

| Operation | Lock order | Uniqueness / conditional guard | Outcome of a lost race |
|---|---|---|---|
| Open a dispute | `bookings` → `payments` `FOR UPDATE`, then insert | `disputes_booking_open_uq` partial unique index; `setProtectionState` version guard | `409 DISPUTE_ALREADY_OPEN`, or `422 DISPUTE_NOT_ELIGIBLE` if the sweep released first. Whole transaction rolls back |
| Claim | `disputes FOR UPDATE` | `UPDATE … WHERE status = 'open'` | zero rows matched → `409 CONFLICT` |
| Resolve | `disputes FOR UPDATE`, then insert the resolution | `dispute_resolutions_dispute_uq UNIQUE (dispute_id)` **plus** `UPDATE … WHERE status IN ('open','under_review')` | zero rows / unique violation → `409 DISPUTE_ALREADY_RESOLVED`. **Double resolution is impossible at the database, not only in code** |
| Link a refund | `disputes` → `dispute_resolutions FOR UPDATE` | `UPDATE … WHERE refund_admin_action_id IS NULL` | `409 CONFLICT` — a resolution is linked to at most one approval chain, so a duplicate refund request cannot be attached |
| Appeal | `disputes FOR UPDATE`, then insert | `dispute_appeals_dispute_uq UNIQUE (dispute_id)` **plus** `UPDATE … WHERE status = 'resolved'` | `409 APPEAL_ALREADY_FILED` |
| Decide the appeal | `disputes` → `dispute_appeals FOR UPDATE` | `UPDATE … WHERE outcome IS NULL` | `409 CONFLICT` |
| Close (sweep or waiver) | `disputes` → `bookings` → `payments` `FOR UPDATE` | `UPDATE … WHERE status IN ('resolved','appealed')`; refund position re-read under the lock; `setProtectionState` version guard | zero rows → skip silently (another closer won); refund not terminal → `422 DISPUTE_REFUND_PENDING` |
| Payout release | — | none needed | **Structural**: spec 024 reads `protection_state` under its own lock, and this spec only ever leaves it `disputed` or `held`, never `released`. There is no window in which a payout could see a stale "not disputed" |

The lock order `bookings → payments → disputes → dispute_*` **extends spec 022's existing
`bookings → payments → refunds` order** rather than introducing a second one, so no cycle and no
deadlock is possible between the specs.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `DISPUTE_NOT_ELIGIBLE` | booking is not `protected`, or protection is not `held` |
| `409` | `DISPUTE_ALREADY_OPEN` | a non-`closed` dispute already exists for the booking |
| `404` | `NOT_FOUND` | the dispute does not exist, or the caller is not a participant and holds no `disputes/read` |
| `403` | `FORBIDDEN` | authenticated, but lacks the required `disputes/*` permission |
| `403` | `DISPUTE_PARTICIPANT_CONFLICT` | an admin acting on a dispute in whose booking they are a participant |
| `422` | `DISPUTE_NOT_OPEN` | posting a message or evidence while `resolved` or `closed` |
| `409` | `DISPUTE_ALREADY_RESOLVED` | a second resolve attempt |
| `422` | `DISPUTE_MESSAGE_LIMIT_REACHED` | `MAX_DISPUTE_MESSAGES` reached |
| `422` | `DISPUTE_EVIDENCE_LIMIT_REACHED` | `MAX_DISPUTE_EVIDENCE` reached |
| `422` | `DISPUTE_EVIDENCE_NOT_ATTACHABLE` | the asset is not the caller's own live, `ready`, `dispute_evidence`-context upload for this dispute |
| `422` | `APPEAL_WINDOW_CLOSED` | appeal filed after `DISPUTE_APPEAL_WINDOW_DAYS` |
| `409` | `APPEAL_ALREADY_FILED` | a second appeal on the same dispute |
| `422` | `APPEAL_NOT_AVAILABLE` | appealing a dispute that is not `resolved` |
| `403` | `APPEAL_REQUIRES_DIFFERENT_ADMIN` | the appeal reviewer is the original resolver |
| `422` | `DISPUTE_REFUND_PENDING` | closing while a proposed refund is un-initiated, `requested` or `processing` |
| `422` | `DISPUTE_REFUND_AMOUNT_INVALID` | proposed amount is not a positive integer, is in the wrong currency, or exceeds the refundable position |
| `429` | `RATE_LIMITED` | the `disputes` rate-limit domain |

All follow spec 004's SCREAMING_SNAKE_CASE stability rule and pass an explicit `status`, since none
is in the baseline `API_ERROR_CODES` map. `RateLimitDomain` gains one member, `disputes`, at
30 / 60 s — the write-surface budget specs 015/017/018/020/027/029/030 each chose for their own
domain.

### Breaking-change check

- [x] No existing route changes shape, except `GET /api/v1/bookings/{id}`, which gains two
      **nullable, additive** fields (`disputeId`, `disputeStatus`).
- [x] `registerDisputeGate()` moves spec 021's sweep from "never disputed" to "disputed when a
      dispute is live". That is the port's documented purpose, and spec 021's own tests reset it
      through `resetDisputeGate()`.
- [x] `registerBookingTransitions('spec 031 (disputes)', …)` adds two pairs spec 020 does not own;
      `isAllowedBookingTransition()` is unchanged, so spec 020's tests are unaffected.
- [x] Registering the `dispute_evidence` context changes `422 FILE_CONTEXT_NOT_AVAILABLE` to a real
      authorization decision for that one context — **but only in a process that has run
      `registerDisputeIntegration()`**. Verified at implementation time: spec 027's
      `lib/files/contexts.integration.test.ts` still asserts `dispute_evidence` is unregistered and
      still passes unchanged, because Vitest gives each file its own module registry and that file
      imports neither `instrumentation.ts` nor `lib/disputes`. So unlike spec 030's `safety_evidence`
      — which widened a database vocabulary and did require a test edit — **no spec 027 test is
      modified by this spec.**
- [x] No column is added to `refunds`, `payments` or `payouts`, and none to `bookings`.

---

## 4. Data model changes

### Entities

Every table below **already exists** as a spec 003 skeleton carrying `baseColumns()` (`id`,
`created_at`, `updated_at`, `version`) and its foreign keys. Migration `0028` adds feature columns,
constraints and indexes. Every foreign key is `ON DELETE RESTRICT` (spec 003's baseline rule) and
every foreign-key column carries its own covering btree index (`schema-lint.test.ts` AC-4). No
monetary value uses `numeric`/`real`/`double precision`; the proposed refund uses
`moneyColumns('proposed_refund')` with `moneyPairChecks`, per spec 003's AC-1 money convention.

| Entity | Change | Added fields |
|---|---|---|
| `disputes` | **columns added** | `status text not null default 'open'`, `reason text not null`, `claimed_by_admin_user_id uuid null fk->users`, `ai_summary text null`, `legal_hold boolean not null default false`, `escalated_safety_report_id uuid null fk->safety_reports`, `closed_at timestamptz null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `dispute_evidence` | **columns added** | `file_asset_id uuid not null fk->file_assets`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `dispute_messages` | **columns added** | `body text not null`, `is_admin boolean not null default false`, `contact_flagged boolean not null default false`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `dispute_resolutions` | **columns added** | `decision text not null`, `reasoning text not null`, `resolved_by_admin_user_id uuid not null fk->users`, `resolved_at timestamptz not null`, `proposed_refund_amount_minor_units integer null`, `proposed_refund_currency_code text null`, `refund_admin_action_id uuid null fk->admin_actions`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `dispute_appeals` | **columns added** | `reason text not null`, `outcome text null`, `reasoning text null`, `reviewed_by_admin_user_id uuid null fk->users`, `decided_at timestamptz null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |

**Corrections to the draft, for the record.** The draft proposed creating all five tables with
`id uuid pk` and `created_at`; they exist and carry `baseColumns()` including `version`, so the
optimistic-concurrency column the §3 guards rely on is already there. The draft's
`dispute_messages.sender_id` is really `sender_user_id`; its `dispute_appeals.filed_by_user_id` is
really `appellant_user_id`; its `dispute_appeals.reviewed_by_admin_id` is renamed
`reviewed_by_admin_user_id` and given a real FK; its `dispute_resolutions.resolved_by_admin_id uuid
fk->AdminProfile` becomes `resolved_by_admin_user_id uuid fk->users` (DECIDED-2); and its
`dispute_resolutions.refund_id uuid fk->Refund` is **removed entirely** in favour of
`refund_admin_action_id uuid fk->admin_actions` (DECIDED-5).

### Constraints and indexes

| Name | Kind | Purpose |
|---|---|---|
| `disputes_status_ck` | CHECK | `status in ('open','under_review','resolved','appealed','closed')` |
| `disputes_closed_pairing_ck` | CHECK | `(status = 'closed') = (closed_at is not null)` |
| `disputes_reason_length_ck` | CHECK | `char_length(reason) between 10 and 2000` |
| `disputes_booking_open_uq` | partial UNIQUE | `(booking_id) WHERE status <> 'closed'` — AC-1's duplicate guard |
| `disputes_opener_idempotency_uq` | UNIQUE | `(opened_by_user_id, idempotency_key)` |
| `disputes_status_created_idx` | INDEX | `(status, created_at)` — the admin queue's ordering |
| `disputes_claimed_by_admin_user_id_idx` | INDEX | FK cover |
| `disputes_escalated_safety_report_id_idx` | INDEX | FK cover |
| `dispute_evidence_file_asset_id_idx` | INDEX | FK cover |
| `dispute_evidence_dispute_asset_uq` | UNIQUE | `(dispute_id, file_asset_id)` — an asset is attached once |
| `dispute_messages_dispute_created_idx` | INDEX | `(dispute_id, created_at)` — the paged thread read |
| `dispute_messages_body_length_ck` | CHECK | `char_length(body) between 1 and 2000` |
| `dispute_messages_sender_idempotency_uq` | UNIQUE | `(sender_user_id, idempotency_key)` |
| `dispute_resolutions_dispute_uq` | **UNIQUE** | `(dispute_id)` — **replaces the skeleton's plain index**; one resolution per dispute, AC-3's double-resolution guard |
| `dispute_resolutions_decision_ck` | CHECK | `decision in ('no_action','refund_customer','partial_refund_customer','favour_provider','mutual_resolution')` |
| `dispute_resolutions_reasoning_length_ck` | CHECK | `char_length(reasoning) between 10 and 2000` |
| `dispute_resolutions_refund_pairing_ck` | CHECK | a proposed refund amount exists **iff** the decision is `refund_customer` or `partial_refund_customer` |
| `dispute_resolutions_proposed_refund_pair_ck` / `_currency_format_ck` / `_positive_ck` | CHECK | `moneyPairChecks('dispute_resolutions','proposed_refund')` plus `amount > 0` |
| `dispute_resolutions_refund_link_ck` | CHECK | `refund_admin_action_id is null or proposed_refund_amount_minor_units is not null` |
| `dispute_resolutions_resolved_by_admin_user_id_idx`, `dispute_resolutions_refund_admin_action_id_idx` | INDEX | FK cover |
| `dispute_appeals_dispute_uq` | **UNIQUE** | `(dispute_id)` — **replaces the skeleton's plain index**; AC-4's one-appeal rule |
| `dispute_appeals_outcome_ck` | CHECK | `outcome is null or outcome in ('upheld','overturned','partially_upheld')` |
| `dispute_appeals_decision_pairing_ck` | CHECK | `outcome`, `reasoning`, `reviewed_by_admin_user_id` and `decided_at` are all null or all non-null |
| `dispute_appeals_reason_length_ck` | CHECK | `char_length(reason) between 10 and 2000` |
| `dispute_appeals_reviewed_by_admin_user_id_idx` | INDEX | FK cover |
| `dispute_appeals_appellant_idempotency_uq` | UNIQUE | `(appellant_user_id, idempotency_key)` |

No `ON DELETE CASCADE` and no `SET NULL` anywhere: spec 003's baseline rule is RESTRICT, and a
dispute's records must not be removable as a side effect of deleting anything else. **Safe deletion**
is therefore by construction — a user, booking, payment or file asset that a live dispute references
cannot be hard-deleted; spec 008's account deletion anonymizes the user row instead, which is the
mechanism already in place and which this spec does not modify.

### Migration

- **Name:** `drizzle/0028_add_disputes_resolution.sql`, with the hand-written sibling
  `drizzle/0028_add_disputes_resolution_down.sql`. **Verified as the next number**: `drizzle/` ends
  at `0027_add_blocking_safety_incidents.sql` and `drizzle/meta/_journal.json`'s last entry is
  `idx: 27`. The draft's `AddDisputeTables` name is the wrong convention and, more importantly, the
  wrong description — it creates no table.
- **Reversible:** yes. The `_down.sql` drops exactly the added columns, constraints and indexes,
  restores `dispute_resolutions_dispute_id_idx` and `dispute_appeals_dispute_id_idx` as the plain
  indexes the skeleton had, and deletes this spec's two `bookings_status_transitions` rows and its
  three `permissions` rows. `file_assets_context_type_ck` is **not touched in either direction**,
  because `dispute_evidence` was already in spec 027's vocabulary and this spec does not widen it.
  The skeleton tables themselves are spec 003's and are never dropped.
- **Backfill required:** no. Every added `NOT NULL` column is on a table that is empty in every
  environment (no dispute has ever been created), so no `DEFAULT`-then-backfill dance is needed and
  none is used.
- **Downtime:** none. All statements are `ALTER TABLE … ADD COLUMN` / `ADD CONSTRAINT` /
  `CREATE INDEX` on empty tables, plus two idempotent `INSERT … ON CONFLICT DO NOTHING` seeds.
- **Safe against partial failure:** every statement is separated by `--> statement-breakpoint`; the
  constraint and index changes use `DROP … IF EXISTS` before their `ADD`/`CREATE`; and both seed
  inserts use `ON CONFLICT DO NOTHING`, so a re-run after a partial failure converges rather than
  erroring.
- **Seeds:**
  - `bookings_status_transitions`: `('protected','disputed')` and `('disputed','protected')`.
  - `permissions`: the three rows in §3 "Resolution ownership", in the `0019`/`0026`/`0027`
    `FROM (VALUES …) JOIN roles` shape.
- **Schema-lint compliance:** no float money type; every timestamp is `timestamptz`; every FK column
  has a covering btree index whose first column is that FK; every FK is `RESTRICT`. Asserted by the
  existing `lib/db/schema-lint.test.ts`, which runs over the whole schema and therefore over these
  tables automatically.
- **Checksums:** `npm run check:migrations` and `npm run check:schema` are part of the §6 static gate.

### Retention and privacy

Dispute evidence, messages, resolutions and appeals are **financial-decision records** and are
retained with the dispute rather than under spec 025's message-retention sweep or spec 027's
ordinary asset expiry. `disputes.legal_hold` suppresses both sweeps for the dispute's assets through
the existing `lib/privacy/file-asset-storage.ts` hold path; no second hold mechanism is built.

Spec 008's account deletion **anonymizes** rather than deletes: the `users` row is anonymized in
place and the FKs stay intact, so a closed dispute remains auditable without retaining the deleted
person's identity. This spec adds no new deletion behaviour and no new export artifact; a
participant's dispute records are included in spec 008's existing export through the same
participant-projection rules §3 "Privacy" defines, so an export never leaks the counterparty's
identity or an admin's.

---

## 5. UI states

**Routes (actual):**

| Route | Who | Purpose |
|---|---|---|
| `app/bookings/[id]/dispute/page.tsx` | participant | Open a dispute, then the live dispute view: status, evidence, thread, resolution, appeal |
| `app/admin/operations/disputes/page.tsx` | admin `disputes/read` | The queue |
| `app/admin/operations/disputes/[id]/page.tsx` | admin `disputes/read` | One dispute in full; resolve / appeal-decision / legal-hold / escalate actions gated by permission |

These sit beside the existing `app/bookings/[id]/{cancel,no-show,review,payment}` and
`app/admin/operations/{safety,refunds,payouts}`, matching the established structure exactly. The
`/admin/operations` landing page gains one link, `{ href: '/admin/operations/disputes', label:
'Disputes' }`, in its existing `links` array.

**Components:** composed entirely from `@/components` — `Card`, `Badge`, `Button`, `FormField`,
`ListRow`, `EmptyState`, `ErrorState`, `Skeleton`, `PriceDisplay`, `RequestStatusTimeline`. A
route-local `app/bookings/[id]/_components/DisputeSection.tsx` mirrors the existing
`RefundSection` / `ReviewSection` / `BookingEvidence` pattern. **No new design-system primitive is
added**, and no raw hex, font size, radius, shadow or spacing value is written — every visual value
comes from `app/styles/apuriva-tokens.css` through the primitives. Per the project branding rule,
neither page adds a logo header; the existing `NavShell` carries the single brand placement.

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` for the dispute card, the evidence list and the thread — the same three-block shape `BookingConversation` already uses. Never a spinner-only screen |
| **Empty** | Participant, no dispute: the section renders a single explanatory line plus a primary action, shown **only** while the booking is eligible (`protected` + `held`); otherwise the section is absent entirely rather than showing a disabled button. Admin queue with nothing open: `EmptyState` reading "Queue clear — no open disputes" |
| **Error** | `ErrorState` with the envelope's `code` mapped to a human sentence. **Evidence-upload failure preserves already-submitted evidence**: each asset is finalized and linked by its own request, so a failure on item 3 leaves items 1–2 attached and the form retries only the failed one. A failed message post keeps the draft in the textarea |
| **Success** | The resolution is shown to **both** parties with its **reasoning**, not just its outcome (master §2.3) and, where one was proposed, the refund amount via `PriceDisplay`. The appeal affordance appears with its deadline stated as an absolute date, and disappears once the window closes or an appeal is filed |
| **Live updates** | Polling on spec 018's cadence and on window focus, stopping once the dispute is `closed` — the identical approach `app/bookings/[id]/page.tsx` already takes. **No WebSocket**, because this repository has none |

---

## 6. Test plan

Vitest only. Unit and integration tests are `**/*.test.ts` colocated in `lib/disputes/` and
`app/api/v1/**`; the end-to-end test is `e2e/disputes.spec.ts`, matching the nine existing specs
there.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | Transition table totality and terminality; eligibility predicate; appeal-window arithmetic and env bounds; proposed-amount shape validation; DTO participant projection (`'me'`/`'counterparty'`, no ids); AI degradation to `null` | `lib/disputes/{transitions,eligibility,limits,rows,ai-assist}.test.ts` |
| **Integration** | Full `open → evidence → messages → resolve → appeal → appeal-decision → closed`; the alternative `open → resolve → window elapses → sweep closes`; waive-appeal; legal hold; safety escalation | `lib/disputes/lifecycle.integration.test.ts`, `appeal.integration.test.ts` |
| **Boundary / financial** | Payout held while a dispute is live and released after closure; the refund proposal→initiate→approve→execute chain through spec 022's real routes; every refund-provider outcome in the §3 table | `lib/disputes/payout-hold.integration.test.ts`, `refund-handoff.integration.test.ts` |
| **Authorization** | Each of the three permissions on each admin route; `DISPUTE_PARTICIPANT_CONFLICT`; different-admin appeal enforcement; non-participant gets `404` not `403` | `app/api/v1/disputes/authorization.test.ts`, `app/api/v1/admin/disputes/authorization.test.ts` |
| **Privacy** | No participant-facing DTO contains a user id, an admin id, `aiSummary`, `refundAdminActionId`, `escalatedSafetyReportId` or `legalHold` — asserted over the serialized JSON, not the type | `lib/disputes/privacy.test.ts` |
| **Concurrency** | Two simultaneous opens → one `201`, one `409`; two simultaneous resolves → one wins; two appeals → one `409`; open racing the protection-release sweep; two closers | `lib/disputes/concurrency.integration.test.ts` |
| **Boundary (source-level)** | `lib/disputes/**` contains no `refunds`/`payouts` insert, no `payments SET status`, no provider call, no `registerRefundEligibilityGate`, no `registerPayoutHoldGate`, no `authorizeAndInitiate` — the shape of spec 022's `no-policy-leak.test.ts` | `lib/disputes/no-money-leak.test.ts` |
| **AI boundary** | No resolve/appeal/close function accepts an AI-derived parameter; a throwing `completeAi` changes no row | `lib/disputes/ai-boundary.test.ts` |
| **Regression** | Spec 021's sweep suite with the gate registered; spec 024's eligibility suite; spec 027's unregistered-context list; spec 020's `isAllowedBookingTransition` still excludes both new pairs | existing suites, extended |
| **Migration / rollback** | `0028` applies to an `0027` database and `0028_down` restores it exactly, including the two restored plain indexes; run by the existing `lib/db/migrations.integration.test.ts` and `rollback.ts` harness | `lib/db/migrations.integration.test.ts` |
| **E2E** | Customer opens a dispute, both sides attach evidence and message, a T&S admin resolves with a partial-refund proposal, the customer appeals, a second admin decides, the dispute closes | `e2e/disputes.spec.ts` |

**Static gate (run in this order, per the project's implementation protocol):** `npx tsc --noEmit`,
`npm run check:schema`, `npm run check:migrations`, `npm run lint:money`, `npm run lint:env`,
`npm run check:openapi-drift`, then exactly one clean full `npx vitest run`.

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/disputes/eligibility.test.ts::only protected + held is eligible`; `concurrency.integration.test.ts::second concurrent open is 409 DISPUTE_ALREADY_OPEN` |
| AC-2 | `lib/disputes/payout-hold.integration.test.ts::evaluateEligibility answers protection_not_released while a dispute is live` |
| AC-3 | `lib/disputes/lifecycle.integration.test.ts::resolution records decision, reasoning, resolver and instant, audited` |
| AC-4 | `lib/disputes/appeal.integration.test.ts::requires a different admin`; `::at most one appeal`; `::money stays held while appealed` |
| AC-5 | `lib/disputes/refund-handoff.integration.test.ts::refund goes through spec 022's override chain`; `lib/disputes/no-money-leak.test.ts` |
| AC-6 | `lib/disputes/ai-boundary.test.ts::no decision path accepts AI output`; `ai-assist.test.ts::every failure degrades to null` |
| AC-7 | `lib/disputes/lifecycle.integration.test.ts::closure returns booking and protection, and closed is terminal` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** the substantive quality of an admin's dispute judgement. Process
correctness — that a decision was made by an authorized human, with a reason, audited, by a
different person on appeal — is tested; the "rightness" of a given human call is not testable and is
not a software property.

---

## 7. Out of scope

- **Safety-specific incident handling** (spec 030). A dispute may escalate *into* a safety report
  through the one-way seam in DECIDED-9; safety enforcement, restriction and the reported-user
  privacy rules stay spec 030's and spec 038's.
- **Moderation actions** — warning, restriction, suspension, ban, content removal, booking
  intervention, payout freeze — and the appeal of a moderation *action* (spec 038). The appeal in
  this spec is of a **dispute resolution**, a different object with a different owner.
- **Automated or AI-decided outcomes** (master §132.17, §2097). Excluded structurally, not by policy.
- **Refund execution, amounts, provider integration, reconciliation** (spec 022) and **payout
  computation, holds, transfers** (spec 024).
- **Support tickets** (`SupportTicket`/`SupportMessage`/`SupportNote`, master §124) — a separate
  entity family and a later spec. A dispute is not a support ticket.
- **Dispute categories / taxonomy and category-based routing.** Considered and rejected: with a
  single resolving role (DECIDED-2) there is nothing to route to, and an unused taxonomy would be a
  migration to maintain for no behaviour.
- **Runtime configuration of the appeal window through an admin UI** — spec 041 owns feature flags
  and platform configuration; until then it is an environment variable with a documented default and
  hard bounds, exactly as specs 008/021/029 handle theirs.

---

## 8. Decisions

Every question the draft left open is resolved here. **There are no open questions.**

| # | Question the draft left open | Decision | Basis |
|---|---|---|---|
| DECIDED-1 | "Dispute-eligibility window (how long after booking completion can a dispute be opened)" | Eligible exactly while `bookings.status = 'protected'` **and** `payments.protection_state = 'held'` — i.e. inside spec 021's payment-protection window, default 48 h, per-payment configurable, bounded 1..720 | Repository evidence: `DEFAULT_PROTECTION_WINDOW_HOURS`, `isValidProtectionWindowHours`, `nextProtectionState`, `evaluateEligibility`. No new constant, and it makes AC-2 always satisfiable |
| DECIDED-2 | "Whether Operations Admin or Trust & Safety Admin (or both, by dispute type) owns resolution — recommend routing by dispute category" | **Trust & Safety resolves; Operations reads only; Super Admin both. No category routing.** Three permissions at `low`/`medium`; resolver identity recorded; an admin who is a participant is refused on every route | Master §69 names disputes in the Trust & Safety line and omits them from the Operations line. §70 puts "reason + audit" at medium; the money that needs four eyes is spec 022's, already at `high` |
| DECIDED-3 | Lifecycle, terminal and reopen behaviour left ambiguous | Five states, the transition table in §3, `closed` terminal and never reopened, and `closed` the **single** financially-final state the gate keys on | Matches spec 030's and spec 023's treatment of closed findings; makes "money held through the appeal" true without a second mechanism |
| DECIDED-4 | Appeal rules unspecified | Either participant; one appeal; `DISPUTE_APPEAL_WINDOW_DAYS` default 7, bounds 1..30, env-configurable; original resolution immutable and standing; reason required, evidence optional; different-admin enforced by user-id comparison; outcome terminal; fully audited | Master §68 "Appeal/review mechanism"; the env-var-with-bounds idiom of specs 008/021/029; spec 009's `SELF_APPROVAL_NOT_ALLOWED` precedent |
| DECIDED-5 | Financial ownership with 022/024 | A **gate, not ownership**: register spec 021's `DisputeGate`, which holds `protection_state = 'disputed'`, which spec 024 already rejects. A resolution records a **proposed** refund; Finance initiates via spec 022's existing override; a second admin approves; linkage is `refund_admin_action_id`. No `refunds`/`payouts` write, no provider call, no `PayoutHoldGate`, no `RefundEligibilityGate` | `refunds/override` is seeded to `finance_admin`/`super_admin` only (migration `0018`), so T&S *cannot* refund; `RefundEligibilityGate` is already occupied by spec 023; `evaluateEligibility` already blocks on `protection_not_released`; `refunds.admin_action_id` already exists and is indexed |
| DECIDED-6 | Evidence handling | Register the already-reserved `dispute_evidence` spec 027 context in `lib/disputes/evidence-policy.ts`; context id is the dispute id; both participants read each other's evidence; admin reads audited pre-disclosure; immutable, undeletable while live; `legal_hold` suppresses both sweeps | Spec 027's registry contract and `lib/files/boundaries.test.ts`; spec 030's `safetyEvidencePolicy` as the template; master §2.3 fairness for the mutual-read difference |
| DECIDED-7 | Whether dispute messages may reuse spec 025 | **Separate table, reusing spec 025's bound and contact filter.** Three concrete reasons: admin visibility is the default here and a justified exception there; retention differs (sweep vs. legal hold); lifecycle differs (dispute vs. booking) | Spec 025's `admin.ts` justification rule, `app/api/v1/cron/message-retention-sweep`, and `applyContactPolicy`'s post-`confirmed` flag branch |
| DECIDED-8 | AI boundary | Advisory summary only, stored in `ai_summary`, read by no decision, absent from every participant DTO, degrading silently to `null`; enforced by a function signature that cannot reach a decision | Master §132.17, §2097; spec 030's `lib/safety/ai-assist.ts` as the template; `summarization` already in `AI_TASKS`, so no spec 033 migration |
| DECIDED-9 | Safety boundary | One-way escalation to spec 030 through its existing path, cross-referenced by `escalated_safety_report_id`; records proceed independently; no sanction, no `lifecycle_status` write, no reverse direction | Spec 030 §1 "a safety concern arising from a dispute escalates here, not the reverse" |
| DECIDED-10 | Privacy / exposure | Participants get relative roles (`'me'`/`'counterparty'`/`'admin'`), never ids; never the AI summary, the approval chain, the safety cross-reference or the legal-hold flag; non-participants get `404`, never `403`. Both parties **do** get the resolution reasoning and the proposed amount | `requireBookingParticipant`'s existing `404` behaviour; spec 024's `lib/payouts/privacy.ts` and spec 029's DTO projections; master §2.3 explainability |
| DECIDED-11 | API completeness (not raised in the draft, found by this review) | Four routes added because the finalized behaviour has no seam without them: `GET /disputes` (the caller's own list), `POST /disputes/{id}/waive-appeal`, `POST /admin/disputes/{id}/link-refund`, and the `dispute-appeal-sweep` cron | AC-7 needs a mover for the appeal deadline; DECIDED-5 needs a way to record the `adminActionId`; a party who accepts the outcome needs a way to release the money early |

### Notifications (spec 026 reuse) — normative

Three types are added to the existing `NOTIFICATION_CATALOGUE`, all in the existing `booking`
category. **No migration is required**: `notification_type` is not a database CHECK — only
`notifications_category_ck` constrains categories, and `booking` is already a member. All three are
content-free, following spec 029's and spec 030's rule that a notification never becomes a channel
for one user's words to reach another.

| Type | Audience | Body carries |
|---|---|---|
| `dispute_opened` | the counterparty | that a dispute was opened on a booking. **Not** the reason, not the opener's name |
| `dispute_resolved` | both participants | that a decision was recorded and where to read it. **Not** the decision, not the reasoning, not an amount |
| `dispute_closed` | both participants | that the dispute is closed. Nothing else |

An appeal being *filed* notifies nobody: the counterparty learns of it from the dispute view, and a
push that says "you are being appealed" adds pressure without adding information. Admin-facing
alerts are the queue's job, not the notification system's.

### Audit events (spec 009 reuse) — normative

Namespaced `disputes.*` and written through `recordAdminAuditEvent()` into `security_events`, the
same way `lib/safety/reports.ts` defines `SAFETY_EVENT_TYPES`. **No second audit framework.**

| Event | When |
|---|---|
| `disputes.opened` | a dispute is created (actor is the participant; roles empty) |
| `disputes.queue_read` | the admin queue is listed |
| `disputes.detail_read` | one dispute is opened by an admin |
| `disputes.evidence_read` | an admin read of an evidence asset, **before** the bytes are disclosed |
| `disputes.messages_read` | an admin read of the thread |
| `disputes.admin_message_posted` | an admin posts into the thread |
| `disputes.claimed` | `open -> under_review` |
| `disputes.resolved` | the resolution is written, with its reason |
| `disputes.refund_linked` | an `adminActionId` is attached to the resolution |
| `disputes.refund_failed` | spec 022 reports a failed refund for a linked action |
| `disputes.payout_hold_applied` / `disputes.payout_hold_released` | the `held -> disputed` and `disputed -> held` protection transitions — the payout seam, recorded on both sides |
| `disputes.appeal_filed` | a participant files an appeal |
| `disputes.appeal_read` | an admin opens an appeal |
| `disputes.appeal_decided` | the appeal outcome is recorded, with its reason |
| `disputes.legal_hold_set` / `disputes.legal_hold_cleared` | with reason |
| `disputes.safety_escalated` | DECIDED-9, cross-referencing the safety report id |
| `disputes.closed` | final closure, whether by sweep, waiver or appeal decision |

### Operational inputs (do **not** block implementation)

| Input | Default shipped | Where it is set |
|---|---|---|
| `DISPUTE_APPEAL_WINDOW_DAYS` | `7` (bounds 1..30) | environment; documented in `.env.example`, validated by `npm run lint:env` |
| Dispute-queue staffing and target resolution time | not a code concern | Operations; spec 040 measures it |
| Whether `legal_hold` should ever be set automatically above some amount | **no** — always explicit, always audited | product; revisit only with legal input |

---

## 9. Rollout

- **Feature flag:** none. The spec is inert until its migration is applied and
  `registerDisputeIntegration()` runs, and the composition root is the switch.
- **Migration order:** `0028` ships **with** the code. It must precede the first request, because
  `registerDisputeGate()` makes spec 021's sweep query `disputes.status`, which does not exist
  before it. The reverse order is the only unsafe one and is prevented by the standard deploy
  sequence (migrate, then release).
- **Registration order at startup** (`lib/disputes/index.ts`, mirroring
  `registerSafetyIntegration()`): `registerBookingTransitions('spec 031 (disputes)', …)`, then
  `registerDisputeGate()`, then `registerFileContextPolicy('dispute_evidence', …)`. All three are
  idempotent, so a hot-reloaded dev server converges.
- **Rollback:** revert the deploy, then apply `0028_add_disputes_resolution_down.sql`. Reverting the
  code alone is already safe — the gate returns to its inert default, the sweep resumes releasing,
  and any live dispute row simply stops being consulted — so the migration rollback is not
  time-critical. Rolling back with a dispute in `open`/`resolved` releases money that was held; the
  runbook therefore says to close or resolve live disputes first, and the queue makes that visible.
- **Observability (spec 040):** dispute volume by status, time from `open` to `resolved`, time from
  `resolved` to `closed`, appeal rate, appeal-overturn rate, and count of disputes blocked from
  closing by `DISPUTE_REFUND_PENDING`. A rising appeal or overturn rate is the quality signal to
  alert on; a rising `DISPUTE_REFUND_PENDING` count means Finance is not acting on proposals and is
  the operational signal.

---

## 10. Verification evidence (implementation)

Implemented and verified on branch `spec/031-disputes-resolution`.

### What shipped

| Area | Files |
|---|---|
| Domain | `lib/disputes/{index,create,read,resolve,appeal,close,messages,evidence,evidence-policy,escalate,gate,ai-assist,notifications,permissions,transitions,limits,validation,errors,rows}.ts` |
| DTOs | `lib/types/disputes.ts` |
| Routes | 15 `route.ts` files under `app/api/v1/{disputes,admin/disputes,bookings/[id]/disputes}` carrying **17 OpenAPI operations**, plus `app/api/v1/cron/dispute-appeal-sweep/route.ts` (cron routes are outside the OpenAPI contract by `scripts/check-openapi-drift.ts`) |
| Migration | `drizzle/0028_add_disputes_resolution.sql` + `_down.sql`, journal entry `idx: 28` |
| Schema | `lib/db/schema.ts` — feature columns on the five spec 003 skeletons; **no table added** (98 tables before and after) |
| Shared, additive | `lib/api/rate-limit.ts` (`disputes` domain), `lib/api/openapi-registry.ts`, `lib/types/notifications.ts` + `lib/notifications/catalogue.ts` (three content-free types), `instrumentation.ts`, `vercel.json`, `.env.example` |
| UI | `app/bookings/[id]/dispute/page.tsx`, `app/admin/operations/disputes/{page.tsx,[id]/page.tsx}`, one link added to `app/admin/operations/page.tsx` |

### Acceptance criteria

| AC | Verified by | Result |
|---|---|---|
| AC-1 | `eligibility.test.ts` (every booking status enumerated), `lifecycle.integration.test.ts::opening…`, `concurrency.integration.test.ts::two simultaneous opens` | **PASS** — only `protected` + `held` is eligible; a second concurrent open yields exactly one dispute row |
| AC-2 | `payout-hold.integration.test.ts` — asserts through **spec 024's own `evaluateEligibility()`**, unmodified | **PASS** — `{ eligible: false, reason: 'protection_not_released' }` while live; zero payout rows; other bookings unaffected |
| AC-3 | `lifecycle.integration.test.ts::resolution records…`, `authorization.integration.test.ts::detail read is audited` | **PASS** — decision, reasoning, resolver and instant recorded; `disputes.resolved` and `disputes.detail_read` audit rows written |
| AC-4 | `appeal.integration.test.ts` (10 cases) | **PASS** — either participant may appeal; exactly one appeal; window enforced; money still held while `appealed`; original resolver refused `403 APPEAL_REQUIRES_DIFFERENT_ADMIN`; original resolution never edited |
| AC-5 | `refund-handoff.integration.test.ts` (9 cases) + `no-money-leak.test.ts` (12 source-level checks) | **PASS** — a resolution creates **no `refunds` row**; spec 022's real `initiateRefundOverride` returns `pending_approval`; `link-refund` stores the `admin_actions` id; closure refused `422 DISPUTE_REFUND_PENDING` until terminal |
| AC-6 | `ai-boundary.test.ts` (13 cases) | **PASS** — no decision function accepts an AI-derived parameter; no decision path selects `ai_summary`; absent from `DisputeDto`; every failure degrades to `null` |
| AC-7 | `lifecycle.integration.test.ts::closing…`, `transitions.test.ts`, `concurrency.integration.test.ts::two simultaneous closes` | **PASS** — booking returns `disputed -> protected`, protection `disputed -> held`, `closed` terminal, exactly one history row under a race |

### Commands

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **PASS for this spec** — 0 errors in any spec 031 file. Two pre-existing errors remain in files this spec does not touch (see below) |
| Schema checksum | `npm run check:schema-checksum` | **PASS** — `0001_baseline_schema.sql` untouched |
| Money lint | `npm run check:schema-money-lint` | **PASS** — no numeric/real/double-precision money column |
| Env parity | `npm run check:env` | **PASS** — 58 variables, all documented (`DISPUTE_APPEAL_WINDOW_DAYS` added to `.env.example`) |
| Schema FK/index lint | `lib/db/schema-lint.test.ts` AC-4 | **PASS** — every dispute foreign key carries a covering btree index |
| OpenAPI drift | `npm run check:openapi-drift` | **All 17 dispute routes registered and drift-free.** The command itself still exits non-zero on a **pre-existing** spec 010 mismatch unrelated to this spec (see below) |
| Migration UP → DOWN → UP | dedicated scratch database `apuriva_spec031_scratch_test` | **PASS** — 28 migrations applied; DOWN removed 33 dispute columns, all 3 unique indexes, 7 permission rows and 2 transitions while leaving the skeletons and their baseline columns intact and restoring both plain indexes; re-applying `0028` succeeded |

### Spec 031 test results

| Suite | Tests |
|---|---|
| Unit — `transitions`, `limits`, `eligibility`, `validation`, `privacy`, `no-money-leak`, `ai-boundary` | 86 passed |
| `lifecycle.integration` | 14 passed |
| `appeal.integration` | 10 passed |
| `payout-hold.integration` | 6 passed |
| `refund-handoff.integration` | 9 passed |
| `concurrency.integration` | 7 passed |
| `authorization.integration` (incl. privacy end to end) | 10 passed |
| `seams.integration` (027 / 025 / 030 boundaries) | 15 passed |
| `migration.integration` | 23 passed |
| `app/api/v1/disputes/routes.integration` | 15 passed |
| `e2e/disputes.spec.ts` | 2 passed |
| **Total** | **197 passed, 0 failed** |

**Two defects were found and fixed during verification. Both were in this spec's own tests, not in
the product** — no acceptance criterion changed and no production line was altered to make a test
pass.

1. **Hook and test timeouts.** The seeded fixture (`seedProtectedBooking` — a genuine booking →
   authorize → capture → complete → protect path) takes longer than Vitest's 10 s hook and 15 s
   test defaults once the whole suite is running concurrently. The eight seeded suites and the E2E
   now declare explicit timeouts.
2. **An unpaged queue assertion in the E2E.** It asserted that a newly-opened dispute appeared in a
   single unpaged fetch of the Trust & Safety queue. That is wrong by construction: the queue is
   ordered `created_at ASC` — FIFO among equals, so nothing waits indefinitely — which puts the
   newest dispute *last*, and in the shared test database every other suite's disputes sit ahead of
   it. The E2E now pages until it finds the dispute or the queue is exhausted. **The product
   ordering is correct and was not changed**; only the assertion was.

### Full-suite run

`npx vitest run` over the whole repository, with no other Vitest process running:

| | |
|---|---|
| Test files | 354 passed, 9 failed, 1 skipped (364) |
| Tests | **3076 passed, 14 failed, 3 skipped (3093)** |
| Duration | 2491 s (~42 min) |
| **Spec 031 tests failed** | **0 — all 197 passed** |

An earlier full run surfaced 27 failures; the two test defects above were fixed and the run repeated.
None of the 14 remaining failures is in a spec 031 file, and each was re-run in isolation:

| Group | Failures | Nature | Isolation result |
|---|---|---|---|
| `lib/db/{schema-coverage,schema-lint,migrations,concurrency}` | 5 | Pre-existing spec 003/010 drift — see the table below | still fails; unrelated to this spec |
| `lib/payments/{protection-window,concurrency}` | 6 | `runPaymentSweep()` is **platform-wide** and selects `LIMIT 200` with **no `ORDER BY`**, so once total fixture volume in the shared test database exceeds 200 eligible payments it is arbitrary whether it reaches the suite's own booking. Every failure is of the form "the sweep did not act on my row" (`expected +0 to be 1`, `expected 'held' to be 'disputed'`) | **15/15 pass** with the `DisputeGate` registered — as do `lib/payments` alone (150/150) and `lib/payments` + `lib/disputes` together (330/330) |
| `lib/offers/decide`, `lib/reviews/{aggregate,report}` | 3 | Test timeouts under a loaded run | pass in isolation |

The spec 021 group deserves the explicit statement, because those tests are the ones that exercise
this spec's gate: **the `DisputeGate` is correct.** Spec 021's own `an open dispute holds protection
past elapse`, `holds a disputed payment even before the window elapses` and `an elapsed window with
no dispute releases protection` all pass with the real gate registered. What fails at full-suite
scale is spec 021's *test design* — asserting on a batch-limited, unordered, platform-wide sweep in
a database shared with every other suite. That fragility grows with total fixture volume and is
contributed to by every spec seeding protected bookings (022, 023, 024, 028, 029, 030 and now 031);
it is not a dispute rule. Fixing it belongs to spec 021, and is deliberately not done here.

### Pre-existing failures — NOT introduced by this spec

Each was verified against `HEAD` before this spec's work and is caused by an earlier spec. None is fixed here.

| Failure | Cause | Evidence it predates this spec |
|---|---|---|
| `lib/db/schema-coverage.test.ts::has exactly the expected set of tables` | `catalog_suggestions` (010), `price_adjustments` (021), `refunds_status_history` + `refunds_status_transitions` (022) exist in `schema.ts` but are missing from spec 003's `EXPECTED_TABLES` | 98 tables at `HEAD` and 98 now; this spec adds **zero** tables |
| `lib/db/migrations.integration.test.ts::creates all 80 tables` | same drift, expressed as a count (expects 80, finds 98) | as above |
| `lib/db/schema-lint.test.ts::AC-5 jsonb allowlist` | `services.metadata`, `catalog_suggestions.metadata`, `service_fields.options`, `service_fields.validation`, `service_requirements.detail`, `service_packages.included_items` — all spec 010's | 22 jsonb columns at `HEAD` and 22 now; this spec adds **zero** |
| `lib/db/concurrency.integration.test.ts` (2 tests) | `INSERT INTO categories DEFAULT VALUES` now violates `categories.name NOT NULL`, added by spec 010 | the test and the `categories` table are both unmodified by this spec |
| `npm run check:openapi-drift` | the registry says `/admin/categories/{categoryId}/subcategories` while the route lives at `app/api/v1/admin/categories/[id]/subcategories` (spec 010) | those registry lines and route files are byte-identical to `HEAD`; a one-word fix belonging to spec 010 |
| `npx tsc --noEmit` (2 errors) | `lib/files/upload.ts:119` (spec 027) and `lib/notifications/delivery.integration.test.ts:26` (spec 026) | `git diff HEAD` is empty for both files |

### Ownership held

Verified at source level by `lib/disputes/no-money-leak.test.ts`: `lib/disputes/**` contains no insert into `refunds` or `payouts`, no `UPDATE payments SET status`, no payment-provider call, no `registerRefundEligibilityGate`, no `registerPayoutHoldGate`, no `authorizeAndInitiate`, no `lifecycle_status` write and no `INSERT INTO safety_reports`. `bookings.status` is written only through spec 020's `applyBookingTransition()` and `payments.protection_state` only through spec 021's `setProtectionState()`.
