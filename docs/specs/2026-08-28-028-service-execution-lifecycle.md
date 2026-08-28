# Spec: Service Execution Lifecycle

**File:** `docs/specs/2026-08-28-028-service-execution-lifecycle.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §43–§45, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 020 defines the booking state machine's transition rules but the detailed
arrival/progress/completion-evidence *workflow content* (milestones, evidence requirements per
service/policy) is master spec §43–§45's own scope and deserves its own acceptance criteria
distinct from the raw state machine, since it drives what providers actually see and do minute
to minute during a job.

**Who is affected:** Providers executing jobs; customers tracking progress; disputes (031),
which may need completion evidence as input.

**Why it matters now:** It's the operational heart of the "Service" step in the customer/
provider journeys (`docs/workflow.md` §1) and must be solid before reviews (029) can trust that
"Completed" actually means something.

**Success looks like:** A provider's arrival, service start, optional progress milestones, and
completion (with evidence where required) are captured accurately and shown to the customer in
real time, without forcing providers into unnecessary constant status updates.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a confirmed booking **When** the provider taps "I've Arrived" **Then** the booking status updates to `Provider En Route`/`Arrived` (per spec 020's exact sequence) and the customer sees this in near real time |
| AC-2 | **Given** an arrived provider **When** they tap "Start Service" **Then** status becomes `In Progress` |
| AC-3 | **Given** a service with optional milestones (Started/Working/Almost Done/custom) **When** the provider posts one **Then** it's recorded and shown to the customer, but providers are never forced to post milestones to progress the booking |
| AC-4 | **Given** a service where the policy/service definition requires completion evidence **When** the provider attempts to mark complete without it **Then** completion is blocked until evidence (photo/video/document) is attached |
| AC-5 | **Given** a service where evidence is optional **When** the provider marks complete without it **Then** completion succeeds |
| AC-6 | **Given** location/time signals available during arrival **When** used **Then** they support (not replace) the provider's explicit action — arrival state never changes purely from a GPS ping without the provider's "I've Arrived" action |
| AC-7 | **Given** a completed booking with evidence **When** the customer views it **Then** they can see the relevant evidence |

---

## 3. API contract

Endpoints reuse and extend spec 020's booking-lifecycle routes:

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/bookings/{id}/milestones` | session (provider, owner) | `201` `ApiResponse<BookingMilestoneDto>` | optional |
| `GET` | `/api/v1/bookings/{id}/milestones` | session (participant) | `200` `ApiResponse<BookingMilestoneDto[]>` | |
| `POST` | `/api/v1/bookings/{id}/complete` | session (provider, owner) | `200` `ApiResponse<BookingDto>` | reuses spec 020's endpoint; this spec defines the evidence-requirement branch in detail |

### Request and response types

```typescript
// packages/types/src/service-execution.ts
export interface BookingMilestoneDto {
  id: string;
  bookingId: string;
  milestone: 'started' | 'working' | 'almost_done' | string; // custom milestones as free text
  note?: string;
  createdAt: string;
}

export interface CompleteBookingRequest {
  evidenceFileAssetIds?: string[];
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `COMPLETION_EVIDENCE_REQUIRED` | service/policy mandates evidence not provided (reused from spec 020) |

### Breaking-change check

- [x] N/A — extends spec 020's contract additively

---

## 4. Data model changes

### Entities

Reuses `BookingMilestone` (stubbed in spec 020). Adds:

| Entity | Change | Fields |
|---|---|---|
| `Service` | extend (spec 010) | `completion_evidence_required boolean default false` |
| `BookingMilestone` | reuse | already defined in spec 020 |

Completion evidence attachments reference `FileAsset` (spec 027) via `context_type =
'booking_evidence'`.

### Migration

- **Name:** `AddCompletionEvidenceRequirement`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Completion evidence may include photos of a customer's property — private by default (spec 027
visibility rules), shared only with the customer and, if a dispute arises, Trust & Safety
(spec 031).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | provider's active-job screen shows current status with a live timer since start |
| **Empty** | no milestones posted: customer sees the base status only, not an empty milestone list |
| **Error** | complete-without-required-evidence attempt shows exactly what's missing, inline on the same screen |
| **Success** | each transition (arrived/started/milestone/complete) confirms with a toast and updates the customer's live status view |

**Route(s):** `apps/web/app/provider/schedule/bookings/[id]/active`,
`apps/web/app/bookings/[id]` (customer live view)
**Shared components used/added:** `packages/ui` `StatusTimeline` (reused), `EvidenceUpload`
(reused from spec 027)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | evidence-requirement branch logic | `apps/api/bookings/**/*.test.ts` |
| **Integration** | arrival→start→milestone→complete flow with and without required evidence | `apps/api/bookings/execution.integration.test.ts` |
| **E2E** | provider completes a job requiring evidence; attempt without evidence is blocked | `apps/web-e2e/service-execution.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-3 | `apps/api/bookings/milestones.integration.test.ts::optional, never forced` |
| AC-4 | `apps/api/bookings/execution.integration.test.ts::blocks completion without required evidence` |
| AC-6 | `apps/api/bookings/arrival.integration.test.ts::location signal does not unilaterally change state` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The booking state machine's transition validation itself (spec
020 — this spec only covers the workflow content within valid transitions).

---

## 7. Out of scope

- Payment protection window transitions triggered by completion (spec 021).
- Review eligibility triggered by completion (spec 029).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Which specific services require completion evidence by default | Product | Open — decided per-service in the catalog (spec 010/011), not hard-coded here |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy.
- **Observability:** completion-evidence-block rate and milestone-usage rate monitored (spec
  040).
