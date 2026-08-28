# Spec: Admin Moderation & Fraud/Abuse

**File:** `docs/specs/2026-08-28-038-admin-moderation-fraud-abuse.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §66–§68, §79, §132.11, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §9.2, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 006 defines provider lifecycle states (Draft/Pending Verification/Active/Paused/
Restricted/Suspended/Banned) and spec 008 defines customer lifecycle states, but no admin action
catalog or fraud/abuse detection exists to actually drive those transitions. Master spec §68
requires moderation actions (warning, restriction, suspension, ban, content removal, booking
intervention, payout freeze, escalation) with reason, evidence, audit, appropriate approval, and
appeal. §79 requires rule-based safeguards plus AI-assisted anomaly detection, with human review
required for serious enforcement and no permanent ban from AI prediction alone.

**Who is affected:** Users subject to moderation; Trust & Safety and Operations admins; the
platform's overall integrity.

**Why it matters now:** By Milestone 11, real user/provider/booking activity exists to moderate;
it also formalizes the account-lifecycle transitions specs 006/008 already named but didn't
implement.

**Success looks like:** Admins can take the full moderation-action catalog against a user/
provider/listing with required reason, evidence, and appropriate approval tier (spec 009);
fraud/abuse signals (rule-based + AI-assisted) surface for human review; no permanent ban is
ever applied by AI alone; every action has an appeal path.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a user/provider **When** an admin issues a warning, restriction, suspension, or ban **Then** a reason is required, evidence is attached where applicable, and the account's lifecycle state (spec 006/008) transitions accordingly |
| AC-2 | **Given** a ban or other high/critical-risk moderation action **When** initiated **Then** it follows spec 009's four-eyes approval before taking effect |
| AC-3 | **Given** an AI-assisted anomaly-detection signal **When** it flags a user/provider **Then** it produces a review-queue entry, never an automatic ban or suspension |
| AC-4 | **Given** any moderation action **When** taken **Then** it is fully audited (spec 039) with actor, role, reason, evidence, target, and approval chain |
| AC-5 | **Given** a moderated user/provider **When** they wish to contest the action **Then** an appeal path exists and is reviewed by an admin (recommend: different from the original actor for high-risk actions, consistent with spec 031's dispute-appeal pattern) |
| AC-6 | **Given** a booking-intervention action (e.g. force-cancel due to fraud) **When** taken **Then** it correctly triggers the appropriate downstream state changes in spec 020/022/023 rather than mutating booking state directly and inconsistently |
| AC-7 | **Given** a payout-freeze action **When** taken **Then** it requires authorized approval (spec 009/070) and is reflected in spec 024's payout state |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/admin/users/{id}/moderation-actions` | admin (scoped by action risk tier) | `201` `ApiResponse<ModerationActionDto>` | reason required; high/critical routes through spec 009 approval |
| `GET` | `/api/v1/admin/moderation/fraud-signals` | admin (Trust & Safety) | `200` `PagedResponse<FraudSignalDto>` | AI + rule-based, review queue only |
| `POST` | `/api/v1/admin/moderation/fraud-signals/{id}/dismiss` | admin (Trust & Safety) | `200` | |
| `POST` | `/api/v1/admin/moderation/fraud-signals/{id}/act` | admin (Trust & Safety) | `200` | creates a `ModerationActionDto`, human-initiated |
| `POST` | `/api/v1/moderation-actions/{id}/appeal` | session (affected user) | `201` `ApiResponse<ModerationAppealDto>` | |
| `POST` | `/api/v1/admin/moderation-appeals/{id}/resolve` | admin (different from original actor for high-risk) | `200` | |

### Request and response types

