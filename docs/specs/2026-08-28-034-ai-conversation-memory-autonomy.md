# Spec: AI Conversation, Memory & Autonomy

**File:** `docs/specs/2026-08-28-034-ai-conversation-memory-autonomy.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §5, §11, §16, §81–§87, §89, §90, §92, §93, §117, §119, §132.3, §132.8, §132.10, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §7.2, §7.4, [docs/workflow.md](../workflow.md)

> **Repository shape.** This repository is a **single Next.js application**, not a monorepo. There
> is no `apps/web`, `apps/api`, `apps/web-e2e`, `packages/ui`, `packages/types` or `packages/mcp`.
> HTTP routes live in `app/api/v1/**/route.ts`, domain logic in `lib/**`, shared DTOs in
> `lib/types/`, design-system primitives in `ui/` behind thin wrappers in `components/`, pages in
> `app/**/page.tsx`, and end-to-end tests are Vitest files in `e2e/*.spec.ts`. Every path in this
> spec is a real path in this repository or a new file at a stated location.

> **Review note.** This revision corrects the draft against the actual repository, the master
> specification and the specs this one depends on. The most consequential corrections are that the
> four AI tables are **existing spec 003 baseline tables that this spec extends**, not new
> entities (§4); that guests are **never** given a stored conversation, per approved spec 007 (§3);
> that action execution belongs to specs 035/036 and reaches this spec **through a port that ships
> inert** (§3.4); and that the draft's two error codes and its invented UI components are replaced
> by what already exists (§3.7, §5).

> **Product decisions (normative).** Four product decisions, approved by the user, now govern this
> spec and replace the open questions the previous revision carried:
>
> 1. **AI memory** holds only explicit, useful user preferences. It never automatically stores
>    conversation content or sensitive personal data. It is user-visible and deletable. The
>    assistant may *propose* a memory item, but nothing is saved until the user explicitly confirms
>    it (§3.9).
> 2. **Proactive suggestions** are useful and low-frequency, always identified as AI suggestions and
>    never presented as system facts, can all be disabled by the user, and never execute a purchase,
>    booking, message, payment, cancellation or any other consequential action (§3.10).
> 3. **Temporary/private conversations** are not retained after they end, never create AI memory,
>    never appear in conversation history, may use normal conversational AI functionality while
>    active, and leave no transcript on the server (§3.11).
> 4. **Conversation retention.** A normal conversation is kept until the user deletes it or the
>    account deletion/privacy process removes or anonymizes it. There is no fixed retention period
>    (§4 "Retention and privacy").
>
> **Final clarifications (normative).** Four further decisions, also approved by the user, close the
> points the previous revision left open:
>
> - **Preferred provider characteristics are not AI memory** in this spec. There is no such key,
>   and one cannot be stored (§3.9).
> - **Communication preferences are not AI memory** in this spec. Spec 026's notification
>   preferences and spec 025's messaging remain their owners (§3.9).
> - **Provider availability/update suggestions are not produced** by this spec (§3.10).
> - **Temporary/private conversations cannot execute actions.** They are conversation-only: no MCP
>   action is proposed, confirmed or executed from one, and no `ai_actions` (activity) record is
>   created (§3.11).
>
> No product question remains open in this spec (§8).

---

## 1. Problem statement

**Today:** Spec 033 provides the AI abstraction (`lib/ai`: `completeAi()`, quotas, rate limits, cost
controls and usage accounting) but not the user-facing assistant, which the master specification
names **Ask Apuriva**. The four spec 003 baseline tables it needs — `ai_conversations`,
`ai_messages`, `ai_memories`, `ai_actions` — exist, but carry only `id`, audit columns, `version` and
their foreign keys; nothing writes to them. The design system already ships the assistant's
primitives under `ui/components/ai/` (`AiAssistantPanel`, `AiMessage`, `AiConfirmationCard`,
`AiToolApproval`, `AiActivityLog`, `AiSuggestedActions`), none of them wired into the app.

Master spec §81 requires conversation history to stay separate from a small, permitted AI memory;
§82 requires users to view, search, delete and clear conversations, and to start temporary/private
conversations; §83–§84 require proactive suggestions that are low-noise, never purchase or message
without permission, and are always distinguishable from system facts; §85 requires an inspectable
activity history; §86 requires honest Undo; and §87 defines a **four-tier** autonomy model — low,
medium, high and **restricted**.

**Who is affected:** Every signed-in user of Ask Apuriva; anyone auditing what the assistant did on
their behalf.

**Why it matters now:** It is the conversational surface that specs 035/036's MCP tools are invoked
from, so it has to exist first. It is deliberately sequenced *before* those tools, which means
this spec must ship its confirmation and activity contracts without any action tool to exercise
them — see §3.4 for how that is done without inventing an execution path.

**Success looks like:** A signed-in user can converse with Ask Apuriva, view, search, delete and
clear their conversations, and hold a temporary conversation that leaves nothing behind. Memory
holds only preferences the user explicitly confirmed, from a closed allow-list, and is viewable,
deletable and resettable. Proactive suggestions are rare, clearly labelled, switchable off, and
never act. Every action the assistant takes is gated by its risk tier, recorded in an inspectable
activity history, and never presented as undoable when it is not.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a signed-in user's normal conversation **When** a turn completes **Then** the user message and the assistant reply are both persisted to that conversation in a single stable order, and nothing from the turn is written to AI memory |
| AC-2 | **Given** AI memory **When** any conversation turn — normal or temporary — is processed **Then** no memory entry is created or changed; an entry is written only by the user's own explicit `POST /api/v1/ai/memory` request (§3.9) |
| AC-3 | **Given** a user's AI memory **When** they view it, delete one entry, or reset it **Then** the change takes effect in the same request and the next read reflects it |
| AC-4 | **Given** an action classified **low** risk **When** the assistant invokes it **Then** it executes without a confirmation step |
| AC-5 | **Given** an action classified **medium** risk **When** the assistant proposes it **Then** it does not execute until the user issues an explicit confirmation request bound to that proposal; a confirmation is never inferred from the text of a message |
| AC-6 | **Given** an action classified **high** risk **When** the assistant proposes it **Then** it executes only after the user confirms through the structured, parameter-bound confirmation UI; conversational confirmation alone never suffices, and any secure authorization the underlying domain requires (payment authorization, spec 008 step-up) still applies |
| AC-7 | **Given** an action classified **restricted** **When** the assistant is asked to perform it **Then** it is neither offered nor executed, and no activity entry records it as performed |
| AC-8 | **Given** a signed-in user **When** they list, search, view, delete one, or clear all of their conversations **Then** each works on their own conversations only; a deleted conversation's messages are gone, while activity entries for actions taken in it remain, and AI memory is unchanged |
| AC-9 | **Given** a proactive suggestion **When** it is rendered **Then** it is labelled, in text and visually, as a suggestion from Ask Apuriva and never as a system fact (master spec §84); **and when** the user has turned proactive suggestions off **Then** they receive none |
| AC-10 | **Given** an assistant-initiated action **When** the user views AI activity history **Then** they see what happened (in plain language, never a raw tool identifier), when, the related request or booking, the result, and whether confirmation was required |
| AC-11 | **Given** an action that is not genuinely reversible **When** it is shown in activity history **Then** no Undo is offered; the entry explains that it cannot be undone and links a recovery path to the related request or booking |
| AC-12 | **Given** a guest (no session) **When** they call any `/api/v1/ai/*` endpoint **Then** it returns spec 007's `401 UNAUTHENTICATED` and nothing is persisted |
| AC-13 | **Given** an assistant reply that proposes a memory item **When** the user does not confirm it **Then** nothing is stored; **when** they confirm it **Then** exactly the proposed allow-listed key and value are stored and appear in their memory; a proposal whose key is not allow-listed or whose value fails that key's validation is dropped and never shown |
| AC-14 | **Given** a temporary conversation **When** the user exchanges turns **Then** replies are returned, and no `ai_conversations`, `ai_messages`, `ai_memories` or `ai_actions` row is created, no memory is proposed, the conversation never appears in conversation list or search, and once it ends its transcript exists nowhere on the server or in browser storage |
| AC-18 | **Given** a temporary conversation **When** the user asks for anything that would be an action at any risk tier **Then** no MCP action is proposed, confirmed or executed, the executor is never invoked, and no activity entry is created; the reply is conversational only |
| AC-19 | **Given** AI memory **When** anything attempts to store a key outside `preferred_category`, `preferred_area` and `language` — including a provider-characteristics or communication-preference key — **Then** it is rejected: a proposal is dropped, `POST /api/v1/ai/memory` returns `400 VALIDATION_ERROR`, and the database CHECK refuses the row |
| AC-15 | **Given** a proactive suggestion **When** it is produced, displayed or selected **Then** no purchase, booking, message, payment, cancellation or other state change occurs; selecting it only navigates to the related booking or request |
| AC-16 | **Given** a normal conversation **When** no user deletion and no account deletion has occurred **Then** it remains retrievable regardless of its age — no time-based sweep removes it |
| AC-17 | **Given** a user's privacy rights **When** they request a data export or their account deletion is swept **Then** the export contains their non-deleted conversations and messages, memory and activity; and the sweep deletes their messages and memory, tombstones their conversations and retains their content-free activity entries |

---

## 3. API contract

### 3.1 Module layout

| Path | Responsibility |
|---|---|
| `lib/ai-assistant/` | this spec's domain module: conversations, messages, temporary turns, memory, proactive suggestions, activity, risk policy, the executor port |
| `lib/ai-assistant/feature-flags.ts` | `isConversationalAssistantEnabled()` (§9) |
| `lib/ai-assistant/risk-policy.ts` | risk tier → confirmation requirement (§3.5) |
| `lib/ai-assistant/executor.ts` | the `AiActionExecutor` port, inert by default (§3.4) |
| `lib/ai-assistant/memory-keys.ts` | the memory key allow-list and each key's value validation (§3.9) |
| `lib/ai-assistant/reply-envelope.ts` | parses the `conversation` task's output into a reply and an optional memory proposal (§3.3) |
| `lib/ai-assistant/suggestions.ts` | derives proactive suggestions at read time (§3.10) |
| `lib/types/ai-assistant.ts` | the DTOs in §3.6 |
| `app/api/v1/ai/**/route.ts` | the conversation, temporary-turn, memory, suggestion and activity routes |
| `app/api/v1/users/me/ai-preferences/route.ts` | the proactive-suggestions preference |

**Why not inside `lib/ai`.** Spec 033 deliberately keeps `lib/ai` content-free: it records "what kind
of call happened, never what was said", and `lib/ai/boundary.test.ts` fails if any `lib/ai` module
persists prompt or response text. Ask Apuriva's transcript *is* what was said, and master spec §82
requires it to be stored. It therefore lives in its own module, exactly as spec 032's support
assistant lives in `lib/support`. `lib/ai-assistant` calls AI only through the `@/lib/ai` barrel —
`completeAi()`, `isAiDegradable()`, the `AiTask` type — and redefines none of it. This spec changes
no file under `lib/ai`.

### 3.2 Endpoints

Every route uses `withApiRoute` + `apiSuccess` (`lib/api/handler.ts`, `lib/api/response.ts`) and
`requireSession` (`lib/auth/require-session.ts`). Every state-changing route also calls
`requireCsrf`. List routes use `parsePageParams`/`buildPage` (`lib/api/pagination.ts`, spec 004
AC-6). A non-owner gets the same `404 NOT_FOUND` as a missing id, never a `403` (the convention
spec 015 §3 records from specs 008 and 012).

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/ai/conversations` | session + CSRF + `Idempotency-Key` | `201` `ApiResponse<AiConversationDto>`; `200` on replay | starts an empty normal conversation |
| `GET` | `/api/v1/ai/conversations` | session | `200` `PagedResponse<AiConversationSummaryDto>` | the caller's own non-deleted conversations, most recently updated first; optional `q` (§3.3) |
| `DELETE` | `/api/v1/ai/conversations` | session + CSRF | `204` | **clear history** — deletes every conversation the caller owns (§4 "Deletion") |
| `GET` | `/api/v1/ai/conversations/{id}/messages` | session | `200` `PagedResponse<AiMessageDto>` | the transcript, in `created_at ASC, id ASC` order |
| `POST` | `/api/v1/ai/conversations/{id}/messages` | session + CSRF + `Idempotency-Key` | `201` `ApiResponse<AiMessageDto>`; `200` on replay | one turn; returns the assistant reply, which may carry a `pendingConfirmation` or a `memoryProposal` |
| `DELETE` | `/api/v1/ai/conversations/{id}` | session + CSRF | `204` | deletes one conversation |
| `POST` | `/api/v1/ai/conversations/{id}/confirm` | session + CSRF + `Idempotency-Key` | `200` `ApiResponse<AiActionDto>` | body `{ confirmationId }`; hands the user's confirmation to the executor (§3.4) |
| `POST` | `/api/v1/ai/temporary-turns` | session + CSRF | `200` `ApiResponse<AiTemporaryReplyDto>` | one temporary turn; conversation-only — stores nothing and executes no action (§3.11) |
| `GET` | `/api/v1/ai/memory` | session | `200` `ApiResponse<AiMemoryItemDto[]>` | the caller's memory; small by construction, so unpaged |
| `POST` | `/api/v1/ai/memory` | session + CSRF | `201` `ApiResponse<AiMemoryItemDto>` when created; `200` when the key already existed | **the user's explicit confirmation** of a proposed item (§3.9) |
| `DELETE` | `/api/v1/ai/memory/{id}` | session + CSRF | `204` | deletes one entry |
| `DELETE` | `/api/v1/ai/memory` | session + CSRF | `204` | **reset** — deletes every entry the caller owns |
| `GET` | `/api/v1/ai/suggestions` | session | `200` `ApiResponse<AiProactiveSuggestionDto[]>` | the caller's current proactive suggestions, derived at read time (§3.10); small by construction, so unpaged |
| `GET` | `/api/v1/ai/activity` | session | `200` `PagedResponse<AiActionDto>` | the caller's activity, newest first |
| `GET` | `/api/v1/users/me/ai-preferences` | session | `200` `ApiResponse<AiPreferencesDto>` | |
| `PATCH` | `/api/v1/users/me/ai-preferences` | session + CSRF | `200` `ApiResponse<AiPreferencesDto>` | turns proactive suggestions on or off |

