# Spec: Blocking, Reporting & Safety Incidents

**File:** `docs/specs/2026-08-28-030-blocking-reporting-safety-incidents.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §53, §64–§65, §132.17, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §9, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (the `safety_reports` baseline skeleton and the `baseColumns()` convention),
spec 004 (envelope, `API_ERROR_CODES`, `RateLimitDomain`, pagination, OpenAPI registry), spec 005
(session, CSRF), spec 006 (`requireActiveMode`, `users.lifecycle_status`), spec 008
(`lib/privacy/export.ts`, the anonymize-on-deletion sweep), spec 009 (`resolvePermission`,
`recordAdminAuditEvent`, the seven roles and four risk tiers — but **not**
`authorizeAndInitiate`, which this spec never calls; see DECIDED-3), spec 015
(`requests.urgency`), spec 017 (`ExclusionReason`, `lib/matching/run.ts`), spec 020 (`bookings`),
spec 025 (`registerConversationBlockGate` — **the port this spec fills**, and the
`messaging/read_conversation` permission), spec 026 (`notify()`), spec 027 (`file_assets`, the
`FileContextPolicy` registry), spec 029 (`review_reports`, and the `reviews/moderate` precedent),
spec 033 (`completeAi`, `isAiDegradable`) — **all verified in this repository while writing this
document.**

**Feeds:** spec 031 (a safety concern arising from a dispute escalates here, not the reverse),
spec 038 (the full moderation-action catalogue reads this spec's queue rather than building a
second one), spec 039 (audit consolidation), spec 040 (observability counters).

> **Repository-shape note (normative).** This repository is a **single Next.js application**. There
> is no `apps/web`, `apps/api`, `apps/worker`, `apps/web-e2e`, `packages/ui` or `packages/types`.
> API routes are `app/api/v1/**/route.ts`, domain logic is `lib/**`, DTOs are `lib/types/*.ts`,
> design-system primitives live in `ui/` and are re-exported through `@/components`, app-level
> components live in `app/_components/` or a route-local `_components/` folder, and migrations are
> `drizzle/NNNN_*.sql` with a hand-written `_down.sql` sibling. The only test runner is **Vitest**,
> whose `include` is `**/*.test.{ts,tsx}` and `e2e/**/*.spec.{ts,tsx}`; there is no Playwright and
> no Cypress. The previous draft's `packages/types/src/safety.ts`, `apps/api/safety/**`,
> `apps/web/app/support/report`, `apps/web/app/admin/operations/safety`, `apps/web-e2e/safety.spec.ts`
> and `packages/ui` `ReportForm`/`PriorityBadge` **do not exist and are not created**; §3, §5 and §6
> name their real counterparts.

---

## 1. Problem statement

**Today:** No blocking, reporting, or safety-incident workflow exists. Verified in this repository:
there is **no block table of any kind** in `drizzle/0001_baseline_schema.sql` or any later
migration, and `safety_reports` exists only as a spec 003 skeleton carrying exactly
`baseColumns()`, `reporter_user_id` and `booking_id` — no target, no category, no priority and no
status, so nothing can be triaged. Spec 025 already shipped a `ConversationBlockGate` **port** with
an inert default (`lib/messaging/block-gate.ts`), whose own comment states "spec 030 owns blocking
mechanics" and "`user_blocks` does not exist and spec 030 has not shipped". That port is live,
consulted on every send, and currently answers "nobody is blocked".

**Who is affected:** Any user needing to protect themselves from another user; Trust & Safety
admins, who today have `messaging/read_conversation` but no safety queue to work; and anyone in a
genuine emergency who must be redirected to real emergency services rather than left believing a
marketplace will respond.

**Why it matters now:** Spec 025 shipped the block seam and spec 029 shipped the moderation-queue
pattern this spec follows. Both preconditions now exist.

**Success looks like:** A user can block another user and be confident that person cannot message
them again or be matched to their future requests; a safety report reaches a named human on a
restricted, audited queue; evidence is preserved in private storage; and no automated system —
least of all the AI assistant — can ban, suspend or restrict anyone.

### What this spec owns, and what it deliberately does not

**Owns:** the `UserBlock` record and every effect of a block; the `SafetyReport` record and its
lifecycle; the `safety_evidence` file context policy; the Trust & Safety queue and its admin
routes; the registration of spec 025's block gate and of this spec's matching-exclusion port; the
**definition** of the `SafetyRestrictionGate` port and the safety-report request/audit record that
goes with it — but not its implementation, and not its registration (DECIDED-3); and the
marketplace-not-emergency disclosure required by AC-6.

**Does not own, and does not modify:**

| Concern | Owner | How this spec relates to it |
|---|---|---|
| Admin role/permission model, risk tiers, approval | spec 009 | Reused verbatim: three new `permissions` rows, checked with `resolvePermission()`. All three are `low`/`medium`, so **this spec never calls `authorizeAndInitiate()`** — it initiates no approval-bearing action (DECIDED-3). No second authorization framework. |
| Audit storage | spec 009 → 039 | `recordAdminAuditEvent()` → `security_events` only. Spec 039 has **not** shipped (there is no `lib/audit`), so this spec writes through spec 009's function exactly as specs 023/025/029 do. |
| Messaging, conversations, admin conversation reads | spec 025 | Read-only. This spec **registers** the existing `ConversationBlockGate` port and writes no messaging column. Admin safety reads already exist via `messaging/read_conversation`. |
| Ranking algorithm, weights, renormalization | spec 017 | Untouched. Exclusion happens in spec 017's **hard eligibility** stage through a registered port (§3 "Blocking → matching"). |
| File upload, scanning, storage, signed URLs, deletion | spec 027 | Reused wholesale. One new context policy; **no** second storage system and no new media route. |
| Review reports | spec 029 | Not duplicated (§3 "Reporting"). `review_reports` stays spec 029's; this spec adds no generic review-report path. |
| AI provider, prompts, quota, usage accounting | spec 033 | Consumed only through `completeAi()`, only for **non-binding** assistance, never for enforcement (§3 "AI boundary"). |
| Disputes | spec 031 | Transactional disagreements are theirs; safety concerns are this spec's. This spec opens no dispute. |
| The full moderation-action catalogue — **warning, restriction, suspension, ban**, content removal, booking intervention, payout freeze — and its appeal path | spec 038 | **Verified**: spec 038's `ModerationActionDto.actionType` is `'warning' \| 'restriction' \| 'suspension' \| 'ban' \| 'content_removal' \| 'booking_intervention' \| 'payout_freeze'`, its AC-1 drives the spec 006/008 lifecycle states, its AC-2 applies spec 009 four-eyes, and its AC-5 provides the appeal. This spec therefore owns **no** enforcement action at all — only a port that hands a request to spec 038 (DECIDED-3). |
| Listing / service content moderation | spec 038 | Its scope is explicitly "user/provider/**listing**" with a `content_removal` action. This spec reports **people**, not listings (DECIDED-2). |

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** user A blocks user B **When** the block is active **Then** B cannot send messages to A and is excluded from matching on A's future requests, while messages already sent remain readable and an authorized Trust & Safety admin can still read the conversation |
| AC-2 | **Given** a user submits a safety report about another user **When** it is submitted **Then** a `safety_reports` row is created with the reporter, the target, a category and a status of `submitted`, and it appears on the Trust & Safety queue |
| AC-3 | **Given** a safety report **When** it exists **Then** its detail, and every evidence asset attached to it, are readable only by an admin holding `safety_reports/read` (plus the reporter's own restricted view), and every such read writes an audit event naming actor, roles, target and correlation id |
| AC-4 | **Given** the AI assistant is used anywhere in this flow **When** it produces a classification or summary **Then** that output is advisory only, is stored as a clearly-labelled suggestion, never sets `priority` or `status`, and no AI failure changes any outcome — enforcement is reachable only through a human admin route |
| AC-5 | **Given** a safety report whose resolution calls for a temporary restriction **When** the resolving admin requests one **Then** the request is handed to spec 038's restriction capability through a registered port, is recorded against the report with its reason, and — while spec 038 has not shipped — is refused cleanly with `422 RESTRICTION_UNAVAILABLE` without changing any account state; **no code in this spec ever writes `users.lifecycle_status`** |
| AC-6 | **Given** a customer is choosing or viewing the "Urgent — as soon as possible" option on a request **When** the urgency UI renders **Then** a visible, non-fine-print notice states that Apuriva is a marketplace and not an emergency service and directs genuine emergencies to appropriate local emergency services |

> AC-2 is deliberately narrower than the previous draft's "reports another user **or a listing**".
> Listing/content moderation is spec 038's: its success statement covers actions "against a
> user/provider/**listing**" and its `ModerationActionDto.actionType` includes `content_removal`
> (DECIDED-2).
>
> AC-5 is deliberately narrower than the previous draft's "it follows spec 009's risk-tiered
> approval". Spec 038 owns the restriction action itself, including its approval tier and its appeal
> path; this spec owns only the seam and the guarantee that nothing else can reach account state
> (DECIDED-3).

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing mechanism (verified in this repository) |
|---|---|
| Response envelope, correlation id, error mapping | `withApiRoute` + `apiSuccess`/`apiPaged`/`apiError` (`lib/api/handler.ts`, `lib/api/response.ts`) |
| Error taxonomy | `ApiRouteError` + `API_ERROR_CODES` (`lib/api/errors.ts`); domain codes pass an explicit `status` |
| Session / CSRF | `requireSession`, `requireCsrf` (`lib/auth/require-session.ts`, `lib/auth/csrf.ts`) |
| Active mode | `requireActiveMode(session, 'customer' \| 'provider')` (`lib/auth/require-mode.ts`) |
| Idempotency | `requireIdempotencyKey` + `idempotencyFingerprint` (`lib/api/idempotency.ts`), scoped per actor at the database |
| Pagination | `parsePageParams` / `buildPage` (`lib/api/pagination.ts`) |
| Rate limiting | `checkRateLimit(domain, identifier)` (`lib/api/rate-limit.ts`) |
| Admin authorization | `resolvePermission(userId, resource, action)` (`lib/admin-rbac/permissions.ts`) behind `requireSafety*Permission()` helpers — the shape `lib/no-show/resolution.ts` and `lib/reviews/permissions.ts` already use |
| Risk-tiered approval | `authorizeAndInitiate()` (`lib/admin-rbac/actions.ts`) — **verified but deliberately NOT used by this spec.** It is the entry point for an approval-bearing admin action; this spec has none, because restrictions are spec 038's (DECIDED-3). Spec 038 will call it for the restriction at whatever tier it assigns |
| Admin audit | `recordAdminAuditEvent()` (`lib/admin-rbac/audit.ts`) → `security_events` |
| Block seam into messaging | `registerConversationBlockGate()` (`lib/messaging/block-gate.ts`) — **already shipped, inert** |
| Admin conversation access | the existing `messaging/read_conversation` permission (migration 0021), granted to `support_admin`, `trust_safety_admin`, `super_admin` |
| Evidence | spec 027's whole pipeline: `POST /files/upload-url`, `POST /files/{id}/finalize`, `GET /files/{id}`, `GET /files/{id}/content`, `DELETE /files/{id}` |
| Notifications | `notify()` (`lib/notifications`), category `security` |
| AI | `completeAi()` from `@/lib/ai`, task `summarization` (already a member of `AI_TASKS`) |
| OpenAPI | every route added to `OPENAPI_ROUTES` (`lib/api/openapi-registry.ts`); `npm run check:openapi-drift` fails CI otherwise |

### Repository paths (normative)

| Draft said | Actual path |
|---|---|
| `packages/types/src/safety.ts` | `lib/types/safety.ts` |
| `apps/api/safety/**` | `lib/safety/**` |
| `apps/web/app/support/report` | `app/support/report/page.tsx` (**new route**; `app/support/` does not exist yet) |
| `apps/web/app/admin/operations/safety` | `app/admin/operations/safety/page.tsx` (`app/admin/operations/` **does** exist — `page.tsx`, `payouts/`, `refunds/`) |
| `apps/web-e2e/safety.spec.ts` | `e2e/safety.spec.ts` |
| `packages/ui` `ReportForm`, `PriorityBadge` | `app/support/report/_components/SafetyReportForm.tsx`; **`PriorityBadge` is not built** — the existing `Badge` from `@/components` renders a priority label (§5) |

New modules: `lib/safety/{blocks,reports,evidence-policy,transitions,permissions,ai-assist,errors,limits,index}.ts`
and `lib/types/safety.ts`.

### Blocking (AC-1) — normative

**How a client names the person to block.** Verified: `app/api/v1/users/` contains **only**
`me/*` routes, so there is no `users/{id}` addressing convention to follow. Verified further:
spec 020's booking DTOs deliberately carry no counterparty `users.id`
(`lib/types/bookings.ts`: "a counterparty's `users.id` never reaches a client"), but spec 025's
`ConversationParticipantDto.userId` and `MessageDto.senderUserId` **do** expose it. A block target
is therefore named by `targetUserId`, which the client legitimately holds for anyone it has a
conversation with. Blocking someone the caller has never conversed with is not reachable from the
UI and needs no separate rule: the route simply 404s an unknown user.

| Question | Decision | Evidence |
|---|---|---|
| Table | **New** `user_blocks` — `(blocker_user_id, blocked_user_id)` plus `baseColumns()` | No block table exists anywhere; nothing to reuse |
| Uniqueness | `user_blocks_pair_uq` on `(blocker_user_id, blocked_user_id)` — the authority | the pattern `review_reports_review_reporter_uq` already uses |
| Directionality | A block is **one-directional as a record** but **bidirectional in effect** for messaging: `checkConversationBlock` is documented as "a block in EITHER direction must report `blocked`" | `lib/messaging/block-gate.ts` |
| Self-block | Rejected `422 CANNOT_BLOCK_SELF` | — |
| Duplicate block | **Idempotent**: returns `200` with the existing block rather than `409`. The caller owns that row, so telling them it exists enumerates nothing | spec 029's duplicate-report rule |
| Unblock | `DELETE`, idempotent: deleting a non-existent block returns `204` | — |
| Effect on messaging | `registerConversationBlockGate()` is registered from `instrumentation.ts`; the gate reads `user_blocks` inside the caller's transaction. **SENDING only** — reads, read markers and admin access are never consulted against it | `lib/messaging/block-gate.ts`, whose comment already states this |
| Effect on existing bookings | **None on readability.** History stays readable to both participants, and an admin holding `messaging/read_conversation` reads it unchanged. This is what AC-1's "safety/support communication remains reachable" means operationally, and it is already spec 025's shipped behaviour | master §53 |
| Effect on matching | Excluded at spec 017's **hard eligibility** stage, before any score — see below | — |
| Retroactivity | A block never cancels or alters an existing booking. Spec 030 writes no booking column and calls no transition | spec 020 owns that |

**Blocking → matching (AC-1), normative.** Verified: `ExclusionReason` (`lib/types/matching.ts`)
is a closed union — `service_not_offered`, `outside_service_area`, `unavailable`, `not_verified`,
`at_capacity` — and `evaluateEligibility` in `lib/matching/eligibility.ts` is a **pure function**
with no database access and no port. There is therefore no existing seam to fill, and two things
are required:

1. A new `ExclusionReason` member, `blocked`. This widens **spec 017's** vocabulary. It is additive
   and `MatchExplainabilityDto` is admin-only, so no customer- or provider-facing DTO changes
   meaning. Precedent: spec 029 added `lib/matching/rating-source.ts` and edited
   `lib/matching/run.ts` under exactly this arrangement.
2. A `ProviderBlockSource` port in `lib/matching/block-source.ts` whose **default is the existing
   behaviour** — unregistered ⇒ nobody is blocked — registered by `lib/safety/index.ts`'s
   `registerSafetyIntegration()` from `instrumentation.ts`. `lib/matching/**` never imports
   `lib/safety/**`; the dependency stays one-directional, exactly as `registerBusyIntervalLoader`
   and `registerProviderRatingSource` do.

Blocks are **user**-scoped while matching candidates are **provider-profile**-scoped, so the port
resolves `provider_profiles.user_id` for the candidate pool in one batched query and returns the
set of provider profile ids blocked by (or blocking) the requesting customer.

> **Scope note.** A block excludes the blocked provider from the blocker's **future** matching runs.
> It does not re-run matching for requests already distributed; spec 017 owns re-distribution.

### Reporting (AC-2) — normative

**The previous draft's `POST /api/v1/reports` targeting "a user, listing, or review" is removed.**
Verified: spec 029 already ships review reporting end to end — `review_reports` with
`review_reports_review_reporter_uq`, `POST /api/v1/reviews/{id}/reports`, a closed reason set, a
20-per-24h cap, and resolution as a side effect of review moderation. Spec 029's own schema comment
states the boundary from its side: "`safety_reports` (spec 030) is deliberately not reused: it is
an unimplemented baseline skeleton for a different feature."

Therefore:

- **Review content** → spec 029, unchanged. This spec adds no route that reports a review.
- **A person, on safety grounds** → this spec's `safety_reports`.
- **A listing/service** → **spec 038** (DECIDED-2). Its scope is explicitly "user/provider/listing"
  and its action catalogue already contains `content_removal`. This spec adds no listing route and
  no listing table; reporting a *person* is what a safety report is for.

There is no generic report abstraction, because there is no second thing to generalise over yet.
Inventing one now would produce a table with one real user and a second queue for spec 038 to
unpick.

### Safety report lifecycle (AC-2, AC-3, AC-5) — normative

```
   submitted ──claim──▶ under_review ──escalate──▶ escalated
       │                     │                        │
       └────────resolve──────┴────────resolve─────────┘
                             ▼
                          resolved   (terminal)
```

| Transition | Who | Requires | Notes |
|---|---|---|---|
| → `submitted` | the reporter (any authenticated user, either mode) | category, target; `Idempotency-Key` | Guests cannot report: an unaccountable report is an unpriced denial-of-service on a safety queue |
| `submitted` → `under_review` | admin with `safety_reports/resolve` | — | Claiming. Records the claiming admin |
| `submitted` \| `under_review` → `escalated` | admin with `safety_reports/escalate` | reason, 10–2000 chars | Master §64's escalation |
| `submitted` \| `under_review` \| `escalated` → `resolved` | admin with `safety_reports/resolve` | reason, 10–2000 chars | Terminal |
| anything → anything else | — | — | `409 INVALID_SAFETY_TRANSITION` carrying `details.currentStatus` |

**Concurrency.** Every admin transition is a conditional `UPDATE` gated on the `expectedStatus` the
admin was shown, the shape `applyBookingTransition()` and spec 029's review-resolve route already
use. A mismatch is `409 CONFLICT` with `details.currentStatus`, so two admins working the queue
cannot silently overwrite one another. `resolved` is terminal and no transition leaves it;
re-opening is **not permitted** (DECIDED-4). A new concern about the same person produces a **new
report**, which is cheap, independently auditable, and leaves the original finding intact. Mutating
a closed safety finding is precisely what an audit trail exists to prevent, and the repository
already treats such states as terminal — spec 023's `no_show_reports` reach `resolved`/`withdrawn`
and never leave them. Master §68's appeal mechanism applies to **admin actions**, which are spec
038's, not to the report record itself.

**Idempotency.** Submission requires `Idempotency-Key`, unique per `(reporter_user_id,
idempotency_key)`. Admin transitions are made idempotent by `expectedStatus` rather than by a key:
replaying the same transition against an already-moved report is a `409`, which is the correct
answer for a human-driven decision.

### Priority (AC-2) — normative (DECIDED-1)

Master §64 lists "Priority classification" as a required capability but **defines no levels and no
rules**; §62/§63 mention "Priority" for support with equally no taxonomy. Verified: nothing in the
repository classifies severity except spec 009's `risk_tier`. **No safety taxonomy is invented
here**, and none is needed to implement this spec, because the resolution is to have **no automated
classification at all**:

- `safety_reports.priority` is a **stored, human-set** column over the closed set
  `low | medium | high | critical` — spec 009's existing `risk_tier` vocabulary, not a second
  severity scale.
- **No rule of any kind reads a report's content, category, target or reporter to choose a
  priority.** `lib/safety/reports.ts` receives no classifier and has no branch on `category`.
  Asserted directly by `lib/safety/reports.test.ts`.
- Every report is created at one constant default, `DEFAULT_SAFETY_PRIORITY = 'medium'` in
  `lib/safety/limits.ts`. It is **mid-scale on purpose**: since no rule may read content, no default
  can encode severity, so its only job is to leave a triaging admin room to move a report in either
  direction. It is explicitly **not** a judgement that a report is moderately serious.
- Only an admin holding `safety_reports/resolve` may change it, and every change writes
  `safety.priority_changed` carrying both values.
- The queue is ordered `priority DESC, created_at ASC`. Among equal priorities that is **FIFO**, so
  nothing waits indefinitely and nothing is silently buried — which is what actually protects a
  report no rule could have recognised as urgent.

**Nothing here is blocked.** A category-to-priority table, if Trust & Safety ever wants one, is a
purely additive refinement: it would set the initial value an admin can already change, and it
alters no column, route, permission or test. It is recorded as a future product input in §8, not as
an implementation blocker.

### Trust & Safety access (AC-3) — normative

Spec 009's model, reused verbatim. Verified existing grants: `trust_safety_admin` already holds
`no_show_reports/*` (0019), `messaging/read_conversation` (0021) and `reviews/*` (0026). Migration
0027 seeds **three** new rows for `trust_safety_admin` and `super_admin` only:

| resource | action | risk tier | Controls | Why |
|---|---|---|---|---|
| `safety_reports` | `read` | `low` | queue access, report detail, **and evidence reads** | Reading is not enforcement; it is nonetheless fully audited because the content is the platform's most sensitive |
| `safety_reports` | `escalate` | `medium` | escalation | Master §70's "medium — authorized admin + reason/audit". Escalation changes who looks, not what happens to anyone |
| `safety_reports` | `resolve` | `medium` | claiming, priority change, resolution | The admin picks an outcome from a closed set, never a sanction |

Note what is **not** in that table: any power to sanction anyone. There are **exactly three**
permissions and none of them changes an account's state — applying a restriction is spec 038's
action behind spec 038's permission and approval tier (DECIDED-3). An admin holding all three can
read, triage, escalate and close a safety report, and nothing else.

`support_admin` is deliberately **excluded** from all three. Master §64 requires restricted access;
support already reaches conversations through `messaging/read_conversation` and does not need the
safety queue.

### Temporary restrictions (AC-5) — normative (DECIDED-3)

**Spec 038 owns the restriction. This spec owns only the seam to it, and the guarantee that
nothing else can reach account state.**

Verified, and decisive: spec 038's `ModerationActionDto.actionType` already enumerates
`'restriction'` alongside `warning`, `suspension` and `ban`; its AC-1 requires a reason and drives
"the account's lifecycle state (spec 006/008)"; its AC-2 routes high/critical actions through spec
009's four-eyes approval; and its AC-5 provides the appeal path master §68 requires. Master §68
lists the same catalogue. Verified further: `users.lifecycle_status` already admits `restricted`,
`suspended` and `banned` (`users_lifecycle_status_ck`), but **nothing in this repository writes
them** — the only writer today is spec 008's deletion flow (`lib/privacy/deletion.ts`), which writes
`deletion_pending`, `active` and `deleted`.

Building a restriction here would therefore create a second enforcement surface, a second approval
tier and a second appeal path for an action spec 038 has already specified — exactly the
duplication §1 forbids. So:

- This spec defines **no** `user_restrictions/apply` permission, **no** restriction route and **no**
  restriction table, and seeds no fourth permission row.
- **No module in `lib/safety/**` writes `users.lifecycle_status`.** `lib/safety/boundary.test.ts`
  asserts this at source level, so the guarantee survives future edits.
- A `SafetyRestrictionGate` port is defined in `lib/safety/restriction-gate.ts`, following the exact
  idiom spec 025 used for `ConversationBlockGate` and spec 020 for `CompletionEvidenceGate`:

```typescript
// lib/safety/restriction-gate.ts — spec 038 registers the real implementation.
export interface RestrictionRequest {
  safetyReportId: string;
  targetUserId: string;
  requestedByAdminUserId: string;
  reason: string;
  correlationId: string | null;
}
export type SafetyRestrictionGate = (req: RestrictionRequest) => Promise<{ moderationActionId: string }>;
```

- **The default is refusal, not silence.** Unregistered, the gate throws
  `restrictionUnavailableError()` → `422 RESTRICTION_UNAVAILABLE`. It deliberately does **not**
  no-op: a resolving admin who asked for a restriction must be told plainly that the capability is
  not installed, never left believing an account was restricted when nothing happened. This is the
  one place where the "a failing gate is treated as harmless" rule from
  `checkConversationBlock` is **inverted**, and for a precise reason: there, failing open preserves
  a live channel; here, failing quiet would fabricate an enforcement outcome.
- When spec 038 ships it registers the real gate from `instrumentation.ts`. At that moment the
  approval tier, the reversal and the appeal are **all spec 038's**, applied through
  `authorizeAndInitiate()` at whatever tier spec 038 assigns — this spec neither sets nor duplicates
  it.
- Either way the request is recorded **here**: `safety_reports.restriction_requested_at`,
  `restriction_requested_by_admin_id` and `restriction_moderation_action_id` capture that a named
  admin asked, with the resolution reason already required by S10. So "a safety report can call for
  a restriction" is a queryable fact in this spec even before spec 038 exists, without this spec
  enforcing anything.

> Consequence, stated rather than hidden: until spec 038 ships, a safety report cannot actually
> restrict anyone. That is the honest state of the platform — the alternative is an undefined
> enforcement system owned by nobody — and it is exactly what AC-5 now asserts and tests.

### AI boundary (AC-4) — normative

Verified: `lib/ai` exports `completeAi`, `isAiAssistantEnabled`, `isAiDegradable` and the four
degradation errors (`AiUnavailableError`, `AiRateLimitedError`, `AiQuotaExceededError`,
`AiProviderConfigurationError`). `AI_TASKS` is
`['search_intent','faq_draft','conversation','summarization','translation']`, closed at the database
by `ai_usage_events_task_ck`. **`summarization` already exists**, so an advisory summary needs **no
new task and no spec 033 migration.**

Binding conditions:

- AI is consumed **only** through `completeAi()` from `@/lib/ai`. No module under `lib/safety/**`
  may import `lib/ai/provider/**`; `lib/safety/boundary.test.ts` asserts this at source level from
  this side, as `lib/ai/boundary.test.ts` already does from the other.
- AI output is **advisory only**. It is stored in a dedicated, clearly-labelled column
  (`ai_summary`) and is rendered in the admin UI under an explicit "AI suggestion — not a decision"
  heading. It **never** writes `priority`, `status`, `resolution_reason` or any restriction.
- **Degradation is total and silent.** `isAiAssistantEnabled() === false`, any degradable error, or
  any thrown error ⇒ the report is created and queued normally with `ai_summary = null`. An AI
  outage must never block a submission or change a triage outcome.
- Enforcement is unreachable from AI by construction. The only status this spec can change is a
  **safety report's own**, and only through an admin route behind `resolvePermission`. No account
  lifecycle is reachable from anywhere in `lib/safety/**` (DECIDED-3), and
  `lib/safety/ai-assist.ts` returns a string and has no database access at all — so there is no
  parameter through which an AI verdict could reach either.

> Master §132.17 is satisfied structurally, not by policy text: the enforcement functions do not
> take an AI-derived argument, so there is no parameter through which an AI verdict could reach one.

### Evidence (AC-3) — normative

Spec 027 is reused in full; **no second storage system is created.** This spec adds exactly one
`FileContextPolicy`.

| Question | Decision | Evidence |
|---|---|---|
| Context type | A **new** `safety_evidence` value added to `FILE_CONTEXT_TYPES` (`lib/types/files.ts`) and to `file_assets_context_type_ck` by migration 0027 | The vocabulary is closed at the database; spec 029 added `review_media` the same way |
| `contextId` | The **`safety_reports.id`** | Unlike review media, a safety report has no pre-existing parent entity to hang evidence from when there is no booking. The report is therefore created **first** (it is already restricted-access), then evidence is attached to it — a two-step flow the UI performs in one submit |
| `publicEligible` | **false** — the only correct answer | Master §64 |
| `allowedKinds` | `['image', 'document', 'video']` | Safety evidence is whatever the reporter has: a screenshot, a message export, a recording. Narrowing it would discard evidence |
| `maxPerContext` | **10** | Wider than spec 029's 5 for the same reason |
| Size / MIME | Spec 027's existing limits and allowlist. This spec adds no size rule | `lib/files/config.ts` |
| `canUpload` | The report's **reporter**, only while the report is not `resolved` | Prevents evidence being bolted onto a closed case |
| `canRead` | The reporter (their own attachments) **or** an admin holding `safety_reports/read`, and the admin read is **audited before the bytes are disclosed** | spec 027 re-runs `canRead` on every URL issue and content fetch, so this is a live answer; the audit-before-disclose pattern is `messageAttachmentPolicy`'s |
| Reporter re-read | Permitted. A reporter may re-read what they themselves submitted | — |
| Target visibility | The reported user **never** sees the evidence, the report, or that it exists | Master §64 |
| Deletion | The reporter may delete an attachment only while the report is `submitted`. After that, spec 027's `DELETE /files/{id}` is refused for this context | Evidence preservation, master §64 |
| Account deletion | Every `safety_evidence` asset is finalized with **`file_assets.legal_hold = true`** — an existing column spec 027's purge sweep already honours (`lib/files/deletion.ts`: "`legal_hold` assets are the exception: they are evidence a later spec must keep"). No new retention mechanism is built (DECIDED-5) | `lib/files/deletion.ts` |

### Urgent / ASAP (AC-6) — normative

Verified: urgency already exists and is **spec 015's**, not this spec's —
`REQUEST_URGENCIES = ['normal','urgent']` (`lib/db/schema.ts`), `requests.urgency` with
`requests_urgency_ck` (migration 0011), `RequestUrgency` (`lib/types/requests.ts`), the selector at
`app/requests/new/[serviceId]/page.tsx` ("Urgent — as soon as possible") and the display at
`app/requests/[id]/page.tsx`.

**No column, enum or API changes.** This spec adds one presentational component,
`app/_components/UrgencyEmergencyNotice.tsx`, owned here, and mounts it in spec 015's two screens —
a one-line mount in each, the same arrangement spec 029 used for `ReviewSection` on spec 020's
booking page. The notice:

- is rendered **adjacent to the urgency control**, always visible when `urgent` is selectable or
  selected — never behind a tooltip, an accordion or fine print (AC-6);
- states plainly that Apuriva is a marketplace that connects customers with providers and is **not**
  an emergency service, and that genuine emergencies should go to local emergency services;
- names **no specific emergency number.** The repository has no country/locale resolution for this
  (spec 042 owns i18n and has not shipped), and printing a wrong number in an emergency is worse
  than printing none — and master §65 itself says only "direct users to appropriate local emergency
  services", which is exactly the generic wording used (DECIDED-6). Nothing here depends on spec 042.

There is **no API behaviour** attached to AC-6: nothing blocks, warns or reclassifies a request
server-side. Master §65 asks for clarity, not gatekeeping.

### Routes added by this spec

All are added to `OPENAPI_ROUTES`. Every mutating route requires CSRF; no GET does. All use a new
`safety` `RateLimitDomain` (**30 requests / 60 s**, the write-surface budget specs
015/017/018/020/027/029 already share), keyed by `session.userId`.

| # | Method | Route | Auth | Authorization | Idem. | Success |
|---|---|---|---|---|---|---|
| S1 | `POST` | `/api/v1/blocks` | session | any authenticated user; body `{ targetUserId }` | **required** | `201` `ApiResponse<BlockDto>` (`200` on duplicate) |
| S2 | `GET` | `/api/v1/blocks` | session | the caller's own blocks only | — | `200` `PagedResponse<BlockDto>` |
| S3 | `DELETE` | `/api/v1/blocks/{id}` | session | the block's own `blocker_user_id` | — | `204` (also `204` when absent) |
| S4 | `POST` | `/api/v1/safety-reports` | session | any authenticated user | **required** | `201` `ApiResponse<SafetyReportDto>` |
| S5 | `GET` | `/api/v1/safety-reports/{id}` | session | the **reporter** only; restricted view | — | `200` `ApiResponse<SafetyReportDto>` |
| S6 | `GET` | `/api/v1/admin/safety-reports` | session | `safety_reports/read` | — | `200` `PagedResponse<AdminSafetyReportDto>` |
| S7 | `GET` | `/api/v1/admin/safety-reports/{id}` | session | `safety_reports/read` | — | `200` `ApiResponse<AdminSafetyReportDto>` |
| S8 | `POST` | `/api/v1/admin/safety-reports/{id}/claim` | session | `safety_reports/resolve` | — | `200` `ApiResponse<AdminSafetyReportDto>` |
| S9 | `POST` | `/api/v1/admin/safety-reports/{id}/escalate` | session | `safety_reports/escalate` | — | `200` `ApiResponse<AdminSafetyReportDto>` |
| S10 | `POST` | `/api/v1/admin/safety-reports/{id}/resolve` | session | `safety_reports/resolve` | — | `200` `ApiResponse<AdminSafetyReportDto>`; `422 RESTRICTION_UNAVAILABLE` if `requestRestriction` is set and spec 038 is not installed |
| S11 | `POST` | `/api/v1/admin/safety-reports/{id}/priority` | session | `safety_reports/resolve` | — | `200` `ApiResponse<AdminSafetyReportDto>` |

Changes from the draft: `POST|DELETE /api/v1/users/{id}/block` becomes S1/S3 — there is no
`users/{id}` route convention in this repository (only `users/me/*`), and a block is a first-class
resource the caller owns. The generic `POST /api/v1/reports` is **removed** (§3 "Reporting"). S2,
S5, S7 and S8 are **added**: a user must be able to see and undo their own blocks, a reporter must
be able to see that their report was received, an admin needs a detail route to audit distinctly
from the queue, and `under_review` needs a transition to reach it. **S11 is added during
implementation**: DECIDED-1 makes `priority` human-set, and without a route no human could set it —
the permission table already assigned "priority change" to `safety_reports/resolve`, so it
introduces no new permission. A restriction route is
**permanently absent**: restrictions are spec 038's action, reached from S10 through the
`SafetyRestrictionGate` port (DECIDED-3).

No route collides with an existing one — verified against every `route.ts` under `app/api/v1/`.
`/api/v1/blocks` and `/api/v1/safety-reports` are new top-level resources; `/api/v1/admin/safety-reports`
sits beside the existing `admin/reviews`, `admin/categories`, `admin/roles` and `admin/matching`.

### Request and response types

```typescript
// lib/types/safety.ts
// This repository has no `packages/types`; every DTO lives under `lib/types/*`.
import type { FileAssetDto } from './files';

export const SAFETY_REPORT_STATUSES = ['submitted', 'under_review', 'escalated', 'resolved'] as const;
export type SafetyReportStatus = (typeof SAFETY_REPORT_STATUSES)[number];

/** Mirrors spec 009's `risk_tier` vocabulary rather than inventing a second severity scale. */
export const SAFETY_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type SafetyPriority = (typeof SAFETY_PRIORITIES)[number];

