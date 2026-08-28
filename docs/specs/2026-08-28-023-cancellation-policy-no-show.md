# Spec: Cancellation Policy & No-show

**File:** `docs/specs/2026-08-28-023-cancellation-policy-no-show.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §50–§51, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No cancellation-fee or no-show workflow exists. Master spec §50 requires a smart
hybrid policy: platform defaults, service/category overrides, provider choice within allowed
options, customer sees the policy before paying — with an example timing-based structure
(>24h free, 12–24h small fee, <12h higher fee), fully configurable. §51 requires a no-show flow
that gathers signals and never auto-accuses based solely on GPS/timestamps.

**Who is affected:** Customers cancelling bookings; providers who lose time to late
cancellations/no-shows; Trust & Safety handling disputes over who's at fault.

**Why it matters now:** Booking (020) and refunds (022) both need a real policy engine to
compute consequences rather than hard-coded values.

**Success looks like:** A customer sees the applicable cancellation policy before booking/
paying; cancelling triggers the correct fee tier automatically; a no-show report gathers real
signals and requires the other party's response before any policy is applied, never an
automatic accusation from timestamps alone.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a booking **When** the customer views it before paying **Then** the applicable cancellation policy (fee tiers by timing) is shown clearly |
| AC-2 | **Given** a cancellation more than 24 hours before the scheduled time **When** the policy default applies **Then** it is free (or whatever the effective configured tier is) |
| AC-3 | **Given** a cancellation 12–24 hours before **When** processed **Then** the configured smaller fee is charged; **given** less than 12 hours **Then** the higher fee is charged — computed server-side from the effective policy, never a client-supplied fee amount |
| AC-4 | **Given** a service/category-level policy override **When** it conflicts with the platform default **Then** the override takes precedence, and a provider can only choose from the options the override/platform allows (not invent arbitrary fees) |
| AC-5 | **Given** a reported no-show **When** submitted **Then** the flow gathers booking timing, status history, location signals (where appropriate), and communications, and requires the other party's response before any policy consequence is applied |
| AC-6 | **Given** repeated verified no-shows by the same party **When** tracked **Then** it affects their reliability signal (feeds spec 016's ranking factor), without an automatic ban (master spec §132.11) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/services/{id}/cancellation-policy` | none | `200` `ApiResponse<CancellationPolicyDto>` | effective policy after platform/category/service resolution |
| `POST` | `/api/v1/bookings/{id}/cancel` | session (customer or provider, owner) | `200` `ApiResponse<{ booking: BookingDto; feeAmountMinorUnits: number }>` | computes fee server-side, triggers spec 022's refund/charge as applicable |
| `POST` | `/api/v1/bookings/{id}/report-no-show` | session (participant) | `201` `ApiResponse<NoShowReportDto>` | |
| `POST` | `/api/v1/no-show-reports/{id}/respond` | session (the other party) | `200` | required before resolution |
| `POST` | `/api/v1/admin/no-show-reports/{id}/resolve` | admin (Trust & Safety) | `200` | applies policy consequence |

### Request and response types

```typescript
// packages/types/src/cancellation.ts
export interface CancellationPolicyDto {
  tiers: Array<{ hoursBeforeMin: number; hoursBeforeMax: number | null; feePercent: number }>;
  source: 'platform_default' | 'category_override' | 'service_override';
}

export interface NoShowReportDto {
  id: string;
  bookingId: string;
  reportedByType: 'customer' | 'provider';
  status: 'awaiting_response' | 'under_review' | 'resolved';
  signals: { bookingTiming: string; statusHistory: string[]; locationSignal?: string };
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `POLICY_OPTION_NOT_ALLOWED` | provider attempts to configure a fee tier outside allowed options |
| `409` | `NO_SHOW_REPORT_ALREADY_EXISTS` | duplicate report for the same booking |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Policy` | new | `id uuid pk`, `type text` ('cancellation'), `scope text` ('platform'/'category'/'service'), `scope_id uuid nullable`, `is_active boolean` |
| `PolicyVersion` | new | `id uuid pk`, `policy_id uuid fk->Policy`, `config jsonb` (fee tiers), `created_at`, `created_by_admin_id uuid nullable` |
| `PolicyAcceptance` | new | `id uuid pk`, `booking_id uuid fk->Booking`, `policy_version_id uuid fk->PolicyVersion`, `accepted_at timestamptz` |
| `Booking` | extend (spec 020) | add `Cancelled` handling already in state machine; no new column beyond linking to the fee-charge record |
| (no-show) | new `NoShowReport` | `id uuid pk`, `booking_id uuid fk->Booking`, `reported_by_type text`, `status text`, `signals jsonb`, `resolution text nullable`, `resolved_by_admin_id uuid nullable`, `created_at` |

