# Spec: Disputes & Resolution

**File:** `docs/specs/2026-08-28-031-disputes-resolution.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §124 (Dispute entities), §68, §70, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No dispute workflow exists, though `Dispute`, `DisputeEvidence`, `DisputeMessage`,
`DisputeResolution`, and `DisputeAppeal` are named entities in master spec §124 and disputes are
referenced throughout (refunds §49, payment protection §47, no-show §51) as the escalation path
when parties disagree.

**Who is affected:** Customers/providers in disagreement over a booking's outcome; Operations
and Trust & Safety admins resolving disputes; payouts (024), which must hold funds pending
dispute resolution.

**Why it matters now:** It's the formal escalation path for every prior transactional
disagreement (cancellation fees, no-shows, quality complaints) that isn't resolved by the
parties themselves.

**Success looks like:** Either party can open a dispute on a booking with evidence; it follows a
clear lifecycle with admin resolution and an appeal path; payout/refund decisions from spec
022/024 are correctly gated while a dispute is open.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a completed or in-progress booking with a disagreement **When** either party opens a dispute **Then** it is created with a required reason and optional evidence, linked to that booking |
| AC-2 | **Given** an open dispute **When** the booking's payout would otherwise become eligible **Then** the payout is held pending dispute resolution (ties to spec 024) |
| AC-3 | **Given** a dispute with evidence and messages from both sides **When** an Operations or Trust & Safety admin resolves it **Then** the resolution records the decision, reasoning, and any resulting refund/payout action, fully audited |
| AC-4 | **Given** a resolved dispute **When** a party disagrees with the outcome **Then** they can file an appeal, which is reviewed by a different admin than the original resolver |
| AC-5 | **Given** a dispute resolution involving a refund **When** applied **Then** it goes through spec 022's refund flow, not a separate ad hoc payment adjustment |
| AC-6 | **Given** a dispute **When** the AI assistant is involved (e.g. summarizing evidence) **Then** it never independently resolves the dispute — only a human admin can (master spec §132.17, consistent with spec 030's safety rule) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/bookings/{id}/disputes` | session (participant) | `201` `ApiResponse<DisputeDto>` | |
| `GET` | `/api/v1/disputes/{id}` | session (participant) or admin | `200` `ApiResponse<DisputeDto>` | |
| `POST` | `/api/v1/disputes/{id}/evidence` | session (participant) | `201` | via spec 027 |
| `POST` | `/api/v1/disputes/{id}/messages` | session (participant) | `201` | dispute-scoped, distinct from booking chat |
| `POST` | `/api/v1/admin/disputes/{id}/resolve` | admin (Operations/Trust&Safety) | `200` `ApiResponse<DisputeResolutionDto>` | reason required |
| `POST` | `/api/v1/disputes/{id}/appeal` | session (participant) | `201` `ApiResponse<DisputeAppealDto>` | only after resolution |

### Request and response types

```typescript
// packages/types/src/disputes.ts
export interface DisputeDto {
  id: string;
  bookingId: string;
  openedByUserId: string;
  reason: string;
  status: 'open' | 'under_review' | 'resolved' | 'appealed' | 'closed';
  evidenceFileAssetIds: string[];
}

export interface DisputeResolutionDto {
  disputeId: string;
  decision: string;
  reasoning: string;
  refundId?: string;
  resolvedByAdminId: string;
  resolvedAt: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `DISPUTE_NOT_ELIGIBLE` | booking state doesn't support opening a dispute |
| `403` | `APPEAL_REQUIRES_DIFFERENT_ADMIN` | appeal reviewer is the same admin as the original resolver |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Dispute` | new | `id uuid pk`, `booking_id uuid fk->Booking`, `opened_by_user_id uuid fk->User`, `reason text`, `status text`, `created_at` |
| `DisputeEvidence` | new | `id uuid pk`, `dispute_id uuid fk->Dispute`, `file_asset_id uuid fk->FileAsset`, `submitted_by_user_id uuid fk->User` |
| `DisputeMessage` | new | `id uuid pk`, `dispute_id uuid fk->Dispute`, `sender_id uuid fk->User`, `body text`, `created_at` |
| `DisputeResolution` | new | `id uuid pk`, `dispute_id uuid fk->Dispute unique`, `decision text`, `reasoning text`, `refund_id uuid fk->Refund nullable`, `resolved_by_admin_id uuid fk->AdminProfile`, `resolved_at timestamptz` |
| `DisputeAppeal` | new | `id uuid pk`, `dispute_id uuid fk->Dispute`, `filed_by_user_id uuid fk->User`, `reason text`, `status text`, `reviewed_by_admin_id uuid nullable` |

### Migration

- **Name:** `AddDisputeTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Dispute evidence/messages are sensitive, access-restricted to participants and assigned admins;
retained per legal/audit policy given their financial-decision relevance.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | dispute detail skeleton |
| **Empty** | admin dispute queue with none open shows a clear "queue clear" state |
| **Error** | evidence-upload failure within a dispute preserves already-submitted evidence |
| **Success** | resolution shown to both parties with the reasoning, not just the outcome, per master spec §2.3 explainability |

**Route(s):** `apps/web/app/bookings/[id]/dispute`, `apps/web/app/admin/operations/disputes`
**Shared components used/added:** `packages/ui` `Timeline`, `EvidenceGallery`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | dispute-eligibility check, appeal different-admin enforcement | `apps/api/disputes/**/*.test.ts` |
| **Integration** | full open→evidence→resolve→appeal flow; payout hold while open; refund integration | `apps/api/disputes/*.integration.test.ts` |
| **E2E** | customer opens a dispute, admin resolves with a partial refund, customer appeals | `apps/web-e2e/disputes.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-2 | `apps/api/payouts/dispute-hold.integration.test.ts::holds payout while dispute open` |
| AC-3 | `apps/api/disputes/resolve.integration.test.ts::records decision, audited` |
| AC-4 | `apps/api/disputes/appeal.integration.test.ts::requires different admin` |
| AC-5 | `apps/api/disputes/resolve.integration.test.ts::refund goes through spec 022 flow` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The substantive quality of admin dispute decisions — process
correctness is tested, not the "rightness" of a given human judgment call.

---

## 7. Out of scope

- Safety-specific incident handling (spec 030 — disputes are transactional disagreements, not
  safety concerns, though a dispute can be escalated to a safety report if it reveals one).
- Automated dispute resolution / AI-decided outcomes (explicitly excluded by master spec
  §132.17).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Dispute-eligibility window (how long after booking completion can a dispute be opened) | Product | Open |
| 2 | Whether Operations Admin or Trust & Safety Admin (or both, by dispute type) owns resolution — master spec §69 lists both roles with overlapping relevance | — | Open — recommend routing by dispute category |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy.
- **Observability:** dispute volume, average resolution time, and appeal rate monitored (spec
  040); alert on rising appeal rate as a quality signal.
