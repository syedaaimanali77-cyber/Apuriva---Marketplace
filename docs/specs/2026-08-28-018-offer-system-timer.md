# Spec: Offer System & 2-Minute Timer

**File:** `docs/specs/2026-08-28-017-offer-system-timer.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §31–§32, §125, §132.4, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.4, §10, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No offer entity exists. Master spec §31 defines the offer flow and fields; §32
mandates a 2-minute response window that is **server/database authoritative** — the browser
timer is cosmetic only, and this is called out as one of the platform's non-negotiable rules
(§132.4).

**Who is affected:** Providers responding to quote-based requests; customers comparing offers
under time pressure; the background job system (spec 046) that must enforce expiry reliably
even if no client is connected.

**Why it matters now:** It's the highest-risk timing-correctness feature in the MVP — explicitly
named in master spec §115's critical test list ("repeated booking tool call cannot create two
bookings" and the offer-expiry equivalent).

**Success looks like:** An offer sent by a provider is only acceptable within exactly 2 minutes
of being sent, enforced by the server regardless of what any client's local timer displays; an
expired offer can never transition to `Accepted` under any race condition.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** an offer sent at time T **When** the customer attempts to accept it at T+2:00:01 (server clock) **Then** the API rejects with `422 OFFER_EXPIRED`, even if the offer was still visually "active" on the client due to clock drift |
| AC-2 | **Given** an offer sent at time T **When** the customer accepts it at T+1:59 (server clock) **Then** it is accepted successfully |
| AC-3 | **Given** an offer that reaches its expiry **When** no client is connected/polling **Then** a background job still transitions it to `Expired` within a bounded delay, not only on next client read |
| AC-4 | **Given** an expired offer **When** viewed **Then** it remains visible in history as `Expired`, never deleted |
| AC-5 | **Given** a request still active after an offer expires **When** the provider wants to try again **Then** they can send a fresh offer, which gets its own independent 2-minute window |
| AC-6 | **Given** two simultaneous accept attempts on the same offer (double-click, retry) **When** both reach the server **Then** exactly one succeeds and the other receives a clear "already accepted/expired" response — no duplicate booking is created (ties to spec 020/091) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/requests/{id}/offers` | session (provider) | `201` `ApiResponse<OfferDto>` | `expiresAt` computed server-side as `now() + 2 minutes`, never client-supplied |
| `GET` | `/api/v1/requests/{id}/offers` | session (owner customer) | `200` `ApiResponse<OfferDto[]>` | |
| `POST` | `/api/v1/offers/{id}/accept` | session (owner customer) | `200` `ApiResponse<OfferDto>` | idempotent via `Idempotency-Key`; server re-validates `expiresAt > now()` at write time |
| `POST` | `/api/v1/offers/{id}/decline` | session (owner customer) | `200` | |
| `POST` | `/api/v1/offers/{id}/withdraw` | session (provider, owner) | `200` | provider withdraws before expiry |

### Request and response types

```typescript
// packages/types/src/offers.ts
export interface OfferDto {
  id: string;
  requestId: string;
  providerId: string;
  status: 'draft' | 'sent' | 'viewed' | 'revised' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  priceAmountMinorUnits: number;
  currencyCode: string;
  includedItems: string[];
  providerMessage?: string;
  estimatedDuration?: string;
  sentAt: string;
  expiresAt: string; // authoritative, server-computed
  version: number;
}
```

The frontend renders a countdown purely from `expiresAt` for display; every accept/decline
action is re-validated server-side against the current server clock regardless of the displayed
countdown.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `OFFER_EXPIRED` | accept attempted after `expiresAt` |
| `409` | `OFFER_ALREADY_DECIDED` | offer already accepted/declined/withdrawn |
| `403` | `FORBIDDEN` | non-owner attempts to accept/decline |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Offer` | new | `id uuid pk`, `request_id uuid fk->Request`, `provider_id uuid fk->ProviderProfile`, `status text`, `price_amount_minor_units integer`, `currency_code text`, `included_items jsonb`, `provider_message text nullable`, `estimated_duration_minutes integer nullable`, `sent_at timestamptz`, `expires_at timestamptz`, `decided_at timestamptz nullable`, `version integer` |
| `OfferRevision` | new | `id uuid pk`, `offer_id uuid fk->Offer`, `price_amount_minor_units integer`, `included_items jsonb`, `created_at` |
| `OfferMessage` | new | `id uuid pk`, `offer_id uuid fk->Offer`, `sender_type text`, `sender_id uuid`, `body text`, `created_at` |

`expires_at` is set exactly once, server-side, at `sent_at + interval '2 minutes'`, and is never
recomputed or extended by any client request.

### Migration

- **Name:** `AddOfferTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Offers contain price/negotiation data tied to both parties; retained per platform policy,
included in relevant data exports (spec 008) for the customer/provider involved only.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | offer list skeleton |
| **Empty** | request with zero offers yet shows "Waiting for offers" with elapsed-time context, never a blank panel |
| **Error** | accept-after-expiry attempt shows "This offer expired — ask for a new one" (master spec §92 pattern), not a generic error |
| **Success** | accept transitions directly into booking flow (spec 020) |

Countdown timer is a pure display component reading `expiresAt`; on WebSocket reconnect (spec
095/architecture §6.1) the authoritative offer state is re-fetched, never assumed from local
state. Reduced-motion respected for the countdown's visual treatment.

**Route(s):** `apps/web/app/requests/[id]/offers`
**Shared components used/added:** `packages/ui` `CountdownTimer` (display-only, non-authoritative), `OfferCard`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | expiry computation, state-transition validator | `apps/api/offers/**/*.test.ts` |
| **Integration** | accept exactly at/after boundary using a controllable clock; concurrent accept race; background expiry sweep | `apps/api/offers/*.integration.test.ts` |
| **MCP** | `accept_offer` tool re-validates expiry server-side identically to the manual path | `packages/mcp/accept-offer.test.ts` |
| **E2E** | provider sends offer, customer accepts within window; separately, customer attempts to accept after simulated expiry | `apps/web-e2e/offer-timer.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/offers/expiry.integration.test.ts::rejects accept after server expiry` |
| AC-3 | `apps/worker/offer-expiry-job.integration.test.ts::expires offers without client polling` |
| AC-6 | `apps/api/offers/concurrency.integration.test.ts::exactly one of two simultaneous accepts succeeds` |

**Coverage:** ≥80% on new code; this spec's timing-correctness tests are held to a stricter bar
given master spec §115's explicit call-out.

**Not covered, deliberately:** Exact UX copy/animation for the countdown — functional
correctness of expiry enforcement is the acceptance bar, not visual polish.

---

## 7. Out of scope

- Offer negotiation/revision UX and comparison (spec 018).
- Booking creation once an offer is accepted (spec 020).
- Configurable timer duration — master spec §32 fixes it at exactly 2 minutes; not admin-
  configurable in MVP.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Background sweep interval/latency bound for AC-3 | — | Open — recommend sub-10-second sweep interval so "expired" state is visible promptly even without a connected client |

---

## 9. Rollout

- **Feature flag:** none — this is core to the marketplace's trust model, not optional.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; in-flight offers evaluated under old code's expiry logic remain
  consistent since `expires_at` is a stored, not computed-on-read-only, value.
- **Observability:** offer-expiry-without-response rate and accept-race-rejection rate
  monitored — a spike would indicate a timer bug (master spec §117).
