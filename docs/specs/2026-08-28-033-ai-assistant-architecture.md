# Spec: AI Assistant Architecture

**File:** `docs/specs/2026-08-28-033-ai-assistant-architecture.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §80, §81, §94, §132.1, §132.3, §132.9, §132.10, §132.11, §132.17, §132.21, §133.7, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §7.1–7.2, [docs/workflow.md](../workflow.md)

> **Repository shape.** This repository is a **single Next.js application**, not a monorepo. There
> is no `packages/ai`, `packages/types`, `packages/ui`, `apps/api`, `apps/web` or `apps/web-e2e`.
> The architecture document's `packages/ai` is realised here as **`lib/ai/`**; shared DTOs live in
> `lib/types/`, HTTP routes in `app/api/v1/**/route.ts`, design-system primitives in `ui/` behind
> the `@/components` barrel, and end-to-end tests in `e2e/`. Every path in this spec is a real
> path in this repository.

---

## 1. Problem statement

**Today:** `lib/ai/` exists but holds exactly one module — `lib/ai/intent-interpreter.ts`, a
deterministic rule-based sandbox that spec 013's `POST /api/v1/search/interpret` calls. Its own
header says the abstraction spec 033 owes it does not exist yet. There is no provider adapter
boundary, no configuration-driven provider selection, no usage accounting, no quota, no caching,
no abuse signalling and no admin visibility. The `ai` rate-limit domain is declared in
`lib/api/rate-limit.ts` (20 requests / 60 s) but no route uses it. Master spec §80 requires one
primary provider behind an internal abstraction with no business logic bound to a vendor; §94
requires usage limits, token/time limits, rate limits, safe caching, admin monitoring, cost
alerts and abuse detection.

**Who is affected:** Every AI-touching feature — spec 013's search interpretation, spec 011's
FAQ drafting, spec 034's conversational assistant, specs 035/036's MCP tools, spec 038's
fraud-signal assist — plus Finance and Platform, who own AI spend.

**Why it matters now:** It is the foundation those specs are written against. Sequencing it here
(after the domain modules it will orchestrate exist, before the conversational assistant) follows
`docs/workflow.md`'s dependency notes.

**Success looks like:** `lib/ai/` wraps a single configured AI provider behind a stable internal
interface. Swapping providers is an environment-variable change, not a code change. Every AI call
is rate-limited, quota-capped, cost-accounted and monitored; AI failure or capping degrades the
consuming feature instead of breaking the transactional workflow underneath it. No prompt or
response text is ever persisted, and no customer ever learns which provider answered them.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any module that needs an AI completion **When** it makes the call **Then** it goes through `lib/ai`'s `completeAi()` entry point; only files under `lib/ai/provider/` may import a vendor SDK or read an AI credential, and no module outside `lib/ai/` may reference a provider adapter, a provider name or a model name |
| AC-2 | **Given** the configured provider **When** `AI_PROVIDER` is changed to another registered adapter **Then** no consuming module's code changes; an unknown `AI_PROVIDER` value throws instead of falling back, and a sandbox adapter throws under `NODE_ENV=production` rather than silently serving fake completions |
| AC-3 | **Given** a subject (user, guest or system caller) **When** its request rate, per-request token cap, or rolling-24 h request/token quota is exceeded **Then** `completeAi()` rejects with `AI_RATE_LIMITED` or `AI_QUOTA_EXCEEDED`, and every consuming workflow degrades to its documented non-AI path (manual search still works, a request can still be created by form) rather than failing |
| AC-4 | **Given** a task declared cacheable and an input that normalises to one already answered **When** the cached entry is within its TTL and was produced by the same provider, model and prompt version **Then** the cached output is returned with `cached: true`, no provider call is made, and no non-cacheable (personalised or user-scoped) task is ever served from cache |
| AC-5 | **Given** a subject whose usage crosses one of the four deterministic abuse thresholds **When** the hourly evaluation runs **Then** a `security_events` row of type `ai.abuse_signal` is written for human review, at most once per subject per signal per UTC day, and nothing about the subject's access is automatically changed |
| AC-6 | **Given** an admin holding the `ai:read_usage` permission **When** they open `GET /api/v1/admin/ai/usage` or `/admin/settings/ai-usage` **Then** they see aggregate request/token/cost figures broken down by task, provider and outcome, containing no prompt text, no response text and no per-user identifiers; and a configured cost threshold being crossed emits an `ai.cost_alert` event at most once per period |

---

## 3. API contract

### 3.1 Module layout (`lib/ai/`)

| Path | Responsibility |
|---|---|
| `lib/ai/types.ts` | `AiTask`, `AiCompletionRequest`, `AiCompletionResult`, `AiSubject` |
| `lib/ai/errors.ts` | `AiRateLimitedError`, `AiQuotaExceededError`, `AiUnavailableError`, `AiProviderConfigurationError` |
| `lib/ai/config.ts` | every env-backed knob in §3.6, read fresh per call |
| `lib/ai/feature-flags.ts` | `isAiAssistantEnabled()` — the `ai-assistant` flag (§9) |
| `lib/ai/provider/types.ts` | `AiProviderAdapter` — the **only** vendor-facing interface |
| `lib/ai/provider/sandbox.ts` | the deterministic sandbox adapter (`isSandbox: true`) |
| `lib/ai/provider/index.ts` | `resolveAiProvider()` — configuration-driven selection |
| `lib/ai/cache.ts` | cache-key derivation and the in-process TTL store |
| `lib/ai/usage.ts` | usage accounting, quota reads, the admin summary query, retention sweep |
| `lib/ai/abuse.ts` | the four deterministic signals and their evaluation |
| `lib/ai/cost.ts` | cost estimation and cost-alert evaluation |
| `lib/ai/complete.ts` | `completeAi()` — the single entry point every consumer uses |
| `lib/ai/permissions.ts` | `requireAiUsagePermission()` — the `ai:read_usage` gate (§4) |
| `lib/ai/index.ts` | the barrel consumers import from; it deliberately re-exports no adapter |
| `lib/ai/intent-interpreter.ts` | **existing, spec 013's**; refactored to call `completeAi()` (§3.10) |

`lib/ai` is an internal library. Its only HTTP surface is the admin read below.

### 3.2 Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/ai/usage` | admin holding `ai:read_usage` | `200` `ApiResponse<AiUsageSummaryDto>` | aggregate only; optional `from`/`to` ISO dates, default the last 30 days, maximum span 366 days |
| `GET` | `/api/v1/cron/ai-usage-sweep` | `CRON_SECRET` bearer | `200` | hourly: retention deletion, abuse evaluation, cost-alert evaluation |

