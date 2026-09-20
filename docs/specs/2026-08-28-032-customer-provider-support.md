# Spec: Customer & Provider Support

**File:** `docs/specs/2026-08-28-032-customer-provider-support.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §62 (Customer Support), §63 (Admin Support Workspace), §69 (Support Admin — "Support tickets and user support"), §132.17, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (the three `support_*` baseline skeletons and `baseColumns()`), spec 004
(`withApiRoute`, `apiSuccess`/`apiPaged`, `API_ERROR_CODES`/`ApiRouteError`, `RateLimitDomain`,
`parsePageParams`/`buildPage`, `requireIdempotencyKey`/`idempotencyFingerprint`, the OpenAPI
registry), spec 005 (`requireSession`, `requireCsrf`, `recordSecurityEvent`), spec 006
(`ActiveMode` on the session), spec 008 (`generateExportPayload`, `sweepDeletions`), spec 009
(`resolvePermission`, `recordAdminAuditEvent`, `getAdminRoleNames`), spec 020
(`requireBookingParticipant`), spec 021 (`payments.booking_id` — read-only), spec 025
(`MESSAGE_BODY_MAX_LENGTH`, `applyContactPolicy`), spec 026 (`notify()`, the `operational`
category), spec 027 (`file_assets`, `registerFileContextPolicy`, the `FileContextPolicy`
interface), spec 030 (`createSafetyReport`, `setSafetyPriority` — the priority precedent, and the
safety escalation target), spec 031 (`disputes.booking_id`, `summarizeForTriage` — the advisory-AI
precedent, `runDisputeAppealSweep` — the deadline-sweep precedent), spec 033 (`completeAi`,
`isAiDegradable`, `isAiAssistantEnabled`) — **all verified in this repository while writing this
document.**

**Feeds:** spec 037 (the admin dashboard may surface support volume; this spec adds the queue, not
the dashboard), spec 039 (audit storage and querying, when it ships), spec 040 (observability
metrics), spec 041 (configuration, when it ships).

---

> **Repository-shape note (normative).** This repository is a **single Next.js application**. There
> is no `apps/web`, `apps/api`, `apps/web-e2e`, `packages/ui` or `packages/types`. API routes are
> `app/api/v1/**/route.ts`, domain logic is `lib/**`, DTOs are `lib/types/*.ts`, design-system
> primitives live in `ui/` and are re-exported through `@/components`, route-local components live
> in a `_components/` folder, and migrations are `drizzle/NNNN_*.sql` with a hand-written
> `_down.sql` sibling. The only test runner is **Vitest**, whose `include` is `**/*.test.{ts,tsx}`
> and `e2e/**/*.spec.{ts,tsx}`; there is no Playwright and no Cypress. The previous draft's
> `packages/types/src/support.ts`, `apps/api/support/**`, `apps/api/admin/**`,
> `apps/web/app/support`, `apps/web/app/admin/operations/support`, `apps/web-e2e/support.spec.ts`
> and the `packages/ui` `Chat` / `Table` / `PriorityBadge` components **do not exist and are not
> created**; §3, §5 and §6 name their real counterparts. There is no `PriorityBadge` anywhere in
> `ui/` or `@/components` — priority is rendered with the existing `Badge`.

> **Skeleton note (normative).** The three tables this spec needs **already exist**, seeded by
> `drizzle/0001_baseline_schema.sql` as spec 003 skeletons: `support_tickets`, `support_messages`
> and `support_notes`, each carrying `baseColumns()` (`id`, `created_at`, `updated_at`, `version`)
> plus its foreign keys and nothing else. Migration `0029` therefore **adds feature columns to
> existing tables**; it creates no table. The draft's column names were also wrong against the
> skeletons and are corrected throughout: `support_tickets.requester_user_id` (not `user_id`),
> `support_messages.sender_user_id` (not `sender_id` + `sender_type`),
> `support_notes.author_user_id` (not `admin_id`). Every existing FK targets `users.id`, **not**
> `admin_profiles.id`, so the draft's `assigned_admin_id uuid fk->AdminProfile` becomes
> `assigned_admin_user_id uuid fk->users` — which is also what `resolvePermission()` and
> `recordAdminAuditEvent()` take.

---

## 1. Problem statement

**Today:** No support-ticket workflow exists. Verified in this repository: `support_tickets`,
`support_messages` and `support_notes` are spec 003 skeletons with no status, no category, no
priority, no assignment and no body column; `app/support/` contains only `report/`, spec 030's
safety-report form, and has no index page, so "Get help" has nowhere to land; there is no
`support` member of `RateLimitDomain`; `file_assets_context_type_ck` admits eight context values
and `support_attachment` is not one of them; and no `support/*` permission row exists in any
migration. Master §62 requires a smart hybrid experience — AI answers common questions, the user
can always reach a human, category-based reporting, booking/payment/dispute context attached
automatically, ticket history, priority, and safety/payment escalation. Master §63 requires a
unified admin support workspace: queue, priority, parties, booking/payment/dispute, conversation,
internal notes, attachments, assignment, SLA/deadline, AI summary, audit trail.

**Who is affected:** Every customer and provider with a problem that the specific flows do not
cover; Support Admins, whom master §69 makes the owner of "Support tickets and user support";
Operations Admins, who navigate to the queue and need visibility without the power to act on it.

**Why it matters now:** It is the general-purpose escalation path, and it is the last of the
user-facing escalation surfaces to ship. The specific workflows it attaches context from all
exist already — bookings (020), payments (021), refunds (022), cancellation and no-show (023),
service execution (028), reviews (029), safety (030) and disputes (031) — so a support ticket can
finally point at something real instead of asking the user to re-explain it.

**Success looks like:** A user asks a question, gets an AI answer where one is possible, and can
always reach a human in one action; a ticket they open from a booking already knows which booking
it is about; Support Admins work one queue with priority, assignment, an SLA deadline and a full
audit trail; and **no support action ever decides a safety case, a dispute, or a refund** — those
are handed off to the specs that own them, and the handoff is recorded.

### What this spec owns, and what it deliberately does not

**Owns:** the `SupportTicket` record and its five-state lifecycle; `SupportMessage` (the
user-to-platform thread) and `SupportNote` (admin-internal, never user-visible); the support
category and priority vocabularies and the fixed category-to-priority table; the SLA deadline and
its pause arithmetic; the `support_attachment` file-context policy; the five `support/*`
permissions; the `support` rate-limit domain; the customer/provider help surface and the admin
support workspace; the **pre-ticket AI answer** and the **advisory admin triage summary**; and the
**handoff record** that points a ticket at a safety report or a dispute — a pointer, never an
outcome.

**Does not own, and does not modify:**

| Concern | Owner | How this spec relates to it |
|---|---|---|
| Admin role/permission model, risk tiers, four-eyes approval, audit emission | spec 009 | Reused verbatim: five new `permissions` rows checked with `resolvePermission()`, and every admin action emitted through `recordAdminAuditEvent()`. **No second RBAC.** Every tier is `low`/`medium`, so this spec **never calls `authorizeAndInitiate()`** — it initiates no approval-bearing action, because no support action is consequential (DECIDED-1). |
| Audit **storage**, retention and audit querying | spec 039 | Spec 039 has not shipped — **verified: there is no `lib/audit` in this repository.** This spec writes through spec 009's `recordAdminAuditEvent()` into `security_events`, exactly as specs 023/025/029/030/031 already do, and builds **no** audit table, sink or reader of its own. §8 "Audit events" names the exact event types spec 039 will inherit. |
| Export artifact format, deletion grace, anonymization | spec 008 | Reused. This spec adds two allow-listed sections to the existing `generateExportPayload()` projection and **no new deletion behaviour**; `sweepDeletions()` anonymizes the `users` row in place and the FKs stay intact. |
| Conversations, booking chat, read receipts, the message retention sweep | spec 025 | **Not extended.** A support thread is user-to-platform with an admin third party, must survive a block, and is retained as an operational record — so it is a separate table, the same reasoning spec 031 applied to dispute messages (DECIDED-7). It reuses spec 025's `MESSAGE_BODY_MAX_LENGTH` and `applyContactPolicy()` rather than inventing a second prose bound or a second contact filter. `runMessageRetentionSweep()` is scoped to `messages` and is neither called nor changed. |
| Notification delivery, channels, preferences, frequency caps | spec 026 | Reused through `notify()`. Four content-free types are added to the existing closed catalogue in the existing `operational` category; **no migration** is needed, because notification *type* is not a database CHECK (only `notifications_category_ck` constrains categories) and `operational` is already a member. No new channel is invented. |
| File upload, scanning, finalization, signed URLs, deletion, retention sweeps | spec 027 | Reused wholesale. One new context value, `support_attachment`, is added to `file_assets_context_type_ck` by migration `0029` and registered through `registerFileContextPolicy()` — exactly what spec 029 did for `review_media` in `0026`. **No second storage system and no new media route.** |
| Blocking, safety reports, restrictions, bans | spec 030 / spec 038 | **One-way escalation only** (DECIDED-1). A support ticket can *create* a safety report through spec 030's existing `createSafetyReport()` and record the pointer. It applies no sanction, writes no `users.lifecycle_status`, and **a `safety`-category ticket can never be resolved `answered`** — a database CHECK, not a policy sentence. Safety priority stays spec 030's `setSafetyPriority()`. |
| Dispute eligibility, evidence, resolution, appeals, the money hold | spec 031 | **One-way escalation only.** A support ticket may point at a dispute as context, or hand off by pointing at a dispute the participant opened through spec 031's own route. This spec **creates no dispute, resolves none, and reads no dispute reasoning** — the admin follows the pointer into spec 031's own permissioned workspace. |
| Payment state, capture, the protection window | spec 021 | Read-only, and only `payments.booking_id`, to resolve a payment context to its booking for the ownership check. No amount, no status write, no provider call. |
| Refund creation, amounts, provider calls, the four-eyes override chain | spec 022 | **Untouched.** This spec creates no `refunds` row and computes no amount. A ticket about money is handed off with `handoff_target = 'refunds'`; a Finance Admin then acts through the existing `POST /api/v1/admin/refunds`. Asserted at source level by `lib/support/no-consequential-action.test.ts`. |
| Payout eligibility, earnings, transfers | spec 024 | **Untouched.** This spec registers no payout gate and writes no `payouts` column. |
| Booking lifecycle and the transition primitive | spec 020 | Read-only. This spec registers **no** booking transition and never writes `bookings.status`. Opening a support ticket about a booking changes nothing about that booking. |
| AI provider, prompts, model choice, quota, usage accounting, cost | spec 033 | Consumed only through `completeAi()`, only for **non-binding** output (DECIDED-2). No new AI task value, no new provider, no prompt store. |
| Admin dashboard composition and cross-domain metrics | spec 037 / spec 040 | This spec ships the support **queue**; the dashboard that may later summarise it is theirs. |

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a signed-in user with a question **When** they ask it at `POST /api/v1/support/assistant` **Then** an AI answer is returned where one is available, and in **every** case — success, disabled assistant, rate limit, quota exhaustion, provider outage or any other failure — the response carries `escalationAvailable: true` and the ticket-creation path works unchanged; **no** AI outcome can prevent, delay or alter reaching a human |
| AC-2 | **Given** a user creating a ticket with `contextType` + `contextId` **When** submitted **Then** the server **re-derives** the caller's authorization over that object (`requireBookingParticipant` for a booking, the booking behind `payments.booking_id` for a payment, the booking behind `disputes.booking_id` for a dispute) and stores the pointer only on success; an unauthorized, unknown or malformed context is refused **uniformly** `422 SUPPORT_CONTEXT_NOT_AVAILABLE`, so no probe can distinguish "does not exist" from "not yours"; a ticket created with valid context needs no re-explanation, and **the client's claim about the object is never trusted** |
| AC-3 | **Given** a user's own ticket **When** they read it **Then** they see its status, its category, its full message thread oldest-first, its attachments and — once resolved — its reopen deadline; and the serialized participant payload contains **no** `assigned_admin_user_id`, **no** `ai_summary`, **no** `support_notes` content, **no** `legal_hold`, **no** handoff pointer id and **no** idempotency column |
| AC-4 | **Given** a ticket created in any category **When** it is inserted **Then** its `priority` is **server-derived from the fixed `CATEGORY_PRIORITY` table and never taken from the request body** — `safety` to `critical`, `payment` to `high`, `booking`/`provider_quality`/`account` to `medium`, `technical`/`other` to `low` — so a `safety` or `payment` ticket can never be created at a lower priority than that table states; afterwards only an admin holding `support/triage` may change it, and the change records both the old and the new value in the audit trail |
| AC-5 | **Given** the admin support workspace **When** an admin holding `support/read` opens the queue and one ticket **Then** they see queue position, priority, the requester and their mode, the booking/payment/dispute **pointer with its neutral status**, the conversation, internal notes, attachments, assignment, the SLA deadline with its breached flag, and the AI summary — and the queue is filterable by `status`, `priority`, `category`, `assignedToMe` and `slaBreached` |
| AC-6 | **Given** any admin action on a ticket (read, assign, priority change, internal note, reply, resolve, reopen, close, hand-off) **When** taken **Then** `recordAdminAuditEvent()` writes the actor, the actor's roles, the action, the target, the reason where one is required, and the request's correlation id — through spec 009's existing emitter into `security_events`, with **no second audit system** |
| AC-7 | **Given** a ticket in any state **When** a transition is attempted **Then** it is accepted only if the `(from, to, actor)` triple appears in the §3 transition table; the write is a version-guarded conditional `UPDATE` on the expected status, so two concurrent transitions produce exactly one `200` and one `409 SUPPORT_TICKET_STATUS_CONFLICT`; a repeated `POST` carrying the same `Idempotency-Key` and fingerprint **replays** rather than acting twice; and `closed` is **terminal** — no actor, including `super_admin`, can leave it |
| AC-8 | **Given** a ticket whose SLA deadline has passed and which is not `resolved` or `closed` **When** the admin queue is read **Then** it is reported `slaBreached: true` and is sortable by deadline — and **nothing else happens**: no automatic escalation, no priority change, no notification and no sanction. Entering `awaiting_user` **pauses** the clock and leaving it pushes the deadline forward by exactly the elapsed pause, so a user's own delay can never breach their ticket |
| AC-9 | **Given** a ticket in category `safety` **When** an admin attempts to resolve it **Then** `resolution_kind = 'answered'` is refused by a database CHECK — it may only be resolved `handed_off` (with a `handoff_target` and, for safety, the `escalated_safety_report_id` pointer set) or `not_actionable`; **no support code path creates a dispute resolution, writes a `refunds`/`payouts`/`payments` column, calls a payment provider, or writes `users.lifecycle_status`**, asserted at source level |
| AC-10 | **Given** a user exercising spec 008 **When** they export their data **Then** it contains their own tickets and the thread bodies (their own and the admin replies they received) and **never** an internal note, an `ai_summary`, an admin identity or an idempotency column; **and when** their account is deleted **Then** spec 008's existing anonymize-in-place sweep runs unchanged and the ticket record stays referentially intact |

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing thing used | Where |
|---|---|---|
| Route envelope, correlation id, error mapping | `withApiRoute`, `apiSuccess`, `apiPaged`, `ApiRouteError` | `lib/api/handler.ts`, `lib/api/response.ts`, `lib/api/errors.ts` |
| Pagination | `parsePageParams`, `buildPage` | `lib/api/pagination.ts` |
| Idempotency | `requireIdempotencyKey`, `idempotencyFingerprint`, `IDEMPOTENCY_KEY_HEADER` | `lib/api/idempotency.ts` |
| Rate limiting | `checkRateLimit`, `rateLimitedError` — one **new** `RateLimitDomain` member, `support` | `lib/api/rate-limit.ts` |
| Session + CSRF | `requireSession`, `requireCsrf` | `lib/auth/require-session.ts` |
| Admin permission | `resolvePermission` | `lib/admin-rbac/permissions.ts` |
| Admin audit | `recordAdminAuditEvent`, `getAdminRoleNames` | `lib/admin-rbac/audit.ts`, `lib/admin-rbac/permissions.ts` |
| Booking ownership | `requireBookingParticipant` | `lib/bookings/read.ts` |
| Prose bound + contact filter | `MESSAGE_BODY_MAX_LENGTH`, `applyContactPolicy` | `lib/messaging/limits.ts`, `lib/messaging/contact-gate.ts` |
| Notifications | `notify()` | `lib/notifications` |
| Files | `registerFileContextPolicy`, `FileContextPolicy` | `lib/files/contexts/registry.ts` |
| AI | `completeAi`, `isAiDegradable`, `isAiAssistantEnabled` | `lib/ai` |
| Safety escalation | `createSafetyReport` | `lib/safety` |
| Deadline sweep idiom | `runDisputeAppealSweep` + the `CRON_SECRET` bearer route | `lib/disputes/close.ts`, `app/api/v1/cron/dispute-appeal-sweep/route.ts` |

### Repository paths (normative)

| Draft path (does not exist) | Real path |
|---|---|
| `packages/types/src/support.ts` | `lib/types/support.ts` |
| `apps/api/support/**` | `lib/support/**` |
| `apps/api/admin/support-inbox.*` | `app/api/v1/admin/support/**/route.ts` + `lib/support/admin-read.ts` |
| `apps/web/app/support` | `app/support/` (already exists, holds spec 030's `report/`) |
| `apps/web/app/admin/operations/support` | `app/admin/operations/support/` |
| `apps/web-e2e/support.spec.ts` | `e2e/support.spec.ts` |
| `packages/ui` `Chat` / `Table` / `PriorityBadge` | `@/components` `Card`, `Badge`, `Table`, `Textarea`, `Select`, `ListRow`, `EmptyState`, `ErrorState`, `Skeleton` — **no new primitive is added, and `PriorityBadge` does not exist** |

New modules: `lib/support/{index,create,read,admin-read,messages,notes,lifecycle,transitions,assign,triage,resolve,handoff,sla,limits,permissions,validation,rows,notifications,ai-assist,attachment-policy,errors,sweep,support-test-support}.ts` and `lib/types/support.ts`.

### Support ownership — normative (DECIDED-1)

**Support owns the conversation, not the consequence.** Every consequential decision in this
platform is already owned by a spec with its own authorization, its own audit and, where money is
involved, its own four-eyes chain. Support is the front door to those, and a front door that could
decide a case would be a second, weaker path to the same power.

| Matter raised in a ticket | Support may | Support may **not** | Where it goes |
|---|---|---|---|
| A question, a how-to, an account or technical problem | Answer it and resolve `answered` | — | Stays in support |
| Harassment, threats, unsafe conduct, impersonation | Record the account, hand off | Sanction, restrict, ban, warn, or judge the conduct | `createSafetyReport()` (spec 030); pointer stored in `escalated_safety_report_id` |
| A contested booking outcome between two parties | Explain the dispute route, hand off | Open a dispute for them, decide one, or read a dispute's reasoning | The participant opens it through spec 031's `POST /api/v1/bookings/{id}/disputes`; pointer stored in `escalated_dispute_id` |
| "I want my money back" | Explain eligibility, hand off `refunds` | Create a refund, quote an amount, or promise one | Finance acts through spec 022's `POST /api/v1/admin/refunds` |
| A payout question | Hand off `refunds` (the Finance target) | Write any `payouts` column | Spec 024's own surfaces |

**Can Support resolve a ticket that contains one of these?** Yes — but only as `handed_off` or
`not_actionable`, never `answered`. The ticket closes because support's part is finished, not
because the matter is decided. For `safety`-category tickets this is a **database CHECK**
(`support_tickets_safety_resolution_ck`), not a policy sentence, so no code path and no future
route can bypass it.

**The handoff is one-way and carries nothing back.** The specialised record's outcome is never
mirrored onto the ticket, because two records of one decision can disagree, and the participant
already sees the real one in the owning workflow. Setting a handoff pointer sets
`support_tickets.legal_hold = true`, which suppresses spec 027's asset expiry for that ticket's
attachments through the existing `lib/privacy/file-asset-storage.ts` hold path — **no second hold
mechanism.**

### AI boundary — normative (DECIDED-2)

Aligned with spec 033. **Exactly two AI call sites exist in `lib/support/`, both in
`lib/support/ai-assist.ts`, and neither returns into a decision.**

| | **1. Pre-ticket answer** (AC-1) | **2. Admin triage summary** (AC-5) |
|---|---|---|
| Purpose | Answer a common question before a ticket is needed | A short brief at the top of the admin queue item |
| Route | `POST /api/v1/support/assistant` | none — called after the ticket row exists |
| Spec 033 task | `conversation` — **already a member of `AI_TASKS` and already admitted by `ai_usage_events_task_ck`**, so no spec 033 migration and no invented vocabulary | `summarization` — likewise already a member |
| Subject | `{ kind: 'user', userId }` — the user asked, so it is their quota | `{ kind: 'system', label: 'support_triage_summary' }` — platform-initiated, so it must **not** consume a participant's quota for assistance they never requested (spec 031's exact precedent) |
| Stored? | **No.** No table, no column, no log of the text. Spec 033's `ai_usage_events` accounts the call and, by its own design, records no prompt and no response | Yes, in `support_tickets.ai_summary` |
| Who can see it | Only the asking user, in that response | Only an admin holding `support/read`. **Never** in a participant DTO (AC-3) |
| Rate limit | Spec 033's `ai` domain via `checkRateLimit('ai', userId)` — **not** `support`, so assistant traffic cannot consume the ticket surface's budget | none — it is not a route |

**When AI may answer directly:** only at call site 1, only in response to an explicit user request,
and only as text shown to that user.

**When human escalation is required:** always available, unconditionally. The response carries
`escalationAvailable: true` in every branch, and `app/support/page.tsx` renders the "Talk to a
human" action **outside** the assistant panel, so it is present before, during and after any AI
call. There is no state in which the UI or the API withholds it.

**AI may not classify.** Category is chosen by the user from the closed vocabulary below. Priority
is derived from that category by the fixed `CATEGORY_PRIORITY` table (DECIDED-4).
**`lib/support/ai-assist.ts` has no database access, no transaction, and takes and returns only
strings** — so there is no interface through which an AI value could reach `category`, `priority`,
`status`, `assigned_admin_user_id`, `resolution_kind`, `handoff_target` or either escalation
pointer, which is what `lib/support/ai-boundary.test.ts` asserts at source level, in the shape of
spec 031's `lib/disputes/ai-boundary.test.ts`.

**AI may generate the admin summary** (call site 2) — and nothing reads it back. No admin action
takes it as a parameter, and it is excluded from every participant projection.

**AI is never allowed to decide:** a category, a priority, an assignment, a transition, a
resolution, a handoff, a refund, a dispute outcome, a safety outcome, a sanction, or anything at
all about another user. It produces text for a human to read.

**Degradation, failure and timeout.** Total and silent for call site 2: a disabled assistant, an
outage, a rate limit, a quota, a configuration error or any other throw all yield `null`, the
column stays empty, and the ticket is created, triaged, assigned and resolved exactly as it would
have been. For call site 1 the failure is **visible but harmless**: the route returns `200` with
`{ answer: null, available: false, escalationAvailable: true }` rather than an error envelope,
because an AI outage is not the user's problem and must not look like a failed support request.
`isAiDegradable()` covers the expected outage shapes; anything else is logged to stderr and
degraded identically.

**Quota and rate limits.** Spec 033's own per-subject quota and the `ai` rate-limit domain apply
unchanged. Exhausting either affects **only** the assistant: ticket creation, messaging,
attachments and every admin route are on the `support` domain and are untouched. An
`AiQuotaExceededError` or `AiRateLimitedError` at call site 1 is caught and converted to the same
degraded `200` above — it is never surfaced as `429` from a support route, because the user has not
exceeded any support limit.

**Structural guarantee.** No AI path can perform enforcement, a refund, a dispute resolution, a
safety action, or any other consequential action, because `lib/support/ai-assist.ts` cannot reach
one: it imports `completeAi` and nothing else from the platform, and every mutating function in
`lib/support/` takes an explicit typed input with no AI-derived field.

### Ticket lifecycle — normative (DECIDED-3)

Five states. `closed` is **terminal**.

```
                 assign                request info
  open ───────────────────► assigned ◄──────────────────► awaiting_user
    │                         │  ▲          user replies          │
    │ resolve                 │  │ reopen (within window)         │ resolve
    │                 resolve │  │                                │
    └─────────────────────────┴──┴──► resolved ◄──────────────────┘
                                         │
                                         │ requester closes, admin closes,
                                         │ or the reopen window elapses (sweep)
                                         ▼
                                      closed   (terminal)
