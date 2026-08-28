# Spec: AI Assistant Architecture

**File:** `docs/specs/2026-08-28-033-ai-assistant-architecture.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §80, §94, §132.1, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §7.1–7.2, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No AI integration exists, though specs 013 (search interpretation) and 011 (FAQ
suggestions) already reference an AI abstraction. Master spec §80 requires one primary AI
provider/model behind an internal abstraction — no business logic depending directly on a
vendor — with future task-based routing structurally possible but not over-built for MVP. §94
requires cost controls: usage limits, rate limits, caching, monitoring, and abuse detection.

**Who is affected:** Every AI-touching feature (search, FAQs, conversation, matching
explanations); Finance/Platform teams controlling AI spend.

**Why it matters now:** It's the foundation `packages/ai` that specs 013, 034, and 035/036 (MCP)
are all built against — sequenced after the modules it will orchestrate exist (per
`docs/workflow.md`'s dependency notes), but before the conversational assistant (034) itself.

**Success looks like:** A `packages/ai` abstraction wraps a single AI provider for MVP behind a
stable internal interface; swapping providers or adding task-based routing later requires only
configuration changes, not business-logic rewrites; usage is rate-limited, cost-monitored, and
capped per user.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any module calling AI (search interpretation, FAQ drafting, conversation) **When** it needs an AI completion **Then** it calls through `packages/ai`'s interface, never a vendor SDK directly |
| AC-2 | **Given** the configured AI provider **When** swapped for another (config change) **Then** no consuming module's code changes, only its configuration |
| AC-3 | **Given** a user **When** their AI usage (tokens/requests/time) exceeds their configured limit **Then** further AI requests are rejected or degraded gracefully, without breaking the underlying transactional workflow (e.g. manual search still works if AI interpretation is capped) |
| AC-4 | **Given** repeated identical/cacheable AI requests **When** safe to reuse **Then** a caching layer avoids redundant provider calls |
| AC-5 | **Given** unusual AI usage patterns (e.g. one account generating excessive requests) **When** detected **Then** it is flagged for abuse review |
| AC-6 | **Given** AI cost/usage **When** monitored **Then** admins can view aggregate usage and receive cost alerts |

---

## 3. API contract

### Endpoints

`packages/ai` is primarily an internal library, not a directly customer-facing API surface. It
exposes:

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/ai/usage` | admin (Analytics/Super Admin) | `200` `ApiResponse<AiUsageSummaryDto>` | aggregate, not per-conversation content |

### Request and response types

```typescript
// packages/ai/src/types.ts (internal contract, not a public REST DTO)
export interface AiCompletionRequest {
  task: 'search_intent' | 'faq_draft' | 'conversation' | 'summarization' | 'translation';
  input: string;
  userId?: string; // for rate limiting/cost attribution; omitted for guest/system calls
  maxTokens?: number;
}

export interface AiCompletionResult {
  output: string;
  tokensUsed: number;
  cached: boolean;
  provider: string; // internal identifier, never exposed to the end customer
}
```

```typescript
// packages/types/src/ai-admin.ts
export interface AiUsageSummaryDto {
  totalRequests: number;
  totalTokens: number;
  estimatedCostMinorUnits: number;
  currencyCode: string;
  byTask: Record<string, number>;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `429` | `AI_RATE_LIMITED` | per-user AI rate limit exceeded |
| `503` | `AI_PROVIDER_UNAVAILABLE` | upstream provider failure; consuming feature must degrade gracefully, not hard-fail the whole request |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `AIToolCall` | new (stub; fully used by spec 035/036) | `id uuid pk`, `user_id uuid fk->User nullable`, `task text`, `tokens_used integer`, `provider text`, `cached boolean`, `created_at` |

This spec's usage-tracking table is the basis spec 040's analytics and this spec's own cost-
control checks both read from.

### Migration

- **Name:** `AddAiUsageTracking`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Usage-tracking records the task type and token count, not necessarily full prompt/response
content by default (full content logging, if enabled for debugging, follows stricter retention
and is admin-access-audited).

---

## 5. UI states

Not applicable directly — this is a backend abstraction. The admin usage dashboard:

| State | Behaviour |
|---|---|
| **Loading** | usage summary skeleton |
| **Empty** | N/A (always has some baseline data once live) |
| **Error** | dashboard load failure shows retry |
| **Success** | usage/cost figures with per-task breakdown |

**Route(s):** `apps/web/app/admin/settings/ai-usage`
**Shared components used/added:** `packages/ui` `StatBlock`, `Table`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | provider-abstraction interface contract, caching key generation, rate-limit accounting | `packages/ai/**/*.test.ts` |
| **Integration** | rate limit rejects over-quota requests; provider swap via config produces identical consuming-module behavior against a test double | `apps/api/ai/*.integration.test.ts` |
| **Cost controls** | usage tracking accuracy, abuse-pattern flagging | `packages/ai/cost-controls.test.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `packages/ai/abstraction.test.ts::consumers never import vendor SDK directly` (lint/architecture check) |
| AC-3 | `packages/ai/rate-limit.test.ts::rejects over-quota gracefully` |
| AC-4 | `packages/ai/cache.test.ts::reuses cacheable responses` |
| AC-5 | `packages/ai/abuse-detection.test.ts::flags unusual patterns` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The underlying model's output quality — this spec tests the
abstraction/controls layer, not model performance.

---

## 7. Out of scope

- Task-based multi-model routing (structurally possible per master spec §80.2, but not built for
  MVP — single provider only).
- Conversational assistant UX, memory, activity history (spec 034).
- MCP tool execution (spec 035/036) — this spec provides the AI completion layer those tools'
  reasoning is built on, not the tool-calling/authorization mechanics themselves.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | AI provider selection and credential availability | — | Open — requires real credentials or a documented mock adapter per master spec §133.7 |
| 2 | Exact per-user usage limits and cost-alert thresholds | Finance/Product | Open |

---

## 9. Rollout

- **Feature flag:** `ai-assistant` (default on, but each consuming feature — search
  interpretation, FAQ drafting — has its own flag per its owning spec so AI can be disabled
  per-feature without disabling the whole platform).
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; disable flag as an emergency kill switch (master spec §119) if
  the provider misbehaves.
- **Observability:** AI request volume, latency, error rate, and cost tracked and alerted
  (master spec §94, §117).
