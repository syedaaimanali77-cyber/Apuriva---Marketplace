# Spec: Provider Payouts & Earnings

**File:** `docs/specs/2026-08-28-024-provider-payouts-earnings.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §48, §125, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, §8, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No payout mechanism exists. Master spec §48 requires a `Pending → Eligible → Paid`
payout lifecycle, a full earnings dashboard (gross, fee, refunds, adjustments, net, pending,
upcoming, paid, booking-level detail, exportable statements), configurable payout methods (bank,
mobile wallets), and re-authentication for changing payout details.

**Who is affected:** Every provider earning money on the platform; Finance Admins reconciling
payouts.

**Why it matters now:** Depends on payment processing (021) and refunds (022) for accurate
figures; the final piece of the money-flow milestone.

**Success looks like:** A provider sees an accurate, real-time earnings dashboard, payouts
progress automatically from Pending to Eligible (once the protection window and any refund
window closes) to Paid, and changing payout details requires step-up re-authentication.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a completed, settled booking **When** its payment protection window closes with no dispute/refund **Then** the corresponding payout line transitions `Pending → Eligible` |
| AC-2 | **Given** a refund issued against a booking after payout eligibility **When** reconciled **Then** the provider's earnings ledger reflects the deduction accurately, never leaving stale "earned" figures |
| AC-3 | **Given** a provider's earnings dashboard **When** viewed **Then** gross, fee, refunds, adjustments, net, pending, upcoming, and paid figures are all shown and mathematically consistent (net = gross − fee − refunds + adjustments) |
| AC-4 | **Given** a provider changing their payout method **When** submitted **Then** step-up re-authentication is required (ties to spec 005/008) |
| AC-5 | **Given** a failed payout **When** it occurs **Then** it is flagged for recovery, the provider is notified, and it does not silently disappear from the dashboard |
| AC-6 | **Given** a provider **When** they export a statement **Then** it accurately reflects booking-level detail for the selected period |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/providers/me/earnings` | session (provider) | `200` `ApiResponse<EarningsSummaryDto>` | |
| `GET` | `/api/v1/providers/me/earnings/bookings` | session (provider) | `200` `PagedResponse<EarningsLineDto>` | booking-level detail |
| `GET` | `/api/v1/providers/me/earnings/statement` | session (provider) | `202` `ApiResponse<{ exportRequestId }>` | async, downloadable when ready |
| `GET` | `/api/v1/providers/me/payout-methods` | session (provider) | `200` `ApiResponse<PayoutMethodDto[]>` | |
| `POST` | `/api/v1/providers/me/payout-methods` | session (provider) + step-up | `201` | |
| `PATCH` | `/api/v1/providers/me/payout-methods/{id}/default` | session (provider) + step-up | `200` | |

### Request and response types

```typescript
// packages/types/src/payouts.ts
export interface EarningsSummaryDto {
  grossAmountMinorUnits: number;
  feeAmountMinorUnits: number;
  refundsAmountMinorUnits: number;
  adjustmentsAmountMinorUnits: number;
  netAmountMinorUnits: number;
  pendingAmountMinorUnits: number;
  upcomingAmountMinorUnits: number;
  paidAmountMinorUnits: number;
  currencyCode: string;
}

export interface PayoutMethodDto {
  id: string;
  type: 'bank' | 'mobile_wallet';
  maskedDetail: string; // never full account/wallet number
  isDefault: boolean;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `STEP_UP_REQUIRED` | payout-method change without fresh re-authentication |
| `422` | `PAYOUT_METHOD_INVALID` | malformed bank/wallet details |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Payout` | new | `id uuid pk`, `provider_id uuid fk->ProviderProfile`, `booking_id uuid fk->Booking`, `status text` (Pending/Eligible/Processing/Paid/Failed), `gross_amount_minor_units integer`, `fee_amount_minor_units integer`, `net_amount_minor_units integer`, `currency_code text`, `eligible_at timestamptz nullable`, `paid_at timestamptz nullable`, `failure_reason text nullable` |
| `PayoutMethod` | new | `id uuid pk`, `provider_id uuid fk->ProviderProfile`, `type text`, `encrypted_detail text` (never plaintext at rest; provider handles most sensitive data per master spec §48), `is_default boolean` |

Sensitive payout credentials are handled by the payment/payout provider where possible per
master spec §48 — `encrypted_detail` stores only what's necessary for display/reference, not
full account numbers.

### Migration

- **Name:** `AddPayoutTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Payout records are financial records retained regardless of account deletion; payout-method
details are highly sensitive and access-restricted, audited on every admin view (spec 039).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | earnings dashboard skeleton per figure block |
| **Empty** | new provider with no bookings yet: dashboard shows all-zero state with guidance, not a broken layout |
| **Error** | statement export failure allows retry; payout-method save failure preserves entered (non-sensitive) fields |
| **Success** | dashboard figures update live as bookings settle/refund |

Payout-method masked details shown by default (e.g. `****1234`); full detail never rendered
client-side after initial entry.

**Route(s):** `apps/web/app/provider/earnings`
**Shared components used/added:** `packages/ui` `StatBlock`, `Table`, `ConfirmDialog`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | earnings-figure math (net = gross − fee − refunds + adjustments), payout-eligibility transition logic | `apps/api/payouts/**/*.test.ts` |
| **Integration** | full Pending→Eligible→Paid lifecycle; refund-after-eligibility reconciliation; failed-payout recovery flagging | `apps/api/payouts/*.integration.test.ts` |
| **Financial** | payout pending, payout failure scenarios per master spec §113 | `apps/api/payouts/financial.integration.test.ts` |
| **E2E** | provider views dashboard, changes payout method with step-up re-auth | `apps/web-e2e/payouts.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/worker/payout-eligibility-job.integration.test.ts::transitions after protection window` |
| AC-2 | `apps/api/payouts/reconciliation.integration.test.ts::reflects post-eligibility refund` |
| AC-3 | `apps/api/payouts/earnings-math.test.ts::figures reconcile` |
| AC-4 | `apps/api/payouts/step-up.integration.test.ts::blocks without fresh reauth` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Payout-provider-specific transfer mechanics beyond the
abstraction contract (covered by the provider's own certification).

---

## 7. Out of scope

- Payment authorization/capture itself (spec 021).
- Refund issuance mechanics (spec 022) — this spec only reconciles against them.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Payout provider/rail selection for Pakistan (bank transfer + which mobile wallets) and credential availability | — | Open — sandbox/mock adapter required in the interim |
| 2 | Exact protection-window length before `Pending → Eligible` (ties to spec 021's protection window) | Product/Finance | Open |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; payout state is provider-authoritative where applicable.
- **Observability:** payout failure rate, average time-to-eligible, and statement-export
  failure rate monitored (master spec §117).
