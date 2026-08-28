# Spec: MCP Tool Catalog, Idempotency & Errors

**File:** `docs/specs/2026-08-28-036-mcp-tool-catalog-idempotency-errors.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §91–§92, §127, §132.6, §132.8, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §7.3, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 035 provides the authorization pipeline but not the actual tool catalog. Master
spec §127 lists the concrete read and action tools (search_services, get_provider,
create_service_request, accept_offer, create_booking, cancel_booking, authorize_payment,
mark_provider_arrived, start_service, complete_service, create_support_ticket, submit_review,
etc.). §91 requires idempotency keys on every important state-changing tool with retries
returning the original result. §92 requires structured backend errors translated into natural
language by the AI, never a claimed success without confirmed backend success.

**Who is affected:** The AI assistant (spec 034) invoking these tools on a user's behalf; every
domain module each tool wraps.

**Why it matters now:** It's the concrete implementation that makes spec 034's conversational
actions actually do something real, built last among the MCP specs since every tool here calls
into an already-specified, already-authorized domain operation (015–032).

**Success looks like:** Every tool named in master spec §127 exists, read tools are cheap/
low-risk, action tools are idempotent and risk-tiered per spec 035's pipeline, and any backend
error is translated into an honest, actionable natural-language response — never a fabricated
success.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** the tool catalog **When** enumerated **Then** it includes at minimum every tool named in master spec §127 (read: search_services, search_providers, get_service, get_provider, get_provider_availability, get_request, get_offers, get_booking, get_customer_profile, get_provider_earnings, get_notifications; action: create_service_request, send_provider_message, send_offer, accept_offer, request_offer_change, create_booking, cancel_booking, authorize_payment, mark_provider_arrived, start_service, complete_service, create_support_ticket, submit_review) |
| AC-2 | **Given** a state-changing tool (create_booking, authorize_payment, cancel_booking, etc.) **When** called twice with the same idempotency key (e.g. due to AI retry logic) **Then** the second call returns the original result without creating a duplicate side effect |
| AC-3 | **Given** `create_booking` specifically **When** called repeatedly with the same key **Then** exactly one booking is created — the master spec §115 critical test case, reusing spec 020's idempotency guarantee through this tool's wrapper |
| AC-4 | **Given** a backend error (e.g. "provider no longer available") **When** returned to the AI **Then** the AI translates it into the natural-language pattern from master spec §92 (e.g. "Ali is no longer available at 5 PM" + concrete options), never a generic failure or a claimed success |
| AC-5 | **Given** a read tool **When** called **Then** it never mutates state and is not subject to idempotency-key requirements (read tools are naturally safe to retry) |
| AC-6 | **Given** an error classified as safely retryable (e.g. transient network failure) **When** encountered **Then** the AI may retry automatically; **given** a non-retryable domain error (e.g. offer expired) **Then** it is surfaced to the user, never silently retried |

---

## 3. API contract

Each tool follows spec 035's `McpToolDefinition` contract. Representative entries:

```typescript
// packages/mcp/src/tools/create-booking.ts
export const createBookingTool: McpToolDefinition<CreateBookingInput, BookingDto> = {
  name: 'create_booking',
  riskTier: 'high',
  requiresConfirmation: true,
  isIdempotent: true,
  inputSchema: createBookingSchema, // { offerId: string, idempotencyKey: string }
  execute: async (input, ctx) => {
    // delegates to apps/api's booking module (spec 020) through its own authorized service call
  },
};