```typescript
// packages/types/src/moderation.ts
export interface ModerationActionDto {
  id: string;
  targetUserId: string;
  actionType: 'warning' | 'restriction' | 'suspension' | 'ban' | 'content_removal' | 'booking_intervention' | 'payout_freeze';
  reason: string;
  evidenceFileAssetIds: string[];
  riskTier: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending_approval' | 'active' | 'reversed';
}

export interface FraudSignalDto {
  id: string;
  targetUserId: string;
  source: 'rule_based' | 'ai_assisted';
  signalType: string;
  confidence: 'low' | 'medium' | 'high';
  status: 'pending_review' | 'dismissed' | 'acted_on';
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `APPROVAL_REQUIRED` | high/critical action attempted without spec 009 approval flow |
| `422` | `REASON_REQUIRED` | moderation action submitted without a reason |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `AdminAction` | reuse (spec 009) | moderation actions are a specific `action_type` category within the existing `AdminAction`/`AdminActionApproval` framework, not a duplicate table |
| (new) `FraudSignal` | new | `id uuid pk`, `target_user_id uuid fk->User`, `source text`, `signal_type text`, `confidence text`, `status text`, `detail jsonb`, `created_at` |
| (new) `ModerationAppeal` | new | `id uuid pk`, `moderation_action_id uuid fk->AdminAction`, `filed_by_user_id uuid fk->User`, `reason text`, `status text`, `resolved_by_admin_id uuid nullable` |

### Migration

- **Name:** `AddFraudSignalModerationAppealTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Fraud signals and moderation evidence are sensitive; access restricted to Trust & Safety/
Operations admins per spec 009's RBAC, retained per legal/safety policy.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | fraud-signal queue and moderation-history skeletons |
| **Empty** | "No signals pending review" — clear, not alarming by default |
| **Error** | action submission failure preserves entered reason/evidence |
| **Success** | action confirmed with resulting lifecycle-state change shown; appeal path surfaced to the affected user via notification (spec 026) |

Moderation-action confirmation is a structured, high-risk dialog (master spec §90 pattern)
requiring explicit reason entry, never a one-click ban.

**Route(s):** `apps/web/app/admin/users/[id]/moderation`, `apps/web/app/admin/operations/fraud`
**Shared components used/added:** `packages/ui` `Table`, `ConfirmDialog`, `EvidenceGallery`
(reused from spec 031)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | risk-tier-to-approval mapping, reason-required validation | `apps/api/moderation/**/*.test.ts` |
| **Integration** | full moderation-action lifecycle with approval; fraud-signal review-queue-only enforcement (never auto-acts); appeal flow | `apps/api/moderation/*.integration.test.ts` |
| **Security/permission** | AI fraud signal cannot directly trigger a ban without human action | `apps/api/moderation/ai-safeguard.integration.test.ts` |
| **E2E** | admin reviews a fraud signal, takes a moderation action with approval, user appeals | `apps/web-e2e/moderation.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-2 | `apps/api/moderation/approval.integration.test.ts::high risk requires four-eyes` |
| AC-3 | `apps/api/moderation/ai-safeguard.integration.test.ts::ai signal never auto-bans` |
| AC-6 | `apps/api/moderation/booking-intervention.integration.test.ts::triggers correct downstream state` |
| AC-7 | `apps/api/moderation/payout-freeze.integration.test.ts::reflected in payout state` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The fraud-detection model/heuristics' precision — functional
correctness of the human-in-the-loop guarantee is tested, not detection quality.

---

## 7. Out of scope

- Safety-report-specific workflow (spec 030 — moderation actions may result from a safety
  report, but the report workflow itself lives there).
- Dispute resolution (spec 031) — distinct from moderation (disputes are transactional
  disagreements; moderation is platform-integrity enforcement).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact fraud/anomaly-detection rule set and AI-assist scope for MVP | Trust & Safety/Product | Open — recommend starting rule-based only, AI-assist as a fast-follow once spec 033 exists |

---

## 9. Rollout

- **Feature flag:** `ai-fraud-signals` (default off until the rule-based baseline is validated)
  — moderation-action mechanics themselves have no flag (core trust infrastructure).
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy.
- **Observability:** moderation-action volume by type, appeal rate, and fraud-signal
  dismiss-vs-act ratio monitored (master spec §117) — a high dismiss rate signals the detection
  needs tuning.
