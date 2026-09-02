# Spec: Payment Processing & Protection

**File:** `docs/specs/2026-08-28-021-payment-processing-protection.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §46–§47, §132.7, §132.22, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §8, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No payment integration exists. Master spec §46 requires service-aware payment timing
(scheduled/fixed at booking, offer-based at selection, deposit-based split, final adjustments
requiring explicit approval) built on a real payment provider's authorization/hold/capture/
payout primitives — never claiming to be an escrow service without legal/technical basis.
§47 requires a payment-protection window before provider payout finalizes.

**Who is affected:** Every paying customer; every provider awaiting payout eligibility;
finance/reconciliation.

**Why it matters now:** It gates real booking completion for paid services and is the base for
refunds (022), cancellation fees (023), and payouts (024).

**Success looks like:** A booking's payment is authorized/captured through a real payment
provider (sandbox in non-production), never a fabricated "success" in application code; funds
are tracked through a protection window before payout eligibility; price changes always require
explicit customer approval before an additional charge.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a fixed/scheduled service booking **When** confirmed **Then** payment is authorized (or charged, per provider capability) at booking time, using the real payment provider's API — sandbox in non-production, never simulated success inside application code |
| AC-2 | **Given** an offer-based service **When** the customer selects/accepts an offer **Then** payment authorization occurs at that point, not before |
| AC-3 | **Given** a deposit-based service **When** booked **Then** the deposit is charged first and the remainder is charged only after explicit customer approval at the appropriate later point |
| AC-4 | **Given** a final price adjustment (e.g. extra parts/time) **When** proposed by the provider **Then** the customer must explicitly approve it before any additional charge occurs — no silent charge |
| AC-5 | **Given** a captured payment **When** the booking has not yet reached the appropriate completion/protection state **Then** provider payout is not finalized (feeds spec 024) |
| AC-5a | **Given** a booking transitions to `Completed` **When** the transition is recorded, regardless of whether the customer or the provider marked it complete **Then** the payment-protection window starts at that moment, using the payment/service model's configured duration (default 48 hours) |
| AC-5b | **Given** a booking's payment-protection window elapses **When** no dispute was opened during that window **Then** the protection is released and the provider becomes eligible for payout (spec 024 executes the actual payout) |
| AC-5c | **Given** a dispute is opened against a booking **When** the dispute is opened before the protection window elapses **Then** provider payout remains blocked until the dispute is resolved, even after the window would otherwise have elapsed |
| AC-6 | **Given** a payment attempt **When** it fails **Then** the customer sees a clear "Payment wasn't completed, no charge was confirmed" message with retry/change-method options, and no booking is confirmed on a failed payment |
| AC-7 | **Given** a duplicate payment-authorization request (retry) **When** using the same idempotency key **Then** the payment provider's idempotency prevents a duplicate charge |
| AC-8 | **Given** the AI assistant **When** it reports a payment outcome **Then** it only ever reports what the backend/payment-provider actually confirmed, never an assumed success (master spec §132.7) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/bookings/{id}/payment/authorize` | session (customer, owner) | `200` `ApiResponse<PaymentDto>` | requires `Idempotency-Key`, delegates to payment provider |
| `GET` | `/api/v1/bookings/{id}/payment` | session (participant) | `200` `ApiResponse<PaymentDto>` | |
| `POST` | `/api/v1/bookings/{id}/payment/capture` | session (system/provider-triggered per service model) | `200` | where auth/capture are separate steps |
| `POST` | `/api/v1/bookings/{id}/price-adjustment` | session (provider, owner) | `201` `ApiResponse<PriceAdjustmentDto>` | proposes, does not charge |
| `POST` | `/api/v1/price-adjustments/{id}/approve` | session (customer, owner) | `200` | triggers the actual additional charge only after this call |

### Request and response types

```typescript
// lib/types/payments.ts
export interface PaymentDto {
  id: string;
  bookingId: string;
  status: 'created' | 'requires_action' | 'authorized' | 'pending' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';
  amountMinorUnits: number;
  currencyCode: string;
  protectionState: 'held' | 'released' | 'disputed';
  protectionWindowStartedAt: string | null; // set when the booking reaches Completed, regardless of who marked it complete
  protectionWindowHours: number; // default 48; the payment/service model may configure a different duration
  providerReference: string; // opaque reference into the real payment provider, never a fabricated ID
}

export interface PriceAdjustmentDto {
  id: string;
  bookingId: string;
  additionalAmountMinorUnits: number;
  reason: string;
  status: 'pending_approval' | 'approved' | 'rejected' | 'charged';
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `PAYMENT_FAILED` | provider declined/failed the authorization |
| `422` | `PAYMENT_REQUIRES_ACTION` | 3DS or equivalent step-up required |
| `409` | `PAYMENT_ALREADY_CAPTURED` | duplicate capture attempt |
| `403` | `ADJUSTMENT_APPROVAL_REQUIRED` | attempt to charge without customer approval on record |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Payment` | new | `id uuid pk`, `booking_id uuid fk->Booking`, `status text`, `amount_minor_units integer`, `currency_code text`, `protection_state text`, `protection_window_started_at timestamptz nullable`, `protection_window_hours integer default 48`, `provider_reference text`, `idempotency_key text unique`, `created_at`, `updated_at`, `version` |
| `PaymentAttempt` | new | `id uuid pk`, `payment_id uuid fk->Payment`, `status text`, `failure_reason text nullable`, `attempted_at timestamptz` |
| `PaymentAuthorization` | new | `id uuid pk`, `payment_id uuid fk->Payment`, `authorized_amount_minor_units integer`, `authorized_at timestamptz`, `captured_at timestamptz nullable` |
| `PriceAdjustment` | new | `id uuid pk`, `booking_id uuid fk->Booking`, `additional_amount_minor_units integer`, `currency_code text`, `reason text`, `status text`, `approved_at timestamptz nullable` |