**Shape decisions and their sources.**

- *`Idempotency-Key` on the three creating conversation `POST`s* follows the repository's rule for
  routes that create durable rows, and matches `POST /api/v1/bookings/{id}/conversation/messages`
  (spec 025), which also returns `201` on creation and `200` on replay. For the message route it
  matters twice over: a retried turn must neither duplicate the transcript nor spend AI quota again.
- *No `Idempotency-Key` on `POST /ai/temporary-turns`.* It creates nothing, which is spec 032's
  `POST /api/v1/support/assistant` precedent ("IT CREATES NOTHING, so it takes no
  `Idempotency-Key`"). Storing a replay record would also mean storing the reply, which §3.11
  forbids. A retried temporary turn is a new AI call, exactly as a retried support question is.
- *No `Idempotency-Key` on `POST /ai/memory`.* It is naturally idempotent: one entry per
  `(user_id, key)` (§4), so a repeat confirmation returns `200` with the same entry instead of
  creating a second. That is spec 016's `POST /api/v1/providers/{id}/availability-notify`
  precedent (`201` created, `200` for the existing row).
- *Clear history and memory reset are `DELETE` on the collection*, following spec 008's
  `DELETE /api/v1/users/me/sessions`. The draft's `POST /ai/memory/reset` is replaced so the spec
  uses one idiom for "delete all", not two.
- *`GET` is added to `/users/me/ai-preferences`*, mirroring spec 014's
  `/users/me/personalization-settings` (`GET` + `PATCH`); without it the toggle's state cannot be
  displayed.
- *The draft had no way to view a conversation, search, or clear history*, although master spec
  §82 requires all three. `GET …/{id}/messages`, the `q` parameter and `DELETE /ai/conversations`
  add them.
- *Rate limiting.* The message and temporary-turn routes' AI calls are limited inside `completeAi()`
  (spec 033 §3.5 step 3, `ai` domain). Neither route adds a second `ai` check of its own. Every
  other route uses the `default` domain, as spec 033's admin usage route does.
- *No `step-up`.* None of these routes is a sensitive action under spec 008 AC-5 (payout method
  change, deletion request, MFA toggle), so none requires one. A sensitive action the assistant
  proposes keeps its own domain's step-up requirement (§3.5).

**Guests.** Master spec §11 allows guests "basic AI discovery". Spec 013's
`POST /api/v1/search/interpret`, which needs no session, already provides it, and this spec
changes nothing there. Every `/api/v1/ai/*` route — including `POST /ai/temporary-turns` —
requires a session. Three sources settle this rather than a new choice:

1. Approved spec 007 §4 says guest state is "never persisted server-side against an anonymous
   identity".
2. The baseline column `ai_conversations.user_id` is `NOT NULL`, so a guest conversation cannot be
   stored.
3. The only guest identifier in the repository is spec 033's `hashRequestIp()` digest, which a
   whole network can share, so it cannot prove ownership of a transcript.

A guest who reaches an `/ai/*` route gets spec 007's `401 UNAUTHENTICATED`, which the client
handles through spec 007's `AuthGate`. How much AI a guest may use is already capped by spec 033's
guest quotas (`AI_GUEST_MAX_REQUESTS_PER_DAY`, `AI_GUEST_MAX_TOKENS_PER_DAY`, per IP hash). Since
nothing is stored for a guest, there is no guest transcript to carry into an account on signup.

### 3.3 Conversation turn

`POST /api/v1/ai/conversations/{id}/messages` with body `{ body: string }`:

1. Checks `isConversationalAssistantEnabled()`. If it is off, the route throws spec 033's
   `AiUnavailableError` (`503 AI_PROVIDER_UNAVAILABLE`).
2. Loads the conversation. Missing, deleted or not owned by the caller → `404 NOT_FOUND`.
3. Calls `completeAi({ task: 'conversation', subject: { kind: 'user', userId }, input })`. The
   `input` is a JSON object `{ memory, turns }`: `memory` is the caller's memory entries as
   `{ key, valueSummary }` (§3.9), and `turns` is the conversation's prior turns plus the new user
   turn as `{ role, body }` in transcript order. System instructions are **not** part of `input`:
   they belong to the provider adapter's prompt template, which spec 033 versions as
   `promptVersion`. That keeps them separate from user content, which master spec §93 treats as
   untrusted.
4. If the error is degradable (`isAiDegradable`), **neither** half of the turn is stored and the
   route returns spec 033's code (`429 AI_RATE_LIMITED`, `429 AI_QUOTA_EXCEEDED` or
   `503 AI_PROVIDER_UNAVAILABLE`). The transcript therefore never holds a question the assistant
   never answered, and retrying with the same `Idempotency-Key` re-attempts the turn cleanly.
5. Parses the output with `reply-envelope.ts` (below) into the reply text and an optional memory
   proposal.
6. On success, persists the user message and the assistant reply text in one transaction, stamps
   the conversation's `updated_at`, and returns the reply. A valid memory proposal is attached to
   the returned `AiMessageDto` only; it is **not** persisted and nothing is written to
   `ai_memories` (AC-1, AC-2).

**Reply envelope.** The `conversation` task's output is parsed as the JSON object
`{ "reply": string, "memoryProposal"?: { "key": string, "value": object } }`.