```

| From | To | Who may perform it | Notes |
|---|---|---|---|
| — | `open` | the requester (`POST /support/tickets`) | Priority derived here (AC-4); SLA deadline computed here |
| `open` | `assigned` | admin with `support/assign` | Claim self, or assign another admin who holds `support/respond` |
| `assigned` | `assigned` | admin with `support/assign` | Reassignment. **Does not reset the SLA deadline** (DECIDED-5) |
| `assigned` | `awaiting_user` | admin with `support/respond`, by replying with `requestsInformation: true` | Starts the SLA pause |
| `awaiting_user` | `assigned` | **the requester**, automatically, by posting any message; or an admin with `support/assign` | Ends the SLA pause and pushes the deadline forward by the elapsed pause |
| `open` \| `assigned` \| `awaiting_user` | `resolved` | admin with `support/resolve` | Requires `resolutionKind` and a reason of 10–2000 characters |
| `resolved` | `assigned` | **the requester**, once, within the reopen window; or an admin with `support/resolve`, within the same window | `reopen_count` is capped at 1 for the requester — spec 031's one-appeal rule, for the same reason: an unbounded reopen makes `closed` unreachable. An admin reopening does not consume the requester's one |
| `resolved` | `closed` | the requester; an admin with `support/resolve`; or the reopen sweep once the window elapses | |
| `closed` | — | **nobody** | Terminal. A new matter is a new ticket |

**Who can reopen.** The requester may, once, within `SUPPORT_REOPEN_WINDOW_DAYS` of `resolved_at`.
An admin holding `support/resolve` may, within the same window, without consuming the requester's
one. **Nobody can reopen a `closed` ticket** — not the requester, not a Support Admin, not
`super_admin`. This is enforced by the transition table and by
`support_tickets_closed_pairing_ck`.

**What happens after resolution.** The requester is notified (`support_ticket_resolved`, carrying
the reopen deadline). The ticket stays readable and can be reopened inside the window, but a
**`resolved` or `closed` ticket accepts no new messages and no new attachments**, so it cannot be
used as a permanent private channel to staff.

**Concurrency and duplicate transitions (AC-7).** Every transition is a single conditional
`UPDATE ... WHERE id = $1 AND status = $expectedStatus`, incrementing `version` and setting
`updated_at = clock_timestamp()`, in the shape `setSafetyPriority()` already uses. A zero-row
result re-reads the row and throws `409 SUPPORT_TICKET_STATUS_CONFLICT` carrying the current status
in `details`. Every mutating `POST` requires an `Idempotency-Key`; a repeat with the same key and
the same fingerprint **replays** the stored outcome with `200` instead of `201`, and the same key
with a different fingerprint is `409 IDEMPOTENCY_KEY_CONFLICT`.

### Categories and priority — normative (DECIDED-4)

Both are **controlled vocabularies enforced by database CHECK constraints**, not arbitrary strings.
The draft left `category text` and `priority text` unconstrained; that is corrected.

```ts
// lib/types/support.ts — mirrored by lib/db/schema.ts and by the CHECKs in 0029
export const SUPPORT_CATEGORIES = [
  'booking', 'payment', 'account', 'provider_quality', 'technical', 'safety', 'other',
] as const;