// packages/mcp/src/tools/search-services.ts
export const searchServicesTool: McpToolDefinition<SearchServicesInput, SearchResultDto[]> = {
  name: 'search_services',
  riskTier: 'low',
  requiresConfirmation: false,
  isIdempotent: false, // read-only, N/A
  inputSchema: searchServicesSchema,
  execute: async (input, ctx) => {
    // delegates to spec 013's /api/v1/search
  },
};
```

### Error codes

Tools surface the same error codes as the domain endpoints they wrap (e.g. `OFFER_EXPIRED` from
spec 017, `SLOT_NO_LONGER_AVAILABLE` from spec 020), plus:

| HTTP-equivalent | `code` | When |
|---|---|---|
| — | `MCP_IDEMPOTENCY_KEY_REQUIRED` | state-changing tool called without a key |
| — | `MCP_DOMAIN_ERROR` | wrapper for any underlying domain error, carrying the original `code` through unchanged |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `AIToolCall` | extend (stubbed spec 033) | `idempotency_key text nullable`, `input_params jsonb`, `output_summary jsonb`, `error_code text nullable`, `retried_from_call_id uuid nullable` |

No tool introduces new domain entities — each wraps an existing, already-specified domain
operation (015–032) and its own idempotency mechanism (e.g. spec 020's `Booking.idempotency_key`
unique constraint, spec 021's `Payment.idempotency_key`).

### Migration

- **Name:** `ExtendAiToolCallForIdempotency`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

`input_params`/`output_summary` may contain personal/transactional data — same retention class
as the underlying domain record (e.g. a `create_booking` call's params are booking-sensitive).

---

## 5. UI states

Not applicable directly — tool execution surfaces through spec 034's conversational UI states
(loading = "thinking/acting" indicator, error = translated natural-language message, success =
inline result or confirmation-then-result for high-risk tools).

**Route(s):** N/A (library) — results surface within spec 034's routes.
**Shared components used/added:** None beyond spec 034's `ChatPanel`.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | each tool's input-schema validation, error-code passthrough | `packages/mcp/tools/**/*.test.ts` |
| **Integration** | each action tool's idempotent-retry behavior against its real domain module; each read tool's data comes from authoritative sources, never fabricated | `packages/mcp/tools/**/*.integration.test.ts` |
| **Critical regression** | repeated `create_booking` tool call cannot create two bookings; repeated `authorize_payment` cannot double-charge (master spec §115) | `packages/mcp/tools/create-booking.integration.test.ts`, `packages/mcp/tools/authorize-payment.integration.test.ts` |
| **E2E** | AI assistant completes a full booking via tool calls, including a simulated retry that doesn't duplicate | `apps/web-e2e/ai-booking-flow.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `packages/mcp/registry.test.ts::catalog includes all §127 tools` |
| AC-2, AC-3 | `packages/mcp/tools/create-booking.integration.test.ts::idempotent retry` |
| AC-4 | `packages/mcp/error-translation.test.ts::natural language, never fabricated success` |
| AC-6 | `packages/mcp/retry-policy.test.ts::retries only safely-retryable errors` |

**Coverage:** ≥80% on new code; idempotency tests for `create_booking` and `authorize_payment`
are held to the same strict bar as master spec §115.

**Not covered, deliberately:** The domain business logic itself (already tested by each owning
spec, 015–032) — this spec tests the tool *wrapper's* correctness (schema, idempotency, error
passthrough), not the underlying logic a second time.

---

## 7. Out of scope

- Admin-only MCP tools (registered separately per spec 035 AC-5; a full admin tool catalog is a
  Phase 2/later addition, not required for MVP's customer/provider AI assistant).
- The authorization pipeline itself (spec 035 — this spec's tools all run through it, don't
  redefine it).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Whether the AI or the client generates idempotency keys for tool calls | — | Open — recommend the AI orchestration layer (spec 034) generates and persists the key per user intent, so a genuine retry reuses it |

---

## 9. Rollout

- **Feature flag:** individual tools may be flagged off independently (e.g. disable
  `authorize_payment` via MCP while keeping read tools active) using the same feature-flag
  system as spec 041.
- **Migration order:** schema extension ships with code.
- **Rollback:** revert deploy; idempotency keys already issued remain valid against the
  underlying domain tables' own constraints.
- **Observability:** per-tool call volume, error rate, and idempotent-retry rate monitored —
  the AI trace `User → AI → MCP tool → authorization → backend → result → AI response`
  (master spec §117) is fully instrumented end to end by this spec plus spec 035.