- An output that is not such an object is treated entirely as `reply`, with no proposal. Spec 033's
  sandbox adapter answers the `conversation` task with an explicitly marked placeholder string, and
  refuses to run under `NODE_ENV=production`. So until a real provider is configured, Ask Apuriva
  stores and shows that placeholder rather than a fabricated answer, and proposes no memory.
- A `memoryProposal` whose key is not in the allow-list, or whose value fails that key's validation
  (§3.9), is **dropped silently**. The reply is still returned (AC-13). The model can therefore
  never widen what memory may hold.
- The envelope is this spec's contract for the `conversation` task's output. A real provider
  adapter's `conversation` prompt template — spec 033's `lib/ai/provider`, versioned by
  `promptVersion` — must produce it. No real adapter exists today, so this spec edits nothing there
  (§8 risk 9).

**Search.** `GET /api/v1/ai/conversations?q=` returns the caller's non-deleted conversations that
contain at least one message whose body contains `q`, case-insensitively. It reads only the
caller's own rows, so a table-wide full-text index is unnecessary. Temporary conversations are never
stored, so they can never match (AC-14).

### 3.4 Action execution — the port this spec ships inert

Under master spec §87's core flow, every AI action goes AI → MCP → backend authorization →
execution. MCP tools are specs 035/036, which are sequenced **after** this spec (`docs/workflow.md`,
Milestone 10). So this spec cannot execute any action itself, and inventing a private execution path
would bypass spec 035's eight-step authorization (master spec §89).

It therefore ships an **`AiActionExecutor` port, inert by default**, which spec 035/036 register
from `instrumentation.ts`. That is the pattern this repository already uses for cross-spec
dependencies in the wrong build order: spec 021's `DisputeGate`, spec 027's file contexts and spec
030's `ConversationBlockGate` each shipped inert and were made real by a later spec.

| Concern | Owner |
|---|---|
| Interpreting the model's tool requests, the tool registry and schemas | **035/036** |
| Spec 035's eight-step authorization, including ownership, mode and permission scope | **035** |
| The confirmation record, its binding to exact parameters, expiry, and detecting stale parameters | **035** (AC-3, and its open question 2 on token format) |
| Tool-call idempotency keys and retries | **036** |
| Risk tier → whether a confirmation is required, enforced before the executor is called (§3.5) | **034** |
| Presenting a pending confirmation and accepting the user's confirm or decline | **034** |
| Recording each attempted action in `ai_actions` and showing activity history | **034** |
| Memory proposals, confirmation of a memory item, proactive suggestions, temporary turns | **034** — none of them is an MCP action, and none passes through the executor |