Both follow the existing conventions: `withApiRoute` + `apiSuccess` (`lib/api/handler.ts`,
`lib/api/response.ts`) for the admin read, and the `CRON_SECRET` bearer check used by
`app/api/v1/cron/account-deletion-sweep/route.ts` for the sweep, with its `vercel.json` entry on
an hourly schedule. The admin read is registered in `lib/api/openapi-registry.ts` under the `ai`
tag, as `scripts/check-openapi-drift.ts` requires; the cron route is deliberately absent, because
that check excludes everything under `app/api/v1/cron` — scheduled-job triggers are platform
infrastructure with their own bearer-secret auth, not public REST surface, exactly as every
existing cron route is treated.

### 3.3 Internal interface

```typescript
// lib/ai/types.ts
/** Master spec §80.2's task list, minus voice transcription (no transcription provider exists —
 * spec 013 already receives voice as text). The union is the routing seam: MVP resolves every
 * task to the one configured provider, and later task-based routing is a change to
 * `resolveAiProvider` alone. */
export type AiTask = 'search_intent' | 'faq_draft' | 'conversation' | 'summarization' | 'translation';

/** Who the call is attributed to, for rate limiting, quota and abuse accounting. A `guest`
 * carries the existing `hashRequestIp()` digest (lib/auth/ip-hash.ts), never a raw IP. */
export type AiSubject =
  | { kind: 'user'; userId: string }
  | { kind: 'guest'; ipHash: string }
  | { kind: 'system'; label: string };

export interface AiCompletionRequest {
  task: AiTask;
  input: string;
  subject: AiSubject;
  /** Clamped down to `AI_MAX_TOKENS_PER_REQUEST`; never up. */
  maxTokens?: number;
}

export interface AiCompletionResult {
  output: string;
  tokensUsed: number;
  cached: boolean;
}
```

`AiCompletionResult` deliberately carries **no** `provider` or `model` field. The vendor identity
never leaves `lib/ai`, so no consumer can accidentally serialise it to a customer (master spec
§132.1/§132.12); it is recorded in `ai_usage_events` and surfaced only to admins through
`AiUsageSummaryDto`.

```typescript
// lib/ai/provider/types.ts — the ONLY vendor-facing interface in the repository.
export interface AiProviderAdapter {
  /** Stable internal identifier, e.g. 'sandbox'. Recorded in usage, never returned to a caller. */
  readonly name: string;
  /** The model this adapter is configured to use, recorded alongside `name`. */
  readonly model: string;
  /** True for any adapter that does not reach a real provider. `resolveAiProvider` refuses these
   * under NODE_ENV=production (AC-2), the same guard as lib/notifications/channels/index.ts. */
  readonly isSandbox: boolean;
  /** The prompt template version this adapter implements. Part of the cache key, so a prompt
   * change can never be answered from a cache built by the previous prompt. */
  readonly promptVersion: string;
  complete(input: { task: AiTask; input: string; maxTokens: number }): Promise<{ output: string; tokensUsed: number }>;
}
```

### 3.4 Provider registration and selection

`lib/ai/provider/index.ts` holds a `PROVIDERS: Record<string, () => AiProviderAdapter>` registry —
the same shape as `lib/notifications/channels/index.ts` and `lib/payments/provider/index.ts`,
copied rather than shared, as those two already are. `resolveAiProvider()`:

1. reads `process.env.AI_PROVIDER`, defaulting to `sandbox`;
2. throws `AiProviderConfigurationError` if that name is not registered — **no silent fallback**,
   so a typo cannot quietly change which provider answers;
3. throws `AiProviderConfigurationError` if the resolved adapter reports `isSandbox` while
   `NODE_ENV === 'production'` — **production can never serve mock completions** (master spec
   §132.21);
4. resolves fresh on every call, never caching the adapter, so whichever call warmed a cache
   cannot bypass step 3.

Adding a real provider is one new file under `lib/ai/provider/` plus one registry line. No
consumer changes, which is exactly what AC-2 asserts.

### 3.5 Call flow and error behaviour

`completeAi(request)` performs these steps in this fixed order. Each step's failure mode is part
of the contract.

1. **Flag** — `isAiAssistantEnabled()` false → throw `AiUnavailableError` (`AI_PROVIDER_UNAVAILABLE`, 503).
2. **Provider resolution** — `resolveAiProvider()` (§3.4). Its `AiProviderConfigurationError` is
   **not** catchable as a degradation signal (§3.8): a misconfigured deployment must be loud.
3. **Rate limit** — `checkRateLimit('ai', subjectKey)` (the existing in-process fixed-window
   limiter, `lib/api/rate-limit.ts`, `ai` = 20 requests / 60 s). Rejected → record a `rejected`
   usage event (de-duplicated, below) and throw `AiRateLimitedError` carrying `retryAfterSeconds`.
4. **Quota** — the rolling 24 h request and token counts for this subject, read from
   `ai_usage_events`. Over either → `rejected` usage event + `AiQuotaExceededError`.
5. **Cache** — for a cacheable task only (§3.7), look the key up. Hit → record a `succeeded`
   event with `cached = true`, `tokens_used = 0`, and return immediately.
6. **Provider call** — `adapter.complete(...)` with `maxTokens` clamped to
   `AI_MAX_TOKENS_PER_REQUEST`, under an `AI_REQUEST_TIMEOUT_MS` timeout. A throw or timeout →
   record a `failed` event and throw `AiUnavailableError`.
7. **Store and account** — populate the cache for a cacheable task, record a `succeeded` event
   with the real token count and latency, return `AiCompletionResult`.

A rejection at step 3 or 4 writes at most **one** `rejected` row per subject per rate-limit window,
de-duplicated in process the same way the limiter itself keeps its windows. Without that bound a
caller being rate-limited could still drive one database write per attempt.

### 3.6 Error codes

| HTTP | `code` | When |
|---|---|---|
| `429` | `AI_RATE_LIMITED` | the `ai` rate-limit window is exhausted for this subject; `retryAfterSeconds` set |
| `429` | `AI_QUOTA_EXCEEDED` | the rolling-24 h request or token quota is exhausted for this subject |
| `503` | `AI_PROVIDER_UNAVAILABLE` | the `ai-assistant` flag is off, or the provider failed or timed out |

Added to spec 004's taxonomy by the rule every domain spec follows: new SCREAMING_SNAKE_CASE
codes, never a repurposed existing one, passed with an explicit `status` through `ApiRouteError`
since they are not in the baseline `API_ERROR_CODES` map. `AiProviderConfigurationError` is
deliberately **not** an `ApiRouteError` — it surfaces as spec 004's generic `INTERNAL_ERROR` 500
plus a stderr log, because it means the deployment itself is wrong.

### 3.7 Configuration

Every knob is an environment variable read fresh per call through `lib/ai/config.ts`, kept in
parity with `.env.example` by `npm run check:env`. These are operational limits, not feature
flags; spec 041 may later move the *flag* into its registry without changing these.

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `sandbox` | selects the registered adapter; an unknown value throws |
| `AI_ASSISTANT_ENABLED` | `true` | the `ai-assistant` kill switch (`false` disables all AI) |
| `AI_REQUEST_TIMEOUT_MS` | `15000` | master spec §94 "time limits" |
| `AI_MAX_TOKENS_PER_REQUEST` | `2000` | per-call ceiling; a caller's `maxTokens` is clamped down to it |
| `AI_MAX_REQUESTS_PER_DAY` | `200` | rolling 24 h, per authenticated user |
| `AI_MAX_TOKENS_PER_DAY` | `100000` | rolling 24 h, per authenticated user; cached hits cost 0 |
| `AI_GUEST_MAX_REQUESTS_PER_DAY` | `40` | rolling 24 h, per guest IP hash |
| `AI_GUEST_MAX_TOKENS_PER_DAY` | `20000` | rolling 24 h, per guest IP hash |
| `AI_CACHE_TTL_SECONDS` | `3600` | cache entry lifetime |
| `AI_CACHE_MAX_ENTRIES` | `1000` | LRU bound on the in-process cache |
| `AI_COST_PER_1K_TOKENS_MINOR_UNITS` | `0` | cost model; `0` until a real provider and its price are known |
| `AI_COST_CURRENCY_CODE` | `PKR` | currency for every cost figure and threshold |
| `AI_DAILY_COST_ALERT_MINOR_UNITS` | `500000` | Rs. 5,000 per UTC day |
| `AI_MONTHLY_COST_ALERT_MINOR_UNITS` | `10000000` | Rs. 100,000 per calendar month |
| `AI_DAILY_TOKEN_ALERT` | `500000` | token-volume alert, meaningful while the cost rate is `0` |
| `AI_ABUSE_REQUESTS_PER_HOUR` | `120` | signal S1 threshold |
| `AI_ABUSE_REJECTIONS_PER_DAY` | `20` | signal S2 threshold |
| `AI_ABUSE_IDENTICAL_INPUTS_PER_HOUR` | `50` | signal S3 threshold |
| `AI_USAGE_RETENTION_DAYS` | `90` | `ai_usage_events` retention (§4) |