/**
 * Categories are a REPORTING vocabulary, not a severity taxonomy: nothing derives priority from
 * them (DECIDED-1). Adding a member is additive and needs only a migration to widen the CHECK.
 */
export const SAFETY_CATEGORIES = [
  'harassment', 'threat', 'unsafe_behaviour', 'impersonation', 'property_damage', 'other',
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];

export interface BlockDto {
  id: string;
  blockedUserId: string;
  createdAt: string;
}

export interface CreateBlockRequest {
  targetUserId: string;
}

export interface CreateSafetyReportRequest {
  targetUserId: string;
  category: SafetyCategory;
  /** Required, 10..2000 chars — normalized exactly as spec 029 normalizes review text. */
  description: string;
  /** Optional. The booking this concerns, when there is one. */
  bookingId?: string | null;
}

/** What the REPORTER sees. Carries no priority, no admin identity and no internal state. */
export interface SafetyReportDto {
  id: string;
  status: SafetyReportStatus;
  category: SafetyCategory;
  createdAt: string;
  /** The reporter's own attachments only. */
  evidence: FileAssetDto[];
}

/** S6–S10 only. Never returned to a reporter or to the reported user. */
export interface AdminSafetyReportDto extends SafetyReportDto {
  reporterUserId: string;
  targetUserId: string;
  bookingId: string | null;
  description: string;
  priority: SafetyPriority;
  /** AC-4: advisory only. Never a decision, and null whenever spec 033 is unavailable. */
  aiSummary: string | null;
  claimedByAdminId: string | null;
  escalatedAt: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  version: number;
}

