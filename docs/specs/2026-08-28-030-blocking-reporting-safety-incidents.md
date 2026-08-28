# Spec: Blocking, Reporting & Safety Incidents

**File:** `docs/specs/2026-08-28-030-blocking-reporting-safety-incidents.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §53, §64–§65, §132.17, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §9, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No blocking, reporting, or safety-incident workflow exists. Master spec §53 requires
block/report with future-contact prevention where appropriate, while keeping existing-booking
safety/support communication available. §64 requires a dedicated Safety Report workflow with
priority classification, evidence preservation, restricted access, escalation, and full audit —
AI must never independently decide serious safety enforcement. §65 requires urgent-job handling
that is clear Apuriva is a marketplace, not an emergency service.

**Who is affected:** Any user needing to protect themselves from another user; Trust & Safety
admins; anyone in a genuine emergency who needs to be redirected appropriately.

**Why it matters now:** Messaging (025) already references blocking's effect; this spec is where
blocking/reporting/safety-incident mechanics are actually defined.

**Success looks like:** A user can block/report another user; blocking prevents future contact/
matching while preserving safety-relevant existing-booking communication; a safety report goes
through a restricted, escalated, fully audited human-reviewed workflow; urgent-job requests are
clearly scoped as marketplace urgency, not emergency response.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** user A blocks user B **When** the block is active **Then** B cannot message A or be matched to A's future requests, but existing-booking communication required for safety/support remains reachable by the safety team |
| AC-2 | **Given** a user reports another user or a listing **When** submitted **Then** it enters a moderation/safety queue with the reason and any evidence |
| AC-3 | **Given** a safety report **When** submitted **Then** it is priority-classified, evidence is preserved (via spec 027's private storage), access is restricted to Trust & Safety admins, and every action on it is audited |
| AC-4 | **Given** a safety report **When** the AI assistant is involved in any part of the flow (e.g. drafting a summary) **Then** it never independently decides enforcement — only a human Trust & Safety admin can apply restrictions/bans (master spec §132.17) |
| AC-5 | **Given** a safety report requiring temporary restriction **When** applied **Then** it follows spec 009's risk-tiered approval where applicable, and is reversible pending review |
| AC-6 | **Given** a customer marks a request "Urgent/ASAP" **When** the AI or UI responds **Then** it clarifies Apuriva is a marketplace, not an emergency authority, and for genuine emergencies directs the user to appropriate local emergency services |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/users/{id}/block` | session | `201` | |
| `DELETE` | `/api/v1/users/{id}/block` | session | `204` | unblock |
| `POST` | `/api/v1/reports` | session | `201` `ApiResponse<ReportDto>` | targets a user, listing, or review |
| `POST` | `/api/v1/safety-reports` | session | `201` `ApiResponse<SafetyReportDto>` | evidence attachments via spec 027, private visibility |
| `GET` | `/api/v1/admin/safety-reports` | admin (Trust & Safety only) | `200` `PagedResponse<SafetyReportDto>` | restricted access |
| `POST` | `/api/v1/admin/safety-reports/{id}/escalate` | admin (Trust & Safety) | `200` | |
| `POST` | `/api/v1/admin/safety-reports/{id}/resolve` | admin (Trust & Safety) | `200` | reason + evidence required |

### Request and response types

```typescript
// packages/types/src/safety.ts
export interface SafetyReportDto {
  id: string;
  reportedByUserId: string;
  targetUserId?: string;
  bookingId?: string;
  category: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'submitted' | 'under_review' | 'escalated' | 'resolved';
  evidenceFileAssetIds: string[];
  createdAt: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | non-Trust&Safety admin attempts to access safety report detail |
| `403` | `BLOCKED` | blocked user attempts to message/match (ties to spec 025/016) |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `SafetyReport` | new | `id uuid pk`, `reported_by_user_id uuid fk->User`, `target_user_id uuid fk->User nullable`, `booking_id uuid fk->Booking nullable`, `category text`, `priority text`, `status text`, `created_at`, `resolved_at timestamptz nullable`, `resolved_by_admin_id uuid nullable` |
| `ReviewReport` | reuse (spec 029) | review-specific reports already covered there |
| (blocking) | new `UserBlock` | `id uuid pk`, `blocker_user_id uuid fk->User`, `blocked_user_id uuid fk->User`, `created_at`, unique `(blocker_user_id, blocked_user_id)` |

Safety-report evidence attachments reference `FileAsset` (spec 027) with `visibility: private`
and access restricted to Trust & Safety admins specifically (not all admin roles).

### Migration

- **Name:** `AddSafetyBlockingTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Safety reports and evidence are the most sensitive data category in the platform — access
strictly limited to Trust & Safety admins, every read audited (spec 039), retained per legal/
safety policy independent of normal account-deletion timelines where required.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | report submission shows progress, especially while evidence uploads |
| **Empty** | admin safety queue with nothing pending shows a clear "queue clear" state |
| **Error** | report submission failure preserves entered text/evidence selection |
| **Success** | reporter sees confirmation and, where appropriate, next steps/support contact — never a false promise of immediate resolution |

Urgent-job UI (AC-6) always pairs the "Urgent/ASAP" option with a visible marketplace-vs-
emergency clarification, not buried in fine print.

**Route(s):** `apps/web/app/support/report`, `apps/web/app/admin/operations/safety`
**Shared components used/added:** `packages/ui` `ReportForm`, `PriorityBadge`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | priority classification logic, block-effect propagation rules | `apps/api/safety/**/*.test.ts` |
| **Integration** | full report→escalate→resolve flow; blocking prevents future matching/messaging; restricted access enforcement | `apps/api/safety/*.integration.test.ts` |
| **Security/permission** | non-Trust&Safety admin cannot read safety-report detail | `apps/api/safety/access.integration.test.ts` |
| **E2E** | user blocks another, reports a safety concern; Trust & Safety admin resolves it | `apps/web-e2e/safety.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/safety/blocking.integration.test.ts::prevents future contact, preserves safety access` |
| AC-3 | `apps/api/safety/report.integration.test.ts::restricted access, full audit` |
| AC-4 | `apps/api/safety/ai-involvement.test.ts::ai never independently enforces` |
| AC-6 | `apps/web/UrgentJobPrompt.test.tsx::shows marketplace-not-emergency clarification` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Fraud/abuse ML signal generation (spec 038 — this spec covers
user-initiated reports and the safety-report workflow, not automated fraud detection).

---

## 7. Out of scope

- Formal admin moderation actions (warnings, suspensions, bans) beyond what's needed to resolve
  a safety report — the full moderation action catalog is spec 038.
- Dispute resolution for transactional disagreements (spec 031) — safety reports are for safety
  concerns specifically, not price/quality disputes.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact priority-classification rules (what makes a report "critical" vs. "high") | Trust & Safety | Open |
| 2 | Legal requirements for safety-evidence retention period, which may exceed normal data policy | Legal | Open |

---

## 9. Rollout

- **Feature flag:** none — safety features are not optional.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; safety-report data itself is never destroyed by a rollback.
- **Observability:** safety-report volume, time-to-resolution, and escalation rate monitored,
  with dedicated alerting for Trust & Safety (master spec §117).