A `system` subject is not quota-capped (it has no end user to protect against and no route to
abuse), but it is rate-limited, accounted and cost-monitored exactly like any other subject.

An unset or malformed numeric value falls back to the documented default rather than failing a
request — the same posture as `lib/notifications/config.ts`. `AI_PROVIDER` is the one exception:
a *wrong* name throws, because silently serving a different provider than the operator configured
is the failure mode master spec §132.21 forbids.

`AI_PROVIDER` is an adapter **name**, not a credential. Any credential a real adapter needs is
read only inside `lib/ai/provider/`, under names matching `AI_*_KEY`, `AI_*_SECRET` or
`AI_*_TOKEN`; the boundary test in §6 fails if any other module reads one.

### 3.8 Caching

**Cacheable tasks.** Exactly one for MVP: `search_intent`. It is a pure function of public,
non-personalised free text, it is the highest-volume AI path in the product, and its output
contains nothing user-specific. `faq_draft`, `conversation`, `summarization` and `translation`
are **not** cacheable: the first two are admin- or user-scoped and personalised, and the latter
two have no MVP consumer to tune a cache for. A task joins `CACHEABLE_TASKS` only once its output
is proven to depend on nothing but `input`.

**Key.** `sha256(providerName + US + model + US + promptVersion + US + task + US + normalise(input))`
in hex, where `US` is the unit-separator `\x1f`. `normalise` = Unicode NFKC, trim, collapse
internal whitespace runs to a single space, lowercase.

The key contains **no** subject identifier, by construction: a cacheable task is one whose output
does not depend on the subject, so including one would only fragment the cache. Because
non-cacheable tasks are never looked up or stored at all, one user can never be served another
user's personalised output. Provider, model and prompt version are in the key, so changing any of
them strands the previous entries rather than reusing them across a boundary where they are no
longer valid.

**Store and invalidation.** An in-process LRU map bounded by `AI_CACHE_MAX_ENTRIES`, entries
expiring `AI_CACHE_TTL_SECONDS` after they are written. That is the same single-process posture as
the existing rate limiter, appropriate for the same reason and with the same caveat (§8 risk 4).
There is no explicit invalidation API and no persistence: entries expire, are evicted by the LRU
bound, or die with the process. Nothing cacheable is written to the database or to disk, so **no
AI output exists at rest**.

**Accounting.** A cache hit is a real request: it consumes the rate-limit window and the daily
*request* quota, and is recorded as a usage event with `cached = true`. It consumes no tokens, so
it counts toward neither the daily *token* quota nor estimated cost.

### 3.9 Graceful degradation contract

`lib/ai` exposes `isAiDegradable(error)`, true for exactly `AiRateLimitedError`,
`AiQuotaExceededError` and `AiUnavailableError`. Consumers catch on that predicate and fall back
to their own documented non-AI path; nothing else is swallowed. The fallbacks that exist today:

| Consumer | Owner | Behaviour when AI is degraded |
|---|---|---|
| `POST /api/v1/search/interpret` | spec 013 | `interpretSearchQuery` yields an empty intent, which spec 013's route already surfaces as its documented low-confidence response; keyword search is untouched |
| Request creation, booking, payment, payout, messaging | specs 015/020/021/024/025 | never call AI at all — master spec §94's "do not break critical transactional workflows" holds structurally, and the §6 boundary test asserts those modules import nothing from `lib/ai` |

### 3.10 Preserved ownership

This spec owns the abstraction and the controls, and nothing else.

- **Spec 013 (search)** keeps every behaviour it shipped. `lib/ai/intent-interpreter.ts` keeps its
  exported `AiIntentInterpreter` / `RawSearchIntent` contract and its extraction rules unchanged;
  only its plumbing changes — the rule-based extraction moves verbatim into the sandbox adapter's
  `search_intent` handler, and `getIntentInterpreter()` obtains its completion through
  `completeAi({ task: 'search_intent' })`, returning `{}` when `isAiDegradable(error)`, so it
  still never throws for ordinary text. The existing `lib/ai/intent-interpreter.test.ts` must pass
  **unmodified**; that is the regression gate. Confidence scoring, the low-confidence fallback,
  the `search` rate-limit domain and the `search-nl-interpretation` flag all remain spec 013's.