`lib/payments` is the only module permitted to hold payment-provider credentials; all
other modules interact through its abstraction, never calling the vendor SDK directly.

### Payment protection window

- The protection window default is **48 hours**. A given payment/service model may configure a
  different duration explicitly; absent that configuration, 48 hours applies.
- The window starts when the booking transitions to `Completed`, regardless of whether the
  customer or the provider triggered that completion (spec 020's completion endpoint, detailed
  further by spec 028).
- If no dispute is opened before the window elapses, `protection_state` transitions
  `held → released` and the provider becomes eligible for payout; spec 024 owns executing the
  actual payout once eligible.
- If a dispute is opened before the window elapses, `protection_state` transitions
  `held → disputed` and provider payout stays blocked regardless of how much of the window
  remains, until the dispute is resolved (spec 031).

### Migration

- **Name:** `AddPaymentTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

No raw card/payment-instrument data is stored by Apuriva (handled by the payment provider per
master spec §48); `Payment`/`PaymentAttempt`/`PaymentAuthorization` records are financial
records retained regardless of account deletion (spec 008), per legal/audit requirements.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | payment step shows explicit "Processing payment..." progress, never an optimistic success before provider confirmation |
| **Empty** | N/A |
| **Error** | exact master spec §105 pattern: "Payment wasn't completed. No charge was confirmed." + Try Again / Change Payment Method |
| **Success** | booking transitions to `Confirmed` only after the backend has the provider's confirmed authorization/capture |

Price-adjustment approval is a structured, high-risk confirmation UI (master spec §90) showing
exact amount/currency before the customer approves.

**Route(s):** `app/bookings/[id]/payment`
**Shared components used/added:** `components` `PaymentForm` (wraps the payment provider's
hosted/embedded UI component), `ConfirmDialog`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | payment-timing-model routing logic, protection-state transitions, protection-window default/override duration resolution | `lib/payments/**/*.test.ts` |
| **Integration** | authorize/capture/fail flows against the payment provider's sandbox; idempotent retry; price-adjustment approval gate; protection window starts on `Completed` regardless of who completed it; window release with no dispute; window blocked by an in-window dispute | `app/api/v1/payments/*.integration.test.ts` |
| **Financial** | success, failure, pending, duplicate-attempt, idempotency scenarios per master spec §113 | `app/api/v1/payments/financial.integration.test.ts` |
| **E2E** | customer completes payment in sandbox, sees confirmed booking; failed payment shows correct error and no booking confirmation | `e2e/payment.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/payments/authorize.integration.test.ts::real sandbox call, no fabricated success` |
| AC-4 | `app/api/v1/payments/price-adjustment.integration.test.ts::requires explicit approval before charge` |
| AC-5a | `lib/payments/protection-window.test.ts::window starts on Completed regardless of who completed it, uses configured or default 48h duration` |
| AC-5b | `app/api/v1/payments/protection-window.integration.test.ts::window elapses with no dispute, releases protection, provider payout-eligible` |
| AC-5c | `app/api/v1/payments/protection-window.integration.test.ts::dispute opened in-window keeps payout blocked past window elapse` |
| AC-6 | `e2e/payment.spec.ts::failed payment shows correct message, no booking` |
| AC-7 | `app/api/v1/payments/idempotency.integration.test.ts::duplicate request does not double-charge` |
| AC-8 | `lib/ai/payment-reporting.test.ts::never claims success without backend confirmation` |

**Coverage:** ≥80% on new code; financial-flow tests (§113 list) are mandatory, not optional.

**Not covered, deliberately:** Payment-provider-specific edge cases beyond what their sandbox
exposes (covered by the provider's own certification, not re-tested here).

---

## 7. Out of scope

- Refund processing (spec 022).
- Payout to providers (spec 024).
- Cancellation-fee calculation (spec 023) — this spec only executes charges once decided.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Payment provider selection for the Pakistan market (must support local payment methods) and sandbox credential availability | — | Open — blocks real integration; a documented mock adapter is required in the interim per master spec §133.7 |
| 2 | Whether Apuriva's payment-protection language can legally use the term "escrow" — master spec §46 explicitly cautions against this | Legal | Open |

---

## 9. Rollout

- **Feature flag:** none — payments are core, not optional; but the specific *provider adapter*
  is swappable via `lib/payments` configuration.
- **Migration order:** schema ships with code; production payment-provider credentials
  provisioned separately from code deploy.
- **Rollback:** revert deploy; in-flight payments' state is provider-authoritative and
  reconciled on next status poll/webhook regardless of app-code version.
- **Observability:** payment success/failure rate, provider latency, and protection-window
  aging alerted (master spec §117).