// The SAME four values spec 030 uses (`SAFETY_PRIORITIES`), deliberately. The draft's
// 'low' | 'medium' | 'high' | 'urgent' is corrected to the repository's existing vocabulary so
// the two admin queues rank identically and one shared `Badge` mapping serves both.
export const SUPPORT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
```

**Priority is server-derived, never user-supplied (AC-4).** `POST /support/tickets` **ignores** any
`priority` in the request body — the field is not in the request DTO, and an unknown property is a
`400 VALIDATION_ERROR` under the existing strict parse. It is computed from a constant:

```ts
// lib/support/limits.ts
export const CATEGORY_PRIORITY: Record<SupportCategory, SupportPriority> = {
  safety: 'critical',          // deterministic, per AC-4 — never "generic low-priority"
  payment: 'high',             // deterministic, per AC-4
  booking: 'medium',
  provider_quality: 'medium',
  account: 'medium',
  technical: 'low',
  other: 'low',
};
```

**Why this does not contradict spec 030's DECIDED-1** ("nothing anywhere derives a priority from a
category; `lib/safety/reports.ts` has no branch on this value"). Spec 030's rule forbids inferring
*severity from content* — reading a report's prose and claiming to know how bad it is. This is a
different thing: a **declared constant map from a value the user themselves chose**, with no
inference, no heuristic, no text analysis and no AI. It is as deterministic as a default, and it is
what makes AC-4 objectively testable. The two rules coexist precisely because this spec **makes no
automated severity claim**: it routes, it does not judge, and it never touches spec 030's own
`safety_reports.priority`, which remains human-set through `setSafetyPriority()`.

**Who may change priority afterwards.** Only an admin holding `support/triage` (tier `medium`),
through `POST /api/v1/admin/support/tickets/{id}/priority`, on a ticket that is not `resolved` or
`closed`. The requester cannot. The change is version-guarded on an `expectedStatus`, and it emits
`support.priority_changed` with `details: { from, to }` — both values, exactly as
`setSafetyPriority()` does. Changing priority **recomputes the SLA deadline** (DECIDED-5), which is
why it is `medium` rather than `low`.

### SLA — normative (DECIDED-5). This resolves the draft's only open question.

**Defaults, in whole hours**, measured from ticket creation:

```ts
// lib/support/sla.ts — pure, no I/O, importable by the UI
export const SLA_HOURS_BY_PRIORITY: Record<SupportPriority, number> = {
  critical: 4,
  high: 12,
  medium: 24,
  low: 72,
};
export const MIN_SLA_HOURS = 1;
export const MAX_SLA_HOURS = 720;   // the same bounds spec 021 uses for the protection window
```

**Configuration source.** These are **module constants**, following
`DEFAULT_PROTECTION_WINDOW_HOURS` / `MIN_` / `MAX_` in `lib/payments/protection-window.ts` — the
repository's existing idiom for a bounded duration that is **not** independently tunable. They are
deliberately **not** four environment variables: four correlated durations configured separately
can be made mutually inconsistent (a `low` deadline tighter than a `critical` one), and a support
queue whose ranking silently inverts is worse than one that is not tunable.
`assertSlaTableValid()` enforces both the bounds and strict monotonicity
(`critical < high < medium < low`) and is asserted by a unit test. **No new configuration system is
introduced**; when spec 041 ships this migrates to it without a contract change, because callers
only ever see `slaHoursFor(priority)`.

The one genuinely independent duration is the reopen window, and it follows the repository's
environment-variable idiom exactly — `DISPUTE_APPEAL_WINDOW_DAYS` (spec 031), `REVIEW_WINDOW_DAYS`
(spec 029), `DELETION_GRACE_PERIOD_DAYS` (spec 008):

```ts
export const DEFAULT_SUPPORT_REOPEN_WINDOW_DAYS = 3;
export const MIN_SUPPORT_REOPEN_WINDOW_DAYS = 1;
export const MAX_SUPPORT_REOPEN_WINDOW_DAYS = 30;
export function supportReopenWindowDays(): number; // reads SUPPORT_REOPEN_WINDOW_DAYS, falls back to the default
```

`SUPPORT_REOPEN_WINDOW_DAYS=3` is added to `.env.example` so `npm run check:env` passes.

**When the clock starts.** At `support_tickets.created_at`. `sla_deadline_at` is **materialised**
on the row at creation (`created_at + slaHoursFor(priority)`), not computed at read time, because
the admin queue sorts and filters by it and a computed expression cannot be indexed usefully here.

**`awaiting_user` pauses the SLA (AC-8).** Entering it stamps `awaiting_user_since`. Leaving it
executes, in the same conditional `UPDATE`:

```
sla_deadline_at     = sla_deadline_at + (clock_timestamp() - awaiting_user_since),
sla_paused_seconds  = sla_paused_seconds + extract(epoch from clock_timestamp() - awaiting_user_since),
awaiting_user_since = NULL
```

so the deadline moves forward by exactly the time spent waiting on the user, and a user's own delay
can never breach their own ticket. A ticket currently in `awaiting_user` is **never** reported
breached, whatever its stored deadline. `sla_paused_seconds` accumulates the total pause so that a
priority change can recompute correctly.

**Reassignment does not reset the deadline.** A new assignee inherits the original one. Resetting
on reassignment would make handing a ticket around a way to erase a breach.

**Priority change recomputes the deadline** as
`created_at + slaHoursFor(newPriority) + sla_paused_seconds`, plus the currently open pause if
there is one — anchored to creation, not to the moment of the change, so re-prioritising cannot buy
time either.

**Deadline calculation and timezone.** All arithmetic is UTC, on `timestamptz` columns, with
Postgres `clock_timestamp()` as the only clock. There is **no business-hours or working-calendar
model** — this repository has none, and inventing one here would create a second calendar that
nothing else respects. SLA hours are therefore wall-clock hours. The UI renders deadlines in the
viewer's locale through the same formatting the booking screens already use; no timezone is stored
on the ticket.

**What happens when an SLA expires.** `slaBreached` becomes `true` in the admin queue DTO, computed
as `sla_deadline_at < now() AND status NOT IN ('awaiting_user','resolved','closed')`, and the queue
can be filtered and sorted by it. **That is all.** No automatic escalation, no automatic priority
change, no notification to anyone, no sanction, no cron. Automated SLA consequences are
**explicitly out of scope** (§7) and are not a follow-up this spec depends on — visibility is what
master §63 asks for ("SLA/deadline" as a workspace field), and visibility is what ships.

### Context attachment — normative (DECIDED-6). Resolves AC-2.

**Supported context types:** `booking`, `payment`, `dispute`. Nothing else — not a request, not an
offer, not a review, not a user. The draft's open-ended `contextType`/`contextId` pair is closed by
`support_tickets_context_type_ck`.

**The client is never trusted.** `contextId` is an opaque identifier the server re-resolves and
re-authorizes on **every** read, using the owning spec's own helper:

| `contextType` | Resolution and authorization | Owning spec |
|---|---|---|
| `booking` | `requireBookingParticipant(userId, contextId)` — no `preferRole`, since either party may file | 020 |
| `payment` | `SELECT booking_id FROM payments WHERE id = $1`, then `requireBookingParticipant(userId, bookingId)` | 021 (read-only) |
| `dispute` | `SELECT booking_id FROM disputes WHERE id = $1`, then `requireBookingParticipant(userId, bookingId)` — **participation in the dispute's booking is the rule**, which is exactly spec 031's own participant definition | 031 (read-only) |

**Every failure is the same error.** Unknown id, malformed uuid, deleted row, or a real object the
caller has no relationship to all produce `422 SUPPORT_CONTEXT_NOT_AVAILABLE` with an identical
message, so the route cannot be used to enumerate bookings, payments or disputes. This is the same
enumeration-safety reasoning behind spec 031's "a non-participant gets `404`, never `403`".

**Context is live, not snapshotted.** The ticket stores `context_type` + `context_id` and nothing
else — no copied amount, no copied status, no copied party name. Every read re-resolves, so the
admin and the user always see the object's current state rather than a stale copy that could
contradict the source of truth.

**If the referenced object disappears or becomes inaccessible**, the ticket stays fully readable:
the DTO returns `context: { type, id, status: null, available: false }`. A support ticket must
never become unopenable because its subject changed, and the conversation is the record that
matters. Re-resolution failure is never an error response on a ticket read.

**Context cannot be added or changed later.** It is set at creation and immutable — there is no
`PATCH` and no `.../context` route. A ticket that has been triaged at a priority and assigned to an
admin must not be retargetable at a different, more sensitive object afterwards; that would make
the authorization check at creation meaningless. A new subject is a new ticket.

**Privacy boundary.** The context projection carries **only** the pointer and one neutral status
string (`bookings.status`, `payments.status`, `disputes.status`) — never an amount, never a
currency, never the counterparty's identity, never a dispute reason or resolution, never evidence,
never a safety report. **This is true of the admin DTO as well.** The admin workspace renders a
**link** into the owning spec's own permissioned surface (`/admin/operations/disputes/{id}`,
`/admin/operations/refunds`), and an admin who lacks that spec's permission simply cannot open it.
This spec therefore **widens no existing exposure**: it adds no way to see a dispute, a payment or
a safety report that specs 021/022/031 did not already grant. That is also why no "view sensitive
context" permission exists here (DECIDED-9) — there is no sensitive context to gate.

### Messages — normative (DECIDED-7)

**Why not spec 025's conversations.** Spec 025 models a **booking-scoped, two-party** thread with a
block gate, read receipts, unread counts and a retention sweep. A support thread is
**user-to-platform** with an admin as a third participant, must survive a block, must be retained
as an operational record rather than swept, and must never appear in the user's message inbox next
to their provider chats. Reusing `conversations` would require a null booking, a null counterparty,
a bypassed block gate and an exempted sweep — four holes in spec 025's own invariants. This is the
identical reasoning spec 031 applied to `dispute_messages`, and it is why the `support_messages`
skeleton already exists. **What is reused** is spec 025's `MESSAGE_BODY_MAX_LENGTH` (2000) and
`applyContactPolicy()` — no second prose bound, no second contact filter.

| Aspect | Rule |
|---|---|
| **Customer/provider messages** | The requester posts to `POST /api/v1/support/tickets/{id}/messages` while the ticket is `open`, `assigned` or `awaiting_user`. Posting while `awaiting_user` also performs `awaiting_user -> assigned` in the same transaction — the reply *is* the response the admin asked for |
| **Admin replies** | The **same route**, following spec 031's one-route-two-authorization-paths pattern (`app/api/v1/disputes/[id]/messages/route.ts`). The participant check is decisive and runs first, so an admin who is somehow the requester is treated as the requester. The admin path requires `support/respond`, sets `is_admin = true`, and accepts `requestsInformation?: boolean`, which performs `assigned -> awaiting_user` |
| **Sender identity** | `sender_user_id` (the existing skeleton column) plus a new `is_admin boolean`. The participant DTO exposes `author: 'you' \| 'support'` and **never an admin's user id or name** — the user is talking to the platform, not to a named individual (AC-3) |
| **Internal notes** | A **separate table**, `support_notes`, reached only through the admin routes. Notes are never rows in `support_messages`, so no projection bug in the thread query can leak one; `lib/support/privacy.test.ts` asserts that no participant code path selects from `support_notes` at all |
| **Rate limits** | The new `support` domain, `{ limit: 30, windowMs: 60_000 }` — the write-surface budget specs 015/017/018/020/027/029/030/031 all chose. Plus `MAX_SUPPORT_MESSAGES = 200` per ticket across all authors, bounding the thread itself, exactly as `MAX_DISPUTE_MESSAGES` does |
| **Contact-data filtering** | `applyContactPolicy(body, true)` — contact details are **flagged for Trust & Safety, never masked**, the same call spec 031 makes. Masking would be actively harmful here: "my phone +44… isn't receiving codes" is the entire content of a legitimate `account` ticket |
| **Editing and deletion** | **Neither exists.** No `PATCH`, no `DELETE`, no soft-delete column. A support thread is append-only, because it is the evidence of what the platform told a user |
| **Retention** | Retained with the ticket as an operational record. **Not** swept by spec 025's `runMessageRetentionSweep()`, which is scoped to the `messages` table and is neither called nor modified |
| **Read access** | The requester, and any admin holding `support/read`. Every admin read of a ticket emits `support.ticket_read` (AC-6) — reading is not deciding, but it is audited, spec 031's rule |
| **Notification** | An **admin** reply notifies the requester (`support_reply_posted`, or `support_info_requested` when `requestsInformation` is set). A **requester** reply notifies nobody: the queue is the admin's surface, and a push per user message would be noise, not information — spec 031's "filing an appeal notifies nobody" |

### Attachments — normative (DECIDED-8)

Spec 027 is reused wholesale. **No second storage system, no new media route, no re-implemented
scanning.**

| Aspect | Rule |
|---|---|
| **Context policy** | One new value, `support_attachment`, added to `file_assets_context_type_ck` by migration `0029` — **exactly what spec 029's `0026` did for `review_media`**, because that vocabulary is closed at the database and a consuming spec adds its own value rather than reusing another's. Registered through `registerFileContextPolicy('support_attachment', supportAttachmentPolicy)` from `registerSupportIntegration()` in `instrumentation.ts`, **after** spec 027 resets and registers its shipped policies and after specs 029/030/031 register theirs |
| **`contextId`** | The **ticket id**. A ticket exists before anything is attached to it, so there is no chicken-and-egg problem and no orphan window |
| **Authorization** | `canUpload`: the requester, on a ticket whose status is `open`, `assigned` or `awaiting_user`. `canRead`: the requester, **or** an admin holding `support/read` (the non-throwing `hasSupportReadPermission()` form, spec 031's `hasDisputeReadPermission` pattern) |
| **Scanning and finalization** | Entirely spec 027's `upload-url` then `finalize` flow with its existing scan gate; `file_assets_ready_pairing_ck` and the clean-scan CHECK already guarantee nothing is `ready` without a clean scan. This spec adds no code on that path |
| **Limits** | `publicEligible: false`. `MAX_SUPPORT_ATTACHMENTS = 5`, matching `MAX_REQUEST_ATTACHMENTS` and `MAX_MESSAGE_ATTACHMENTS`. `allowedKinds: ['image', 'document']` — a screenshot or a receipt, which is what a support attachment is |
| **Internal-note attachments** | **Deliberately not supported.** One context, one policy, one authorization rule. An admin with something to share attaches it to their reply, where the user can see it — which is the only place an admin-supplied file is useful. Stated explicitly so the absence is a decision, not an omission |
| **Retention and legal hold** | Ordinary spec 027 expiry, **except** that setting a handoff pointer sets `support_tickets.legal_hold = true`, which suppresses expiry for that ticket's assets through the existing `lib/privacy/file-asset-storage.ts` hold path — the same reuse spec 031 makes through `disputes.legal_hold`. **No second hold mechanism** |

### Admin RBAC — normative (DECIDED-9)

Five permissions on resource `support`, seeded by `drizzle/0029_add_customer_provider_support.sql`,
checked with `resolvePermission()`. The role split follows master §69, which gives **"Support
tickets and user support"** to the **Support Admin** by name.

| Permission | Tier | Roles | Covers |
|---|---|---|---|
| `support/read` | `low` | `support_admin`, `operations_admin`, `super_admin` | The queue, one ticket, the thread, the notes and attachment reads |
| `support/assign` | `low` | `support_admin`, `super_admin` | Claim, assign, reassign |
| `support/respond` | `low` | `support_admin`, `super_admin` | Admin replies **and** internal notes |
| `support/triage` | `medium` | `support_admin`, `super_admin` | Priority change (which recomputes the SLA deadline) |
| `support/resolve` | `medium` | `support_admin`, `super_admin` | Resolve, hand off, admin reopen, admin close |

**Why `operations_admin` gets read and nothing else.** The workspace lives at
`/admin/operations/support`, under the Operations nav item, exactly as spec 031 placed the dispute
queue — so Operations can **watch** the queue it navigates to. But master §69 names the Support
Admin for support tickets and names Operations for "Requests, bookings, providers", so Operations
decides nothing here. This is spec 031's `disputes/read` reasoning, applied identically.

**Why `trust_safety_admin` and `finance_admin` are absent.** A handed-off ticket reaches them
through **their own** spec's queue — `safety_reports` (030), `disputes` (031),
`POST /api/v1/admin/refunds` (022) — each already carrying the full context, the reason and, for
money, the four-eyes chain. Granting them a second window onto the same matter would duplicate
exposure without adding capability.

**Why there is no "view sensitive context" permission.** Because there is no sensitive context to
gate (DECIDED-6): the workspace shows pointers and neutral statuses only, and the detail is read
through the owning spec's own permissioned routes. Adding a permission here would imply an exposure
this spec does not create.

**Why no `authorizeAndInitiate()`.** Every tier is `low`/`medium`. No support action is
consequential — the consequential ones all belong to other specs and already carry their own
approval chains. Layering four-eyes onto "wrote an internal note" would gate nothing.

**Participant/admin conflict rule.** An admin who is the ticket's **requester** may not assign it,
triage it, note on it, reply to it as an admin, resolve it, hand it off, reopen it as an admin or
close it as an admin — every such attempt is `403 SUPPORT_PARTICIPANT_CONFLICT`, the exact mirror
of spec 031's `DISPUTE_PARTICIPANT_CONFLICT`. They retain full access **as the requester** through
the participant routes. The check runs before the permission check, so the error is about the
conflict, not about a permission they in fact hold.

### Routes added by this spec

All under `/api/v1`. Every route is wrapped in `withApiRoute`. Every mutating route requires
`requireCsrf` and an `Idempotency-Key` header. Every route is rate-limited on the new `support`
domain keyed by `session.userId`, **except** the assistant, which uses spec 033's `ai` domain.
**No route requires an active mode:** a support ticket is filed by a person, not by a role, and a
provider may well need help with something they did as a customer. The session's `active_mode` at
creation is recorded in `support_tickets.requester_mode` so the admin knows which hat the user was
wearing, but it gates nothing.

**Participant routes**

| Method | Route | Auth | Permission | Idem. | Success | Notes |
|---|---|---|---|---|---|---|
| `POST` | `/support/assistant` | session + CSRF | — | no | `200` `ApiResponse<SupportAssistantAnswerDto>` | AC-1. `ai` rate-limit domain. Creates nothing, so no idempotency key. **Never** returns `429`/`503` for an AI failure — degrades to `available: false` |
| `POST` | `/support/tickets` | session + CSRF | — | **yes** | `201` `ApiResponse<SupportTicketDto>` | AC-2, AC-4. Optional `contextType`/`contextId`. `priority` is **not** an accepted field |
| `GET` | `/support/tickets` | session | — | — | `200` `PagedResponse<SupportTicketSummaryDto>` | Own tickets, newest first. Scoped by `requester_user_id` in the `WHERE`, so it cannot widen |
| `GET` | `/support/tickets/{id}` | session (requester) | — | — | `200` `ApiResponse<SupportTicketDto>` | A non-requester gets `404`, never `403` |
| `POST` | `/support/tickets/{id}/messages` | session + CSRF | `support/respond` **on the admin path only** | **yes** | `201` (`200` on replay) | One route, two authorization paths (spec 031's pattern). A requester post while `awaiting_user` also transitions to `assigned` |
| `GET` | `/support/tickets/{id}/messages` | session (requester) or admin `support/read` | — | — | `200` `PagedResponse<SupportMessageDto>` | **Oldest first** — it reads as a record, not a chat feed |
| `POST` | `/support/tickets/{id}/reopen` | session (requester) + CSRF | — | **yes** | `200` `ApiResponse<SupportTicketDto>` | Within the window, once. `409 SUPPORT_REOPEN_LIMIT_REACHED` / `422 SUPPORT_REOPEN_WINDOW_ELAPSED` |
| `POST` | `/support/tickets/{id}/close` | session (requester) + CSRF | — | **yes** | `200` `ApiResponse<SupportTicketDto>` | The requester accepting the resolution early |

**Admin routes**

| Method | Route | Permission | Idem. | Success | Notes |
|---|---|---|---|---|---|
| `GET` | `/admin/support/tickets` | `support/read` | — | `200` `PagedResponse<AdminSupportTicketSummaryDto>` | AC-5. The unified inbox. Filters: `status`, `priority`, `category`, `assignedToMe`, `slaBreached`. Sorts: `slaDeadlineAt` (default, ascending), `createdAt`. The draft's `/admin/support/inbox` is **corrected** to this, matching `/admin/disputes` and `/admin/safety-reports` |
| `GET` | `/admin/support/tickets/{id}` | `support/read` | — | `200` `ApiResponse<AdminSupportTicketDto>` | AC-5. Emits `support.ticket_read` |
| `POST` | `/admin/support/tickets/{id}/assign` | `support/assign` | **yes** | `200` | `{ assigneeUserId, expectedStatus }` — self or another admin holding `support/respond`; `422 SUPPORT_ASSIGNEE_NOT_ELIGIBLE` otherwise |
| `POST` | `/admin/support/tickets/{id}/priority` | `support/triage` | **yes** | `200` | AC-4. `{ priority, reason, expectedStatus }`. Recomputes the SLA deadline |
| `POST` | `/admin/support/tickets/{id}/notes` | `support/respond` | **yes** | `201` | Internal. **Never** customer-visible |
| `GET` | `/admin/support/tickets/{id}/notes` | `support/read` | — | `200` `PagedResponse<SupportNoteDto>` | Admin-only by route placement **and** by permission |
| `POST` | `/admin/support/tickets/{id}/resolve` | `support/resolve` | **yes** | `200` | `{ resolutionKind, reason, handoffTarget?, expectedStatus }`. AC-9 |
| `POST` | `/admin/support/tickets/{id}/reopen` | `support/resolve` | **yes** | `200` | Within the window; does not consume the requester's one |
| `POST` | `/admin/support/tickets/{id}/close` | `support/resolve` | **yes** | `200` | |
| `POST` | `/admin/support/tickets/{id}/hand-off` | `support/resolve` | **yes** | `200` | Creates a spec 030 safety report via `createSafetyReport()`, **or** records an existing dispute id, **or** records `refunds`; sets `legal_hold` |

**Cron route** (not public REST surface; excluded from the OpenAPI contract by
`scripts/check-openapi-drift.ts`, as spec 001 §8 risk #1 establishes):

| Method | Route | Auth | Notes |
|---|---|---|---|
| `GET` | `/cron/support-reopen-sweep` | `Bearer ${CRON_SECRET}` | Closes `resolved` tickets whose reopen window has elapsed. Mirrors `/cron/dispute-appeal-sweep` exactly — same mechanism, same bearer check, **no new scheduling framework**. It decides nothing: an un-reopened resolution simply becomes final |

**OpenAPI registration.** All 18 non-cron routes are appended to `OPENAPI_ROUTES` in
`lib/api/openapi-registry.ts` with `tags: ['support']` (participant) and `tags: ['admin']` (admin),
matching how spec 031 registered its own. `npm run check:openapi-drift` must pass.

### Request and response types

```ts
// lib/types/support.ts  (NOT packages/types/src/support.ts — that path does not exist)