- **Spec 011 (FAQs)** keeps its `ai_suggested` → `pending_review` → admin-published state machine
  and its approval endpoint. This spec ships the `faq_draft` task on the interface; it does **not**
  build the drafting job, and no AI-drafted FAQ ever becomes visible without the admin decision
  spec 011 already requires (master spec §132.9/§132.10).
- **Spec 034** owns conversational UX, conversation history, AI memory and autonomy tiers. This
  spec creates no `ai_conversations`, `ai_messages`, `ai_memories` or `ai_actions` rows and stores
  nothing that could serve as memory.
- **Specs 035/036** own MCP tool definition, execution, authorization and idempotency.
  `ai_tool_calls` already exists as a spec 003 baseline table keyed by `ai_action_id`; this spec
  neither creates, extends nor writes it (§8 risk 6).
- **Spec 038** owns moderation and enforcement. This spec only *writes* abuse signals for humans.
- **Spec 039** owns audit storage; this spec reuses `security_events`, the same interim
  arrangement `lib/admin-rbac/audit.ts` already documents.
- **Spec 040** owns analytics. Its `GET /api/v1/admin/analytics/ai-usage` reuses this spec's
  `AiUsageSummaryDto` and calls this spec's `getAiUsageSummary()`; it does not re-derive usage.
- **Spec 041** owns the flag registry. `ai-assistant` ships here as an environment variable and
  migrates to that registry without a contract change, exactly as `search-nl-interpretation` and
  `home-personalization-v1` already do.

### 3.11 Response type

```typescript
// lib/types/ai.ts
export interface AiUsageSummaryDto {
  from: string;                    // ISO-8601, inclusive
  to: string;                      // ISO-8601, exclusive
  totalRequests: number;           // every accounted attempt, including rejected and cached
  succeededRequests: number;
  rejectedRequests: number;
  failedRequests: number;
  cachedRequests: number;
  totalTokens: number;
  estimatedCostMinorUnits: number; // derived at read time (§3.7), never stored
  currencyCode: string;
  byTask: Record<AiTask, { requests: number; tokens: number }>;
  byProvider: Record<string, { requests: number; tokens: number }>;
  costAlertThresholds: { dailyMinorUnits: number; monthlyMinorUnits: number; dailyTokens: number };
}
```

### Breaking-change check

- [x] N/A — new spec. `lib/ai/intent-interpreter.ts`'s public contract is unchanged; every other
      file this spec adds is new.

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `ai_usage_events` | **new** | `id uuid pk`, `created_at`, `updated_at`, `version` (spec 003 `baseColumns()`), `task text not null`, `subject_kind text not null`, `user_id uuid null fk->users restrict`, `subject_hash text null`, `provider_name text not null`, `model_name text not null`, `outcome text not null`, `rejection_reason text null`, `tokens_used integer not null default 0`, `cached boolean not null default false`, `latency_ms integer null`, `input_fingerprint text null` |

Checks: `task` in the five `AiTask` values; `subject_kind` in `('user','guest','system')`;
`outcome` in `('succeeded','rejected','failed')`; `rejection_reason` in
`('rate_limited','quota_exceeded')` and non-null **iff** `outcome = 'rejected'`; `user_id`
non-null **iff** `subject_kind = 'user'`; `subject_hash` non-null **iff** `subject_kind = 'guest'`;
`tokens_used >= 0`; `latency_ms >= 0`; `tokens_used = 0` whenever `cached`. Indexes: `(user_id)`
(spec 003 AC-4 requires a covering index on every foreign key), `(created_at)`,
`(subject_kind, subject_hash, created_at)`, `(input_fingerprint, created_at)`.

No money columns. Cost is **derived at read time** from
`tokens_used × AI_COST_PER_1K_TOKENS_MINOR_UNITS`, never stored — so correcting the price
retroactively corrects history, and `npm run check:schema-money-lint` has nothing to police here.

**`ai_tool_calls` is not touched.** It is a spec 003 baseline table belonging to spec 035/036's
action lineage; this spec adds its own table rather than repurposing one that already has a
different owner and a different foreign key.

### Migration

- **Name:** `0025_add_ai_usage_tracking`, with a hand-written `0025_add_ai_usage_tracking_down.sql`
  per this repository's convention — the down file carries no `drizzle/meta/_journal.json` entry,
  so `npm run db:migrate` never applies it.
- **Contents:** creates `ai_usage_events` with its checks and indexes, and seeds this spec's own
  `permissions` rows — `('ai', 'read_usage', 'low')` for `analytics_admin`, `finance_admin` and
  `super_admin`, `ON CONFLICT DO NOTHING`, the idiom spec 025's migration established. `low` risk
  tier: audited and narrowly granted, but aggregate-only and read-only, so it needs no
  second-admin approval (spec 009 requires one at high/critical).
