# Spec: Booking Creation & State Machine

**File:** `docs/specs/2026-08-28-020-booking-creation-state-machine.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §39, §43–§45, §125, §132.6, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.4, §14, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No booking entity exists. Master spec §39 requires the booking to be fully
server-authoritative, revalidating availability/slot/price/permissions/offer-state immediately
before confirmation and preventing race-condition double booking. §43–§45 define the
arrival/start/progress/completion workflow. §125 defines the full booking state machine.

**Who is affected:** Every customer and provider once an offer is accepted; payments (spec 021),
which triggers off booking state; the non-negotiable rule against duplicate bookings on retries
(master spec §132.6).

**Why it matters now:** It's the point where an accepted offer (017/018) and validated
availability (019) become a real, confirmed transaction — the pivot of the entire marketplace.

**Success looks like:** Accepting an offer creates exactly one booking even under retry/race
conditions, with full server-side revalidation at confirmation time; the booking then progresses
through Pending → Confirmed → Provider En Route → Arrived → In Progress → Completed →
Protected → Settled (with Cancelled/Disputed/Refunded/Failed as alternates), every transition
validated server-side.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** an accepted offer **When** booking creation is triggered **Then** the server revalidates provider availability, the slot, the price, the caller's permissions, and the offer's current state immediately before confirming |
| AC-2 | **Given** a slot that became unavailable between offer acceptance and booking confirmation **When** confirmation is attempted **Then** the customer sees "This time is no longer available" with alternatives offered, not a silent failure |
| AC-3 | **Given** an identical booking-creation request retried (network retry, double-click, duplicate MCP tool call) **When** using the same `Idempotency-Key` **Then** exactly one booking is created and all retries return that same booking |
| AC-4 | **Given** a confirmed booking **When** the provider marks "I've Arrived" then "Start Service" **Then** the status progresses `Confirmed → Provider En Route → Arrived → In Progress` in order, and the customer receives updates at each step |
| AC-5 | **Given** a service requiring completion evidence **When** the provider marks complete without it **Then** completion is rejected until evidence is attached; **given** evidence is optional for the service **Then** completion succeeds without it |
| AC-6 | **Given** any booking status transition **When** attempted out of the valid sequence (e.g. `Pending → In Progress` directly) **Then** the server rejects it |
| AC-7 | **Given** location/time signals during arrival **When** used **Then** they support verification but never unilaterally force a state change without the corresponding user action |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/bookings` | session (customer, from accepted offer) | `201` `ApiResponse<BookingDto>` | requires `Idempotency-Key`; body references `offerId` |
| `GET` | `/api/v1/bookings/{id}` | session (participant) | `200` `ApiResponse<BookingDto>` | |
| `GET` | `/api/v1/bookings` | session (own only) | `200` `PagedResponse<BookingSummaryDto>` | filter: upcoming/active/completed/cancelled/disputed |
| `POST` | `/api/v1/bookings/{id}/provider-arrived` | session (provider, owner) | `200` | |
| `POST` | `/api/v1/bookings/{id}/start-service` | session (provider, owner) | `200` | |
| `POST` | `/api/v1/bookings/{id}/complete` | session (provider, owner) | `200` | body may include evidence attachment IDs |

### Request and response types

```typescript
// packages/types/src/bookings.ts
export interface CreateBookingRequest {
  offerId: string;
}

export interface BookingDto {
  id: string;
  requestId: string;
  offerId: string;
  customerId: string;
  providerId: string;
  status: 'pending' | 'confirmed' | 'provider_en_route' | 'arrived' | 'in_progress' | 'completed' | 'protected' | 'settled' | 'cancelled' | 'disputed' | 'refunded' | 'failed';
  scheduledAt: string;
  priceAmountMinorUnits: number;
  currencyCode: string;
  version: number;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `SLOT_NO_LONGER_AVAILABLE` | revalidation at confirmation time fails |
| `422` | `OFFER_NOT_ACCEPTABLE` | offer expired/withdrawn/already used for a booking |
| `409` | `INVALID_STATUS_TRANSITION` | out-of-sequence status change attempted |
| `422` | `COMPLETION_EVIDENCE_REQUIRED` | service/policy requires evidence not yet provided |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Booking` | new | `id uuid pk`, `request_id uuid fk->Request`, `offer_id uuid fk->Offer unique`, `customer_id uuid fk->CustomerProfile`, `provider_id uuid fk->ProviderProfile`, `status text`, `scheduled_at timestamptz`, `price_amount_minor_units integer`, `currency_code text`, `idempotency_key text unique`, `created_at`, `updated_at`, `version` |
| `BookingStatusHistory` | new | `id uuid pk`, `booking_id uuid fk->Booking`, `from_status text`, `to_status text`, `actor_type text`, `actor_id uuid`, `created_at` |
| `BookingMilestone` | new | `id uuid pk`, `booking_id uuid fk->Booking`, `milestone text` (started/working/almost_done/custom), `note text nullable`, `created_at` |

