# Spec: MCP Tool Catalog, Idempotency & Errors

**File:** `docs/specs/2026-08-28-036-mcp-tool-catalog-idempotency-errors.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §85–§93, §115, §117, §127, §132.3, §132.6–§132.8, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §7.3, [docs/workflow.md](../workflow.md); specs 003, 008 (account deletion), 015–032 (the domain operations each tool wraps), 033 (AI platform), 034 (conversation surface and `AiActionExecutor` port), 035 (tool contract and authorization pipeline)

> **Review note (2026-09-24).** This draft was verified against the repository and against
> approved specs 020, 021, 033, 034 and 035, then finalized through three rounds of
> platform-owner decisions. APURIVA is a **single Next.js application**, not a monorepo: there is no
> `packages/mcp`, no `apps/api` and no `apps/web-e2e`. Every path below was checked against the
> tree. All decisions are recorded in §8. No open question remains in this document; what remains
> outside it is listed in §8 as **Dependencies**.
>
> **Implementation note (2026-09-24).** Implemented together with the required spec 034 amendment
> (spec 034 §3.4a). Five points the finalized draft did not settle were decided by the platform owner
> during implementation and are recorded as D-20 – D-24: the card rows, a rejected tool call, the
> follow-up failure, how spec 034 obtains the catalogue, and `get_offers` (deferred — its only
> domain read mutates). Registered tools: **ten**.

**Ownership, restated.** Spec 035 owns authorization (the eight-step pipeline, the confirmation
record and its binding). **This spec owns the tool catalogue and the tool execution contract**
(tools, idempotency keys, the outcome shape, error classification, retry, the `ai_tool_calls`
record). Spec 034 owns conversational orchestration (when tools run within a turn or a
confirmation, feeding outcomes to the model, and what the user is shown).

---

## 1. Problem statement

**Today:** Spec 035 shipped the tool contract (`lib/mcp/types.ts`), the eight-step authorization
pipeline (`lib/mcp/authorize.ts`) and the confirmation record (`mcp_confirmations` +
`mcp_confirmation_parameters`), and registered spec 034's `AiActionExecutor` port — but it
registers **no business tool**, so the assistant proposes nothing (master spec §132.8). Master spec
§127 lists the concrete read and action tools. §91 requires idempotency keys on every important
state-changing tool, with retries returning the original result. §92 requires structured backend
errors translated into natural language by the AI, never a claimed success without confirmed
backend success, and retrying only safely retryable errors.

Review also found that the port, as shipped, cannot carry a real tool call end to end:

- `lib/mcp/executor.ts` passes `rawInput: {}` to the pipeline, and the confirmation record stores
  only display strings, so a confirmed tool never receives its validated input;
- the executor hard-codes `activeMode: 'customer'`, so no provider-mode tool can ever run;
- the port's `execute` returns only `{ succeeded: boolean }`, and spec 034 persists the turn's reply
  before the action runs, so neither a tool's output nor a structured domain error can reach the
  model.

**Who is affected:** The AI assistant (spec 034) invoking tools on a user's behalf; every domain
module each tool wraps (specs 010–032).

**Why it matters now:** It is the concrete catalogue that makes spec 034's conversational actions
real, built last among the MCP specs because every tool calls an already-specified,
already-authorized domain operation.

**Success looks like:** Every §127 tool that can be carried safely today — its domain operation
exists, its risk tier is documented, and its confirmed input needs no free text — is registered in
a dedicated catalogue, runs only through spec 035's pipeline, is idempotent through a
server-generated key when it changes state, and returns its real output — or the domain's own
structured error, unchanged — so the model's reply is generated only from the confirmed backend
result. Nothing reports success the backend did not confirm. Every other §127 tool is mapped and
explicitly deferred.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** the tool catalogue **When** enumerated **Then** it registers exactly these ten tools — read: search_services, get_service, get_provider_availability, get_request, get_booking, get_provider_earnings, get_notifications; action: create_booking, cancel_booking, authorize_payment — and no other. The deferred tools of §7 (eight with an undocumented risk tier, two whose confirmed input would need free text, get_offers whose only domain read mutates, three capability gaps) are **not** registered |
| AC-2 | **Given** a state-changing tool **When** the same accepted tool intent is executed more than once (a replayed confirmation) **Then** every execution carries the same server-generated idempotency key, and the domain returns the original result without creating a duplicate side effect |
| AC-3 | **Given** `create_booking` specifically **When** executed repeatedly for one accepted intent **Then** exactly one booking exists — master spec §115's critical example, satisfied by spec 020's `bookings_customer_idempotency_key_uq` and `bookings_offer_id_uq` through this tool's wrapper |
| AC-4 | **Given** a domain operation that fails (e.g. `SLOT_NO_LONGER_AVAILABLE`, `OFFER_EXPIRED`) **When** its outcome is returned **Then** it carries the domain's original `code`, `message` and `details` unchanged, is recorded as a failure, and is what the conversation model receives — so the model's reply is generated from the confirmed backend result and never reports a success (master spec §92, §132.7, §132.8) |
| AC-5 | **Given** a read tool **When** called **Then** it never mutates state and is issued no idempotency key |
| AC-6 | **Given** any failure **When** encountered **Then** it is not retried automatically unless it is an explicitly classified transient infrastructure failure, and then at most once under the same key. No such classification is established by the repository or any spec (§3 "Retry policy"), so **no automatic retry occurs**. Domain/business errors, spec 035 pipeline errors and `MCP_IDEMPOTENCY_KEY_REQUIRED` are never retried automatically |
| AC-7 | **Given** a medium/high-risk tool **When** the user confirms it **Then** the tool executes with the exact input the server validated when the confirmation was issued, restored from the safe normalized binding values stored in spec 035's `mcp_confirmation_parameters` — never input re-supplied by the model or the client at confirmation time — and no free text, attachment ID or nested payload is ever written to that record |
| AC-8 | **Given** any tool call **When** authorized **Then** the pipeline's `activeMode` is the caller's current `sessions.active_mode`, resolved server-side — never a hard-coded mode and never a value from tool input |
| AC-9 | **Given** a tool call **When** persisted to `ai_tool_calls` **Then** `input_params`/`output_summary` hold only the minimal redacted structure of §4 — no free-text content, no contact data, no payment-provider data |
| AC-10 | **Given** a user's account deletion **When** the deletion flow runs **Then** every `ai_tool_calls` row belonging to that user's actions is removed; none survives the deletion |
| AC-11 | **Given** a user's AI data export **When** generated **Then** it includes that user's `ai_tool_calls` rows in the same minimal redacted structure of §4, and nothing more |

---

## 3. API contract

No new HTTP route. Tools are invoked **in-process** through spec 034's `AiActionExecutor` port,
exactly as spec 035 §3 decided — no MCP SDK, no transport, no new dependency.

### Module boundary

| Location | Owner | Holds |
|---|---|---|
| `lib/mcp/**` | spec 035 | tool contract, registries, eight-step pipeline, confirmation record, executor port implementation |
| **`lib/mcp-tools/**`** | **this spec** | the tool catalogue (one small file per tool), the model-facing catalogue metadata, idempotency-key issue, the `ai_tool_calls` recorder, error classification and retry policy |

The catalogue lives outside `lib/mcp` deliberately: spec 035's `lib/mcp/boundary.test.ts` asserts
that no `lib/mcp/**` file calls `registerMcpTool(`, references `ai_tool_calls`, or calls
`tool.execute(` outside `authorize.ts`. This spec keeps all three true. Tools are registered from
`instrumentation.ts`, the registration point specs 021, 027, 030, 034 and 035 already use.

### Tool contract

Every tool is a spec 035 `McpToolDefinition` (`lib/mcp/types.ts`), used as shipped:

```typescript
// lib/mcp-tools/tools/create-booking.ts
export const createBookingTool: McpToolDefinition<CreateBookingToolInput, BookingDto> = {
  name: 'create_booking',
  riskTier: 'high',                 // master spec §87: Booking
  label: 'Book a service',          // plain language, master spec §85
  reversible: false,                // no reversal is declared (spec 034 §3.8)
  adminOnly: false,
  modes: ['customer'],              // POST /api/v1/bookings: requireActiveMode(session, 'customer')
  requiresConfirmation: true,       // must equal requiresConfirmation('high') — enforced at registration
  isIdempotent: true,
  // Hand-written, strict (lib/mcp/validation.ts): exactly { offerId, scheduledAt? }.
  // No idempotencyKey field — the key is server-generated (§3 "Idempotency").
  validate: (raw) => { /* requireExactFields(raw, ['offerId', 'scheduledAt']) … */ },
  checkOwnership: /* delegates to spec 020's own customer/offer query */,
  execute: async (input, context) => {
    // lib/bookings/create.ts createBooking(context.userId, <server key>, input) — spec 020.
    // Returns the BookingDto; a thrown ApiRouteError propagates unchanged.
  },
};
```

`validate` uses spec 035's helpers (`requireExactFields`, `requireUuid`, `requireString`,
`requireEnum`, `requireIntegerMinorUnits`); this repository has no schema library. `execute`
returns the tool's output directly (spec 035's shipped shape), not an `McpToolResult`. `execute`
calls the **domain function**, never an HTTP route: each route is a thin wrapper, so the tool
inherits every guarantee (spec 015 AC-6, spec 020 §3 "MCP implications", spec 019 §7).

### Registered catalogue

Modes are those the existing route enforces for the same operation.

| Tool | Tier | Tool input (strict) | Domain operation (owning spec) | Modes | Domain idempotency |
|---|---|---|---|---|---|
| search_services | low | as `searchServices`' parameters | `lib/search/query.ts` `searchServices` (013) | customer, provider | n/a (read) |
| get_service | low | `{ serviceId }` | `lib/catalog/services.ts` `getServicePublic` (010) | customer, provider | n/a (read) |
| get_provider_availability | low | `{ providerProfileId }` | `lib/availability/summary.ts` `getAvailabilitySummary` (016) | customer, provider | n/a (read) |
| get_request | low | `{ requestId }` | `lib/requests/read.ts` `getRequestForOwner` (015) in customer mode; `lib/matching/provider-requests.ts` `getIncomingRequest` (017) in provider mode | customer, provider | n/a (read) |
| get_booking | low | `{ bookingId }` | `lib/bookings/read.ts` `requireBookingParticipant` + `loadBookingDto` (020) | customer, provider | n/a (read) |
| get_provider_earnings | low | as `earningsSummary`' parameters | `lib/payouts/read.ts` `earningsSummary` (024) | provider | n/a (read) |
| get_notifications | low | as `listNotifications`' parameters | `lib/notifications/inbox.ts` `listNotifications` (026) | customer, provider | n/a (read) |
| create_booking | high | `{ offerId, scheduledAt? }` | `lib/bookings/create.ts` `createBooking` (020) | customer | key; `bookings_customer_idempotency_key_uq`, `bookings_offer_id_uq` |
| cancel_booking | high | `{ bookingId }` | `lib/cancellation/cancel.ts` `cancelBookingAsParticipant` (023) | customer, provider | key |
| authorize_payment | high | `{ bookingId }` | `lib/payments/authorize.ts` `authorizePayment` (021) | customer | key, forwarded to the payment adapter; `payments_booking_id_uq` |

- **`create_booking`** takes exactly what spec 020's `createBooking` accepts from a caller besides
  the key — `offerId` and optional `scheduledAt` (spec 020 records this requirement for this spec:
  `scheduledAt` is how a retry with one of AC-2's returned alternatives is expressed).
- **`cancel_booking`** takes `{ bookingId }` only. Spec 023's `CancelBookingRequest` also has an
  optional free-text `note` and an optional `reasonCode`; neither is accepted by this tool and its
  `validate` rejects both. `note` is free text. `reasonCode` is described in
  `lib/types/cancellation.ts` as "from a closed list", but no such list exists in the repository —
  the route validates it only as a length-bounded string — so from the model it would be
  unconstrained text. The domain call passes no body, exactly as a cancellation submitted without a
  reason or note does.
- **Read-tool inputs** are the existing domain function's own parameters (IDs, filters, paging),
  validated strictly; the exact field lists are those functions' signatures.
- **`authorize_payment`**'s result is the `PaymentDto` spec 021's `authorizePayment` returns,
  read back from persisted, adapter-confirmed state through `lib/payments/read.ts` (spec 021 AC-8).
  A `requires_action` or `failed` payment is reported as exactly that, never as success (§132.7).
  `PaymentProviderUnavailable` becomes spec 021's own `paymentProviderUnavailableError`, exactly
  as the payment route's `withProviderGuard` maps it.
- **Output summaries** (`ai_tool_calls.output_summary`) record only a resource's type, id and
  status: a booking, payment, service or request; a provider's availability state; a cancellation
  record with no status of its own. A search, earnings or notification read has no single resource
  and records `null`. A provider's `get_request` view has no request status, so it records `null`
  rather than one inferred. Every tool declares `reversible: false`: no reversal is declared
  (spec 034 §3.8).

### Risk tiers

Tiers use spec 034's `AiProposedRiskTier`, and `requiresConfirmation` must equal spec 034's
`requiresConfirmation(tier)` (enforced by spec 035's registry). Only tiers the master specification
documents are assigned (§87); spec 035 assigns no per-tool tier.

| Tier | Tools | Source |
|---|---|---|
| low | all seven registered read tools (and the deferred `get_offers`) | §87 Low: "Search … Read information" |
| medium | send_provider_message, create_service_request — **documented, but both deferred** (§7) | §87 Medium: "Send message", "Create draft/request" |
| high | create_booking, cancel_booking, authorize_payment | §87 High: "Booking", "Payment", "Cancellation" |
| undocumented | send_offer, accept_offer, request_offer_change, mark_provider_arrived, start_service, complete_service, create_support_ticket, submit_review | **no tier is assigned; deferred and not registered** (§7) |

### Model-facing catalogue and the tool-call envelope

This spec owns the catalogue and its metadata; spec 034 consumes it for orchestration. No separate
prompt system is introduced — the existing architecture already carries structured data to the
model: spec 034 sends the `conversation` task a JSON `input` (`{ memory, turns }`) through spec
033's `completeAi`.

- `lib/mcp-tools` exports the model-facing catalogue: for each **registered user-registry** tool its
  `name`, plain-language `label` and the names and value kinds of its accepted input fields. It
  exposes no `validate`, `execute`, ownership logic, deferred tool or admin tool. Spec 034 adds it
  to the `conversation` input as data.
- The model requests a tool with an optional `toolCall: { name: string, input: object }` member of
  spec 034's existing reply envelope. Spec 034's `parseReplyEnvelope` reads only `reply` and
  `memoryProposal`, so the member does not alter reply parsing. The executor's `interpretTurn`
  (spec 035 §3 left the wire shape to this spec) reads it, looks the name up in the **user**
  registry only, and runs the tool's `validate` before anything else. At most one tool call per turn
  (spec 034 §3.4).
- Everything in `toolCall` is untrusted data (master spec §93, spec 035 AC-4). An `idempotencyKey`,
  identity field or unknown field in `input` is rejected by `validate`.

### Execution contract — changes to specs 034 and 035 (decided in review)

1. **Validated input travels through spec 035's existing confirmation-parameter record, which
   remains the source of truth.** `interpretTurn` validates `toolCall.input` with the tool's
   `validate`, and `AiProposedAction` carries the validated input server-side (never copied into a
   client DTO). For a medium/high proposal, the confirmation record is created with two kinds of
   `mcp_confirmation_parameters` rows — **no new table, no new column, no JSONB**:
   - **display rows** — the plain-language parameters the user sees on the confirmation card
     (master spec §85, §90), exactly as spec 035 stores them today;
   - **binding rows** — one per validated input field, `label` = the tool's input field name,
     `value` = the string form of the value `validate` returned.

   Binding rows may hold **only safe normalized values required to bind the confirmed intent**: IDs
   of the resource being acted on, enum values, integer minor-unit amounts with currency codes,
   timestamps and booleans. They **never** hold raw free text, attachment IDs or nested payloads —
   which is why every tool that would need one is deferred (§7), and why `cancel_booking` accepts
   neither `note` nor `reasonCode`.

   Spec 034 builds the user's card from the proposal's display parameters only, so binding rows are
   never shown and no raw ID reaches the client. `lib/mcp-tools` rejects at registration any
   confirmable tool whose input field name equals one of its display labels, or that declares a
   field of a non-safe kind, keeping the two kinds unambiguous within spec 035's unique
   `(confirmation, label)` rows. `resolveConfirmation` restores the input from the binding rows by
   the tool's field names; the pipeline runs the tool's `validate` on it again and `execute` runs
   exactly what was confirmed (AC-7). Nothing supplied at confirmation time — by the model or the
   client — can alter it.

   **Display rows are re-derived from LIVE data** (D-20: master spec §90's Service, Provider,
   Date/time and Price — Price formatted with its currency by the existing `formatMinorUnits` —
   without Location; a value the domain does not hold is left off, never invented). They are
   re-derived when the confirmation is resolved and again at execution. So a price or slot that moved
   since the card was shown no longer matches the stored rows under spec 035's `bindingMatches`, and
   the result is `MCP_CONFIRMATION_STALE`. At resolution this happens before spec 034 records anything.
   An expired or already-used binding is stale too.
2. **Active mode is resolved server-side.** `lib/mcp/executor.ts` gains
   `resolveSessionActiveMode`/`mcpAuthContextFor`, which read the caller's current
   `sessions.active_mode` for the session identified by `AiActionContext.sessionId` (unrevoked, not
   expired, this user's) and pass it as `McpAuthContext.activeMode` (AC-8). The hard-coded
   `'customer'` is removed. A session that no longer resolves yields an empty session id, so the
   pipeline refuses at step 1. `isAdmin` stays `false` on the user surface (spec 035 AC-5).

   **Placement.** The catalogue's executor is `lib/mcp-tools/executor.ts`, registered from
   `instrumentation.ts` right after spec 035's `registerMcpIntegration()`, whose place it takes.
   It has to live outside `lib/mcp`, because it writes `ai_tool_calls`, which spec 035's boundary
   test forbids there. It reaches a tool only through `authorizeAndExecute`. Spec 035's code
   changes minimally, and only for compatibility:
   - its executor conforms to the amended port and uses the session mode;
   - `McpAuthContext` gains an optional `idempotencyKey`, the one channel for the server-issued key;
   - `lib/mcp/index.ts` exports the mode helpers and two of its existing error factories.
3. **The port returns the real outcome (spec 034 port, this spec's contract).** `execute` returns:

   ```typescript
   type AiActionOutcome =
     | { status: 'succeeded'; data: unknown }
     | { status: 'failed';  error: { code: string; message: string; details?: Record<string, unknown>; retryable: false } }
     | { status: 'unknown'; error: { code: 'INTERNAL_ERROR'; message: string; retryable: false } };
   ```

   - `succeeded` — only when the domain function returned.
   - `failed` — a **confirmed** failure: a domain `ApiRouteError`, a spec 035 pipeline error, or
     `MCP_IDEMPOTENCY_KEY_REQUIRED`. Spec 034 records the `ai_actions` row as `failed`.
   - `unknown` — any other failure (an unexpected throw that is not a domain or pipeline answer).
     For a state-changing tool the effect may or may not have committed, so it is reported as
     exactly that. Spec 034 keeps the `ai_actions` row `pending` ("outcome unknown"), its existing
     meaning. `INTERNAL_ERROR` is spec 004's baseline code for an unexpected failure; no new code is
     introduced.

   No variant can be read as success except `succeeded` (§92, §132.8). `retryable` is `false` in
   every variant because no transient-failure classification exists (§3 "Retry policy").

### Spec 034 amendment (made — spec 034 §3.4a)

Spec 034 owns conversational orchestration, so the amendment lives in spec 034's own document
(§3.4a). It was implemented together with this spec. This spec required it to establish, at minimum:

- a **confirmed** medium/high action executes with the validated input restored from spec 035's
  record (execution contract 1);
- the `AiActionOutcome` (data or structured error) is returned **to the conversation model**, as
  data in the `conversation` input;
- the user-facing natural-language response about an action is generated by the model **only
  after, and only from, that outcome** — for a low-risk action within the turn, and for a confirmed
  action after `POST …/confirm` executes;
- no path renders a success the outcome does not state;
- spec 034's AI data export includes the user's `ai_tool_calls` rows in the §4 redacted structure
  (AC-11), since that export is spec 034's.

Spec 034 §3.4a specifies the concrete orchestration.
- **Catalogue.** The port gains `catalogFor(ctx)` (D-23). The catalogue enters a normal turn's
  input as `tools` only when non-empty.
- **Low-risk tool.** It runs *before* the turn is persisted, and a follow-up `conversation`
  completion with `toolResult` writes the reply. That completion is an ordinary `completeAi` call,
  so spec 033 accounts for it like any other.
- **Rejected tool call.** It is fed back to the model the same way: nothing runs, nothing is
  recorded (D-21).
- **Confirm response.** `POST …/confirm` returns `AiConfirmResultDto`: the recorded action plus an
  optional `message`, the reply written from the real outcome.
- **Follow-up unavailable (D-22).** A turn fails like any model failure, with nothing persisted.
  After a confirmed action there is simply no `message`, and the recorded result stands.

### Idempotency

- **Server-generated, one key per accepted tool intent.** An intent is *accepted* when spec 034
  executes its `ai_actions` row: immediately for a low-risk tool, or on
  `POST /ai/conversations/{id}/confirm` for medium/high. For a state-changing tool,
  `lib/mcp-tools` generates a random key server-side on the first execution for that `ai_actions`
  row and persists it on the `ai_tool_calls` row (§4). Any later execution for the same
  `ai_actions` row finds and reuses that key. Through the pipeline such a repeat is refused at
  step 6 (the confirmation was single-use) before the domain is reached. When the same key does
  reach the domain, the domain replays its original result. Either way, one booking or payment per
  intent. The key reaches a tool only through `McpAuthContext.idempotencyKey`.
- **Retries reuse it.** Were an automatic retry ever permitted (§3 "Retry policy" — none is today),
  it would create a new `ai_tool_calls` row with the **same** key and `retried_from_call_id` set to
  the first attempt, so the domain replays its original result. While no retry is permitted,
  `retried_from_call_id` is always null.
- **Replays do not re-execute.** A replayed `POST …/confirm` with the same HTTP `Idempotency-Key` is
  answered by spec 034 from the stored `ai_actions` row and never reaches the executor. The
  confirmation itself is single-use (spec 035).
- **The AI never supplies or controls the key.** No tool input accepts one; the model-facing
  catalogue does not mention one.
- **Domain fingerprints** for functions taking `{ key, fingerprint }` are computed from the
  validated input with `lib/api/idempotency.ts` `idempotencyFingerprint`, the same way the HTTP
  routes compute them. (None of the three registered action tools takes a fingerprint argument.)
- **Read tools** get no key (AC-5); `ai_tool_calls.idempotency_key` is null for them.
- **A state-changing tool is never invoked without a key.** The wrapper issues the key before
  `execute`; if a state-changing tool would be invoked without one, the call is refused with
  `MCP_IDEMPOTENCY_KEY_REQUIRED` (§3 "Errors") and the domain function is not called.

An intent whose outcome is `unknown` that the user starts again is a new intent with a new key. The
domain's own natural constraints (`bookings_offer_id_uq`, `payments_booking_id_uq`) still prevent a
duplicate booking or payment; the second attempt fails with the domain's conflict error rather than
replaying.

### Errors

A domain error passes through **unchanged**: its original `code`, `message` and `details` (e.g.
`SLOT_NO_LONGER_AVAILABLE` from spec 020 with its alternatives in `details`; `OFFER_EXPIRED` from
**spec 018**, `lib/offers/errors.ts`, `422`). Those details are where the concrete options of master
spec §92's example come from. Spec 035's pipeline codes (`MCP_AUTHORIZATION_FAILED`,
`MCP_TOOL_NOT_AVAILABLE_IN_CONTEXT`, `MCP_CONFIRMATION_STALE`, `MCP_SCHEMA_VALIDATION_FAILED`) also
pass through unchanged, keeping their non-disclosure rule.

The draft's `MCP_DOMAIN_ERROR` wrapper code is **removed**: replacing the domain code would hide it.
MCP classification is **additive** — the outcome's `status` and `retryable` — and never replaces
`code`, `message` or `details`.

| `code` | When | Outcome |
|---|---|---|
| *(the domain's own code, unchanged)* | a wrapped domain operation fails | `failed` |
| *(spec 035's codes, unchanged)* | a pipeline check fails | `failed` |
| `MCP_IDEMPOTENCY_KEY_REQUIRED` | a state-changing tool would be invoked without a server-issued key — the MCP-specific contract error, kept distinct from spec 004's `VALIDATION_ERROR` | `failed` |
| `INTERNAL_ERROR` (spec 004 baseline) | any other, unexpected failure | `unknown` |

`MCP_IDEMPOTENCY_KEY_REQUIRED` is carried as a structured outcome to spec 034, not emitted as an
HTTP response by this spec, so this spec assigns it no HTTP status. If spec 034's amendment ever
surfaces it over HTTP, the status is fixed there.

### Retry policy

- **The rule.** A failure may be retried automatically only if it is an explicitly classified
  transient infrastructure failure — never a domain or pipeline answer — and then **at most once**,
  under the same server-generated idempotency key.
- **The classification today.** Neither the repository nor any spec establishes a transient
  infrastructure failure classification: no module classifies database, connection or network
  failures. The classified set is therefore **empty, and no automatic retry is performed.** This spec
  does not invent one.
- **Never retried automatically:** any domain/business error (every `ApiRouteError` from a domain
  module), any spec 035 pipeline error, and `MCP_IDEMPOTENCY_KEY_REQUIRED`. This includes spec
  021's declined-payment error, whose `details.retryable: true` (`lib/payments/errors.ts`) is a
  domain signal that the *user* may try again; it is passed through unchanged in `details` and never
  triggers an automatic retry.
- **Never for a tool that needed confirmation.** Spec 035's confirmation is single-use, and the
  first attempt consumed it. A retry therefore could not pass step 6, and it would misreport an
  effect that may have committed. Such a failure stays `unknown`.
- A failure that is neither a domain nor a pipeline answer is reported as `unknown` (§3 execution
  contract 3), without a retry.
- **Implementation.** The classification lives in `lib/mcp-tools/transient-failures.ts`, which
  returns `false` for everything. The rule is `shouldRetry` in `lib/mcp-tools/retry-policy.ts`
  (`MAX_AUTOMATIC_RETRIES = 1`). Adding a member to the classification is a spec change.

### Breaking-change check

- [x] This spec adds no HTTP route. The spec 034 port and spec 035 executor/confirmation changes
      above are internal (in-process) and listed explicitly.
- [x] One additive response change, made by the spec 034 amendment: `POST …/confirm` returns
      `AiConfirmResultDto`, which is `AiActionDto` plus an optional `message`. Every existing field is
      unchanged, and the OpenAPI registry summary is updated.

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `ai_tool_calls` | **extend** — a **spec 003 baseline** table (`drizzle/0001_baseline_schema.sql`), not a spec 033 stub. Today it holds only `id`, `created_at`, `updated_at`, `version` and `ai_action_id uuid not null` (FK → `ai_actions`, `RESTRICT`, indexed) | `idempotency_key text null` (null for read tools), `input_params jsonb not null`, `output_summary jsonb null` (null until an outcome with a resource exists), `error_code text null`, `retried_from_call_id uuid null` (FK → `ai_tool_calls`, `RESTRICT`, indexed; always null while no retry is permitted) |
| `mcp_confirmation_parameters` (spec 035) | **reused, not altered** — additionally carries the binding rows of §3 execution contract 1 | none |

Exact constraint and index names follow spec 003's baseline conventions.

**jsonb registration.** Spec 003's `lib/db/schema-lint.test.ts` fails on any jsonb column not in its
reviewed allow-list. `ai_tool_calls.input_params` and `output_summary` need an allow-list entry —
an edit to another spec's test file, which requires explicit approval at implementation time
(**Dependency DEP-2**, §8).

No tool introduces a domain entity. Each wraps an existing domain operation and that domain's own
idempotency (spec 020 `bookings`, spec 021 `payments`, spec 023 cancellations).

### Minimal redacted structure (AC-9, AC-11)

Consistent with spec 033 §4 (no prompt or model text persisted) and spec 034 (`ai_actions` stores
no free text). The rules apply to every value at every depth.

- **`input_params`** — only the validated input's:
  - IDs (UUIDs);
  - enum values;
  - integer minor-unit amounts together with their currency codes;
  - timestamps (ISO 8601);
  - booleans;
  - **free-text fields by field name only** — the name is recorded, marked redacted; the content
    never is.

  No contact data, address text or coordinates.
- **`output_summary`** — the resulting resource's **type, ID and status**, and nothing else. Never a
  copy of the returned DTO and never payment-provider data (`provider_reference` or any adapter
  credential — spec 021 AC-8).
- **`error_code`** — the outcome's `code` only; never its message or details.

### Migration

- **Name:** `drizzle/0032_extend_ai_tool_calls.sql` with `drizzle/0032_extend_ai_tool_calls_down.sql` and a
  `drizzle/meta/_journal.json` entry — the repository's numbered-pair convention (0031 is the latest
  migration; the draft's `ExtendAiToolCallForIdempotency` is not the convention and is dropped).
- **Scope:** the `ai_tool_calls` columns above only. Spec 035's tables are not altered.
- **Reversible:** yes — the `_down.sql` removes exactly what the up migration adds and touches no
  other table.
- **Backfill required:** no — `ai_tool_calls` has no rows (nothing wrote to it before this spec).
- **Downtime:** none.

### Retention and privacy

- **Lifecycle.** `ai_tool_calls` rows follow the existing AI activity lifecycle: they exist as long
  as their `ai_actions` row. A user deleting a conversation tombstones it and retains its
  `ai_actions` (spec 034), so its tool-call rows are retained with them.
- **Account deletion (AC-10).** Tool-call rows must **not** survive account deletion. This spec
  contributes a step to spec 008's deletion flow (`lib/privacy/deletion.ts`) that hard-deletes the
  user's `ai_tool_calls` rows — the same per-spec contribution pattern specs 015–019 and 024–027 and
  034 use there. Spec 034's `ai_actions` rows themselves remain retained exactly as spec 034
  decided; this spec does not change that.
- **Data export (AC-11).** `ai_tool_calls` rows join the existing AI activity data export (spec
  034's `lib/ai-assistant/privacy.ts`, amended in spec 034 §3.4a), in the §4 redacted structure only.
- **No retention period.** Neither the repository nor any spec defines a time-based retention period
  for AI activity (spec 034 AC-16: no time-based sweep exists). This spec introduces none.
- **Confirmation records.** Binding rows hold no free text, attachment ID or nested payload (§3
  execution contract 1), so extending spec 035's confirmation record adds no free-text PII to it.

---

## 5. UI states

None of this spec's own. Tool outcomes surface through spec 034's existing conversation, pending
confirmation and activity-history surfaces (spec 034 §5: the `AiAssistantPanel` composed in
`app/_components/AskApurivaPanel.tsx`, and `app/account/ai-activity/page.tsx`). This spec adds no
route and no component. (The draft's `ChatPanel` does not exist and is not referenced.)

**Route(s):** N/A.
**Shared components used/added:** none.

---

## 6. Test plan

Vitest, co-located beside the source — the repository's convention. `e2e/*.spec.ts` is a
configured Vitest pattern (`vitest.config.ts` `include`) that walks whole journeys through real
route handlers against the `*_test` database; there is no Playwright runner.

| Level | What it covers | Where |
|---|---|---|
| **Unit — catalogue** | exactly the ten tools; none of the deferred ones; documented tier, route modes and state-changing-ness; `requiresConfirmation` derived from spec 034; registration refuses a confirmable tool that would bind free text or whose field collides with a display label; the model-facing catalogue exposes names/labels/field kinds only, per mode, never an idempotency key | `lib/mcp-tools/catalog.test.ts` |
| **Unit — validation** | each tool's strict `validate` (extra, identity and `idempotencyKey` fields rejected; `cancel_booking` rejects `note` and `reasonCode`; timestamps normalized); a state-changing tool without a server key refuses with `MCP_IDEMPOTENCY_KEY_REQUIRED` before its domain function | `lib/mcp-tools/tools/validation.test.ts` |
| **Redaction** | `input_params` holds only safe kinds, free text/coordinates/plain numbers by name only; binding rows round-trip | `lib/mcp-tools/redaction.test.ts` |
| **Errors** | domain `code`/`message`/`details` preserved; spec 035 codes unchanged; `MCP_IDEMPOTENCY_KEY_REQUIRED` distinct; an unexpected throw is `unknown`/`INTERNAL_ERROR`; nothing reads as success | `lib/mcp-tools/errors.test.ts` |
| **Retry** | at most one retry; the real classification is empty; never a domain error (incl. a declined payment's `details.retryable`), pipeline error, `MCP_IDEMPOTENCY_KEY_REQUIRED` or confirmed action | `lib/mcp-tools/retry-policy.test.ts` |
| **Critical regression** | one intent → one key → one booking; the tool wrapper with the same key replays; the §90 card (no Location, no raw id) bound to server-stored rows; live-data staleness and expiry; model-supplied key rejected; provider mode refused | `lib/mcp-tools/tools/create-booking.integration.test.ts` |
| **Critical regression** | the same key replays a payment with no second adapter attempt; a decline is `PAYMENT_FAILED` with spec 021's details, never success, never retried; an unconfigured provider is spec 021's own error | `lib/mcp-tools/tools/authorize-payment.integration.test.ts` |
| **Integration** | customer and provider cancellation through spec 023; `{ bookingId }` is the only binding; same key replays; a stranger gets no card | `lib/mcp-tools/tools/cancel-booking.integration.test.ts` |
| **Integration** | every read tool against its domain module; no key; `get_booking` changes nothing; a domain error passes through unretried; earnings provider-only | `lib/mcp-tools/tools/read-tools.integration.test.ts` |
| **Spec 034 amendment** | catalogue in the input only when non-empty; a low-risk tool runs before the reply and the reply comes from its real outcome; failed/unknown/rejected outcomes reach the model and are recorded truthfully; follow-up failure fails the turn with nothing stored; confirm returns the reply written from the outcome, a replay adds none, and a follow-up failure leaves the result standing | `lib/ai-assistant/tool-outcome.integration.test.ts` |
| **Account deletion and export** | `sweepDeletions` removes the user's `ai_tool_calls` (retry rows included), keeps `ai_actions`, touches nobody else; the export carries the redacted rows, never the key | `lib/mcp-tools/privacy.integration.test.ts` |
| **Boundary** | no `app/` import or HTTP call; no direct tool execution; only the recorder writes `ai_tool_calls`, fed `redactInput`; no deferred tool; no offer view-marking or notification read-marking | `lib/mcp-tools/boundary.test.ts` |
| **Migration** | 0032 is the next journaled migration, alters only `ai_tool_calls`, additive; applied shape; the down migration's guard and a real down run inside a rolled-back transaction | `lib/mcp-tools/migration.integration.test.ts` |
| **E2E (Vitest)** | a read whose real result reaches the model, a high-risk proposal, the structured confirmation, a retried confirmation — exactly one booking; activity and keyed tool calls | `e2e/ai-booking-flow.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/mcp-tools/catalog.test.ts::registers exactly the ten available, tier-documented tools` |
| AC-2, AC-3 | `lib/mcp-tools/tools/create-booking.integration.test.ts::executing the same accepted intent again reuses the SAME key and cannot create a second booking`; `…::the tool wrapper with the same server key replays the original booking` |
| AC-4 | `lib/mcp-tools/errors.test.ts::preserves a domain error’s code, message and details unchanged`; `lib/ai-assistant/tool-outcome.integration.test.ts::a failed outcome goes to the model with the domain’s own code` |
| AC-5 | `lib/mcp-tools/tools/read-tools.integration.test.ts::get_booking returns spec 020’s booking, issues no key and changes nothing` |
| AC-6 | `lib/mcp-tools/retry-policy.test.ts::the REAL classification is empty`; `lib/mcp-tools/tools/authorize-payment.integration.test.ts::a declined payment … never auto-retried` |
| AC-7 | `lib/mcp-tools/tools/create-booking.integration.test.ts::a confirmed booking runs with the stored input` |
| AC-8 | `lib/mcp-tools/tools/create-booking.integration.test.ts::the mode comes from the live session`; `lib/mcp-tools/tools/cancel-booking.integration.test.ts::the provider cancels in PROVIDER mode` |
| AC-9 | `lib/mcp-tools/redaction.test.ts::keeps IDs, enums, … records everything else by name only` |
| AC-10 | `lib/mcp-tools/privacy.integration.test.ts::account deletion hard-deletes the user’s tool calls` |
| AC-11 | `lib/mcp-tools/privacy.integration.test.ts::the AI data export includes each action’s tool calls in the redacted structure` |

**Coverage:** ≥80% on new code; the `create_booking`/`authorize_payment` idempotency tests are held
to master spec §115's bar.

**Not covered, deliberately:** the domain business logic itself (tested by each owning spec,
015–032); the wording of the model's natural-language replies (model output; spec 034's
orchestration is tested under its amendment).

**Other specs' tests.** Spec 035's `lib/mcp/boundary.test.ts` passes unmodified. Spec 003's
`lib/db/schema-lint.test.ts` gains the approved `ai_tool_calls` jsonb allow-list entry (DEP-2).
Spec 034's `TestExecutor` (`lib/ai-assistant/ai-assistant-test-support.ts`) implements the amended
port, and one spec 034 assertion now expresses a failed outcome in the amended shape.

---

## 7. Out of scope

### Deferred §127 tools — mapped, not registered

**Undocumented risk tier.** Master spec §87/§90 and spec 035 assign these no tier, and this spec
assigns none. They stay unregistered until a tier is documented.

| Tool | Domain operation (owning spec) | Modes | Domain idempotency |
|---|---|---|---|
| send_offer | `lib/offers/create.ts` `createOffer` (018) | provider | key |
| accept_offer | `lib/offers/decide.ts` `acceptOffer` (018) | customer | key |
| request_offer_change | `lib/negotiation/change-requests.ts` `createChangeRequest` (019) | customer | key |
| mark_provider_arrived | `lib/bookings/lifecycle.ts` `advanceBooking(…, 'arrived')` (020) | provider | state-based (a repeat returns the current booking) |
| start_service | `lib/bookings/lifecycle.ts` `advanceBooking(…, 'in_progress')` (020) | provider | state-based |
| complete_service | `lib/bookings/complete.ts` `completeBooking` (020/028) | customer, provider | state-based (spec 028 safeguard S9) |
| create_support_ticket | `lib/support/create.ts` `createSupportTicket` (032) | customer, provider | key + fingerprint |
| submit_review | `lib/reviews/create.ts` `createReview` (029) | customer | key + fingerprint |

**Confirmed input would need free text.** Both have a documented medium tier, so they need
confirmation, but their required input cannot be carried as safe normalized binding values (§3
execution contract 1). They stay unregistered until a safe way to carry their content through
confirmation is specified.

| Tool | Domain operation (owning spec) | Why it cannot be carried |
|---|---|---|
| send_provider_message | `lib/negotiation/messages.ts` `sendCustomerMessage` (019) | its input is the message body — free text |
| create_service_request | `lib/requests/create.ts` `createRequest` (015) | requires a free-text `description` and nested `fieldValues`; optionally `budget` (nested) and `attachmentIds` |

**The only domain read mutates (D-24).** A read tool must never mutate state (AC-5).

| Tool | Domain operation (owning spec) | Why it is deferred |
|---|---|---|
| get_offers | `lib/offers/read.ts` `listOffersForCustomer` (018), customer mode | it calls `markViewed`, moving the customer's live offers `sent` → `viewed` with a status-history row — spec 018's rule for a customer seeing offers. No non-marking domain read exists, and this spec changes no spec 018 code |

**Capability gaps.** No domain operation exists; this spec neither implements one nor assigns an
owner. Each becomes registrable once its owning domain spec provides the operation.

| Tool | What exists today | Gap |
|---|---|---|
| search_providers | `lib/search/query.ts` searches service offerings (each result carries a `providerId`) | no provider-search operation |
| get_provider | provider reviews, rating aggregates and availability summary are separate reads; spec 029 §8 open question 4 records that no public provider profile exists | no public provider-profile read |
| get_customer_profile | `lib/auth/profiles.ts` `getProfileFlags` returns only whether profiles exist | no customer-profile read operation |

### Otherwise out of scope

- Admin-only MCP tools (spec 035 AC-5 keeps them separate; not needed for the MVP assistant).
- Any admin view of the tool-call log (spec 035 §3 assigned the log to this spec; no view is
  specified).
- The authorization pipeline, confirmation binding and risk decision (specs 035/034) beyond the
  execution-contract changes listed in §3.
- Conversational orchestration — spec 034's, amended in spec 034 §3.4a.
- Per-tool feature flags (spec 041 is Draft; see §9).

---

## 8. Risks and open questions

### Decided in review

| # | Decision |
|---|---|
| D-1 | Catalogue lives in `lib/mcp-tools/**`, not `lib/mcp/tools/**` (spec 035's boundary test protects `lib/mcp/**`) |
| D-2 | Validated input is carried from proposal to execution through spec 035's existing `mcp_confirmation_parameters` record, which remains the source of truth — no parallel JSONB mechanism; no AI-supplied key or unvalidated input is trusted |
| D-3 | `activeMode` is resolved server-side from the session; the hard-coded `'customer'` is removed |
| D-4 | The port returns the real outcome (`succeeded` / `failed` / `unknown`) instead of `{ succeeded }` |
| D-5 | This spec owns the catalogue and its model-facing metadata; spec 034 consumes it through the existing `conversation` input — no separate prompt system |
| D-6 | Idempotency keys are server-generated per accepted intent, persisted on `ai_tool_calls`, and reused on any retry or replay (resolves the draft's open question 1) |
| D-7 | search_providers, get_provider, get_customer_profile are capability gaps (§7) |
| D-8 | Only documented risk tiers are assigned; the eight undocumented-tier tools are deferred and not registered (resolves OQ-1) |
| D-9 | Automatic retry only for explicitly classified transient infrastructure failures, at most once, same key; none is classified by the repository or any spec, so no automatic retry is performed; never for domain, pipeline or `MCP_IDEMPOTENCY_KEY_REQUIRED` errors (resolves OQ-2) |
| D-10 | Domain error `code`/`details` preserved; `MCP_DOMAIN_ERROR` wrapper removed |
| D-11 | `input_params`/`output_summary` are jsonb holding only the minimal redacted structure of §4 |
| D-12 | Tool-call rows follow the AI activity lifecycle and are hard-deleted on account deletion; no retention period is introduced |
| D-13 | Spec 034 is amended so confirmed execution receives the validated input, the outcome is returned to the model, and the model's reply is generated only from it (DEP-1) |
| D-14 | `MCP_IDEMPOTENCY_KEY_REQUIRED` is kept as the MCP-specific contract error, distinct from `VALIDATION_ERROR` |
| D-15 | Only existing feature-flag (environment variable) and structured-log infrastructure is used |
| D-16 | Confirmation binding rows hold only safe normalized values (IDs of the acted-on resource, enums, minor-unit amounts + currency, timestamps, booleans) — never raw free text, attachment IDs or nested payloads (resolves OQ-3) |
| D-17 | send_provider_message and create_service_request are deferred and not registered, because their confirmed input would need free text / nested payloads |
| D-18 | cancel_booking's input is `{ bookingId }` only: no free-text `note`, and no `reasonCode` because no closed list exists in the repository |
| D-19 | `ai_tool_calls` rows join the existing AI activity data export in the §4 redacted structure; no retention period is introduced (resolves OQ-5) |
| D-20 | *(implementation)* The confirmation card shows master spec §90's Service, Provider, Date/time and Price — no Location; values derived server-side from live domain data and re-derived at resolution and execution |
| D-21 | *(implementation)* A tool call naming an unknown/unavailable tool, or with input failing its strict schema, is fed back to the model as a failed outcome (nothing executed or recorded) |
| D-22 | *(implementation)* If the follow-up completion cannot be generated: in a turn the turn fails like any model failure and nothing is stored; after a confirmed action there is no reply and the recorded result stands |
| D-23 | *(implementation)* Spec 034 obtains the catalogue through a new port method `catalogFor(ctx)` (inert default `[]`), not by importing `lib/mcp-tools` |
| D-24 | *(implementation)* `get_offers` is deferred: its only domain read, spec 018's `listOffersForCustomer`, marks offers viewed — a mutation AC-5 forbids a read tool — and no non-marking read exists |

### Open questions

**None remain in this document.** OQ-1, OQ-2, OQ-3 and OQ-5 were resolved by D-8, D-9, D-16–D-18
and D-19; OQ-4, OQ-6, OQ-7 and OQ-8 were resolved earlier by D-11, D-13, D-14 and D-7.

### Dependencies — outside this document

| # | Dependency | Blocks |
|---|---|---|
| DEP-1 | **Spec 034 amendment — DONE.** Written into spec 034 §3.4a and implemented together with this spec: confirmed execution with restored input, outcome returned to the model, reply generated only from it, the AI export including redacted tool-call rows, turn order, follow-up completion, `POST …/confirm` response and its failure behaviour | — (was AC-4's model half, AC-7 end to end, AC-11) |
| DEP-2 | **Approval to add the `ai_tool_calls` jsonb columns to spec 003's `lib/db/schema-lint.test.ts` allow-list — GIVEN** by the platform owner for this implementation, and the entry was added | — |
| DEP-3 | **Spec 015 §3 wording.** Spec 015 says its `400 VALIDATION_ERROR` for a missing key "matches spec 036's `MCP_IDEMPOTENCY_KEY_REQUIRED` rule … so the AI path and the form path carry identical requirements", and `lib/api/idempotency.ts`'s comment says the two paths "fail identically". Under D-14 the *requirement* is identical (a key is always required) but the *code* differs, and on the MCP path the key is server-issued. Reported, not edited — spec 015 and its code are Approved | wording consistency only; nothing in this spec's behaviour |
| DEP-4 | **Spec 023 `reasonCode` closed list.** `lib/types/cancellation.ts` describes `reasonCode` as "from a closed list", but no list exists — the cancel route validates only a bounded string. Reported, not edited. If spec 023 later provides the list, `cancel_booking` could accept `reasonCode` as an enum binding value by amending this spec | nothing in this spec's current behaviour |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | No real model emits `toolCall` yet — spec 033's sandbox adapter returns a placeholder (spec 034 §8 risk 9) | tests drive the path through a mocked `completeAi`, as spec 034's e2e does |
| R-2 | An `unknown` outcome that the user starts again is a new intent with a new key | domain natural constraints still prevent duplicates (§3 "Idempotency") |
| R-3 | With no transient classification, a momentary infrastructure fault surfaces as `unknown` instead of being retried | honest by construction (§92); a classification can be added later by amending this spec |

---

## 9. Rollout

- **Feature flag:** no new flag. The catalogue is gated by the existing environment-variable flags —
  spec 033's `AI_ASSISTANT_ENABLED` kill switch (`lib/ai/feature-flags.ts`) and spec 034's
  `AI_CONVERSATIONAL_ASSISTANT_ENABLED` (`lib/ai-assistant/feature-flags.ts`). Per-tool flags wait
  for spec 041, which is Draft and not implemented; this spec does not depend on it.
- **Migration order:** migration 0032 ships with the code.
- **Rollback:** revert the deploy and apply `0032_…_down.sql`. Spec 034's port falls back to spec
  035's executor with an empty catalogue, so the assistant proposes nothing. Keys already issued
  stay valid against the domain tables' own constraints.
- **Observability:** structured stdout events, following the convention of spec 035's
  `mcp.tool_call` audit event and spec 004's `lib/api/security-log.ts` — one `mcp_tools.tool_call` event per tool-call
  execution carrying tool name, outcome status, `error_code` and the `auditId`, never input values.
  Together with spec 035's events this covers master spec §117's `User → AI → MCP tool →
  authorization → backend → result → AI response` trace. Aggregation into call-volume and
  error-rate views is spec 046's (Draft, not implemented) and is not assumed here.