- **Reversible:** yes, with a guard. The down migration refuses to run while `ai_usage_events`
  holds any row (`RAISE EXCEPTION`, the idiom `0021_..._down.sql` established), then deletes only
  the `('ai','read_usage')` permission rows and drops only what `0025` created. It never touches
  `0001_baseline_schema.sql`, `ai_conversations`, `ai_messages`, `ai_memories`, `ai_actions`,
  `ai_tool_calls`, `security_events`, or any table another spec owns.
- **Backfill required:** no. **No usage row is ever seeded, generated or back-dated** — an
  `ai_usage_events` row exists only because a real call was accounted. Spec 045's demo seed data
  must not invent any, or the cost figures admins act on would be fiction.
- **Downtime:** none — one new table plus additive permission rows.
- **Reviewed SQL:** generated by `drizzle-kit`, checksum-pinned (`npm run check:schema-checksum`),
  reviewed in PR.

### Retention and privacy

`ai_usage_events` records **what kind of call happened, never what was said**. There is no prompt
column, no response column, and no configuration that adds one — the §6 boundary test fails if any
`lib/ai` module writes request or response text to a table or a log. This is stricter than the
draft's "full content logging, if enabled for debugging": there is no such switch, so there is no
retention or access policy to get wrong.

`input_fingerprint` is an HMAC-SHA256 of the normalised input keyed with the application's server
secret (`lib/auth/secret.ts`), stored hex. It exists solely so signal S3 can count identical
repeated inputs. It is keyed rather than plainly hashed so a short input cannot be recovered by
dictionary attack, and it is never returned by any endpoint, never exported and never shown to an
admin.

Rows are deleted after `AI_USAGE_RETENTION_DAYS` (90) by the hourly sweep. That window — not spec
008's anonymisation — is what removes the user linkage: the table holds no exportable personal
content, so spec 008's export and deletion flows need no change. That is a deliberate decision,
recorded in §8 risk 5.

**What an admin can see:** aggregates only. `AiUsageSummaryDto` carries counts, token totals,
derived cost and per-task/per-provider breakdowns for a date range. It carries no `userId`, no
`subject_hash`, no `input_fingerprint`, no prompt and no response. Identifying a specific abusive
subject is spec 038's job, done from the `ai.abuse_signal` events in `security_events`, under spec
039's audit rules — not from this endpoint. **What a customer can see:** nothing about the
provider. `provider_name` and `model_name` appear in no customer-facing response, ever.

---

## 5. UI states

One admin screen, composed entirely from existing design-system primitives.