`offer_id unique` on `Booking` enforces "one booking per offer" at the database level as a
second line of defense beyond the idempotency key.

### Migration

- **Name:** `AddBookingTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Bookings contain exact operational address (revealed per spec 012's rules) and are core
financial/audit records — retained per legal/financial policy even through account deletion
(spec 008), anonymized rather than deleted where required.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | booking confirmation shows a progress indicator during server revalidation, not an optimistic "Confirmed" state before the server responds |
| **Empty** | "Bookings" tab with none yet shows browse/search CTA |
| **Error** | slot-no-longer-available shows the specific conflict and offers alternatives (per AC-2), preserving the customer's place in the flow |
| **Success** | booking status timeline (master spec §37-style) updates live via WebSocket as the provider progresses through arrival/start/completion |

Never claims booking success without confirmed server response (master spec §103, §132.7) —
the frontend shows a pending state until the `201` is received, no client-side optimistic
"booked" state.

**Route(s):** `apps/web/app/bookings/[id]`, `apps/web/app/provider/schedule/bookings/[id]`
**Shared components used/added:** `packages/ui` `StatusTimeline` (reused from spec 015),
`EvidenceUpload`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | state-machine transition validator, revalidation-check composition | `apps/api/bookings/**/*.test.ts` |
| **Integration** | full lifecycle Pending→Settled; concurrent booking-creation race with identical idempotency key; slot-conflict rejection | `apps/api/bookings/*.integration.test.ts` |
| **MCP** | `create_booking` tool idempotency identical to manual path; repeated tool call cannot create two bookings (master spec §115 critical example) | `packages/mcp/create-booking.test.ts` |
| **E2E** | offer accepted → booking confirmed → arrival → start → completion with evidence | `apps/web-e2e/booking-lifecycle.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/bookings/create.integration.test.ts::revalidates all before confirming` |
| AC-2 | `apps/api/bookings/create.integration.test.ts::slot conflict shows alternatives` |
| AC-3 | `apps/api/bookings/idempotency.integration.test.ts::retry returns same booking` |
| AC-4 | `apps/api/bookings/lifecycle.integration.test.ts::progresses in order with customer updates` |
| AC-6 | `apps/api/bookings/state-machine.test.ts::rejects out-of-sequence transition` |

**Coverage:** ≥80% on new code; this spec is explicitly named in master spec §115's critical
test examples, so its idempotency/concurrency tests are held to a stricter bar.

**Not covered, deliberately:** Payment authorization/capture mechanics (spec 021) — this spec
covers the booking state machine only, referencing payment state as an input/output where the
two intersect (e.g. `Protected`/`Settled` reflect payment protection state from spec 021).

---

## 7. Out of scope

- Payment authorization/capture (spec 021).
- Cancellation policy and no-show handling (spec 023).
- Review eligibility (spec 029) — triggered by `Completed`/`Settled` but detailed separately.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact mechanism for "offer alternatives" shown on slot conflict (re-run matching, or just surface other open offers) | Product | Open |
| 2 | Whether `Protected`/`Settled` transitions are driven by this spec or entirely by spec 021's payment-protection logic | — | Open — recommend spec 021 owns the transition trigger, this spec owns the state machine definition it writes into |

---

## 9. Rollout

- **Feature flag:** none — core transactional flow.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; in-flight bookings remain valid (additive schema only).
- **Observability:** booking-confirmation failure rate (slot conflicts), status-transition
  latency, and idempotency-key collision rate monitored — directly informs master spec §115's
  "no duplicate bookings on retries" guarantee.