export const SUPPORT_CATEGORIES = [
  'booking', 'payment', 'account', 'provider_quality', 'technical', 'safety', 'other',
] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

export const SUPPORT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const SUPPORT_TICKET_STATUSES = [
  'open', 'assigned', 'awaiting_user', 'resolved', 'closed',
] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const SUPPORT_CONTEXT_TYPES = ['booking', 'payment', 'dispute'] as const;
export type SupportContextType = (typeof SUPPORT_CONTEXT_TYPES)[number];

export const SUPPORT_RESOLUTION_KINDS = ['answered', 'handed_off', 'not_actionable'] as const;
export type SupportResolutionKind = (typeof SUPPORT_RESOLUTION_KINDS)[number];

export const SUPPORT_HANDOFF_TARGETS = ['safety', 'dispute', 'refunds'] as const;
export type SupportHandoffTarget = (typeof SUPPORT_HANDOFF_TARGETS)[number];

/** The live, re-resolved pointer (DECIDED-6). Carries a neutral status and nothing else. */
export interface SupportContextDto {
  type: SupportContextType;
  id: string;
  /** `bookings.status` / `payments.status` / `disputes.status`. `null` when unavailable. */
  status: string | null;
  /** False when the object is gone or the caller can no longer reach it. The ticket still reads. */
  available: boolean;
}