**Route:** `app/admin/settings/ai-usage/page.tsx`
**Reached from:** one new entry in `app/admin/settings/page.tsx`'s existing `links` array —
`{ href: '/admin/settings/ai-usage', label: 'AI usage & cost' }`, the pattern spec 014's
`PlaceholderPage` already provides for `/admin/roles`. No new nav item and no new top-level route,
so the admin console's existing header stays the page's single brand placement. That one-line entry
is prepared in the working tree but ships with the earlier design-system work already in flight in
the same file, rather than being committed under this spec — the route itself is complete and
directly reachable, and the link is discoverability only.

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` blocks in the stat row and the table |
| **Empty** | `EmptyState` — "No AI usage recorded in this period". A real, expected state before AI traffic exists; never a fabricated figure |
| **Forbidden** | caller lacks `ai:read_usage` — `ErrorState` naming the missing permission, the same shape `app/admin/roles/page.tsx` uses |
| **Error** | `ErrorState` with retry |
| **Success** | a `StatBlock` row (total requests, total tokens, estimated cost, cache-hit rate) above a `Table` broken down by task and by provider, with rejected/failed counts as `Badge`s |

**Shared components used/added:** existing `Alert`, `Card`, `Table`, `Skeleton`, `EmptyState`,
`ErrorState`. `StatBlock` already exists at `ui/components/data/StatBlock` but is not yet
re-exported, so this spec adds the thin `components/StatBlock.tsx` re-export, exactly as
`components/Table.tsx` does, and imports it from that module directly rather than through the
`@/components` barrel — `components/index.ts` currently carries in-flight design-system work
belonging to earlier specs, and this spec does not touch a file it does not own. That is still the
app-facing layer, never `ui/` internals, so the design-system rule holds; the barrel re-export can
follow with that work. No new colour, size, radius, shadow or spacing value is introduced —
`app/styles/apuriva-tokens.css` and `app/admin/admin.module.css` cover the screen.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | provider selection and both refusals; cache key, normalisation, TTL, LRU; quota arithmetic; cost estimation; abuse thresholds; config defaults and malformed-value fallback; the `completeAi` step order | `lib/ai/provider/index.test.ts`, `lib/ai/cache.test.ts`, `lib/ai/config.test.ts`, `lib/ai/cost.test.ts`, `lib/ai/complete.test.ts` |
| **Source-level boundary** | AC-1 and the privacy invariants, in the idiom `lib/payments/no-fabricated-success.test.ts` established | `lib/ai/boundary.test.ts` |
| **Integration (DB)** | usage accounting rows; rolling-window quota rejection and its recorded event; abuse-signal emission and per-day de-duplication; cost-alert emission and de-duplication; retention sweep | `lib/ai/usage.integration.test.ts`, `lib/ai/quota.integration.test.ts`, `lib/ai/abuse.integration.test.ts`, `lib/ai/cost.integration.test.ts` |
| **Route** | admin usage endpoint — per-role permission gate, range validation, aggregate-only payload; cron sweep authorization | `app/api/v1/admin/ai/usage/route.integration.test.ts`, `app/api/v1/cron/ai-usage-sweep/route.integration.test.ts` |
| **Component** | the five admin screen states | `app/admin/settings/ai-usage/page.test.tsx` |
| **Regression** | spec 013's interpreter contract survives the refactor | `lib/ai/intent-interpreter.test.ts` (existing, unmodified) |
| **Static** | `npm run typecheck`, `npm run check:env`, `npm run check:schema-baseline`, `npm run check:openapi-drift` | CI |

`lib/ai/boundary.test.ts` asserts the following against comment-stripped source — comments in this
codebase describe the boundaries they respect, so matching raw file text would fail a correct file:

- no file outside `lib/ai/provider/` imports a vendor SDK or reads an `AI_*_KEY`, `AI_*_SECRET` or
  `AI_*_TOKEN`;
- no file outside `lib/ai/` imports `lib/ai/provider/**` or references `AiProviderAdapter`;
- no file outside `lib/ai/` reads `process.env.AI_PROVIDER`;
- `AiCompletionResult` declares no `provider`/`model` field, and no route under `app/api/v1/`
  except `app/api/v1/admin/ai/` serialises `providerName` or `modelName`;
- no `lib/ai` module inserts request or response text into any table, and none logs `input` or
  `output`;
- `lib/requests`, `lib/bookings`, `lib/payments`, `lib/payouts` and `lib/messaging` import nothing
  from `lib/ai` — the structural half of AC-3.

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/ai/boundary.test.ts::only lib/ai/provider may import a vendor SDK or read an AI credential`; `::no module outside lib/ai references a provider adapter or provider name` |
| AC-2 | `lib/ai/provider/index.test.ts::an unknown AI_PROVIDER throws instead of falling back`; `::a sandbox adapter is refused under NODE_ENV=production`; `::resolves fresh per call so no cached adapter bypasses the production guard`; `::every registered adapter satisfies the same AiProviderAdapter contract` |
| AC-3 | `lib/ai/complete.test.ts::rate limiting throws AI_RATE_LIMITED with retryAfterSeconds`; `::clamps maxTokens down to AI_MAX_TOKENS_PER_REQUEST`; `lib/ai/quota.integration.test.ts::rejects past the rolling 24h request quota`; `::rejects past the token quota`; `::records exactly one rejected event per window`; `lib/ai/intent-interpreter.test.ts` (degraded AI still yields an empty intent, never a throw); `lib/ai/boundary.test.ts::transactional modules import nothing from lib/ai` |
| AC-4 | `lib/ai/cache.test.ts::reuses a cacheable response within TTL`; `::normalises whitespace and case into one key`; `::a different provider, model or prompt version is a different key`; `::a non-cacheable task is never looked up or stored`; `::evicts past AI_CACHE_MAX_ENTRIES and expires past TTL`; `lib/ai/complete.test.ts::a cache hit consumes no tokens and records cached=true` |
| AC-5 | `lib/ai/abuse.integration.test.ts::flags S1 volume`; `::flags S2 rejection pressure`; `::flags S3 identical-input repetition`; `::flags S4 token burn`; `::emits at most one row per subject, signal and UTC day`; `::changes nothing about the subject's access` |
| AC-6 | `app/api/v1/admin/ai/usage/route.integration.test.ts::analytics, finance and super admin may read`; `::every other admin role is forbidden`; `::the payload contains no user identifier, fingerprint, prompt or response`; `::rejects a range longer than 366 days`; `lib/ai/cost.integration.test.ts::emits ai.cost_alert once per period past each threshold`; `app/admin/settings/ai-usage/page.test.tsx` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** the underlying model's output quality. This spec tests the
abstraction and the controls, not model performance — the sandbox adapter is deterministic
precisely so these tests assert control behaviour rather than prose.

---

## 7. Out of scope

- Task-based multi-model routing (master spec §80.2). The `AiTask` union and the
  `resolveAiProvider` seam make it a later change to one function; MVP resolves every task to the
  single configured provider.
- Voice transcription: no transcription provider exists and spec 013 already receives voice input
  as text, so `AiTask` deliberately omits it.
- Conversational assistant UX, conversation history, AI memory, autonomy tiers — spec 034.
- MCP tool definition, execution, authorization and idempotency — specs 035/036.
- Generating FAQ drafts, moderation verdicts or fraud scores — specs 011 and 038 own those
  workflows; this spec only provides the completion capability they will call.
- Prompt-injection defence for tool-calling contexts (architecture §7.5): it belongs with the
  specs that actually give the model tools (035/036). Every task here is text-in, text-out, with
  no tool surface to inject into.
- A shared multi-process cache or rate-limit store, and per-organisation billing — scaling
  concerns, deliberately matching the existing in-process posture of `lib/api/rate-limit.ts`.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | No real AI provider or credentials exist yet | Platform | **Resolved for MVP:** `AI_PROVIDER=sandbox` ships as the documented mock adapter (master spec §133.7). It is refused under `NODE_ENV=production`, so production cannot silently run on it; wiring a real provider is one new file under `lib/ai/provider/` plus a registry entry, and touches no consumer |
| 2 | Per-user limits and cost-alert thresholds were unquantified | Finance/Product | **Resolved for MVP:** the concrete defaults in §3.7, every one overridable by environment without a code change. Revisit once real traffic and a real price per 1k tokens exist |
| 3 | `AI_COST_PER_1K_TOKENS_MINOR_UNITS` defaults to `0`, so estimated cost reads `0` until a provider is priced | Finance | Accepted and visible: `AI_DAILY_TOKEN_ALERT` gives a meaningful alert meanwhile, and because cost is derived at read time, setting the real rate corrects history retroactively |
| 4 | The cache and the rate limiter are per-process, so those limits are per-instance on a multi-instance deploy | Platform | Accepted — identical to the posture `lib/api/rate-limit.ts` already ships. The 24 h quotas and every abuse signal read `ai_usage_events`, so those remain exact regardless of instance count |
| 5 | Spec 008's account anonymisation does not clear `ai_usage_events` | Privacy | **Deliberate:** the table holds no exportable personal content, and the 90-day retention sweep removes the linkage. Revisit only if a future spec adds anything content-bearing to it |
| 6 | Spec 036 §4 records `AIToolCall` as "stubbed spec 033" | Platform | **Reported, not edited:** `ai_tool_calls` is a spec 003 baseline table keyed by `ai_action_id`, so spec 036 extends spec 003's table directly. Spec 033 adds `ai_usage_events` instead and touches `ai_tool_calls` nowhere. Spec 036 is still Draft; correcting its wording belongs to its own review |
| 7 | "Flagged for abuse review" has no moderation queue to land in (spec 038 unbuilt) | Trust & Safety | **Resolved for MVP:** a flag is a `security_events` row, type `ai.abuse_signal`, severity `warning` — the same interim store `lib/admin-rbac/audit.ts` already uses. It triggers no automatic block, throttle, suspension or ban (master spec §132.11, §132.17). Spec 038 later reads these rows into its queue |

### Abuse signals — the deterministic MVP set

Evaluated hourly by the sweep over `ai_usage_events`. Each is a plain count against a configured
threshold, with no model involved, so any signal is reproducible from the table alone.

| # | Signal | Condition |
|---|---|---|
| S1 | `volume` | more than `AI_ABUSE_REQUESTS_PER_HOUR` events for one subject in the last hour |
| S2 | `rejection_pressure` | at least `AI_ABUSE_REJECTIONS_PER_DAY` `rejected` events for one subject in the last 24 h |
| S3 | `repetition` | at least `AI_ABUSE_IDENTICAL_INPUTS_PER_HOUR` events sharing one `input_fingerprint` for one subject in the last hour |
| S4 | `token_burn` | more than 80% of the subject's daily token quota consumed within the last hour |

Each writes one `security_events` row whose metadata carries the signal name, subject kind,
subject reference, window bounds, observed value and threshold — no prompt, no response, no
fingerprint. De-duplicated to one row per subject per signal per UTC day. A signal is an input to
a human review and nothing else: it never changes the subject's limits, access or status.

---

## 9. Rollout

- **Feature flag:** `ai-assistant`, default on, shipped as `AI_ASSISTANT_ENABLED` through
  `lib/ai/feature-flags.ts` until spec 041's registry exists. It is the platform-wide kill switch
  (master spec §119): turning it off makes every `completeAi()` call throw `AiUnavailableError`,
  which every consumer already degrades on. Each consuming feature keeps its own narrower flag —
  spec 013's `search-nl-interpretation` still disables search interpretation alone without
  disabling the platform.
- **Migration order:** `0025` ships with the code. It is purely additive, so the order is not
  delicate.
- **Rollback:** disable the flag first — that is the instant, non-destructive kill switch; then
  revert the deploy. **The down migration is a last resort and destroys usage history**: it
  refuses to run once any `ai_usage_events` row exists, so after real traffic the correct response
  to a defect is a forward fix. In every case rollback destroys no user data, because this spec
  stores none.
- **Observability:** request volume, latency, error rate, rejection rate, cache-hit rate and
  estimated cost are all derivable from `ai_usage_events` and surfaced on
  `/admin/settings/ai-usage`; `ai.cost_alert` and `ai.abuse_signal` land in `security_events`
  (master spec §94, §117).
