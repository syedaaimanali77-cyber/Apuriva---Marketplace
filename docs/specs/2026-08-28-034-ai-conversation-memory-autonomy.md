# Spec: AI Conversation, Memory & Autonomy

**File:** `docs/specs/2026-08-28-034-ai-conversation-memory-autonomy.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §81–§87, §132.1, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §7.2, §7.4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 033 provides the raw AI abstraction but not the user-facing "Ask Apuriva"
assistant itself. Master spec §81 requires separating conversation history from a small,
permitted AI memory; §82 requires users to view/search/delete conversations; §83–§84 require
proactive suggestions that are low-noise, never make purchases/send messages without permission,
and are always distinguishable from system facts; §85 requires an inspectable AI activity
history; §86 requires honest Undo behavior; §87 defines the four-tier risk-based autonomy model.

**Who is affected:** Every user interacting with "Ask Apuriva"; anyone auditing what the AI did
on their behalf.

**Why it matters now:** It's the user-facing conversational layer that ties together search
(013), request creation (015), and — once built — MCP tools (035/036); it must exist before
MCP action tools have a conversational surface to be invoked from.

**Success looks like:** A user can converse with Ask Apuriva, which remembers only a small,
visible, deletable set of preferences (not full conversation copies), acts within its risk-tiered
autonomy (auto for low-risk, confirm for medium/high), never claims an irreversible action is
undoable, and every consequential action it took is inspectable in an activity history.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a conversation with Ask Apuriva **When** it ends **Then** the full transcript is stored as conversation history, separate from AI memory |
| AC-2 | **Given** AI memory **When** inspected by the user **Then** it contains only a small set of explicit, useful preferences — never an automatic full copy of conversations |
| AC-3 | **Given** AI memory **When** the user views/deletes/resets it **Then** the action takes effect immediately and is confirmed |
| AC-4 | **Given** a low-risk AI action (search, filter, summarize, translate, read) **When** requested **Then** it executes automatically without confirmation |
| AC-5 | **Given** a medium-risk AI action (send message, modify preference, draft a request) **When** requested **Then** conversational confirmation is obtained before execution |
| AC-6 | **Given** a high-risk AI action (booking, payment, cancellation, payout, security/account change) **When** requested **Then** explicit confirmation through a structured, secure UI is required — never conversational confirmation alone |
| AC-7 | **Given** a proactive AI suggestion **When** shown **Then** it is visually/textually distinguishable from a system fact (master spec §84's exact example pattern), and the user can disable non-essential proactive suggestions |
| AC-8 | **Given** an AI-initiated action **When** the user views AI activity history **Then** they see what happened, when, the related request/booking, the result, and whether confirmation was required |
| AC-9 | **Given** an irreversible AI-initiated action **When** the user looks for an Undo option **Then** Undo is only shown if genuinely reversible; otherwise the UI explains why and offers a recovery path instead of a false Undo |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/ai/conversations` | session or guest (limited) | `201` `ApiResponse<AiConversationDto>` | |
| `POST` | `/api/v1/ai/conversations/{id}/messages` | session or guest | `200` `ApiResponse<AiMessageDto>` | routes through risk-tier evaluation; may return a `pendingConfirmation` |
| `POST` | `/api/v1/ai/conversations/{id}/confirm` | session | `200` | executes a pending medium/high-risk action after confirmation |
| `GET` | `/api/v1/ai/conversations` | session | `200` `PagedResponse<AiConversationSummaryDto>` | |
| `DELETE` | `/api/v1/ai/conversations/{id}` | session | `204` | |
| `GET` | `/api/v1/ai/memory` | session | `200` `ApiResponse<AiMemoryItemDto[]>` | |
| `DELETE` | `/api/v1/ai/memory/{id}` | session | `204` | |
| `POST` | `/api/v1/ai/memory/reset` | session | `204` | |
| `GET` | `/api/v1/ai/activity` | session | `200` `PagedResponse<AiActionDto>` | |
| `PATCH` | `/api/v1/users/me/ai-preferences` | session | `200` | disable non-essential proactive suggestions |

### Request and response types