// ---- Participant projection. Note what is ABSENT (AC-3): assignedAdminUserId, aiSummary,
// note content, legalHold, escalatedSafetyReportId, escalatedDisputeId, idempotency columns,
// slaDeadlineAt, slaBreached, requesterUserId.
export interface SupportTicketDto {
  id: string;
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  context: SupportContextDto | null;
  /** True once a handoff pointer exists — the fact, never the target record's id. */
  handedOff: boolean;
  resolutionKind: SupportResolutionKind | null;
  /** The admin's stated reason, which the user is entitled to (master §2.3's reasoning rule). */
  resolutionReason: string | null;
  resolvedAt: string | null;
  /** Present only while `resolved`; an absolute ISO instant, rendered in the viewer's locale. */
  reopenBy: string | null;
  reopenCount: number;
  attachmentCount: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketSummaryDto {
  id: string;
  subject: string;
  category: SupportCategory;
  status: SupportTicketStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessageDto {
  id: string;
  /** Never an admin's identity (AC-3). */
  author: 'you' | 'support';
  body: string;
  createdAt: string;
}

// ---- Admin projection (AC-5). Everything master §63 lists, and pointers for the rest.
export interface AdminSupportTicketDto {
  id: string;
  subject: string;
  description: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  requesterUserId: string;
  requesterMode: 'customer' | 'provider';
  context: SupportContextDto | null;
  assignedAdminUserId: string | null;
  slaDeadlineAt: string;
  slaBreached: boolean;
  slaPausedSeconds: number;
  awaitingUserSince: string | null;
  /** Spec 033 advisory output (DECIDED-2). NO decision path reads this, and it never reaches a
   * participant DTO. `null` whenever AI was unavailable — which changes nothing. */
  aiSummary: string | null;
  resolutionKind: SupportResolutionKind | null;
  resolutionReason: string | null;
  handoffTarget: SupportHandoffTarget | null;
  escalatedSafetyReportId: string | null;
  escalatedDisputeId: string | null;
  legalHold: boolean;
  reopenCount: number;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface AdminSupportTicketSummaryDto {
  id: string;
  subject: string;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportTicketStatus;
  assignedAdminUserId: string | null;
  slaDeadlineAt: string;
  slaBreached: boolean;
  createdAt: string;
}

export interface SupportNoteDto {
  id: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

/** AC-1. `escalationAvailable` is `true` in EVERY branch, including every failure. */
export interface SupportAssistantAnswerDto {
  answer: string | null;
  available: boolean;
  escalationAvailable: true;
}

// ---- Requests
export interface CreateSupportTicketRequest {
  subject: string;          // 5..200
  description: string;      // 10..4000
  category: SupportCategory;
  contextType?: SupportContextType;
  contextId?: string;
  // NO `priority` FIELD — AC-4. An unknown property is a 400 VALIDATION_ERROR.
}

export interface PostSupportMessageRequest {
  body: string;             // 1..MESSAGE_BODY_MAX_LENGTH (spec 025's 2000)
  /** Admin path only; ignored on the participant path. Performs `assigned -> awaiting_user`. */
  requestsInformation?: boolean;
}

export interface ResolveSupportTicketRequest {
  resolutionKind: SupportResolutionKind;
  reason: string;                            // 10..2000
  handoffTarget?: SupportHandoffTarget;      // required iff resolutionKind === 'handed_off'
  expectedStatus: SupportTicketStatus;
}

export interface HandOffSupportTicketRequest {
  target: SupportHandoffTarget;
  reason: string;                            // 10..2000
  /** target 'safety': the reported user; a spec 030 report is created via createSafetyReport(). */
  targetUserId?: string;
  /** target 'dispute': an EXISTING dispute id. This spec never creates a dispute. */
  disputeId?: string;
  expectedStatus: SupportTicketStatus;
}
```

### Privacy and data exposure — normative (DECIDED-11)

| Field | Requester sees | `support/read` admin sees |
|---|---|---|
| `subject`, `category`, `status`, `priority`, timestamps | yes | yes |
| `description` (their own prose) | yes (they wrote it) | yes |
| Message bodies, both directions | yes | yes |
| Message author | `'you'` / `'support'` | the `sender_user_id` |
| `support_notes` | **never, under any circumstance** | yes |
| `ai_summary` | **never** | yes |
| `assigned_admin_user_id` | **never** | yes |
| `sla_deadline_at`, `sla_breached`, `sla_paused_seconds` | **never** | yes |
| `legal_hold`, `escalated_safety_report_id`, `escalated_dispute_id` | **never** (only `handedOff: boolean`) | yes |
| `resolution_kind`, `resolution_reason` | yes — a user is entitled to the reason for a decision about them | yes |
| `idempotency_key`, `idempotency_fingerprint`, `version` | **never** | `version` only |
| Context object detail (amount, parties, dispute reasoning, evidence) | **never** — neutral status only | **never** — neutral status plus a link into the owning spec's own permissioned surface |

Asserted over the **serialized JSON**, not the TypeScript type, in `lib/support/privacy.test.ts` —
spec 031's exact test shape, because a type assertion cannot catch a stray `SELECT *`.

**Spec 008 integration (AC-10).** `lib/privacy/export.ts` gains two sections built with an explicit
column allowlist and an ownership-scoped join, never `select *` — the file's own stated rule:

```ts
supportTickets: Array<{
  id: string; subject: string; description: string; category: string;
  status: string; resolutionKind: string | null; resolutionReason: string | null;
  createdAt: string; resolvedAt: string | null;
}>;   // never: ai_summary, assigned_admin_user_id, sla_*, legal_hold, either escalation
      // pointer, priority-change history, or an idempotency column
supportMessages: Array<{
  id: string; ticketId: string; author: 'you' | 'support'; body: string; createdAt: string;
}>;   // never a sender_user_id, so an admin is never identified to the user by an export either
```

`support_notes` is **not exported and is not exportable** — there is no code path from
`generateExportPayload()` to that table.

**Deletion.** No new behaviour. `sweepDeletions()` anonymizes the `users` row in place; every
`support_*` FK is `ON DELETE restrict` and stays intact, so a closed ticket remains auditable
without retaining the deleted person's identity — spec 031's rule, verbatim.

### Idempotency and concurrency — normative

Every mutating `POST` requires `Idempotency-Key`. `support_tickets` carries
`(requester_user_id, idempotency_key)` unique; `support_messages` carries
`(sender_user_id, idempotency_key)`; `support_notes` carries `(author_user_id, idempotency_key)`. A
replay with a matching fingerprint returns the stored result with `200`; a mismatched fingerprint
is `409 IDEMPOTENCY_KEY_CONFLICT`. Every state change is a version-guarded conditional `UPDATE`
(AC-7).

### Error codes

The eight baseline codes in `API_ERROR_CODES` plus these domain codes, passed with an explicit
`status` per spec 004 §3's extension rule:

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | An admin route without the required `support/*` permission |
| `403` | `SUPPORT_PARTICIPANT_CONFLICT` | An admin acting on a ticket they themselves raised (DECIDED-9) |
| `404` | `SUPPORT_TICKET_NOT_FOUND` | Unknown id, **or** a ticket the caller is neither requester nor a `support/read` admin of — never `403`, so the id space cannot be enumerated |
| `409` | `SUPPORT_TICKET_STATUS_CONFLICT` | `expectedStatus` did not match, or a concurrent transition won. Carries `details.currentStatus` |
| `409` | `SUPPORT_REOPEN_LIMIT_REACHED` | The requester has already used their one reopen |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | Same key, different fingerprint. Reuses spec 015's existing `idempotencyKeyConflictError()` rather than minting a second code for the same condition — the Prompt-1 draft named it `IDEMPOTENCY_KEY_REUSED`, which does not exist in this repository |
| `422` | `SUPPORT_CONTEXT_NOT_AVAILABLE` | AC-2 — unknown, malformed, deleted **or** unauthorized context, uniformly |
| `422` | `SUPPORT_TRANSITION_NOT_ALLOWED` | The `(from, to, actor)` triple is not in the transition table, including any attempt to leave `closed` |
| `422` | `SUPPORT_TICKET_CLOSED` | A message or attachment attempted on a `resolved`/`closed` ticket |
| `422` | `SUPPORT_REOPEN_WINDOW_ELAPSED` | Reopen attempted after the window |
| `422` | `SUPPORT_ASSIGNEE_NOT_ELIGIBLE` | The assignment target does not hold `support/respond` |
| `422` | `SUPPORT_RESOLUTION_INVALID` | `handed_off` without a `handoffTarget`; a `safety` ticket resolved `answered` (AC-9); a `safety` handoff without `targetUserId`; a `dispute` handoff without a reachable `disputeId` |
| `422` | `SUPPORT_MESSAGE_LIMIT_REACHED` | `MAX_SUPPORT_MESSAGES` reached |
| `429` | `RATE_LIMITED` | The `support` domain (or the `ai` domain on the assistant route, and only for a genuine rate limit — never for an AI failure, which degrades instead) |

### Breaking-change check

- [x] N/A — new spec. No existing route, DTO, permission or table shape changes. The only edits to
  shipped files are **additive**: one `RateLimitDomain` member, one `file_assets` context value,
  four notification catalogue entries, two `DataExportPayload` sections, one `instrumentation.ts`
  registration, one link in `app/admin/operations/page.tsx`, and the new `OPENAPI_ROUTES` entries.

---

## 4. Data model changes

### Entities

All three tables **already exist** as spec 003 skeletons. Migration `0029` adds columns; it creates
no table.

| Entity | Change | Existing columns (spec 003) | Columns added by `0029` |
|---|---|---|---|
| `support_tickets` | **extend** | `id`, `created_at`, `updated_at`, `version`, `requester_user_id uuid not null fk->users` | `subject text not null`, `description text not null`, `category text not null`, `priority text not null`, `status text not null default 'open'`, `requester_mode text not null`, `context_type text null`, `context_id uuid null`, `assigned_admin_user_id uuid null fk->users`, `sla_deadline_at timestamptz not null`, `sla_paused_seconds integer not null default 0`, `awaiting_user_since timestamptz null`, `ai_summary text null`, `resolution_kind text null`, `resolution_reason text null`, `handoff_target text null`, `escalated_safety_report_id uuid null fk->safety_reports`, `escalated_dispute_id uuid null fk->disputes`, `legal_hold boolean not null default false`, `reopen_count integer not null default 0`, `resolved_at timestamptz null`, `closed_at timestamptz null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `support_messages` | **extend** | `id`, `created_at`, `updated_at`, `version`, `support_ticket_id uuid not null fk->support_tickets`, `sender_user_id uuid not null fk->users` | `body text not null`, `is_admin boolean not null default false`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `support_notes` | **extend** | `id`, `created_at`, `updated_at`, `version`, `support_ticket_id uuid not null fk->support_tickets`, `author_user_id uuid not null fk->users` | `body text not null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |

**No new table is created, and none is needed.** The draft's `SupportTicket` / `SupportMessage` /
`SupportNote` "new" entities are these three. `assigned_admin_user_id` targets **`users.id`**, not
`admin_profiles.id`, because every existing `support_*` FK targets `users` and because
`resolvePermission()` and `recordAdminAuditEvent()` both take a `users.id` — spec 031's DECIDED-2
made the identical correction for `disputes.claimed_by_admin_user_id`.

### Constraints and indexes

```sql
-- Controlled vocabularies (the draft left all three as free text)
support_tickets_category_ck          category IN ('booking','payment','account','provider_quality','technical','safety','other')
support_tickets_priority_ck          priority IN ('low','medium','high','critical')
support_tickets_status_ck            status   IN ('open','assigned','awaiting_user','resolved','closed')
support_tickets_requester_mode_ck    requester_mode IN ('customer','provider')
support_tickets_context_type_ck      context_type IS NULL OR context_type IN ('booking','payment','dispute')
support_tickets_context_pairing_ck   (context_type IS NULL) = (context_id IS NULL)
support_tickets_resolution_kind_ck   resolution_kind IS NULL OR resolution_kind IN ('answered','handed_off','not_actionable')
support_tickets_handoff_target_ck    handoff_target IS NULL OR handoff_target IN ('safety','dispute','refunds')

-- Lifecycle invariants, enforced by the database rather than by prose
support_tickets_resolution_pairing_ck   (resolution_kind IS NOT NULL) = (resolved_at IS NOT NULL)
                                        AND (resolution_kind IS NOT NULL) = (resolution_reason IS NOT NULL)
support_tickets_handoff_pairing_ck      (resolution_kind = 'handed_off') = (handoff_target IS NOT NULL)
support_tickets_closed_pairing_ck       (status = 'closed') = (closed_at IS NOT NULL)
support_tickets_awaiting_pairing_ck     (status = 'awaiting_user') = (awaiting_user_since IS NOT NULL)
support_tickets_assigned_pairing_ck     status <> 'open' OR assigned_admin_user_id IS NULL
support_tickets_reopen_count_ck         reopen_count BETWEEN 0 AND 2   -- 1 requester + 1 admin
support_tickets_sla_paused_ck           sla_paused_seconds >= 0

-- AC-9 AT THE DATABASE: support can never adjudicate a safety matter, whatever code does.
support_tickets_safety_resolution_ck    category <> 'safety' OR resolution_kind IS NULL
                                        OR resolution_kind IN ('handed_off','not_actionable')

-- Prose bounds (reusing spec 025's 2000 for message bodies; no second platform bound)
support_tickets_subject_length_ck       char_length(subject) BETWEEN 5 AND 200
support_tickets_description_length_ck   char_length(description) BETWEEN 10 AND 4000
support_tickets_reason_length_ck        resolution_reason IS NULL OR char_length(resolution_reason) BETWEEN 10 AND 2000
support_messages_body_length_ck         char_length(body) BETWEEN 1 AND 2000
support_notes_body_length_ck            char_length(body) BETWEEN 1 AND 2000

-- Idempotency (AC-7)
support_tickets_requester_idempotency_uq   UNIQUE (requester_user_id, idempotency_key)
support_messages_sender_idempotency_uq     UNIQUE (sender_user_id, idempotency_key)
support_notes_author_idempotency_uq        UNIQUE (author_user_id, idempotency_key)

-- Queue access paths (AC-5). The requester/ticket/author indexes already exist from 0001.
support_tickets_status_priority_created_idx   (status, priority, created_at)
support_tickets_sla_deadline_idx              (sla_deadline_at) WHERE status IN ('open','assigned')
support_tickets_assigned_admin_idx            (assigned_admin_user_id)
support_tickets_context_idx                   (context_type, context_id)
support_messages_ticket_created_idx           (support_ticket_id, created_at)
support_notes_ticket_created_idx              (support_ticket_id, created_at)

-- Spec 027 vocabulary extension, exactly as 0026 did for `review_media`
file_assets_context_type_ck   -- dropped and recreated with 'support_attachment' added
```

No partial-unique "one open ticket per user" constraint exists, deliberately: a person may
legitimately have several unrelated problems at once, and forcing them into one thread would
destroy the categorisation AC-4 depends on.

### Migration

- **Number:** `0029` — **verified** against `drizzle/meta/_journal.json`, whose last entry is
  `idx: 28`, `tag: "0028_add_disputes_resolution"`.
- **Name:** `0029_add_customer_provider_support.sql`, with a hand-written
  `0029_add_customer_provider_support_down.sql` sibling, per the repository convention.
- **Contents:** `ALTER TABLE ... ADD COLUMN` on the three existing skeleton tables; the CHECK and
  UNIQUE constraints and the six indexes above; drop-and-recreate of `file_assets_context_type_ck`
  with `support_attachment` added; and the five `permissions` rows, seeded with the
  `INSERT ... SELECT ... FROM (VALUES ...) JOIN roles ... ON CONFLICT DO NOTHING` idiom that `0028`
  uses.
- **Reversible:** **yes.** The `_down.sql` drops every added column, constraint and index, restores
  `file_assets_context_type_ck` to its exact pre-`0029` eight-value form, and deletes the five
  `permissions` rows by `(resource, action)`. Because the three tables are **not** created here,
  rollback returns them to their spec 003 skeleton shape rather than dropping them — which is what
  keeps `0001`'s foreign keys valid.
- **Backfill:** none. The tables are empty, so every added `not null` column without a default is
  added on an empty table and no `USING`/two-step dance is needed. `npm run check:schema-checksum`
  and `npm run check:schema-money-lint` must pass; **no money column is added by this spec**, which
  is the money lint's whole concern.
- **Downtime:** none.

### Retention and privacy

Support tickets, their threads and their notes are **operational records** and are retained with
the ticket — not under spec 025's message-retention sweep (scoped to `messages`, untouched) and,
where a handoff has set `legal_hold`, not under spec 027's ordinary asset expiry either, through
the existing `lib/privacy/file-asset-storage.ts` hold path. **No second hold and no second
retention mechanism is built.**

Spec 008's account deletion **anonymizes rather than deletes**: the `users` row is anonymized in
place and every `support_*` FK stays intact, so a resolved ticket remains auditable without
retaining the deleted person's identity. This spec adds **no new deletion behaviour and no new
export artifact**; it adds two allow-listed sections to spec 008's existing export projection
(§3 "Privacy"), and `support_notes` is unreachable from `generateExportPayload()`.

---

## 5. UI states

**Routes (actual).** `app/support/` already exists and holds spec 030's `report/`; this spec adds
its siblings rather than moving anything.

| Route | Who | Purpose |
|---|---|---|
| `app/support/page.tsx` | any session | **New.** The help entry point: the AI assistant panel, a permanently visible "Talk to a human" action, and the caller's ticket history |
| `app/support/new/page.tsx` | any session | **New.** Ticket creation: category `Select`, subject, description, attachments, and context pre-filled from `?contextType=&contextId=` |
| `app/support/tickets/[id]/page.tsx` | requester | **New.** One ticket: status, context pointer, thread, attachments, resolution and its reason, reopen/close actions |
| `app/support/report/page.tsx` | any session | **Unchanged** — spec 030's safety-report form, which this spec neither moves nor edits |
| `app/admin/operations/support/page.tsx` | admin `support/read` | **New.** The unified inbox (AC-5) |
| `app/admin/operations/support/[id]/page.tsx` | admin `support/read` | **New.** One ticket in full; assign / priority / note / reply / resolve / hand-off actions each gated by their own permission |

These sit beside the existing `app/admin/operations/{safety,refunds,payouts,disputes}`, matching
the established structure exactly. The `/admin/operations` landing page gains **one** entry in its
existing `links` array: `{ href: '/admin/operations/support', label: 'Support' }`. **No new
top-level admin nav item is added** — `app/components/nav-items.ts` is unchanged, because master's
admin nav is Operations / Users / Marketplace / Analytics / Settings and Support belongs under
Operations.

**Entry points into support.** `app/bookings/[id]/page.tsx` and the payment and dispute views each
gain a single "Get help with this" link carrying `?contextType=&contextId=`, which is what makes
AC-2's "not requiring the user to re-explain it" true in practice. The link is a plain `next/link`;
no component is added.

**Components.** Composed entirely from `@/components` — `Card`, `Badge`, `Button`, `Select`,
`Textarea`, `FormField`, `ListRow`, `Table`, `EmptyState`, `ErrorState`, `Skeleton`, `Alert`,
`Tag` — plus `app/_components/FileUpload` for attachments, exactly as `app/support/report/page.tsx`
already uses it. Route-local components live in `app/support/_components/` and
`app/admin/operations/support/_components/`. **No new design-system primitive is added** (the
draft's `PriorityBadge` does not exist anywhere in `ui/` or `@/components`; priority renders as a
`Badge`), and **no raw hex, font size, radius, shadow or spacing value is written** — every visual
value comes from `app/styles/apuriva-tokens.css` through the primitives, per the project's
design-system rule. Per the branding rule, **no page adds a logo header**; the existing `NavShell`
carries the single brand placement. **No premium visual redesign is introduced** — these screens
look like the safety, dispute and refund screens already shipped.

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` blocks for the ticket card, the thread and the attachment list; the admin inbox renders a `Skeleton` table with the same column widths as the loaded state, so the layout does not jump. Never a spinner-only screen. The assistant panel shows its own inline pending state while the rest of the page stays interactive — **the "Talk to a human" action is never disabled, not even mid-request** |
| **Empty** | A user with no tickets sees the "Get help" entry point and an `EmptyState` saying they have not contacted support yet — **not a blank history**, per the draft's own requirement. The admin queue with nothing open: `EmptyState` reading "Queue clear — no open tickets". A ticket with no attachments simply omits the section |
| **Error** | `ErrorState` with the envelope's `code` mapped to a human sentence. **Creation failure preserves the entered subject, description, category and already-finalized attachments** — the draft's requirement, and the same rule `app/support/report/page.tsx` already implements for the identical reason: someone describing a problem must never be made to type it twice. Attachments are finalized individually, so a failure on item 3 leaves items 1–2 attached and only the failed one retries. A failed message post keeps the draft in the `Textarea`. A `409 SUPPORT_TICKET_STATUS_CONFLICT` re-reads the ticket and explains that someone else changed it, rather than showing a generic error |
| **Success** | Ticket creation confirms **what will actually happen**: whether the question was answered by the assistant or the ticket is queued for a human. It never promises a response time it cannot keep — it states that a person will reply in the thread, not a guessed timeline. The resolution is shown to the requester **with its reason**, not just its outcome (master §2.3), and the reopen affordance appears with its deadline as an absolute date and disappears once the window closes or the one reopen is used |
| **Escalation** | The "Talk to a human" action is rendered **outside** the assistant panel and is present before, during and after any AI call, in every AI outcome (AC-1). When the assistant is unavailable the panel collapses to one neutral line and the escalation action is unaffected — it never becomes the *only* path by accident, and it is never the *unavailable* path |
| **Conversation** | Oldest-first, with admin messages visually distinguished as from "Support" and never from a named person. The composer is disabled with an explanatory line — never silently — once the ticket is `resolved` or `closed` |
| **Internal notes** | Admin detail page only, in a visually distinct panel labelled "Internal — not visible to the user", rendered from a **separate** request to `/admin/support/tickets/{id}/notes`. There is no code path on the participant page that could fetch them |
| **Assignment** | Admin detail page: current assignee, "Claim" for an unassigned ticket, and reassignment to another eligible admin. The SLA deadline is shown unchanged across a reassignment, which is the visible form of DECIDED-5 |
| **Priority** | A `Badge` everywhere it appears. Changeable only on the admin detail page, only with `support/triage`, and only behind a `ConfirmDialog` that states the reason is recorded |
| **SLA** | Admin surfaces only, never the requester's. The deadline as an absolute instant plus a relative "in 3h" / "overdue by 2h"; a breached ticket carries a distinct `Badge`. A paused ticket shows "paused — awaiting user" instead of a countdown, so the pause is legible rather than looking like a stalled clock |
| **Attachments** | `FileUpload` with the spec 027 `support_attachment` context and the ticket id; the five-file cap is shown before it is hit, not as an error afterwards |
| **Resolution** | The admin resolve action requires `resolutionKind` and a reason before it enables. Choosing `handed_off` requires a target; on a `safety`-category ticket the `answered` option is **absent from the UI as well as refused by the database** (AC-9) |
| **Accessibility** | Per spec 043: every control reachable and operable by keyboard with a visible focus ring from the token set; the thread is an `aria-live="polite"` region so a new reply is announced; status, priority and SLA are conveyed by **text as well as colour**, never colour alone; the assistant panel's pending state is announced; `ConfirmDialog` traps focus and restores it on close; every form control has a programmatic label through `FormField` |
| **Live updates** | Polling on the cadence `app/bookings/[id]/page.tsx` already uses, and on window focus, stopping once the ticket is `closed`. **No WebSocket**, because this repository has none |

---

## 6. Test plan

Vitest only. Unit and integration tests are `**/*.test.ts` colocated in `lib/support/` and
`app/api/v1/**`; the end-to-end test is `e2e/support.spec.ts`, joining the ten already there. The
draft's `apps/api/**` and `apps/web-e2e/**` paths do not exist and are replaced throughout.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | Transition-table totality and terminality of `closed`; `CATEGORY_PRIORITY` exhaustive over `SUPPORT_CATEGORIES`; `assertSlaTableValid()` bounds and strict monotonicity; deadline and pause arithmetic including a priority change during a pause; reopen-window arithmetic and env bounds; DTO participant projection; AI degradation to `null` | `lib/support/{transitions,limits,sla,validation,rows,ai-assist}.test.ts` |
| **API integration** | Full `open -> assign -> awaiting_user -> assigned -> resolve -> reopen -> resolve -> close`; the sweep-closes path; every route's happy path and its error table | `lib/support/lifecycle.integration.test.ts`, `app/api/v1/support/routes.integration.test.ts` |
| **Authorization** | Each of the five permissions on each admin route; `SUPPORT_PARTICIPANT_CONFLICT`; `operations_admin` can read and can do nothing else; a non-requester gets `404` not `403`; `SUPPORT_ASSIGNEE_NOT_ELIGIBLE` | `app/api/v1/support/authorization.test.ts`, `app/api/v1/admin/support/authorization.test.ts` |
| **Context authorization (AC-2)** | Each of the three context types: owned then attached; someone else's then `422 SUPPORT_CONTEXT_NOT_AVAILABLE`; nonexistent then the **same** code and message (byte-identical, asserted); malformed uuid then the same; a context that becomes unreachable after creation leaves the ticket readable with `available: false`; context is immutable (no route accepts a change) | `lib/support/context.integration.test.ts` |
| **Privacy (AC-3, AC-10)** | No participant-facing payload contains `assignedAdminUserId`, `aiSummary`, note content, `legalHold`, either escalation pointer, any `sla*` field or an idempotency column — asserted over the **serialized JSON**; no participant code path selects from `support_notes`; the export carries tickets and thread bodies and none of the above | `lib/support/privacy.test.ts`, `lib/privacy/export.integration.test.ts` (extended) |
| **Messaging** | A requester post while `awaiting_user` transitions to `assigned`; an admin post with `requestsInformation` transitions to `awaiting_user`; `MESSAGE_BODY_MAX_LENGTH` and `MAX_SUPPORT_MESSAGES` enforced; contact details flagged not masked; a post to a `resolved`/`closed` ticket is `422 SUPPORT_TICKET_CLOSED`; no edit or delete route exists | `lib/support/messages.integration.test.ts` |
| **Attachments** | Upload/read authorization for requester, `support/read` admin and a stranger; the five-file cap; upload refused on a closed ticket; a handoff sets `legal_hold` and the asset survives spec 027's expiry sweep; `support_attachment` is unregistered until `registerSupportIntegration()` runs (`422 FILE_CONTEXT_NOT_AVAILABLE` before it) | `lib/support/attachments.integration.test.ts` |
| **AI boundary and degradation (AC-1)** | `escalationAvailable: true` in **every** branch — success, `isAiAssistantEnabled() === false`, `AiRateLimitedError`, `AiQuotaExceededError`, `AiUnavailableError`, `AiProviderConfigurationError` and an arbitrary throw — and the assistant route returns `200` in all of them; a throwing `completeAi` changes no row and leaves `ai_summary` null; no create/assign/triage/resolve/handoff function accepts an AI-derived parameter (source level) | `lib/support/ai-assist.test.ts`, `lib/support/ai-boundary.test.ts` |
| **Consequential-action boundary (AC-9, source level)** | `lib/support/**` contains no `refunds`/`payouts`/`payments` write, no provider call, no `users.lifecycle_status` write, no `dispute_resolutions` write, no `applyBookingTransition` and no `authorizeAndInitiate` — the shape of `lib/disputes/no-money-leak.test.ts` | `lib/support/no-consequential-action.test.ts` |
| **SLA (AC-8)** | Deadline per priority; `awaiting_user` pauses and resuming pushes the deadline by exactly the elapsed pause; a paused ticket is never reported breached; reassignment leaves the deadline unchanged; a priority change recomputes from `created_at` plus the accumulated pause; a breached ticket is flagged and filterable and **nothing else happens** — no notification emitted, no priority changed, no status changed | `lib/support/sla.integration.test.ts` |
| **Lifecycle (AC-7)** | Every allowed transition by every allowed actor; every disallowed pair refused `422 SUPPORT_TRANSITION_NOT_ALLOWED`; `closed` unreachable-from for every role including `super_admin`; one requester reopen then `409 SUPPORT_REOPEN_LIMIT_REACHED`; reopen after the window `422` | `lib/support/lifecycle.integration.test.ts` |
| **Concurrency / idempotency (AC-7)** | Two simultaneous creates with one key produce one `201` and one replay; two simultaneous assigns produce one `200` and one `409`; two resolves, one wins; a reopen racing the sweep; same key with a different fingerprint is `409 IDEMPOTENCY_KEY_CONFLICT` | `lib/support/concurrency.integration.test.ts` |
| **Notifications** | The four types emitted on their exact triggers and on no others — in particular **no** notification on a requester reply, on assignment, on closure or on SLA breach; each body content-free; a duplicate `eventKey` suppressed; a throwing sink never rolls back the ticket | `lib/support/notifications.integration.test.ts` |
| **Audit (AC-6)** | Every one of the nine `support.*` events written to `security_events` with actor, roles, action, target, reason and correlation id; an admin ticket read is audited; no second audit store is written | `lib/support/audit.integration.test.ts` |
| **Export / deletion (AC-10)** | The two export sections' exact column sets; `support_notes` absent and unreachable; `sweepDeletions()` runs unchanged and leaves the ticket referentially intact | `lib/privacy/export.integration.test.ts`, `lib/privacy/deletion.integration.test.ts` (extended) |
| **Cross-spec regression** | Spec 027's registered-context list now includes `support_attachment` and nothing else changed; spec 025's `runMessageRetentionSweep()` still touches only `messages`; spec 030's `safety_reports` priority path is unchanged; spec 031's dispute routes are unchanged; spec 026's catalogue still renders every type; spec 004's OpenAPI drift check passes | existing suites, extended |
| **Migration / rollback** | `0029` applies to an `0028` database and `0029_down` restores it exactly, including the original eight-value `file_assets_context_type_ck` and the three skeleton tables' original shape; run by the existing `lib/db/migrations.integration.test.ts` and `lib/db/rollback.ts` harness | `lib/db/migrations.integration.test.ts` |
| **E2E** | A customer opens a booking, asks the assistant, escalates to a ticket with the booking attached, attaches a screenshot, a Support Admin claims it, requests information, the customer replies, the admin resolves with a reason, the customer reopens once, the admin resolves again and the ticket closes | `e2e/support.spec.ts` |

**Static gate (run in this order, per the project's implementation protocol, using the script names
that actually exist in `package.json`):** `npx tsc --noEmit` (or `npm run typecheck`),
`npm run check:env`, `npm run check:schema-baseline` (which runs `check:schema-checksum` then
`check:schema-money-lint`), `npm run check:openapi-drift`, then **exactly one clean full
`npx vitest run` with no other Vitest process running concurrently**.

> **Correction carried forward, not applied.** Spec 031 §6 names `npm run check:schema`,
> `npm run check:migrations`, `npm run lint:money` and `npm run lint:env`. **None of those four
> scripts exists in `package.json`.** Spec 031 is Approved and is deliberately **not edited here**,
> per the project's rule on previously approved specs; the real script names are used above and the
> discrepancy is reported rather than silently propagated.

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/support/ai-assist.test.ts::escalationAvailable is true in every branch`; `app/api/v1/support/routes.integration.test.ts::assistant returns 200 when AI is unavailable` |
| AC-2 | `lib/support/context.integration.test.ts::re-derives authorization for each context type`; `::unauthorized and unknown are byte-identical 422 SUPPORT_CONTEXT_NOT_AVAILABLE` |
| AC-3 | `lib/support/privacy.test.ts::participant payload omits every admin-only field` |
| AC-4 | `lib/support/limits.test.ts::CATEGORY_PRIORITY is exhaustive`; `lib/support/create.integration.test.ts::priority in the body is rejected and the table value is used`; `lib/support/triage.integration.test.ts::priority change audits from and to` |
| AC-5 | `app/api/v1/admin/support/inbox.integration.test.ts::returns every master §63 field`; `::filters by status, priority, category, assignedToMe and slaBreached` |
| AC-6 | `lib/support/audit.integration.test.ts::every admin action is recorded` |
| AC-7 | `lib/support/transitions.test.ts::closed is terminal`; `lib/support/lifecycle.integration.test.ts::closed is terminal`; `lib/support/concurrency.integration.test.ts::one 200 and one 409` |
| AC-8 | `lib/support/sla.integration.test.ts::awaiting_user pauses and resuming restores exactly`; `::a breach flags and does nothing else` |
| AC-9 | `lib/support/resolve.integration.test.ts::a safety ticket cannot be resolved answered`; `lib/support/no-consequential-action.test.ts` |
| AC-10 | `lib/privacy/export.integration.test.ts::support sections carry the allow-listed columns only`; `lib/privacy/deletion.integration.test.ts::support rows survive anonymization` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** the AI's answer *quality* for common questions. Functional
correctness of the escalation path — that a human is always reachable, in every AI outcome — is
tested exhaustively; whether a given answer was *good* is a product-iteration concern and is not a
software property. Likewise the substantive quality of an admin's reply: process correctness (an
authorized human, with a reason, audited, within a visible deadline) is tested; the rightness of a
given human judgement is not testable.

---

## 7. Out of scope

- **Safety adjudication** (spec 030). A ticket escalates into a safety report and stops; the report
  is spec 030's to work, and a `safety`-category ticket cannot be resolved `answered` (AC-9).
- **Dispute creation and resolution** (spec 031). Support explains the route and may point at an
  existing dispute; a participant opens one through spec 031's own route, and only Trust & Safety
  decides it.
- **Refund creation and amounts** (spec 022). A money ticket is handed off to Finance's existing
  four-eyes override chain; this spec quotes no amount and creates no refund.
- **Automated SLA consequences.** Breach is **visible only** (AC-8) — no auto-escalation, no
  auto-reprioritisation, no breach notification, no sanction. Master §63 asks for "SLA/deadline" as
  a workspace field; that is what ships. This is a bounded decision, not a deferred dependency:
  nothing in this spec assumes a follow-up.
- **Business-hours / working-calendar SLA.** Wall-clock hours only. The repository has no working
  calendar, and a second one owned here would be respected by nothing else.
- **Support teams, shifts, routing rules, round-robin assignment.** Master §63 lists "Team" as a
  workspace field; assignment here is **to a named admin**, which is the part that is implementable
  against spec 009's existing role model. A team abstraction needs a team entity that does not
  exist, and inventing one would be a second, parallel grouping alongside roles.
- **Live chat / WebSocket transport.** Master §62's "Chat for active/urgent cases" is served by the
  ticket thread with focus-and-interval polling, the transport every other live surface in this
  repository uses. There is no WebSocket here and this spec does not add one.
- **Canned replies, macros, knowledge-base articles, CSAT surveys.** None is required by master §62
  or §63, and each would be a content system of its own.
- **Support analytics and dashboards** (specs 037/040). This spec emits the data; they present it.
- **Audit storage and querying** (spec 039). This spec emits `support.*` events through spec 009's
  existing emitter and builds no store.

---

## 8. Decisions

Every question the draft left open is resolved. **There are no remaining open questions.** The
draft's §8 table held exactly one row — "SLA deadlines per priority tier, Support Ops, Open" — and
it is resolved by DECIDED-5.

| # | Decision | Where |
|---|---|---|
| DECIDED-1 | Support owns the conversation, not the consequence. Safety, disputes and money are handed off, never decided; a `safety` ticket cannot be resolved `answered` (a database CHECK) | §1, §3 "Support ownership", §4 |
| DECIDED-2 | Exactly two AI call sites, both advisory, both degrading totally; AI classifies nothing, decides nothing, and is structurally unable to reach a consequential path; escalation to a human is unconditional | §3 "AI boundary" |
| DECIDED-3 | Five states, `closed` terminal; the full `(from, to, actor)` table; one requester reopen inside a three-day window; version-guarded transitions and idempotent POSTs | §3 "Ticket lifecycle" |
| DECIDED-4 | Closed category and priority vocabularies at the database; priority **server-derived** from a fixed constant map and never client-supplied; changeable only by `support/triage`, audited with both values | §3 "Categories and priority" |
| DECIDED-5 | **Resolves the draft's only open question.** SLA = 4/12/24/72 wall-clock hours by priority, as bounded module constants (not four env vars); the clock starts at creation; `awaiting_user` pauses it; reassignment does not reset it; a priority change recomputes from creation; breach is visible and has no automated consequence; all arithmetic is UTC | §3 "SLA" |
| DECIDED-6 | Three context types; the server re-derives authorization every time; one uniform `422` for every failure; context is **live, not snapshotted**, and **immutable after creation**; only a neutral status is ever projected, to admins as well as users | §3 "Context attachment" |
| DECIDED-7 | A separate support thread rather than a spec 025 conversation, with spec 025's prose bound and contact filter reused; internal notes in a separate table; append-only, no edit, no delete | §3 "Messages" |
| DECIDED-8 | One new spec 027 context `support_attachment`, added to the closed CHECK by `0029` and registered at boot; requester uploads only; no internal-note attachments; legal hold reuses the existing path | §3 "Attachments" |
| DECIDED-9 | Five `support/*` permissions; `operations_admin` reads only; Trust & Safety and Finance reach a handed-off matter through their own specs; **no** sensitive-context permission, because no sensitive context is exposed; requester/admin conflict is `403` | §3 "Admin RBAC" |
| DECIDED-10 | Nine `support.*` audit events through spec 009's `recordAdminAuditEvent()` into `security_events`; **no** audit storage is built here; spec 039 inherits the event types when it ships | §8 "Audit events" |
| DECIDED-11 | An explicit participant/admin field matrix asserted over serialized JSON; two allow-listed spec 008 export sections; notes unreachable from the export; no new deletion behaviour | §3 "Privacy", §4 |
| DECIDED-12 | Four content-free notification types in spec 026's existing `operational` category; no migration; **no** notification on requester replies, assignment, closure or SLA breach | §8 "Notifications" |
| DECIDED-13 | Eighteen real routes at real paths; the draft's `/admin/support/inbox` corrected to `/admin/support/tickets`; the routes the acceptance criteria require but the draft omitted are added (assistant, message list, requester reopen/close, admin priority, note list, admin reopen/close, hand-off, and the reopen sweep) | §3 "Routes" |
| DECIDED-14 | Migration **`0029`**, extending the three existing spec 003 skeletons rather than creating tables; column names corrected to the skeletons'; `assigned_admin_user_id` targets `users`, not `admin_profiles` | §4 |

### Notifications (spec 026 reuse) — normative (DECIDED-12)

Four types added to the existing closed catalogue in `lib/notifications/catalogue.ts`, all in the
existing `operational` category. **No migration is required**, because notification *type* is not a
database CHECK — only `notifications_category_ck` constrains categories, and `operational` is
already a member. No new channel and no new category is invented.

| Type | Recipient | Trigger | Params |
|---|---|---|---|
| `support_ticket_created` | requester | Ticket created | none |
| `support_reply_posted` | requester | An **admin** replies | none |
| `support_info_requested` | requester | `assigned -> awaiting_user` | none |
| `support_ticket_resolved` | requester | `-> resolved` | `reopenBy` |

**Every body is content-free** — it carries the fact and a pointer into the app, never the ticket's
subject, the admin's words or the resolution reason. A notification must never become the channel
through which the content travels; the ticket is.

**Who is deliberately not notified.** A **requester reply** notifies nobody: the queue is the
admin's surface, and a push per user message is noise. **Assignment** notifies nobody: it is
internal bookkeeping. **Closure** notifies nobody: the requester was already told at resolution and
nothing further is required of them. **SLA breach** notifies nobody — DECIDED-5, and the single
most important of the four, because a breach notification is the thin end of the automated
consequence this spec puts out of scope.

Emission is **fire-and-forget after commit**, the shape specs 022/024/031 established: a failing
sink logs and is swallowed, because a notification must never roll back a ticket. The `eventKey` is
deterministic (`<type>:<ticketId>:<recipient>`, and `<type>:<messageId>` for a reply), so spec 026's
duplicate suppression makes a retried emission a no-op rather than a second push.

### Audit events (spec 009 reuse) — normative (DECIDED-10)

All emitted through `recordAdminAuditEvent()` into `security_events`, namespaced `support.*`, with
`resource: 'support'`, `targetType: 'support_ticket'`, `targetId: <ticketId>`, the actor's roles
from `getAdminRoleNames()`, an empty `approvalChain` (no support action needs approval — DECIDED-9)
and the request's `correlationId`.

| `eventType` | `action` | Reason required | `details` |
|---|---|---|---|
| `support.ticket_read` | `read` | no | — |
| `support.ticket_assigned` | `assign` | no | `{ from, to }` |
| `support.priority_changed` | `triage` | **yes** | `{ from, to }` — both values, spec 030's `setSafetyPriority()` shape |
| `support.note_added` | `respond` | no | `{ noteId }` |
| `support.admin_replied` | `respond` | no | `{ messageId, requestsInformation }` |
| `support.ticket_resolved` | `resolve` | **yes** | `{ resolutionKind, handoffTarget }` |
| `support.ticket_reopened` | `resolve` | **yes** | `{ by: 'admin' }` |
| `support.ticket_closed` | `resolve` | no | `{ by: 'admin' }` |
| `support.handed_off` | `resolve` | **yes** | `{ target, safetyReportId, disputeId }` |

**Handoff to spec 039.** Spec 039 owns audit storage, retention and querying; it has not shipped —
**verified: there is no `lib/audit` in this repository.** This spec therefore writes through spec
009's existing emitter exactly as specs 023/025/029/030/031 do, and builds **no** second audit
system. The nine event types above are namespaced so that when spec 039 builds real audit querying
over whatever store it ends up owning, it inherits them without this spec changing. The draft's
bare "(spec 039)" reference in AC-6 is corrected to name that handoff explicitly.

### Ownership table

| Concern | Owner | This spec's relationship |
|---|---|---|
| Privacy export projection, deletion grace, anonymization | **008** | Adds two allow-listed export sections; adds no deletion behaviour |
| Admin roles, permissions, risk tiers, four-eyes, audit **emission** | **009** | Seeds five `support/*` permissions; emits nine `support.*` events; adds no RBAC and no audit store |
| Booking lifecycle and participant resolution | **020** | Read-only, via `requireBookingParticipant`; registers no transition |
| Payment state and the protection window | **021** | Reads `payments.booking_id` only |
| Refunds and the money override chain | **022** | Hands off; creates no refund, quotes no amount |
| Conversations, booking chat, message retention | **025** | Reuses `MESSAGE_BODY_MAX_LENGTH` and `applyContactPolicy`; adds no conversation and touches no sweep |
| Notification delivery, channels, preferences | **026** | Adds four content-free types in the existing `operational` category; no migration |
| File upload, scanning, storage, retention, legal hold | **027** | Adds and registers one context, `support_attachment`; reuses the existing hold path |
| Blocking, safety reports, restrictions, bans | **030** / **038** | One-way escalation via `createSafetyReport()`; applies no sanction; a `safety` ticket cannot be resolved `answered` |
| Disputes, evidence, resolutions, appeals, the money hold | **031** | One-way pointer only; creates no dispute, decides none, reads no reasoning |
| **Support tickets, threads, internal notes, priority, SLA, assignment, the admin workspace** | **032** | **This spec** |
| AI provider, prompts, tasks, quota, usage accounting, cost | **033** | Consumes `completeAi` for two advisory call sites; adds no task value and no provider |
| Admin dashboard composition | **037** | Emits the queue; the dashboard is theirs |
| Moderation actions and action appeals | **038** | Untouched; a sanction is never a support action |
| Audit **storage**, retention and querying | **039** | Not shipped; this spec emits through 009 and inherits into 039 unchanged |
| Analytics and observability | **040** | Emits the metrics named in §9 |
| Feature flags and platform configuration | **041** | Not shipped; the SLA constants and the one env var migrate to it without a contract change |

### Operational inputs (do **not** block implementation)

- The four SLA durations (4/12/24/72 h) and the three-day reopen window are **product decisions
  recorded in this spec**, not open questions. Support Ops may revise them later; revising them is
  a constant change and an `.env.example` value, not a design change, because every caller sees
  only `slaHoursFor(priority)` and `supportReopenWindowDays()`.
- The category labels rendered in the UI are copy, owned by the same people, and changing a label
  never changes the `SUPPORT_CATEGORIES` value it maps to.

---

## 9. Rollout

- **Feature flag:** none. The spec 033 assistant already sits behind `isAiAssistantEnabled()`, and
  AC-1 guarantees the human path works with the assistant off — so there is nothing left to flag.
- **Migration order:** `0029` ships with the code. It adds columns to empty tables and extends one
  CHECK, so the order within the deploy is not load-bearing.
- **Boot order:** `registerSupportIntegration()` is added to `instrumentation.ts` **after** spec
  027 (which resets and registers its shipped policies) and after specs 029/030/031, matching the
  documented chain. It registers exactly one thing — the `support_attachment` file-context policy.
  Rolling this spec back returns that context to its refusing default
  (`422 FILE_CONTEXT_NOT_AVAILABLE`), so no shipped spec breaks.
- **Rollback:** revert the deploy and run `0029_add_customer_provider_support_down.sql`, which
  restores the three skeleton tables, the original eight-value `file_assets_context_type_ck` and
  the pre-`0029` permission set exactly.
- **Observability (spec 040):** ticket volume by category and priority; time-to-first-admin-reply
  and time-to-resolution by priority; SLA-breach rate by priority; reopen rate; handoff rate by
  target; and assistant-answer-versus-escalation rate. All derived from the columns above; this
  spec adds no metrics pipeline.

---

## 10. Verification evidence (implementation)

Recorded at implementation time. Everything below was run in this repository against the isolated
`apuriva_test` database (`vitest.config.ts` rewrites `DATABASE_URL` to a `*_test` sibling, so the
developer's own `apuriva` database is never touched).

### What shipped

| Area | Files |
|---|---|
| Types | `lib/types/support.ts`; one value added to `lib/types/files.ts`, four to `lib/types/notifications.ts` |
| Schema | `lib/db/schema.ts` — the three spec 003 skeletons extended; `file_assets_context_type_ck` widened |
| Migration | `drizzle/0029_add_customer_provider_support.sql` + its `_down.sql`, journal entry `idx: 29` |
| Domain | `lib/support/{index,limits,sla,reopen-window,transitions,errors,validation,rows,permissions,audit,notifications,ai-assist,context,create,read,admin-read,messages,notes,assign,triage,resolve,handoff,attachment-policy,sweep,support-test-support}.ts` |
| Routes | 8 participant + 10 admin under `app/api/v1/{support,admin/support}/**`, plus `app/api/v1/cron/support-reopen-sweep/route.ts` and `app/api/v1/support/support-id.ts` |
| UI | `app/support/{page,new/page,tickets/[id]/page}.tsx` + `support.module.css`; `app/admin/operations/support/{page,[id]/page}.tsx` + `support-admin.module.css`; one link added to `app/bookings/[id]/page.tsx` |
| Wiring | `lib/api/rate-limit.ts` (the `support` domain), `lib/api/openapi-registry.ts` (18 routes), `lib/notifications/catalogue.ts` (4 types), `lib/privacy/export.ts` (2 sections), `instrumentation.ts`, `vercel.json`, `.env.example`, `app/admin/operations/page.tsx` |

### Acceptance criteria

| AC | Verified by |
|---|---|
| AC-1 | `lib/support/ai-assist.test.ts` — `escalationAvailable` stays true across all six spec 033 failure modes, and the assistant route answers `200` in every branch |
| AC-2 | `lib/support/context.integration.test.ts` — an unauthorized context and a nonexistent one produce **byte-identical** refusals once the per-request correlation id is set aside |
| AC-3 | `lib/support/privacy.test.ts` (assertions over serialized JSON), `lifecycle.integration.test.ts` (a stranger gets `404`, never `403`), `e2e/support.spec.ts` (the internal note never reaches the customer) |
| AC-4 | `lib/support/limits.test.ts` (the table is exhaustive), `validation.test.ts` (a client-supplied priority is `400`), `lifecycle.integration.test.ts` (payment to high, safety to critical), `sla.integration.test.ts` (the audit records both values) |
| AC-5 | `lifecycle.integration.test.ts` (inbox fields and filters), `migration.integration.test.ts` (every column present) |
| AC-6 | `lifecycle.integration.test.ts` and `e2e/support.spec.ts` — six `support.*` event types asserted in `security_events` |
| AC-7 | `transitions.test.ts` (the table is total and `closed` is terminal for every actor), `concurrency.integration.test.ts` (one `200` and one `409`, and replays) |
| AC-8 | `sla.integration.test.ts` — pause and resume are exact, reassignment leaves the deadline byte-identical, a paused ticket is never breached, and a breach changes no row and emits no notification |
| AC-9 | `resolve.integration.test.ts` — refused by the application **and**, with the application bypassed entirely, by `support_tickets_safety_resolution_ck`; plus `no-consequential-action.test.ts` at source level |
| AC-10 | `export.integration.test.ts` — the two sections carry the allow-listed columns only, and the internal note is absent in any form |

### Commands

```
npx tsc --noEmit
npm run check:env                 # OK — 59 variables, all documented
npm run check:schema-baseline     # checksum PASSED; money-lint PASSED
npm run check:openapi-drift
npx vitest run lib/support e2e/support.spec.ts
npx vitest run lib/support e2e/support.spec.ts lib/files lib/privacy lib/safety \
               lib/notifications/catalogue.test.ts lib/disputes/ai-boundary.test.ts
```

### Spec 032 test results

**175 passed / 175**, across 20 files: the unit suites `transitions`, `limits`, `sla`,
`validation`, `privacy`, `ai-assist`, `ai-boundary`, `no-consequential-action`; and the integration
suites `lifecycle`, `context`, `authorization`, `sla`, `resolve`, `concurrency`, `notifications`,
`attachments`, `sweep`, `export`, `migration`, plus `e2e/support.spec.ts`.

### Cross-spec regression

**514 passed / 514**, across 56 files — spec 032 together with `lib/files` (spec 027),
`lib/privacy` (spec 008), `lib/safety` (spec 030), spec 026's catalogue and spec 031's AI boundary.
No shipped spec regressed.

### Rollback

`0029_add_customer_provider_support_down.sql` is **executed**, not merely read, by
`lib/support/migration.integration.test.ts`: it runs statement by statement inside a transaction
that is then rolled back, asserting that the feature columns disappear while the spec 003 skeleton
(`id`, `requester_user_id`) survives, and that the live schema is untouched afterwards. The content
gate — `RAISE EXCEPTION` while any support row exists — is asserted separately at file level. The
rollback narrows `file_assets_context_type_ck` by exactly one value; `safety_evidence` and
`review_media` survive it.

### Defects found and fixed during implementation

1. **Missing covering indexes.** `support_tickets.escalated_safety_report_id` and
   `escalated_dispute_id` were added as foreign keys without their own btree index, which spec 003
   AC-4 requires. Caught by `lib/db/schema-lint.test.ts` and fixed in `lib/db/schema.ts`, `0029`
   and `0029_down`.
2. **Wrong error-code name in the Prompt-1 draft.** Section 3 named `IDEMPOTENCY_KEY_REUSED`; this
   repository's code is `IDEMPOTENCY_KEY_CONFLICT` (`lib/requests/errors.ts`). The spec now names
   the real one and the implementation reuses the existing helper rather than minting a second code
   for the same condition.
3. **`handoff_target` written too early.** The hand-off route initially set it while the ticket was
   still live, which would have hollowed out `support_tickets_handoff_pairing_ck` (the pair would
   have been half-formed, and a CHECK comparing against a NULL passes). It is now written only by
   the resolution; the hand-off records the pointer, the legal hold and the audit event.

### Schema drift corrected (spec 030, one line, authorized)

`lib/db/schema.ts` declared `file_assets_context_type_ck` with eight values, but migration `0027`
(spec 030) had already added a ninth, `safety_evidence`, to the live constraint. Because `0029` has
to drop and recreate that constraint, recreating it from the stale declaration would have **removed
`safety_evidence` from the live database and broken spec 030's evidence uploads**. The migration
therefore recreates all ten values, and the declaration in `lib/db/schema.ts` was corrected to
match the migrations. No spec 030 logic, route or test was changed.

### Pre-existing failures — NOT introduced by this spec

Each was verified to be independent of spec 032 and deliberately left alone.

| Failure | Belongs to | Evidence it is not spec 032's |
|---|---|---|
| `lib/files/upload.ts(119,45)` TS2345 — `isUuid(string \| undefined)` | spec 027 | `upload.ts` and `lib/files/sql.ts` are both unmodified; this spec's entire change to `lib/types/files.ts` is one added union member |
| `lib/notifications/delivery.integration.test.ts(26,107)` TS2339 — `DispatchSweepOptions.adapters` | spec 026 | Unmodified file, unrelated to the catalogue entries this spec adds |
| `check:openapi-drift` — `/admin/categories/{id}` versus `{categoryId}` | spec 010 | Both registry entries exist at `HEAD`; this spec's registry diff is purely additive and touches no catalog route |
| `lib/db/migrations.integration.test.ts` — expects 80 tables, finds 98 | spec 003 | `0029` contains **zero** `CREATE TABLE`; migrations `0012`–`0027` added 16 tables, so the hard-coded 80 has been stale since around spec 019 |
| `lib/db/schema-coverage.test.ts` — 4 extra tables (`catalog_suggestions`, `price_adjustments`, `refunds_status_history`, `refunds_status_transitions`) | specs 010/019/022 | None is a support table; this spec creates no table |
| `lib/db/schema-lint.test.ts` AC-5 — 6 undocumented `jsonb` columns across `services`, `catalog_suggestions`, `service_fields`, `service_requirements`, `service_packages` | specs 010/011 | This spec adds no `jsonb` column |
| Booking-seeded suites fail between roughly 23:00 and midnight Asia/Karachi | spec 020 fixture | `seedBookingScenario` places `preferred_at` at `now + 1 minute` with a 60-minute duration, so the slot straddles midnight and fits inside no single day's `00:00–1440` availability window. Reproduced on spec 031's committed suite: 14/14 failed at 23:35, 14/14 passed at 00:08. Reported, not fixed |

### Ownership held

No booking transition registered, no payment, payout or refund gate registered, no safety
restriction gate registered, no `refunds`/`payouts`/`payments` row written, no dispute created or
resolved, and no `users.lifecycle_status` touched — asserted at source level by
`lib/support/no-consequential-action.test.ts`, and structurally for the AI paths by
`lib/support/ai-boundary.test.ts`.