`PolicyAcceptance` records exactly which policy version applied to a given booking, so a later
policy change never retroactively alters an already-booked customer's terms.

### Migration

- **Name:** `AddCancellationPolicyNoShowTables`
- **Reversible:** yes
- **Backfill required:** yes — seed the platform-default policy
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

No-show reports may include location signals tied to both parties — retained per dispute-
evidence policy (ties to spec 031), not indefinitely.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | policy display skeleton on booking screen |
| **Empty** | N/A |
| **Error** | cancellation attempt failure (e.g. already past a cancellable state) shows why |
| **Success** | cancellation confirms with the exact fee shown before commit (never surprise-charged) |

No-show report flow explicitly avoids presenting the report as a verdict — status language is
neutral ("under review") until an admin resolves it (master spec §51's "do not automatically
accuse" rule reflected in UI copy, not just backend logic).

**Route(s):** `apps/web/app/bookings/[id]/cancel`, `apps/web/app/bookings/[id]/report-issue`
**Shared components used/added:** `packages/ui` `PolicyDisplay` (new), `ConfirmDialog`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | policy resolution precedence (platform < category < service), fee-tier calculation | `apps/api/cancellation/**/*.test.ts` |
| **Integration** | cancellation at each timing tier charges the correct fee; no-show flow requires other-party response before resolution | `apps/api/cancellation/*.integration.test.ts` |
| **Financial** | cancellation-fee charge scenarios per master spec §113 | `apps/api/cancellation/financial.integration.test.ts` |
| **E2E** | customer cancels within the fee window, sees and pays the correct fee | `apps/web-e2e/cancellation.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-2, AC-3 | `apps/api/cancellation/fee-tiers.integration.test.ts::charges correct tier by timing` |
| AC-4 | `apps/api/cancellation/policy-resolution.test.ts::override precedence` |
| AC-5 | `apps/api/cancellation/no-show.integration.test.ts::requires other party response before resolution` |
| AC-6 | `apps/api/cancellation/reliability.integration.test.ts::repeated no-shows affect reliability signal, not auto-ban` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The actual refund/charge execution mechanics (spec 022) — this
spec computes the fee and hands off to spec 022's refund/payment flow.

---

## 7. Out of scope

- Formal dispute resolution once a no-show report escalates beyond initial review (spec 031).
- Provider reliability scoring algorithm details beyond "no-shows are one input" (spec 016 owns
  ranking; this spec only supplies the signal).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact default fee percentages per tier | Product | Open — master spec gives an example structure, not final numbers |
| 2 | Which location signals are "appropriate" to use for no-show evidence without over-relying on GPS alone | Trust & Safety | Open |

---

## 9. Rollout

- **Feature flag:** none — but policy *values* are admin-configurable data, not code, from day
  one (spec 041 exposes the config surface).
- **Migration order:** schema + default policy seed ships with code.
- **Rollback:** revert deploy; `PolicyAcceptance` ensures already-booked customers are
  unaffected by any policy-config rollback/change.
- **Observability:** cancellation-fee dispute rate and no-show report volume monitored (spec
  040); alert Trust & Safety on repeated-offender patterns.