```typescript
// packages/types/src/ai-assistant.ts
export interface AiMessageDto {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  pendingConfirmation?: {
    riskTier: 'medium' | 'high';
    actionType: string;
    boundParameters: Record<string, unknown>; // exact params confirmation is bound to
  };
}

export interface AiActionDto {
  id: string;
  actionType: string;
  requiredConfirmation: boolean;
  result: 'success' | 'failed' | 'reversed';
  relatedEntityType?: string;
  relatedEntityId?: string;
  reversible: boolean;
  createdAt: string;
}

export interface AiMemoryItemDto {
  id: string;
  key: string;
  valueSummary: string;
  createdAt: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `409` | `CONFIRMATION_PARAMETERS_CHANGED` | user attempts to confirm an action whose bound parameters (price, time, provider) have since changed — must re-confirm (master spec §90) |
| `422` | `ACTION_NOT_UNDOABLE` | undo attempted on an irreversible action |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `AIConversation` | new | `id uuid pk`, `user_id uuid fk->User nullable`, `created_at`, `archived_at timestamptz nullable` |
| `AIMessage` | new | `id uuid pk`, `conversation_id uuid fk->AIConversation`, `role text`, `body text`, `created_at` |
| `AIMemory` | new | `id uuid pk`, `user_id uuid fk->User`, `key text`, `value jsonb`, `created_at`, `updated_at` |
| `AIAction` | new | `id uuid pk`, `user_id uuid fk->User`, `conversation_id uuid fk->AIConversation nullable`, `action_type text`, `risk_tier text`, `required_confirmation boolean`, `result text`, `reversible boolean`, `related_entity_type text nullable`, `related_entity_id uuid nullable`, `created_at` |

`AIAction` is the activity-history source of truth and is populated by every MCP action call
(spec 035/036) that originates from this conversational surface.

### Migration

- **Name:** `AddAiConversationMemoryTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Conversation history and memory are personal data, fully covered by spec 008's export/deletion
flow; memory is deliberately minimal by design (AC-2), reducing the sensitive-data surface
rather than relying solely on deletion rights.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | assistant response shows a typing/thinking indicator, never a fabricated instant answer |
| **Empty** | new conversation shows suggested starter prompts, not a blank box |
| **Error** | AI unavailable (spec 033's `AI_PROVIDER_UNAVAILABLE`) degrades to "Ask Apuriva is temporarily unavailable — try search directly" rather than blocking the underlying feature |
| **Success** | low-risk actions render inline; medium-risk shows a conversational confirm chip; high-risk opens a structured confirmation dialog with exact bound parameters (master spec §90's example: Provider/Service/Date/Time/Location/Price/Currency) |

Proactive suggestions render in a visually distinct style from system-status messages (per
AC-7), with a per-user toggle to disable them. AI activity history is fully keyboard/screen-
reader navigable.

**Route(s):** `apps/web/app/ai` (contextual assistant panel, not a permanent tab per spec 014),
`apps/web/app/account/ai-memory`, `apps/web/app/account/ai-activity`
**Shared components used/added:** `packages/ui` `ChatPanel`, `ConfirmDialog` (structured,
reused), `ActivityTimeline`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | risk-tier classification per action type, memory key/value scoping rules | `apps/api/ai/**/*.test.ts` |
| **Integration** | full conversation flow including a high-risk action requiring structured confirmation; parameter-change invalidates a stale pending confirmation | `apps/api/ai/*.integration.test.ts` |
| **MCP** | every action tool call from this surface produces a corresponding `AIAction` record | `packages/mcp/*.test.ts` |
| **E2E** | user converses, gets a low-risk answer automatically, then attempts a booking and must confirm through the structured UI | `apps/web-e2e/ai-assistant.spec.ts` |
| **Accessibility** | chat panel and confirmation dialogs keyboard/screen-reader tested | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-2 | `apps/api/ai/memory.integration.test.ts::never auto-copies conversation` |
| AC-6 | `apps/api/ai/confirmation.integration.test.ts::high risk requires structured confirmation` |
| AC-8 | `apps/api/ai/activity.integration.test.ts::records inspectable action detail` |
| AC-9 | `apps/web/UndoButton.test.tsx::hidden for irreversible actions` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** MCP tool authorization pipeline internals (spec 035) — this spec
covers the conversational UX and risk-tier UI/confirmation contract that MCP tools are invoked
through.

---

## 7. Out of scope

- MCP tool registry, authorization pipeline mechanics, idempotency (spec 035/036).
- Admin-facing AI assistance tooling (referenced in master spec §80.2 but not detailed here —
  admin AI tools are separately permissioned per master spec §127 and out of MVP-critical-path
  scope for this spec).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact set of "small, useful, permitted" memory categories | Product | Open — must be an explicit allow-list, not free-form |
| 2 | Guest AI conversation limits (how much can an unauthenticated user do before signup is required, ties to spec 007) | Product | Open |

---

## 9. Rollout

- **Feature flag:** `ai-conversational-assistant` (default on) — independent kill switch from
  spec 033's underlying AI abstraction flag.
- **Migration order:** schema ships with code.
- **Rollback:** disable flag; underlying transactional flows (search, requests, bookings) remain
  fully functional without the assistant.
- **Observability:** confirmation-abandonment rate, activity-history view rate, and memory
  deletion rate monitored (master spec §117); helps detect if autonomy tiers are miscalibrated
  (e.g. too many confirmations abandoned suggests friction, too few suggests risk
  under-classification).