export interface SafetyTransitionRequest {
  /** Required for escalate and resolve, 10..2000 chars. Optional for claim. */
  reason?: string;
  /** Optimistic concurrency: the status the admin was looking at. */
  expectedStatus: SafetyReportStatus;
  /**
   * S10 only. Asks spec 038 to restrict the reported account (DECIDED-3). This spec applies
   * nothing itself: it records the request and calls the `SafetyRestrictionGate`, which is
   * unregistered until spec 038 ships and then throws `422 RESTRICTION_UNAVAILABLE`.
   */
  requestRestriction?: boolean;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `CANNOT_BLOCK_SELF` | `targetUserId` is the caller |
| `422` | `CANNOT_REPORT_SELF` | the reporter is the target |
| `409` | `INVALID_SAFETY_TRANSITION` | the requested transition is not in the lifecycle table |
| `409` | `CONFLICT` | `expectedStatus` no longer matches; `details.currentStatus` carries the truth |
| `422` | `SAFETY_EVIDENCE_NOT_ATTACHABLE` | attaching to a `resolved` report, or an asset that is not a live `ready` `safety_evidence` asset for this report owned by the caller |
| `422` | `RESTRICTION_UNAVAILABLE` | a resolution requested a restriction but spec 038's `SafetyRestrictionGate` is not registered. The report still resolves; **no account state changes** |
| `403` | `FORBIDDEN` | missing admin permission, or a non-Trust-&-Safety admin reaching a safety route |
| `404` | `NOT_FOUND` | an unknown user, block, or report — and every report the caller neither filed nor may moderate |
| `429` | `RATE_LIMITED` | the `safety` domain budget |

> A non-participant addressing a report receives `404`, never `403`: `403` would confirm the report
> exists. This is the rule specs 025/027/029 already follow.

### Breaking-change check

- [x] N/A — new spec. No existing route, DTO, column or permission changes meaning. Two additive
      widenings are made to other specs' closed vocabularies, both behind ports whose defaults are
      today's behaviour: `ExclusionReason` gains `blocked` (spec 017) and `FILE_CONTEXT_TYPES` gains
      `safety_evidence` (spec 027). Spec 025's `ConversationBlockGate` is filled, not changed.

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `safety_reports` | **ALTER** (baseline has `id`, `created_at`, `updated_at`, `version`, `reporter_user_id`, `booking_id`) | `+ target_user_id uuid not null fk→users`, `+ category text not null`, `+ description text not null`, `+ priority text not null default 'medium'`, `+ status text not null default 'submitted'`, `+ ai_summary text null`, `+ claimed_by_admin_id uuid null fk→admin_profiles`, `+ escalated_at timestamptz null`, `+ resolved_at timestamptz null`, `+ resolved_by_admin_id uuid null fk→admin_profiles`, `+ resolution_reason text null`, `+ restriction_requested_at timestamptz null`, `+ restriction_requested_by_admin_id uuid null fk→admin_profiles`, `+ restriction_moderation_action_id uuid null`, `+ idempotency_key text not null`, `+ idempotency_fingerprint text not null` |
| `user_blocks` | **NEW** table | `baseColumns()`, `blocker_user_id uuid not null fk→users`, `blocked_user_id uuid not null fk→users` |
| `file_assets` | **ALTER constraint only** | `file_assets_context_type_ck` dropped and re-added including `'safety_evidence'`. No column and no data change |
| `permissions` | **seed** | three rows (`safety_reports/read` low, `safety_reports/escalate` medium, `safety_reports/resolve` medium) for `trust_safety_admin` and `super_admin`, `ON CONFLICT DO NOTHING`. **Exactly three** — no restriction permission is seeded here (DECIDED-3) |

**Constraints and indexes**

- `user_blocks_pair_uq` unique on `(blocker_user_id, blocked_user_id)` — the concurrency authority.
- `user_blocks_no_self_ck` CHECK `blocker_user_id <> blocked_user_id` — self-block is
  unrepresentable at the database, not merely rejected in application code.
- `user_blocks_blocked_user_id_idx` — the gate's lookup direction.
- `safety_reports_status_ck`, `safety_reports_priority_ck`, `safety_reports_category_ck` — closed
  vocabularies at the database.
- `safety_reports_no_self_ck` CHECK `reporter_user_id <> target_user_id`.
- `safety_reports_resolution_pairing_ck` CHECK
  `(status = 'resolved') = (resolution_reason is not null and resolved_by_admin_id is not null and resolved_at is not null)`
  — a resolution without a named human and a recorded reason is physically unrepresentable. This is
  the mechanical form of AC-3/AC-5 and it holds whatever application code does. It is deliberately
  the same device as spec 029's `reviews_removal_pairing_ck`.
- `safety_reports_author_idempotency_uq` unique on `(reporter_user_id, idempotency_key)`.
- `safety_reports_queue_idx` on `(priority, created_at)` for the queue ordering.
- `safety_reports_target_user_id_idx`.

**Why `safety_reports` keeps `reporter_user_id`** (a **user** id, not a profile id): spec 003
already shipped that column and its foreign key, spec 008's export keys off user ids, and a safety
report is about a person, not about a role they happened to be wearing.

### Migration

- **Name:** `0027_add_blocking_safety_incidents` (`drizzle/0027_add_blocking_safety_incidents.sql`)
  with a hand-written `drizzle/0027_add_blocking_safety_incidents_down.sql` sibling. **Verified:
  0026 is the highest existing migration** (`drizzle/0026_add_reviews_ratings.sql`), so 0027 is next.
- **Content:** one `ALTER TABLE safety_reports … ADD COLUMN` group; one `CREATE TABLE user_blocks`;
  one `file_assets_context_type_ck` drop/re-add; one `permissions` seed.
- **Precondition:** `safety_reports` receives `NOT NULL` columns without defaults
  (`target_user_id`, `category`, `description`, `idempotency_key`, `idempotency_fingerprint`). It is
  an empty skeleton — no code has ever written a row — so this is safe. The migration asserts
  emptiness and **fails loudly** rather than silently defaulting if that assumption is ever wrong.
- **Reversible:** yes, and safely. The down migration drops exactly what was added, drops
  `user_blocks`, restores the 0026 form of the context CHECK, and deletes the seeded permission
  rows. It is **gated**: it refuses if any `safety_reports` row or any `safety_evidence`
  `file_assets` row exists, because dropping the columns would destroy the substance of a safety
  report while leaving a meaningless skeleton behind. Once real reports exist, the correct response
  to a defect is a forward fix. Role assignments are untouched.
- **Backfill required:** no. There is no existing data.
- **Downtime:** none. `ADD COLUMN` on an empty table is metadata-only; the `file_assets` check swap
  is a brief `ACCESS EXCLUSIVE` on one table, as in 0026.
- **Rollback and orphaning:** rolling back **orphans no bytes and destroys no audit record.**
  Evidence lives in `file_assets`, which the down migration does not delete — those rows simply
  become unreferenced and fall to spec 027's existing soft-delete/purge sweep. `security_events`
  rows written by `recordAdminAuditEvent()` are never touched: audit outlives the feature, which is
  the entire point of writing it to spec 009's store rather than to a table this spec owns.
- **Reviewed SQL:** generated, then hand-reviewed in the PR. `npm run check:schema-checksum` keeps
  `0001_baseline_schema.sql` immutable.

### Retention and privacy

- **Reporter-visible** (S5): their own report's `id`, `status`, `category`, `createdAt` and their
  own attachments. Deliberately **not** `priority`, `aiSummary`, any admin identity, or the
  resolution reason — a reporter learning that their report was triaged `low` tells them about the
  platform's internal judgement, not about themselves.
- **Target-visible:** **nothing.** The reported user is never told a report exists, by any route or
  notification. Master §64.
- **Admin-visible** (S6–S10): the full `AdminSafetyReportDto`, behind `safety_reports/read`.
- **Export (spec 008):** `lib/privacy/export.ts` gains a `safetyReports` section containing the
  reports the user **filed** (`id`, `category`, `description`, `status`, `createdAt`) and the blocks
  they **created**. It must contain **no** report filed *about* them, no priority, no `ai_summary`,
  no admin identity and no evidence belonging to anyone else — the same ownership-scoped column
  allowlist spec 029 established. The reporter's own `description` **is** exported: it is their own
  authored words, and spec 008 already exports a user's own prose (spec 029 exports review text).
  `targetUserId` is deliberately **not** exported — the reporter knows who they reported, and an
  export file is a document that travels (DECIDED-5).
- **Deletion (spec 008) — DECIDED-5, built entirely from existing mechanisms:**
  - **Report rows survive automatically.** `safety_reports.reporter_user_id` and `target_user_id`
    are `ON DELETE restrict` foreign keys, so the sweep cannot remove them; they are retained keyed
    to the now-anonymized user, which is the same outcome `lib/privacy/deletion.ts` already
    documents for other retained rows.
  - **Evidence survives via `legal_hold`.** Every `safety_evidence` asset is finalized with
    `file_assets.legal_hold = true`, which spec 027's purge sweep already honours. **No new
    retention mechanism is created.**
  - **The description is NOT redacted** by the anonymization sweep, unlike `offers.provider_message`
    and `offer_messages.body`. Master §64 requires evidence preservation, and a safety record whose
    substance is replaced by `[redacted]` when its author closes their account would let anyone
    erase a safety finding about a third party by deleting themselves. `lib/safety/privacy.integration.test.ts`
    asserts this directly.
  - **Audit rows are untouched**, as they are for every other spec: they live in `security_events`.
  - **No automated purge is specified.** This spec deletes nothing on a timer, which is the
    conservative default and requires no legal input to implement safely. A finite retention period,
    if Legal sets one, is an additive sweep that reads `legal_hold` — see §8 "Operational inputs".
- **Audit:** every safety-sensitive action **and every read** writes `recordAdminAuditEvent()` into
  `security_events`, namespaced `safety.*`:

| Event type | When |
|---|---|
| `safety.queue_read` | S6 — one event per queue page load |
| `safety.report_read` | S7 — one event per detail read |
| `safety.evidence_read` | every signed-URL issue and content fetch, **written before the bytes are disclosed** |
| `safety.report_claimed` | S8 |
| `safety.report_escalated` | S9 |
| `safety.report_resolved` | S10 |
| `safety.priority_changed` | a priority change, carrying both values |
| `safety.restriction_requested` | S10 requested a restriction through the port — recording that a named admin **asked**, whether or not spec 038 was installed to act on it |

Each carries actor, **all** roles held, target type/id, reason and the request's `correlationId`.
If the audit write fails, the surrounding transaction fails and the action does not take effect.
**No reporter identity is written into an event about a restriction**, so an audit trail shared with
a restricted user cannot expose who reported them.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` rows in the admin queue; the report form shows progress while evidence uploads, and never appears to hang |
| **Empty** | A queue with nothing pending shows a neutral `EmptyState` — "Nothing waiting" — never phrasing that implies the platform is unsafe or that reports were dismissed |
| **Error** | A failed submission **preserves the entered text and the selected evidence**; the user never retypes an account of something distressing. Draft text is held in component state and re-rendered on failure |
| **Success** | The reporter sees confirmation that the report reached a human, with **no promise of a timeline or an outcome** — master §64's restricted workflow means we cannot honestly promise either |
| **Blocked (sender)** | Spec 025's composer already renders the gate's refusal; this spec supplies the real answer, not new UI |

**Accessibility.** The urgency notice (AC-6) is a visible, statically-rendered block adjacent to the
control — not a tooltip, not an `aria-describedby`-only string, and not collapsed behind a
disclosure. It must be reachable by a screen reader in the normal reading order of the form.

| Path | Kind | Notes |
|---|---|---|
| `app/support/report/page.tsx` | **new route** | The reporter's form. `app/support/` does not exist yet and is created by this spec |
| `app/support/report/_components/SafetyReportForm.tsx` | new component | Category `Select`, `Textarea`, `FileUpload` (spec 027's existing component, `contextType: 'safety_evidence'`), `Button` |
| `app/admin/operations/safety/page.tsx` | **new route** | The queue and the transition form, modelled on the existing `app/admin/actions/no-show-reports/page.tsx` and `app/admin/actions/review-moderation/page.tsx`. `app/admin/operations/` already exists (`page.tsx`, `payouts/`, `refunds/`) |
| `app/_components/UrgencyEmergencyNotice.tsx` | new component | AC-6. Mounted in spec 015's `app/requests/new/[serviceId]/page.tsx` and `app/requests/[id]/page.tsx` — one line each |
| `app/_components/BlockUserButton.tsx` | new component | Mounted in spec 025's conversation UI, where `ConversationParticipantDto.userId` is already available. Uses the existing `ConfirmDialog` |

**Design-system check (reported, not silently worked around).** `Badge`, `Card`, `Select`,
`Textarea`, `Button`, `Skeleton`, `EmptyState`, `ErrorState` and `ConfirmDialog` all already exist
and are re-exported from `@/components`. The draft's `PriorityBadge` is therefore **not built** —
`Badge` with a priority label is the existing primitive and forking it would duplicate a component.
The draft's `ReportForm` is built as an app-level component, not in `ui/`, following the documented
precedent in `components/index.ts`.

---

## 6. Test plan

Vitest only. Unit and component tests are `*.test.ts(x)` beside the code; database-touching tests
are `*.integration.test.ts`; the end-to-end flow is `e2e/safety.spec.ts`. Integration tests run only
against the isolated `*_test` database (`vitest.config.ts` rewrites `DATABASE_URL`, and
`test/db-reset.ts` refuses any other name), so the developer's own database is never touched.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | Transition table (every legal and illegal pair, including that `resolved` is terminal); description normalization and bounds; **priority is a constant and no code branches on `category`**; the restriction gate's refusing default | `lib/safety/{transitions,reports,limits,restriction-gate}.test.ts` |
| **Boundary** | Source-level: `lib/safety/**` imports no `lib/ai/provider/**`; **no module under `lib/safety/**` writes `users.lifecycle_status` at all**; `lib/matching/**` never imports `lib/safety/**` | `lib/safety/boundary.test.ts` |
| **Integration** | Block effects, report lifecycle, admin RBAC, evidence authorization, audit, privacy/export | `lib/safety/*.integration.test.ts` |
| **Component** | The report form's four states (especially error-preserves-input); the queue and transition form; the urgency notice | `app/support/report/page.test.tsx`, `app/admin/operations/safety/page.test.tsx`, `app/_components/UrgencyEmergencyNotice.test.tsx` |
| **E2E** | Block a user → report a safety concern with evidence → Trust & Safety admin claims, escalates and resolves it | `e2e/safety.spec.ts` |

**Traceability — every AC maps to a named, objectively testable case**

| AC | Test |
|---|---|
| AC-1 | `lib/safety/blocking.integration.test.ts::a blocked sender cannot send`; `::the block is bidirectional in effect`; `::history stays readable to both participants`; `::an admin with messaging/read_conversation still reads the conversation`; `::unblock restores sending`; `lib/safety/matching-exclusion.integration.test.ts::a blocked provider is excluded with reason 'blocked' before any score is computed`; `::the port defaults to nobody-blocked when unregistered` |
| AC-2 | `lib/safety/report.integration.test.ts::creates a submitted report with reporter, target and category`; `::appears on the Trust & Safety queue`; `::rejects reporting yourself`; `::a duplicate Idempotency-Key replays rather than creating a second` |
| AC-3 | `lib/safety/access.integration.test.ts::every role without safety_reports/read receives 403 on the queue and the detail`; `::support_admin is refused`; `::a reporter reads only their own restricted view`; `::the target is never told the report exists`; `lib/safety/evidence.integration.test.ts::an admin evidence read is audited BEFORE the bytes are disclosed`; `::a stranger cannot read evidence`; `lib/safety/audit.integration.test.ts::each of the eight safety.* events is written with actor, roles, target and correlationId` |
| AC-4 | `lib/safety/ai-assist.test.ts::returns a string and has no database access`; `lib/safety/ai-boundary.integration.test.ts::an AI outage still creates and queues the report with a null summary`; `::the AI summary never sets priority or status`; `lib/safety/boundary.test.ts::no safety module imports lib/ai/provider` |
| AC-5 | `lib/safety/restriction-gate.test.ts::the unregistered default THROWS rather than silently succeeding`; `lib/safety/restriction.integration.test.ts::a resolution requesting a restriction returns 422 RESTRICTION_UNAVAILABLE and changes no account state`; `::the request is still recorded on the report with the requesting admin and reason`; `::a registered gate receives the report id, target, admin and reason`; `::writes safety.restriction_requested`; `lib/safety/boundary.test.ts::no module under lib/safety writes users.lifecycle_status` |
| AC-6 | `app/_components/UrgencyEmergencyNotice.test.tsx::states Apuriva is not an emergency service`; `::is rendered visibly, not behind a tooltip or a collapsed disclosure`; `app/requests/new/[serviceId]/page.test.tsx::the notice is present whenever the urgent option is offered` |

Additional non-AC coverage required before this spec may be marked Approved: transition concurrency
(two admins resolving the same report simultaneously — one wins, the other gets `409` with
`details.currentStatus`); the `safety` rate-limit domain; `safety_reports_resolution_pairing_ck`
rejecting a direct database write that resolves without a reason; and the down migration refusing
to run while a report exists.

**Coverage:** ≥ 80 % on new code.

**Not covered, deliberately:** the *quality* of any AI summary (AC-4 guarantees it cannot affect an
outcome, which is the testable property); and the correctness of any priority taxonomy, because by
DECIDED-1 none exists and nothing is ever classified automatically.

---

## 7. Out of scope

- **Every moderation action** — warning, **restriction**, suspension, ban, content removal, booking
  intervention, payout freeze — and the appeal path. All spec 038's (DECIDED-3). This spec ships a
  port to the restriction action and no enforcement of its own.
- **Listing/service reporting and content removal.** Spec 038 (DECIDED-2).
- **Review reporting.** Spec 029 owns it end to end and it is not duplicated here.
- **Dispute resolution** for transactional disagreements — spec 031.
- **Automated fraud/abuse detection.** Spec 038. This spec covers user-initiated reports only.
- **Re-running matching for already-distributed requests** after a block — spec 017 owns
  distribution.
- **Emergency-service integration of any kind.** AC-6 is a disclosure, explicitly not a capability.
- **A public "blocked users" management screen** beyond S2's list and S3's undo.

---

## 8. Decisions, risks and operational inputs

**All six questions the previous revision left open are now resolved against the repository and the
owning specs. Nothing in this document is blocked, and nothing below is guessed.**

| # | Decision | Resolved by | Effect on this document |
|---|---|---|---|
| DECIDED-1 | **No automated priority classification exists.** `priority` is a human-set column over spec 009's `low\|medium\|high\|critical`; every report is created at the constant `medium`; no rule reads content, category, target or reporter; the queue is `priority DESC, created_at ASC`, i.e. FIFO among equals | Master §64 requires "Priority classification" but defines no levels, and §62/§63 define none either; the repository has no severity scale but `risk_tier`. Having **no** classifier is therefore the only option that invents nothing — and it is fully implementable | §3 "Priority", §4 default `'medium'`, unit test asserting no branch on `category` |
| DECIDED-2 | **Listing/service reporting belongs to spec 038**, not here | Spec 038's own success statement covers actions "against a user/provider/**listing**" and its `ModerationActionDto.actionType` includes `content_removal` | AC-2 stays user-scoped; §3 "Reporting"; §7 |
| DECIDED-3 | **Spec 030 owns no enforcement action.** Restrictions are spec 038's; this spec ships a `SafetyRestrictionGate` port whose unregistered default **throws** `422 RESTRICTION_UNAVAILABLE`, records the request on the report, and never writes `users.lifecycle_status` | Spec 038 already enumerates `'restriction'` in its action catalogue with its own approval tier (AC-2) and appeal path (AC-5); master §68 lists the same catalogue. Verified: nothing in the repository writes `restricted`/`suspended`/`banned` today | AC-5 rewritten; §3 "Temporary restrictions"; no fourth permission; new `restriction_*` columns; AC-5 tests |
| DECIDED-4 | **`resolved` is terminal; a report is never re-opened.** A new concern produces a new report | Spec 023's `no_show_reports` treat `resolved`/`withdrawn` as terminal; master §68's appeal applies to admin **actions** (spec 038), not to the report record | §3 lifecycle |
| DECIDED-5 | **Retention is built from existing mechanisms**: `file_assets.legal_hold = true` on evidence (spec 027's purge already honours it), `ON DELETE restrict` keeps report rows through account deletion, the description is **not** redacted by the sweep, the reporter's own description **is** exportable while `targetUserId` is not, and **no automated purge is specified** | `lib/files/deletion.ts` already documents `legal_hold` as "evidence a later spec must keep"; `lib/privacy/deletion.ts` already retains `restrict`-keyed rows against an anonymized user; master §64 requires evidence preservation | §3 "Evidence", §4 "Retention and privacy" |
| DECIDED-6 | **The AC-6 notice names no specific emergency number**, using master §65's own wording — "appropriate local emergency services" | Master §65 states exactly that and never names a number, so no locale resolution is needed and nothing depends on spec 042 | §3 "Urgent / ASAP", §5, AC-6 tests |

### Operational inputs (do **not** block implementation)

These are refinements that can land later without changing a column, route, permission or test in
this spec. They are recorded so they are not lost, not as gates.

| # | Input | Owner | Why it is not a blocker |
|---|---|---|---|
| INPUT-1 | An optional category-to-priority table that sets a report's **initial** priority | Trust & Safety | Purely additive: it would set a value an admin can already change. DECIDED-1 ships a working queue without it |
| INPUT-2 | A finite retention period after which safety reports and held evidence may be purged | Legal | DECIDED-5 specifies **no** automated purge, which is the conservative, non-destructive default. A future sweep reads the existing `legal_hold` column |
| INPUT-3 | Whether Trust & Safety wants an SLA/alerting threshold on queue age | Trust & Safety | §9 already emits time-to-first-admin-action; a threshold is an alerting configuration, not a code change |

| # | Risk | Mitigation |
|---|---|---|
| R-1 | A block silently severs a live booking's coordination channel, stranding two people mid-job | The gate affects **sending only** and is already documented that way by spec 025; history stays readable and admins retain access. Asserted directly by AC-1's tests |
| R-2 | The matching port fails and silently excludes everyone, or nobody | Its default is "nobody blocked" — today's behaviour — and a throwing gate is treated as not-blocked and logged, the rule `checkConversationBlock` already establishes |
| R-3 | An AI summary is mistaken for a verdict by a tired admin | It is stored in a separate column, rendered under an explicit "AI suggestion — not a decision" heading, and structurally cannot reach an enforcement function (§3 "AI boundary") |
| R-4 | Audit noise from per-read events makes the trail unusable | Events are namespaced `safety.*` and carry `correlationId`, so a single request's reads collapse into one investigation thread |
| R-5 | An admin resolves a report believing they restricted an account, when spec 038 is not installed | The `SafetyRestrictionGate` default **throws** `422 RESTRICTION_UNAVAILABLE` rather than no-opping, so the admin is told plainly. The request is still recorded and audited as `safety.restriction_requested`, so the intent is not lost (DECIDED-3) |

---

## 9. Rollout

- **Feature flag:** none. Safety features are not optional, and spec 041 (the flag mechanism) does
  not exist.
- **Migration order:** `0027_add_blocking_safety_incidents` ships with the code, as every prior spec
  has.
- **Composition root:** `instrumentation.ts` gains one line — `registerSafetyIntegration()` from
  `@/lib/safety` — registering spec 025's `ConversationBlockGate`, spec 017's `ProviderBlockSource`
  and spec 027's `safety_evidence` context policy. It deliberately does **not** register a
  `SafetyRestrictionGate` — that registration is spec 038's, from the same composition root, when it
  ships (DECIDED-3). It must run **after** spec 027, which resets and registers its own shipped
  policies. This is the composition root specs 021–029 already use.
- **Rollback:** revert the deploy and run `0027_add_blocking_safety_incidents_down.sql`. It refuses
  if any safety report or `safety_evidence` asset exists. All three ports return to their documented
  pre-030 defaults — nobody blocked, no exclusions, `422 FILE_CONTEXT_NOT_AVAILABLE` — so no shipped
  spec breaks. No account state can have been changed by this spec, because it never writes any
  (DECIDED-3), so a rollback cannot strand a restricted user. **Safety-report data and `security_events` audit rows are never destroyed by a
  rollback.**
- **Notification catalogue:** entries are added to spec 026's closed `NOTIFICATION_TYPES` under the
  existing `security` category, for the **reporter only**. The reported user is never notified.
- **Observability (spec 040):** safety-report volume by category, time-to-first-admin-action,
  time-to-resolution, escalation rate, and block volume. Dedicated Trust & Safety alerting per
  master §117. No metric carries report content.

---

## 10. Verification evidence (implementation)

Recorded when this spec moved Draft → Approved.

| Check | Result |
|---|---|
| Spec 030 targeted suite | **15 files / 165 tests passing** — `lib/safety/**`, `e2e/safety.spec.ts`, `UrgencyEmergencyNotice.test.tsx`, `app/admin/operations/safety/page.test.tsx` |
| Cross-spec regression | **73 files / 552 tests passing** — `lib/messaging` (025), `lib/matching` (017), `lib/files` (027), `lib/admin-rbac` (009), `lib/privacy` (008), `lib/ai` (033), `lib/bookings` (020/028). No regression in any of them |
| TypeScript | clean except two failures that predate this spec (`lib/files/upload.ts`, `lib/notifications/delivery.integration.test.ts`), both untouched |
| Env parity / schema checksum / money lint | pass |
| OpenAPI drift | all 11 routes registered; the only drift is spec-010's pre-existing `{categoryId}` vs `[id]` mismatch |
| Migration rollback | **16/16 checks** on a dedicated scratch database, which was then dropped. Refuses while reports exist; restores both widened CHECKs; leaves `security_events` untouched |
| AC-1 | `blocking.integration.test.ts` (14), `matching-exclusion.integration.test.ts` (9) |
| AC-2 | `reports.integration.test.ts` "AC-2: creation", `routes.integration.test.ts` |
| AC-3 | `access.integration.test.ts` (11), `evidence.integration.test.ts` (13), `privacy.integration.test.ts` (7) |
| AC-4 | `ai-assist.test.ts` (9), `boundary.test.ts` AI block, `app/admin/operations/safety/page.test.tsx` AI block |
| AC-5 | `restriction-gate.test.ts` (6), `reports.integration.test.ts` "AC-5 / DECIDED-3", `routes.integration.test.ts` `RESTRICTION_UNAVAILABLE` |
| AC-6 | `UrgencyEmergencyNotice.test.tsx` (7) |

**One defect was found and fixed during implementation:** the three new `*_by_admin_id` foreign-key
columns initially lacked the covering btree index spec 003 AC-4 requires
(`lib/db/schema-lint.test.ts`). Three indexes were added to the schema, the migration and the down
migration.

**Known pre-existing failures, untouched:** five `lib/db` tests fail for reasons that predate this
spec — `schema-coverage` and `migrations.integration` (extra tables from specs 010/021/022),
`concurrency.integration` ×2 (spec 010's `NOT NULL` on `categories.name`), and `schema-lint` AC-5
(six jsonb columns owned by spec 010's catalog). Spec 030 adds **no** jsonb column and its own
`user_blocks` entry is registered in `schema-coverage`.