With the default port, the assistant proposes no actions, so no confirmation can ever be pending,
and `POST …/confirm` returns `404 NOT_FOUND` for any `confirmationId`. That is the honest behaviour
of a surface that has no tools yet (master spec §132.8: "Do not claim an MCP action succeeded without
tool confirmation"). AC-4 to AC-7, AC-10 and AC-11 are verified against a test executor (§6).

When an action runs, this spec inserts its `ai_actions` row with `result = 'pending'` **before**
calling the executor and passes the row's id through, because spec 036's `ai_tool_calls` rows
reference it. It sets `succeeded` or `failed` only from the result the executor confirms. If the
process dies mid-action, the row stays `pending`, which activity history shows as "outcome
unknown". It is never shown as a success — master spec §92: "Never claim success without confirmed
backend success".

The executor is invoked only from a normal conversation turn and from `POST …/confirm`. It is
**never** invoked by `POST /ai/temporary-turns` — temporary conversations are conversation-only
(§3.11) — by `GET /ai/suggestions` (§3.10) or by `POST /ai/memory` (§3.9). `POST …/confirm` is
addressed by a stored conversation's id, which a temporary conversation never has, so no
confirmation can originate from one.

**The port's shape (implementation correction, approved).** `lib/ai-assistant/executor.ts`:

```typescript
interface AiActionContext { userId: string; sessionId: string; conversationId: string }
interface AiProposedAction {
  actionType: string;          // spec 035's tool name — stored, never sent to a client
  actionLabel: string;         // plain language
  riskTier: 'low' | 'medium' | 'high' | 'restricted';
  parameters: Array<{ label: string; value: string }>;
  related: { type: 'request' | 'booking'; id: string } | null;
  confirmationId?: string;     // spec 035-issued, medium/high only
}
interface AiActionExecutor {
  interpretTurn(ctx, output: string): Promise<AiProposedAction | null>;          // normal turns only
  resolveConfirmation(ctx, confirmationId): Promise<AiProposedAction | null>;    // null → 404; stale → 035's error
  execute(ctx, aiActionId, action): Promise<{ succeeded: boolean }>;
  labelFor(actionType): string | null;                                           // null → not shown
}
```

At most ONE action is proposed per turn, matching the singular `pendingConfirmation`. The inert
default returns `null` from both lookups and never reaches `execute`. Specs 035/036 register a real
one with `registerAiActionExecutor()` from `instrumentation.ts`; this spec does not touch that file.
A confirmation is resolved (and a stale one rejected) BEFORE its `ai_actions` row is inserted, so a
stale confirmation records nothing. An executor that throws leaves its row `pending`.

### 3.5 Risk tiers and confirmation

| Tier (§87) | Confirmation (§90) | This spec enforces | UI (§5) |
|---|---|---|---|
| **low** — search, filter, summarize, translate, calculate, read | none | executes immediately | result rendered inline |
| **medium** — send message, modify preferences, create a draft/request | conversational confirmation | not executed until an explicit `POST …/confirm` for that `confirmationId` | `AiToolApproval` |
| **high** — booking, payment, cancellation, payout, account/security change | structured confirmation UI | as medium; the confirmation must come from the structured UI showing every bound parameter | `AiConfirmationCard` with `riskLevel="high"` |
| **restricted** — safety enforcement, serious disputes, bans, financial investigations | human/admin only | refused; never offered, never passed to the executor, never recorded as performed | none — `AiConfirmationCard`'s own contract: "restricted actions are never offered here" |

**Confirmation security.**

- **A confirmation is a request, never an interpretation.** Medium and high confirmations exist only
  as an explicit `POST …/confirm` carrying the `confirmationId` spec 035 issued. The model never
  decides that a typed "yes" means "confirmed". That would make the AI the confirmation authority,
  which master spec §89 ("AI is never the security boundary"), §93 and §132.3 ("Do not trust AI
  authorization") forbid. `AiToolApproval`'s own contract says the same: "Approval here is a UI
  courtesy — authorization is still enforced server-side." The same rule governs memory: a typed
  "yes, remember that" saves nothing; only `POST /ai/memory` does (§3.9).
- **Bound to exact parameters.** The confirmation covers the exact parameters displayed (master
  spec §90). If one has changed, the executor rejects the confirmation with spec 035's error, which
  this route passes through unchanged. The user must confirm again. This spec defines no error code
  of its own for that condition (§3.7).
- **Confirmation is necessary, never sufficient.** Master spec §90's fourth level — "financial /
  security: secure authorization" — is unchanged. A payment still needs spec 021's authorization
  flow, and an account/security change still needs spec 008 AC-5's fresh step-up
  (`403 STEP_UP_REQUIRED`). The assistant's confirmation replaces neither.
- **Replay.** `POST …/confirm` requires an `Idempotency-Key`. A retry returns the original result
  instead of executing twice (master spec §91). Single-use enforcement and expiry of the
  confirmation itself belong to spec 035's confirmation record.
- **Session-bound.** Confirming needs the caller's own session and CSRF token, and the confirmation
  must belong to a conversation the caller owns. Anything else returns `404`.

### 3.6 Request and response types

```typescript
// lib/types/ai-assistant.ts
export type AiMessageRole = 'user' | 'assistant';
export type AiActionRiskTier = 'low' | 'medium' | 'high'; // 'restricted' is never executed, so never recorded

export interface AiConversationDto {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationSummaryDto extends AiConversationDto {
  /** The first user message, truncated to its first 120 characters for display — derived at read
   *  time, never stored. */
  preview: string;
}

export interface AiMessageDto {
  id: string;
  role: AiMessageRole;
  body: string;
  createdAt: string;
  /** Present only on the reply that proposes a medium/high action. Not rehydrated when the
   *  transcript is re-read: the confirmation is spec 035's record and may since have gone stale. */
  pendingConfirmation?: AiPendingConfirmationDto;
  /** Present only on the reply that proposes a memory item (§3.9). Never persisted, so never
   *  rehydrated: an unconfirmed proposal leaves no trace. */
  memoryProposal?: AiMemoryProposalDto;
}

export interface AiPendingConfirmationDto {
  /** Opaque, issued by spec 035's confirmation record. */
  confirmationId: string;
  riskTier: 'medium' | 'high';
  /** Plain language, e.g. "Book AC repair with Ali Raza" — never a raw tool identifier (§85). */
  actionLabel: string;
  /** The exact parameters the confirmation is bound to (§90), in display order. */
  parameters: Array<{ label: string; value: string }>;
}

export interface AiActionDto {
  id: string;
  conversationId: string;
  actionLabel: string;
  riskTier: AiActionRiskTier;
  requiredConfirmation: boolean;
  result: 'pending' | 'succeeded' | 'failed';
  related: { type: 'request' | 'booking'; id: string } | null;
  reversible: boolean;
  createdAt: string;
}

/** §3.9 — the closed allow-list. Provider characteristics and communication preferences are
 *  deliberately absent and cannot be stored. */
export type AiMemoryKey = 'preferred_category' | 'preferred_area' | 'language';

/** Each key's value shape, reusing an existing repository vocabulary (§3.9). */
export interface AiMemoryValueByKey {
  /** A `categories.id` (spec 010) that is `published` when the entry is written. */
  preferred_category: { categoryId: string };
  /** The coarse `city`/`area` fields of spec 012's `StructuredAddress` — never a street address,
   *  address id or coordinates. */
  preferred_area: { city: string; area?: string };
  /** Master spec §5.1's languages as BCP 47 tags: English, Urdu, Roman Urdu. */
  language: { language: 'en' | 'ur' | 'ur-Latn' };
}

export type AiMemoryEntry = {
  [K in AiMemoryKey]: { key: K; value: AiMemoryValueByKey[K] };
}[AiMemoryKey];

export type AiMemoryProposalDto = AiMemoryEntry & {
  /** Human-readable rendering of the VALUE, e.g. "DHA, Lahore" — derived, never stored. The key's label
   *  is rendered separately (§5: "Preferred area — DHA, Lahore"). */
  valueSummary: string;
};

/** Body of `POST /api/v1/ai/memory` — the user's explicit confirmation of a proposal. */
export type ConfirmAiMemoryRequest = AiMemoryEntry & {
  /** The normal conversation whose reply carried the proposal. */
  conversationId: string;
};

export type AiMemoryItemDto = AiMemoryEntry & {
  id: string;
  /** Human-readable rendering of the stored value — derived at read time. */
  valueSummary: string;
  createdAt: string;
  updatedAt: string;
};

/** Body of `POST /api/v1/ai/temporary-turns` (§3.11). */
export interface AiTemporaryTurnRequest {
  /** The whole temporary transcript so far, held only by the client, ending with the new user
   *  turn. */
  turns: Array<{ role: AiMessageRole; body: string }>;
}

/** Deliberately has no `id`, no `createdAt`, no `pendingConfirmation` and no `memoryProposal`:
 *  a temporary turn is conversation-only — nothing about it is stored, actionable, confirmable or
 *  rememberable. */
export interface AiTemporaryReplyDto {
  role: 'assistant';
  body: string;
}

/** §3.10 — closed. Provider availability/update suggestions are deliberately not produced. */
export type AiProactiveSuggestionKind = 'upcoming_booking' | 'unfinished_request';

export interface AiProactiveSuggestionDto {
  kind: AiProactiveSuggestionKind;
  /** Always present; the UI renders it as the suggestion's attribution (AC-9). */
  source: 'ask_apuriva';
  /** Fixed copy per kind, phrased as a suggestion. It never states or restates a status. */
  text: string;
  /** Where selecting the suggestion navigates. Selecting it does nothing else (AC-15). */
  link: { type: 'booking' | 'request'; id: string };
}

export interface AiPreferencesDto {
  proactiveSuggestionsEnabled: boolean;
}
```

The draft's `AiMessageDto.pendingConfirmation.boundParameters: Record<string, unknown>` and
`AiActionDto.actionType: string` are replaced. Both would have sent raw tool arguments and tool ids
to the client, which master spec §85 forbids ("Do not expose raw MCP internals") and which
`AiToolApproval`'s `toolLabel` contract rules out ("not the raw MCP tool id"). The labelled
`parameters` list is exactly the shape `AiConfirmationCard` and `AiToolApproval` render.

`AiActionDto.result` no longer includes `'reversed'`. No reversal mechanism exists upstream
(§3.8), so no action can reach that state.

### 3.7 Error codes

This spec adds **no** error codes. Every refusal reuses an existing one:

| HTTP | `code` | Owner | When |
|---|---|---|---|
| `400` | `VALIDATION_ERROR` | spec 004 | malformed body or unexpected field, empty `body`, a turn `body` or search `q` longer than spec 025's `MESSAGE_BODY_MAX_LENGTH` (2000 — the bound spec 032 already applies to its assistant question); a temporary turn list that is empty or does not end with a `user` turn; a memory key outside the allow-list, a value failing its key's validation, or a `categoryId` that is not a published category |
| `401` | `UNAUTHENTICATED` | spec 004/007 | no session, including every guest (AC-12) |
| `403` | `CSRF_TOKEN_INVALID` | spec 005 | state-changing call without a valid CSRF token |
| `404` | `NOT_FOUND` | spec 004 | missing, deleted or not-owned conversation (including the `conversationId` of a memory confirmation), memory entry or confirmation |
| `409`/`400` | `IDEMPOTENCY_KEY_CONFLICT` / `IDEMPOTENCY_KEY_REQUIRED` | spec 004 | reused key with a different body / missing key |
| `429` | `AI_RATE_LIMITED`, `AI_QUOTA_EXCEEDED` | spec 033 | turn refused by the AI controls |
| `503` | `AI_PROVIDER_UNAVAILABLE` | spec 033 | assistant or platform AI disabled, or the provider failed |
| — | the stale-confirmation code | spec 035 | bound parameters changed; passed through unchanged |

**Removed from the draft:**

- `409 CONFIRMATION_PARAMETERS_CHANGED` duplicated spec 035's `409 MCP_CONFIRMATION_STALE` for the
  same condition (spec 035 AC-3). The condition belongs to spec 035. Spec 035 is still Draft, so
  this spec names its code by reference rather than by a string that 035's own review may change.
- `422 ACTION_NOT_UNDOABLE` was the error of an undo endpoint the draft never defined (§3.8).

### 3.8 Undo

Master spec §86: "Only show Undo when an action is genuinely reversible. Never pretend an
irreversible action can be undone. If irreversible: explain, offer recovery path."

Whether an action can be reversed, and how, is a property of the tool that performed it. Specs
035/036 do not currently declare it: spec 035's `McpToolDefinition` has no reversibility flag and no
reversal operation. So this spec records `ai_actions.reversible = false` for every action, ships
**no undo endpoint**, and renders every activity entry with the §86 fallback: an explanation plus a
recovery link to the related request (`app/requests/[id]`) or booking (`app/bookings/[id]`).

This is not a limitation to paper over. A compensating action is **not** an undo. Cancelling a
booking the assistant created runs spec 023's cancellation policy, fees and refund rules, and
presenting it as "Undo" would be exactly the false promise §86 forbids.

Undo for a specific action becomes possible only once its tool declares a genuine reversal. That
needs a reversibility contract in specs 035/036, which is reported as a cross-spec gap (§8 risk 6),
plus a design-system Undo affordance, which `AiActivityLog` does not have today.

A confirmed memory entry is not an action and has no Undo: the user removes it with delete or
reset (§3.9), which is genuinely reversible because nothing else depends on it.

### 3.9 AI memory

Master spec §81: memory is a "small set of useful, relevant, permitted preferences", it "must not
automatically become a copy of all conversations", users can "View, Delete, Reset", and "Sensitive
data should not be casually remembered".

**What memory may hold.** Only explicit, useful user preferences, under a **closed allow-list** in
`lib/ai-assistant/memory-keys.ts`, each with a fixed value shape taken from a vocabulary the
repository already has. There is no free-text key, and no key whose value could carry conversation
content or sensitive personal data:

| Key | Value | Existing source of the shape | Validation at write time |
|---|---|---|---|
| `preferred_category` | `{ categoryId }` | spec 010's `categories.id`; `/api/v1/search` already accepts `categoryId` | the id names a `published` category |
| `preferred_area` | `{ city, area? }` | spec 012's `StructuredAddress.city` / `.area`; spec 013's `SearchIntentDto.area` | the same rules spec 012 applies to those two fields; no other field is accepted, so a street address, address id or coordinates cannot be stored (spec 012 AC-3's coarse-location posture) |
| `language` | `{ language }` | master spec §5.1: English, Urdu, Roman Urdu | one of `en`, `ur`, `ur-Latn` |

**Not AI memory, by decision.** Two preference types are deliberately excluded from this spec:

- **Preferred provider characteristics.** There is no key for them, so they cannot be stored.
- **Communication preferences.** There is no key for them. How a user is notified and how they
  message are owned by spec 026's notification preferences and spec 025's messaging, and this spec
  neither duplicates nor reads them.

The exclusion is enforced three times: the envelope drops any proposal with a key outside the
allow-list (§3.3), `POST /ai/memory` rejects it with `400 VALIDATION_ERROR` (§3.7), and the
`ai_memories.key` CHECK refuses it (§4) (AC-19).

The `language` entry governs only the language Ask Apuriva replies in. It never changes the
platform UI locale, which spec 042 owns.

**How an entry is written — propose, then confirm.**

1. A normal conversation turn may return a `memoryProposal` (§3.3). It is shown to the user and
   **not stored anywhere** — not in `ai_memories`, not in `ai_messages`.
2. The entry is written only when the user confirms it in the UI (§5), which sends
   `POST /api/v1/ai/memory` with `{ conversationId, key, value }`. The write is the user's own
   request — a typed "yes" in the conversation never saves anything (§3.5).
3. The route re-validates the key and value exactly as the envelope did, and requires
   `conversationId` to be a non-deleted normal conversation the caller owns (`404` otherwise). A
   temporary conversation has no `conversationId`, so it can never produce a memory write (AC-14).
4. The entry is upserted on `(user_id, key)`: `201` when the key is new; `200` when it existed,
   with its value replaced by the one the user just confirmed.

`POST /ai/memory` is this spec's own write to its own table. It is not an MCP action, does not pass
through the executor, and records no `ai_actions` row. The memory page is its inspectable record
(§5), with each entry's `createdAt` and `updatedAt`.

**How memory is used.** A turn — normal or temporary — sends the caller's entries to the model as
`{ key, valueSummary }` (§3.3). Reading memory creates nothing, so a temporary conversation uses it
like any other (§3.11).

**View, delete, reset.** `GET /ai/memory` lists every entry. `DELETE /ai/memory/{id}` removes one,
and `DELETE /ai/memory` removes all. Both hard-delete and take effect in the same request (AC-3).
Memory and conversation history are independent: deleting a conversation or clearing history
leaves memory unchanged, and resetting memory leaves conversations unchanged (AC-8).

### 3.10 Proactive suggestions

Master spec §83: "useful, low-noise suggestions"; the AI must not "Spam, Make purchases without
permission, Send messages without permission, Constantly interrupt"; "Users can disable
non-essential proactive suggestions". §84: "System facts are authoritative. AI suggestions are
clearly suggestions. AI cannot rewrite system status." Spec 026's ownership table assigns "AI
proactive suggestions" to this spec and keeps the notification catalogue, delivery and frequency
cap for itself.

**The suggestions.** Exactly two kinds, and no others. Each is derived at read time from the caller's own existing domain rows, so no table and no trigger job is
added:

| Kind | Approved example | Condition, from existing data | Links to |
|---|---|---|---|
| `upcoming_booking` | upcoming booking reminder | the caller's earliest booking (spec 020) with status `confirmed` and `scheduled_at` in the future | `app/bookings/[id]` |
| `unfinished_request` | unfinished request | the caller's most recently updated request (spec 015) in `offers_open` — the state where the next step is the customer's (master spec §83's own example: "You have not selected an offer yet") | `app/requests/[id]` |

**Provider availability/update suggestions are not produced by this spec**, by decision.
`AiProactiveSuggestionKind` has no member for them. A customer who opted in through spec 016's
availability notification is still told through spec 026's system notification, which this spec
does not change.

**Low frequency, by construction.** No number is needed:

- **Pull, never push.** Suggestions are computed only when the user opens the assistant panel
  (`GET /ai/suggestions`). They are never sent as spec 026 notifications, never pushed, and never
  raise a badge or counter. The assistant cannot interrupt.
- **At most one per kind.** The endpoint returns at most one `upcoming_booking` and one
  `unfinished_request`.
- **Self-expiring.** Each disappears as soon as its condition stops holding — the booking starts or
  leaves `confirmed`, or the request leaves `offers_open`.

**Never a system fact.** Each suggestion carries `source: 'ask_apuriva'` and is rendered with that
attribution on the AI surface (§5). Its `text` is fixed copy per kind, phrased as a suggestion
— `upcoming_booking`: "Ask Apuriva suggests reviewing your upcoming booking."; `unfinished_request`:
"Ask Apuriva suggests taking a look at your request." It never states or restates a
status — the linked page shows the authoritative facts. Suggestions make **no** AI call: fixed copy
spends no quota on content the user did not ask for, and cannot rewrite a system status (§84).

**Never an action.** Producing, showing or selecting a suggestion executes nothing: no purchase,
booking, message, payment, cancellation or other state change (AC-15). Selecting one only navigates
to its link. The endpoint is a `GET`, performs no write, and never calls the executor.

**Switching them off.** `PATCH /users/me/ai-preferences { proactiveSuggestionsEnabled: false }`
turns off **every** proactive suggestion: `GET /ai/suggestions` then returns `[]`. Every suggestion
this spec produces is non-essential. Anything essential — a booking starting, a payment, a
security event — is a system fact, delivered by its owning spec through spec 026's notifications,
which this preference never affects. `GET /ai/suggestions` also returns `[]` when the assistant
flag is off (§9) or the caller has no customer profile.

The starter prompts shown on an empty conversation (§5) are not proactive suggestions. They appear
only after the user opened the assistant to ask something, only pre-fill the composer, and are not
governed by the preference.

### 3.11 Temporary/private conversations

Master spec §82: users can "Start temporary/private AI conversations where appropriate".

A temporary conversation is **not stored on the server at any point**. The transcript exists only
in the client's in-memory component state while the conversation is active.

`POST /api/v1/ai/temporary-turns` with body `{ turns }` (§3.6):

1. Checks `isConversationalAssistantEnabled()` → `503 AI_PROVIDER_UNAVAILABLE` if off.
2. Validates `turns`: non-empty, the last turn is the user's, and each `body` meets the same rules
   as a normal turn's `body` (§3.7).
3. Calls `completeAi({ task: 'conversation', subject: { kind: 'user', userId }, input })` with the
   same `{ memory, turns }` input as a normal turn (§3.3). A degradable error returns spec 033's code,
   as in §3.3 step 4.
4. Parses the output with `reply-envelope.ts` and **discards any memory proposal**.
5. Returns `{ role: 'assistant', body }`. It never invokes the executor, writes no row in
   `ai_conversations`, `ai_messages`, `ai_memories` or `ai_actions`, keeps no idempotency record,
   and logs no message content.

**What a temporary conversation can do.** It is **conversation-only**. It uses normal
conversational AI functionality while active: the same model task, the same memory as context, the
same quotas and rate limits.

**What it cannot do.**

- **Execute actions.** No MCP action at any risk tier — low, medium or high — is proposed,
  confirmed or executed from a temporary conversation. The route never invokes the executor, its
  reply type has no `pendingConfirmation`, and `POST …/confirm` needs a stored conversation's id,
  which a temporary conversation never has (AC-18). This holds whatever executor specs 035/036
  register later.
- **Create activity records.** Because nothing executes, no `ai_actions` row is written, and the
  temporary conversation never appears in activity history (AC-18).
- **Create AI memory.** The route discards proposals, and `POST /ai/memory` requires a stored
  conversation (AC-14).
- **Appear in history.** It never appears in conversation list, search or export, because it is
  never stored.

A user who wants the assistant to act does so from a normal conversation, where §3.4 and §3.5
apply.

**When it ends.** It ends when the user closes the assistant panel, starts a new conversation,
switches temporary mode off, reloads or leaves the page, or signs out. The client then discards the
transcript. The client never writes it to `localStorage`, `sessionStorage` or IndexedDB, so it does
not survive the end of the conversation in the browser either. A temporary conversation cannot be
turned into a saved one.

**What remains on the server.** Only spec 033's content-free `ai_usage_events` row for each AI call
(task, tokens, outcome — "what kind of call happened, never what was said"), which every AI call
records under spec 033's own retention. Spec 033 marks the `conversation` task non-cacheable, so no
reply is held in its cache either.

**Trust.** The client supplies the prior turns, including the assistant's. A forged assistant turn
gains nothing: all of `input` is untrusted user content (master spec §93), no confirmation is ever
inferred from text (§3.5), and the route can perform no action and writes nothing.

---

## 4. Data model changes

### Entities

All four tables are **existing spec 003 baseline tables** (`lib/db/schema.ts`), created by
`drizzle/0001_baseline_schema.sql` and never extended since. Spec 003's convention is that the
owning spec adds feature columns ("Feature-specific columns … are added by each entity's owning
spec"). This spec owns these four; `ai_tool_calls` belongs to spec 036 and is not touched. Every
existing column, foreign key and `restrict` rule is kept.

| Table | Change | Columns added |
|---|---|---|
| `ai_conversations` | extend | `deleted_at timestamptz null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `ai_messages` | extend | `role text not null` (`in ('user','assistant')`), `body text not null`, `idempotency_key text null`, `idempotency_fingerprint text null` |
| `ai_memories` | extend | `key text not null` (`in ('preferred_category','preferred_area','language')`), `value jsonb not null` |
| `ai_actions` | extend | `action_type text not null`, `risk_tier text not null` (`in ('low','medium','high')`), `required_confirmation boolean not null`, `result text not null default 'pending'` (`in ('pending','succeeded','failed')`), `reversible boolean not null default false`, `related_entity_type text null` (`in ('request','booking')`), `related_entity_id uuid null`, `idempotency_key text null`, `idempotency_fingerprint text null` |
| `users` | extend | `ai_proactive_suggestions_enabled boolean not null default true` |

No table is added. Temporary conversations and proactive suggestions need no storage (§3.10, §3.11).

**Idempotency storage (implementation correction, approved).** §3.2 requires an `Idempotency-Key`
with `201`/`200` replay on three `POST`s, but the finalized table above listed no column to hold it.
The repository stores every such key ON the created row — `idempotency_key` + `idempotency_fingerprint`
with a per-owner unique index (specs 015, 018, 020, 021, 025, 032) — and this spec follows that:

- `ai_conversations`: both `NOT NULL`, unique `(user_id, idempotency_key)`.
- `ai_messages`: set on the turn's **assistant** row only (the row the route returns), so
  `ai_messages_idempotency_ck` requires `(role = 'assistant') = (idempotency_key is not null)`;
  unique `(ai_conversation_id, idempotency_key)`.
- `ai_actions`: set only by `POST …/confirm` (a low-risk action run inside a turn has none); unique
  `(ai_conversation_id, idempotency_key)`.

A replay with the same body returns the original row with `200`; a different body is
`409 IDEMPOTENCY_KEY_CONFLICT` and writes nothing. Neither column is ever exported.

Checks and indexes:

- `ai_actions`: `related_entity_type` and `related_entity_id` are both null or both set.
- `ai_actions.risk_tier` **excludes `restricted`**, so a restricted action cannot be recorded as
  performed even by a bug (AC-7).
- `ai_memories.key` is CHECK-limited to the three allow-listed keys, so the database refuses any
  other key — including a provider-characteristics or communication-preference key (AC-19). Each
  key's `value` shape is validated in `lib/ai-assistant/memory-keys.ts` (§3.9).
- `ai_memories`: unique `(user_id, key)` — a preference holds one value, and it makes
  `POST /ai/memory` naturally idempotent (§3.2).
- Indexes: `ai_conversations (user_id, updated_at)` for the list,
  `ai_messages (ai_conversation_id, created_at, id)` for the transcript order,
  `ai_actions (ai_conversation_id, created_at)` for activity. The baseline FK indexes stay.
  Proactive suggestions read `bookings` and `requests` through their existing customer indexes.

**Corrections against the draft:**

- *"New entities."* All four tables already exist. Recreating them would conflict with the baseline
  migration.
- *`ai_conversations.user_id nullable`.* The baseline column is `NOT NULL`, and it stays that way —
  guests are not stored (§3.2).
- *A temporary flag on `ai_conversations`.* Not added. A temporary conversation is never stored, so
  there is nothing to flag (§3.11).
- *`ai_actions.user_id`.* Not added. Ownership comes from the parent conversation's `user_id` (the
  baseline FK is `NOT NULL`). Deleted conversations are kept as tombstones (below), so that
  ownership stays resolvable. A second `user_id` would create a second source of ownership that
  could disagree with the first.
- *`ai_actions.conversation_id nullable`.* Not changed. The baseline column is `NOT NULL`, and every
  recorded action originates from a normal conversation, which is this spec's only action surface —
  temporary conversations execute no actions (§3.11).
- *`archived_at`.* Dropped. Nothing in the draft used it. `deleted_at` is the one lifecycle column,
  and it has a defined meaning.
- No plain-language label column on `ai_actions`. `actionLabel` is derived when read from
  `action_type` through the tool's label (§8 risk 6), so no free text is stored — including a
  counterparty's name, which a stored label such as "Message Ali Raza" would contain.
- No source-conversation column on `ai_memories`. A memory entry is a preference, not a record of
  what was said, and must survive the deletion of the conversation it came from (§3.9).

### Deletion

Every baseline foreign key is `restrict` (spec 003 AC-4). This repository never hard-deletes a row
something references; it anonymizes or tombstones instead (specs 008, 015, 018, 025). The same
applies here:

- **Delete a conversation / clear history** hard-deletes the conversation's `ai_messages` rows,
  which nothing references. It then sets `ai_conversations.deleted_at`. The tombstone disappears
  from list, search and transcript reads (`404`). Its `ai_actions` rows **remain**, so activity
  history still shows, for example, that the assistant booked something. Master spec §82 keeps
  transactional records under the booking/payment systems, and §85's activity history is separate
  from §82's conversation history. **AI memory is not touched** (§3.9).
- **Delete a memory entry / reset memory** hard-deletes `ai_memories` rows, which nothing
  references. It takes effect in the same request (AC-3). **Conversations are not touched.**
- **Temporary conversations** have nothing to delete: no transcript, memory or activity record
  (§3.11).

### Migration

- **Name:** `NNNN_add_ai_conversation_memory` — the next free number at implementation time
  (currently `0030`), following `drizzle/`'s `NNNN_snake_case` convention, with a hand-written
  `NNNN_add_ai_conversation_memory_down.sql` that has no journal entry, so `npm run db:migrate`
  never applies it.
- **Contents:** `ALTER TABLE … ADD COLUMN` for the columns above, plus their checks and indexes.
  No `CREATE TABLE`.
- **Reversible:** yes, with a guard. The down migration refuses to run while any `ai_messages`,
  `ai_memories` or `ai_actions` row exists (`RAISE EXCEPTION`, the idiom of `0021` and `0025`). It
  drops only what this migration added, and never touches `0001_baseline_schema.sql`, `ai_tool_calls`
  or any other spec's table.
- **Backfill required:** no. Nothing has ever written the four baseline tables, so they are empty
  and the new `NOT NULL` columns need no default. The `users` column carries its own default.
- **Downtime:** none.
- **Reviewed SQL:** generated by `drizzle-kit`, reviewed in PR. `npm run check:schema-checksum` pins
  only the baseline file, which is not edited.

### Retention and privacy

Conversation history and memory are personal data. Spec 008's export and deletion flows do **not**
cover them automatically. Every spec that stores personal data adds its own section to
`lib/privacy/export.ts` and to `sweepDeletions` in `lib/privacy/deletion.ts`, as specs 015, 017,
018, 024 and 025 did. This spec does the same (AC-17):

- **Export** includes the caller's non-deleted conversations with their messages, their memory
  entries (key, value and `valueSummary`), and their activity entries. Temporary conversations are
  never stored, so there is nothing of them to export.
- **Account deletion sweep** hard-deletes the user's `ai_messages` and `ai_memories` and tombstones
  their conversations. Their `ai_actions` rows are retained, keyed to the now-anonymized user. They
  carry no free text, so nothing further needs redacting.

**Retention (normative).** A normal conversation is retained until the user deletes it (one
conversation or clear history) or spec 008's account deletion sweep removes and anonymizes it. This
spec defines **no** time-based retention period and adds **no** retention sweep (AC-16). Master
spec §82's "Retention follows platform policy" is met by that platform process. If a platform-wide
retention policy is introduced later, it governs this data through the same privacy architecture —
a sweep registered in `lib/privacy` — without changing this spec's tables or routes. Spec 025's
`MESSAGE_RETENTION_DAYS` covers booking messages only and does not apply here.

Memory entries follow the same rule: kept until the user deletes one, resets memory, or the account
is swept.

**Minimisation.** Memory is minimal by design: a closed allow-list of fixed value shapes, written
only by the user's explicit confirmation (§3.9). That shrinks the sensitive surface instead of
relying on deletion alone ("Sensitive data should not be casually remembered", master spec §81).
Temporary conversations leave no transcript at all (§3.11), and proactive suggestions store nothing
(§3.10).

`ai_usage_events` (spec 033) keeps recording each turn's AI call, normal or temporary. It stores no
content, so no transcript is duplicated there, and it follows spec 033's own retention.

---

## 5. UI states

The screens are composed from primitives that **already exist** in `ui/components/ai/`. Each is
exposed through a thin wrapper in `components/` (for example `components/AiAssistantPanel.tsx`), the
way `components/Table.tsx` and spec 033's `components/StatBlock.tsx` are, and imported from that
wrapper directly. `components/index.ts` carries other specs' in-flight design-system work. The
draft's invented `ChatPanel`, `ActivityTimeline` and `UndoButton` are dropped, and no new AI
primitive is added:

| Need | Existing primitive | Its own documented contract |
|---|---|---|
| The assistant surface | `AiAssistantPanel`, opened from `AiAssistantLauncher` | "a drawer on mobile, a side panel on desktop … Never a bottom-nav tab" |
| One turn; the thinking state | `AiMessage` (`role`, `pending`) | "Never let it claim an action succeeded without backend confirmation" |
| Medium-risk confirmation; memory proposal | `AiToolApproval` (`toolLabel`, `args`, `state`, `onApprove`, `onDeny`) | "Permission gate for one MCP tool call" — e.g. "Send a message". Master spec §87 classes "modify preferences" as medium risk, so a memory proposal uses the same gate |
| High-risk structured confirmation | `AiConfirmationCard` with `riskLevel="high"` | "Parameter-bound approval for a high-risk assistant action … If any change, ask again" |
| Activity history | `AiActivityLog` (`confirmed`, `status`) | "Meaningful actions only — never raw MCP internals" |
| Starter prompts; proactive suggestions | `AiSuggestedActions` (`label`, `actions`, `onSelect`) | "Suggestions, never commitments — tapping one starts a flow, it does not perform a high-risk action" |
| Temporary-mode switch; proactive-suggestions toggle | `Switch` (`components/Switch.tsx`) | existing form control |
| Delete / clear / reset confirmation | `ConfirmDialog` (`components/ConfirmDialog.tsx`) | existing destructive-action dialog |

**Routes and placements.**

- **Assistant panel:** no page route. The draft's `apps/web/app/ai` page is replaced by
  `AiAssistantPanel`, opened from `AiAssistantLauncher` wherever the assistant is placed in
  context, and composed in `app/_components/AskApurivaPanel.tsx`. Master spec §16 names the service
  page (`app/explore/[category]/[service]/page.tsx`), and spec 014 AC-8 requires the assistant to
  be contextual rather than a permanent tab. No further placements are decided here.
- **`app/account/ai-conversations/page.tsx`** — view, search, delete and clear conversations
  (§82). The draft had no route for this.
- **`app/account/ai-memory/page.tsx`** — view, delete and reset memory, and the
  proactive-suggestions toggle, next to the other AI controls.
- **`app/account/ai-activity/page.tsx`**

| State | Behaviour |
|---|---|
| **Loading** | the pending reply renders as `AiMessage pending` (the typing indicator), never a fabricated instant answer. Account pages use the admin/account convention: `Card` + `Skeleton`. Proactive suggestions load after the panel opens and never block it |
| **Empty** | a new conversation shows `AiSuggestedActions` starter prompts — "Find a service near me", "Help me describe what I need", "How does booking work?" — which only pre-fill the composer. An empty memory, activity or conversation list renders `EmptyState`. The memory empty state explains that Ask Apuriva only remembers preferences you confirm. No proactive suggestion renders nothing — there is no "no suggestions" placeholder |
| **Error** | a degradable AI failure (spec 033's `429`/`503`) shows "Ask Apuriva is temporarily unavailable — try search directly", which never blocks the underlying feature; in a temporary conversation the transcript so far is kept on screen. A failed suggestion fetch renders nothing and is not retried in a loop. Other failures use `ErrorState` with retry |
| **Success** | a low-risk result renders inline. A medium-risk proposal renders `AiToolApproval`, and a high-risk one renders `AiConfirmationCard riskLevel="high"` listing every bound parameter (master spec §90's example: provider, service, date/time, location, price, currency). Each activity entry is labelled, timestamped and linked to its request or booking; every entry carries the §86 explanation and recovery link (§3.8). Settled entries render through `AiActivityLog`. A `pending` entry is NOT passed to `AiActivityLog`, which has only `done`/`failed` and draws a success check for anything not failed (§8 risk 11): it renders in its own text-only "Outcome unknown" list built from `Card` and a `Badge` reading "Outcome unknown" |
| **Unauthenticated** | a guest launching the assistant is taken through spec 007's `AuthGate` to sign in |

**Memory proposal (AC-13).** A reply's `memoryProposal` renders `AiToolApproval` with
`toolLabel="Remember this preference"` and one `args` row: the key's plain-language label and the
`valueSummary` (for example "Preferred area — DHA, Lahore"). Approve sends `POST /ai/memory`; on
success the card shows `state="approved"` and the entry is on the memory page. Deny sends nothing and
shows `state="denied"`. Closing the panel or reloading without choosing also stores nothing. A
failed save shows `state="failed"` with a plain-language `errorMessage`.

**Memory page.** Each entry shows the key's plain-language label, its `valueSummary`, when it was
saved, and a delete control. "Reset memory" opens `ConfirmDialog`, which states that every
remembered preference will be removed and that conversations are unaffected.

**Conversations page.** Search, the list, delete-one and clear-history, each destructive action
through `ConfirmDialog`. The clear-history dialog states that remembered preferences and AI
activity history are kept, and that transactional records stay under their bookings and requests.

**Temporary conversation (AC-14).** The panel offers a "Temporary conversation" `Switch` before a
conversation starts. While it is on, the panel's `subtitle` says, in text, that the conversation is
not saved, not used to remember preferences, cannot take actions, and disappears when closed. That
notice stays visible for the whole conversation. No memory proposal, `AiToolApproval`,
`AiConfirmationCard` or activity entry is ever rendered in this mode (AC-18). Closing the panel ends
the conversation without a "save" prompt.

**Proactive suggestions (AC-9, AC-15).** Rendered in the panel's `footer` through
`AiSuggestedActions` with `label="Ask Apuriva suggests"`, so the attribution is visible text, on the
AI surface tokens (`--ai-surface`) that distinguish the assistant from system content. They are
never rendered as a notification, banner, status badge or toast. Selecting one navigates to its
link and does nothing else. With the preference off, none renders. The memory page's toggle is
labelled "Proactive suggestions from Ask Apuriva" and explains that booking, payment and security
notifications are unaffected.

**Accessibility.** Per spec 043: every control is keyboard-operable with a visible token focus
ring. The transcript is an `aria-live="polite"` region, so each reply is announced. The pending
state is announced. A confirmation card's parameters are a labelled list, and the confirm and
decline actions are real buttons with explicit labels. The temporary-mode notice is part of the
panel's accessible name or description, not only a visual cue. The proactive-suggestion group is
labelled by its "Ask Apuriva suggests" text. Risk tier, result and temporary mode are conveyed in
text, never by colour alone.

---

## 6. Test plan

Vitest throughout (`vitest.config.ts` includes `**/*.test.{ts,tsx}` and `e2e/**/*.spec.{ts,tsx}`).
Integration tests run against the isolated `*_test` database only. There is no Playwright and no
`lib/mcp` (spec 036 is unbuilt). Every action-tier behaviour is therefore exercised through a
**test executor** registered on the §3.4 port, and the executor's real authorization is spec 035's
to test. Model outputs carrying a memory proposal are produced by mocking `@/lib/ai` with
`vi.mock`, the pattern `lib/support/ai-assist.test.ts` and `lib/safety/ai-assist.test.ts` already
use; the sandbox adapter's placeholder is used where a plain reply suffices.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | tier → confirmation mapping; `restricted` refused before the executor; the allow-list and each key's value validation (every key outside the three — including provider-characteristic and communication-preference keys — extra fields, street-address fields, unsupported languages rejected); envelope parsing (non-JSON output is a plain reply, an invalid proposal is dropped) | `lib/ai-assistant/risk-policy.test.ts`, `lib/ai-assistant/memory-keys.test.ts`, `lib/ai-assistant/reply-envelope.test.ts` |
| **Integration** | turn persistence and order; degraded turn stores nothing; a proposal is returned but not stored; delete/clear tombstones and removes messages while activity and memory survive; search; memory confirm, upsert, delete and reset; reset leaves conversations; confirmation flow and staleness pass-through against a test executor; `pending` → confirmed result; temporary turns write nothing, never invoke the executor at any tier and create no activity row; suggestion derivation limited to the two kinds, self-expiry, no write | `lib/ai-assistant/conversations.integration.test.ts`, `lib/ai-assistant/memory.integration.test.ts`, `lib/ai-assistant/confirmation.integration.test.ts`, `lib/ai-assistant/activity.integration.test.ts`, `lib/ai-assistant/temporary.integration.test.ts`, `lib/ai-assistant/suggestions.integration.test.ts`, `lib/ai-assistant/migration.integration.test.ts` (0030 applied shape, and its `_down.sql` actually run inside a rolled-back transaction) |
| **Route** | session/CSRF/`Idempotency-Key` guards; guest `401` on every route; non-owner `404`; `201` vs replay `200`; memory `201`/`200`; flag off → `503` on creating routes and `[]` from suggestions while reads, deletes and export still work | `app/api/v1/ai/conversations.integration.test.ts`, `app/api/v1/ai/memory.integration.test.ts`, `app/api/v1/ai/temporary-turns.integration.test.ts`, `app/api/v1/ai/suggestions.integration.test.ts`, `app/api/v1/users/me/ai-preferences/ai-preferences.integration.test.ts` |
| **Privacy** | export includes this spec's data; the deletion sweep deletes messages and memory, tombstones conversations, retains actions; an active user's old conversation is never swept | cases added to `lib/privacy/export.integration.test.ts` and `lib/privacy/deletion.integration.test.ts` |
| **Boundary** | `lib/ai-assistant` reaches AI only through `@/lib/ai`; no transactional module imports `lib/ai-assistant`; `ai_memories` is written only by the `POST /ai/memory` path; the temporary-turn and suggestion paths import no database write helper and no executor | `lib/ai-assistant/boundary.test.ts` |
| **Component** | account pages' loading, empty, error and success states; panel pending state; high-risk card lists every bound parameter; no Undo is rendered; memory proposal approve/deny; temporary-mode notice and no memory proposal or action confirmation in that mode; suggestion attribution and navigation-only selection | `app/account/ai-conversations/page.test.tsx`, `app/account/ai-memory/page.test.tsx`, `app/account/ai-activity/page.test.tsx`, `app/_components/AskApurivaPanel.test.tsx` |
| **Accessibility** | the §5 accessibility requirements, colocated with the component they cover (spec 025's `BookingConversation.a11y.test.tsx` convention) | `app/_components/AskApurivaPanel.a11y.test.tsx`, `app/account/ai-activity/ai-activity.a11y.test.tsx`, `app/account/ai-memory/ai-memory.a11y.test.tsx` |
| **E2E (Vitest)** | a signed-in user starts a conversation, sends a turn, gets a reply, sees it in history, deletes it; a high-risk proposal from a test executor cannot run without the structured confirmation; a temporary conversation leaves no history | `e2e/ai-assistant.spec.ts` |
| **Regression** | spec 033's `lib/ai/boundary.test.ts` and spec 013's search suite still pass unmodified | existing |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/ai-assistant/conversations.integration.test.ts::persists both halves of a turn in created_at, id order (AC-1)` |
| AC-2 | `conversations.integration.test.ts::a conversation turn never creates or changes a memory entry, even when a proposal comes back (AC-2)`; `memory.integration.test.ts::a typed "yes" in the conversation never saves anything`; `temporary.integration.test.ts::a memory proposal is discarded — a temporary conversation can never create memory` |
| AC-3 | `memory.integration.test.ts::delete and reset take effect in the same request (AC-3)` |
| AC-4 | `confirmation.integration.test.ts::a low-risk action runs without confirmation (AC-4)` |
| AC-5 | `confirmation.integration.test.ts::medium-risk waits for an explicit confirm request (AC-5)`; `::a typed "yes" never confirms` |
| AC-6 | `confirmation.integration.test.ts::high-risk requires the structured confirmation and never runs from the turn itself (AC-6)`; `::stale parameters are rejected with the executor’s own error, unchanged, and nothing is recorded`; `AskApurivaPanel.test.tsx::a high-risk proposal renders the structured card listing every bound parameter` |
| AC-7 | `risk-policy.test.ts::restricted is refused before the executor — never executed, never confirmable (AC-7)`; `confirmation.integration.test.ts::restricted is never offered, never executed and never recorded (AC-7)`; `migration.integration.test.ts::the database refuses a restricted action row` |
| AC-8 | `conversations.integration.test.ts::delete removes messages and keeps activity and memory (AC-8)`; `::clear history tombstones every conversation…`; `::search matches own messages only…`; `::a non-owner gets the same 404…`; `memory.integration.test.ts::memory and history are independent…`; `app/api/v1/ai/conversations.integration.test.ts::non-owner gets 404` |
| AC-9 | `AskApurivaPanel.test.tsx::a proactive suggestion is attributed to Ask Apuriva, never rendered as a system fact, and selecting it only navigates`; `suggestions.integration.test.ts::disabled preference returns none (AC-9)`; `ai-preferences.integration.test.ts::toggle persists` |
| AC-10 | `activity.integration.test.ts::entry carries label, time, related entity, result and confirmation flag, never a tool id (AC-10)` |
| AC-11 | `app/account/ai-activity/page.test.tsx::no Undo; explains and links the recovery path`; `activity.integration.test.ts::every entry is irreversible…` |
| AC-12 | `app/api/v1/ai/conversations.integration.test.ts::guest gets 401 and nothing is stored, on every route (AC-12)`; the matching guest cases in `memory`, `temporary-turns`, `suggestions` and `ai-preferences` route tests |
| AC-13 | `memory.integration.test.ts::a proposal is not stored until confirmed; confirming stores exactly the proposed key and value (AC-13)`; `reply-envelope.test.ts::an unknown key or invalid value is dropped, and the reply is still returned`; `AskApurivaPanel.test.tsx::a memory proposal is shown for approval; deny stores nothing` |
| AC-14 | `temporary.integration.test.ts::no conversation, message, memory or action row is written`; `::a memory proposal is discarded…`; `::never appears in conversation list or search`; `app/api/v1/ai/memory.integration.test.ts::confirmation without a stored conversation is 404`; `AskApurivaPanel.test.tsx::the temporary transcript is never written to browser storage` |
| AC-15 | `suggestions.integration.test.ts::producing suggestions changes no row — navigation only, never an action (AC-15)`; `AskApurivaPanel.test.tsx::a proactive suggestion is attributed … and selecting it only navigates` |
| AC-16 | `lib/privacy/deletion.integration.test.ts::an active user's old conversation is never swept — there is no time-based retention (AC-16)` |
| AC-17 | `lib/privacy/export.integration.test.ts::export includes conversations, messages, memory and activity`; `lib/privacy/deletion.integration.test.ts::sweep deletes messages and memory, tombstones conversations, retains actions` |
| AC-18 | `temporary.integration.test.ts::the executor is never invoked, at any risk tier, and no activity row is written (AC-18)`; `AskApurivaPanel.test.tsx::no action confirmation or memory proposal renders in temporary mode`; `boundary.test.ts::the temporary-turn path writes nothing and never reaches the executor` |
| AC-19 | `memory-keys.test.ts::rejects every key outside the allow-list, including provider-characteristic and communication-preference keys`; `memory.integration.test.ts::rejects every key outside the allow-list with 400…`; `::the database CHECK refuses a non-allow-listed key even if application validation were bypassed (AC-19)`; `app/api/v1/ai/memory.integration.test.ts::a non-allow-listed key is 400 at the route (AC-19)` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** MCP authorization internals, tool schemas and idempotency — specs
035/036 own and test them. The quality of the model's replies — the sandbox adapter is
deterministic so these tests assert control behaviour, not prose (spec 033's position). Whether a
real model proposes *useful* memory items — that depends on a real provider's prompt template
(§8 risk 9); these tests assert that nothing is stored without confirmation, whatever is proposed.

---

## 7. Out of scope

- MCP tool registry, the eight-step authorization pipeline, the confirmation record, tool
  idempotency and error translation — specs 035/036.
- Undo execution for any action — needs a reversibility contract that specs 035/036 do not define
  yet (§3.8, §8 risk 6).
- Spec 032's support assistant (`POST /api/v1/support/assistant`). It is a separate, stateless FAQ
  answerer that stores nothing and always offers human escalation. It is not Ask Apuriva, and this
  spec neither absorbs nor changes it.
- Guest AI beyond spec 013's `POST /api/v1/search/interpret` (§3.2).
- Admin-facing AI assistance (master spec §80.2) — separately permissioned per master spec §127.
- Analytics on how often pages are viewed — spec 040.
- Delivering proactive suggestions as notifications, and any notification type for them — spec
  026 owns the catalogue and this spec delivers suggestions only inside the panel (§3.10).
- A platform-wide data-retention policy — none exists; if one is introduced it governs this data
  through `lib/privacy` (§4).
- The platform UI locale — spec 042; the `language` memory entry affects only the assistant's
  replies (§3.9).
- Preferred provider characteristics as AI memory — excluded by decision (§3.9).
- Communication preferences as AI memory — excluded by decision; spec 026's notification
  preferences and spec 025's messaging own them (§3.9).
- Provider availability/update proactive suggestions — excluded by decision (§3.10).
- Any action from a temporary/private conversation — excluded by decision; temporary conversations
  are conversation-only (§3.11).

---

## 8. Risks and open questions

**Open product questions: none.** The four approved product decisions settle memory, proactive
suggestions, temporary conversations and retention, and the four final clarifications settle the
points the previous revision left open:

| # | Former open question | Resolution (approved) | Where encoded |
|---|---|---|---|
| 1 | Value shape of "preferred provider characteristics" | **Not AI memory in this spec.** No key exists and none can be stored | §3.9, §4, AC-19 |
| 2 | Meaning and value shape of "communication preferences" | **Not AI memory in this spec.** Spec 026's notification preferences and spec 025's messaging remain the owners | §3.9, §4, AC-19 |
| 3 | When a "provider availability/update" suggestion stops showing | **Not produced by this spec.** `AiProactiveSuggestionKind` has exactly two members | §3.10 |
| 4 | Whether MCP actions are available in a temporary conversation | **No.** Temporary conversations are conversation-only: no action at any tier, no executor call, no `ai_actions` record | §3.4, §3.11, AC-18 |

**Risks.**

| # | Risk | Owner | Resolution |
|---|---|---|---|
| 5 | Every action tier depends on specs 035/036, which are sequenced after this spec | Platform | **Resolved by design:** the §3.4 port ships inert and those specs register it, the pattern `instrumentation.ts` already uses for specs 021, 027 and 030. Tier enforcement is tested against a test executor |
| 6 | **Cross-spec gap — reported, not edited.** Spec 035's `McpToolDefinition` declares neither reversibility nor a plain-language label, yet master spec §86 needs the first and §85 (with `AiToolApproval`'s contract) needs the second | Platform | Specs 035/036 are Draft; their own review must add both. Until then every action is recorded irreversible (§3.8), and an action whose tool has no label cannot be shown in activity history |
| 7 | **Cross-spec open questions not settled here.** Spec 035 open question 2 (confirmation token vs server-side record) and spec 036 open question 1 (who generates tool-call idempotency keys; 036 recommends this spec) | Platform | Left to those specs' reviews. This spec only needs an opaque `confirmationId` and its own HTTP `Idempotency-Key` |
| 8 | **Mixed files at implementation time.** Account navigation lives in `app/account/page.tsx` and the shell in `app/components/NavShell.tsx`, and both are currently staged with other specs' in-flight work. `components/index.ts` carries unstaged in-flight work too | Platform | The account pages are reachable by route without touching those files. Any link added to them must be committed as its own hunk, never by staging the whole file. Components are imported from their own wrappers (§5) |
| 9 | **The reply envelope depends on a real provider's prompt template.** Only spec 033's sandbox adapter exists, and it returns a plain placeholder, so no memory is ever proposed in production until a real adapter's `conversation` template emits the §3.3 envelope | Platform | By design this fails closed: a plain reply is valid and proposes nothing. The spec that adds a real provider adapter under `lib/ai/provider` implements the envelope; this spec edits nothing in `lib/ai` |
| 10 | **Temporary turns resend the whole transcript.** Each temporary turn carries every prior turn, so long temporary conversations cost more tokens per turn | Platform | The same is true of a normal turn's `input` (§3.3). Spec 033's per-request token cap, quotas and cost alerts bound both. No server-side copy is kept to avoid it, because that is exactly what §3.11 forbids |
| 11 | **Design-system gap — reported, not patched.** `AiActivityLog` offers only `done`/`failed` and draws a success check for any entry that is not `failed`, so it cannot show an action whose outcome is unknown without implying success (master spec §92) | Design system | Pending entries render in their own text-only "Outcome unknown" list from existing `Card` + `Badge` (§5). A `pending`/unknown state on `AiActivityLog` in `ui/` would let them join the log; until then no new AI primitive is created |

---

## 9. Rollout

- **Feature flag:** `ai-conversational-assistant`, default on, shipped as the environment variable
  `AI_CONVERSATIONAL_ASSISTANT_ENABLED` through `lib/ai-assistant/feature-flags.ts` and documented in
  `.env.example` (`npm run check:env`). This is the pattern of spec 033's `AI_ASSISTANT_ENABLED` and
  spec 013's `SEARCH_NL_INTERPRETATION_ENABLED`, until spec 041's registry exists. It is independent
  of spec 033's platform-wide AI kill switch. With either one off, starting a conversation, sending
  a turn, sending a temporary turn, confirming an action and confirming a memory item return
  `503 AI_PROVIDER_UNAVAILABLE`, and `GET /ai/suggestions` returns `[]`.
  **Privacy rights are never gated by the flag.** Viewing, searching, deleting and clearing
  conversations, viewing, deleting and resetting memory, reading and changing the
  proactive-suggestions preference, activity history, export and the deletion sweep all keep
  working with it off (master spec §81, §82).
- **Proactive suggestions default on** (`ai_proactive_suggestions_enabled default true`). They are
  pull-only and appear only inside a panel the user opened (§3.10), and the user can turn them off at
  any time.
- **No retention job ships.** Conversations and memory are kept until the user deletes them or the
  account is swept (§4); nothing is scheduled.
- **Migration order:** the migration ships with the code. It is purely additive.
- **Rollback:** turn the flag off first — that is instant and non-destructive. Search, requests and
  bookings stay fully functional without the assistant. Reverting the deploy follows. The down
  migration is a last resort: it refuses to run once any transcript, memory or activity row exists,
  so after real use the correct response to a defect is a forward fix.
- **Scope shipped is closed.** Memory ships with exactly `preferred_category`, `preferred_area` and
  `language`. Proactive suggestions ship with exactly `upcoming_booking` and `unfinished_request`.
  Temporary conversations ship conversation-only, with no action path. Nothing is feature-flagged
  "for later": provider-characteristic and communication-preference memory, provider
  availability/update suggestions and temporary-conversation actions are excluded by decision
  (§8), not pending.
- **Observability** (master spec §117): confirmation outcomes are derivable from `ai_actions`
  (confirmation required against succeeded or failed). Memory rows are hard-deleted, so memory
  confirmations, deletions and resets are counted through structured log events
  (`ai_assistant.memory_confirmed`, `ai_assistant.memory_deleted`, `ai_assistant.memory_reset`), in
  the repository's `console` JSON style, carrying the key but never the value. Temporary turns are
  counted through spec 033's `ai_usage_events` like any other `conversation` call, and log no
  content. Activity-history *view* rates are page analytics and belong to spec 040. These signals
  exist to catch mis-calibrated tiers: many abandoned confirmations suggest friction; almost none
  suggest risk is being under-classified.
