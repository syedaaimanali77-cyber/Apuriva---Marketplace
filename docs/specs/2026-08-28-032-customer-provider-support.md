# Spec: Customer & Provider Support

**File:** `docs/specs/2026-08-28-032-customer-provider-support.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §62–§63, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No support-ticket system exists. Master spec §62 requires a smart hybrid support
experience: AI handles common questions, users can request a human, category-based issue
reporting, booking/payment/dispute context auto-attached, ticket history, priority, and
safety/payment escalation. §63 requires a unified admin support workspace (queue, priority,
context, conversation, internal notes, attachments, assignment, SLA, AI summary, audit trail).

**Who is affected:** Every customer/provider with an issue; Support Admins triaging tickets.

**Why it matters now:** It's the general-purpose escalation path once the specific flows (offers,
bookings, payments, disputes, safety) exist to attach context from.

**Success looks like:** A user can get AI-assisted help for common questions or escalate to a
human ticket with relevant context auto-attached; Support Admins work from a unified inbox with
priority, assignment, SLA, and full audit trail.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a common question **When** asked via the AI assistant **Then** it's answered directly where possible, with a clear "talk to a human" escalation option always available |
| AC-2 | **Given** a user creates a support ticket from a specific booking/payment/dispute context **When** submitted **Then** that context (booking ID, payment status, dispute ID) is automatically attached, not requiring the user to re-explain it |
| AC-3 | **Given** a support ticket **When** viewed by the user **Then** they see its history and current status |
| AC-4 | **Given** a payment or safety-related ticket **When** categorized **Then** it is escalated/prioritized appropriately rather than treated as a generic low-priority ticket |
| AC-5 | **Given** the admin support workspace **When** an admin views the unified inbox **Then** they see queue, priority, associated customer/provider/booking/payment/dispute, conversation, internal notes, attachments, assignment, SLA/deadline, and an AI-generated summary |
| AC-6 | **Given** any admin action on a ticket (assignment, note, resolution) **When** taken **Then** it is recorded to the audit trail (spec 039) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/support/tickets` | session | `201` `ApiResponse<SupportTicketDto>` | optional `contextType`/`contextId` (booking/payment/dispute) |
| `GET` | `/api/v1/support/tickets` | session (own only) | `200` `PagedResponse<SupportTicketSummaryDto>` | |
| `GET` | `/api/v1/support/tickets/{id}` | session (owner) or admin (Support) | `200` `ApiResponse<SupportTicketDto>` | |
| `POST` | `/api/v1/support/tickets/{id}/messages` | session (owner) or admin | `201` | |
| `GET` | `/api/v1/admin/support/inbox` | admin (Support) | `200` `PagedResponse<SupportTicketDto>` | filterable by priority/assignment/category |
| `POST` | `/api/v1/admin/support/tickets/{id}/assign` | admin (Support) | `200` | |
| `POST` | `/api/v1/admin/support/tickets/{id}/notes` | admin (Support) | `201` | internal, never customer-visible |
| `POST` | `/api/v1/admin/support/tickets/{id}/resolve` | admin (Support) | `200` | |

### Request and response types

```typescript
// packages/types/src/support.ts
export interface SupportTicketDto {
  id: string;
  category: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'assigned' | 'awaiting_user' | 'resolved' | 'closed';
  contextType?: 'booking' | 'payment' | 'dispute';
  contextId?: string;
  assignedAdminId?: string;
  slaDeadline?: string;
  aiSummary?: string;
  createdAt: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | non-owner, non-Support-admin attempts to view a ticket |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `SupportTicket` | new | `id uuid pk`, `user_id uuid fk->User`, `category text`, `priority text`, `status text`, `context_type text nullable`, `context_id uuid nullable`, `assigned_admin_id uuid fk->AdminProfile nullable`, `sla_deadline timestamptz nullable`, `ai_summary text nullable`, `created_at`, `updated_at` |
| `SupportMessage` | new | `id uuid pk`, `ticket_id uuid fk->SupportTicket`, `sender_type text`, `sender_id uuid`, `body text`, `created_at` |
| `SupportNote` | new | `id uuid pk`, `ticket_id uuid fk->SupportTicket`, `admin_id uuid fk->AdminProfile`, `body text`, `created_at` |

### Migration

- **Name:** `AddSupportTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Tickets contain personal/transactional data; retained per platform policy, included in export
(spec 008); `SupportNote` (internal) is never exposed to the ticket owner under any
circumstance.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | ticket list/detail skeleton; admin inbox skeleton per queue section |
| **Empty** | user with no tickets sees a "Get help" entry point, not a blank history |
| **Error** | ticket creation failure preserves entered description/attachments |
| **Success** | ticket confirmation shows expected response context (AI-answered vs. queued for a human) |

**Route(s):** `apps/web/app/support`, `apps/web/app/admin/operations/support`
**Shared components used/added:** `packages/ui` `Chat` (reused), `Table`, `PriorityBadge`
(reused from spec 030)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | context-attachment resolution, priority/category classification | `apps/api/support/**/*.test.ts` |
| **Integration** | ticket creation with context; admin assignment/notes/resolution; internal notes never leak to user-facing endpoints | `apps/api/support/*.integration.test.ts` |
| **E2E** | user creates a ticket from a booking, gets AI answer or escalates, admin resolves | `apps/web-e2e/support.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-2 | `apps/api/support/tickets.integration.test.ts::auto-attaches context` |
| AC-4 | `apps/api/support/priority.integration.test.ts::escalates payment/safety tickets` |
| AC-5 | `apps/api/admin/support-inbox.integration.test.ts::returns unified fields` |
| AC-6 | `apps/api/support/audit.integration.test.ts::admin actions logged` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The AI's answer-quality for common questions — functional
correctness of the escalation path is tested, not response quality (product-iteration concern).

---

## 7. Out of scope

- Safety-specific reporting (spec 030 — safety reports are a distinct, more restricted workflow;
  a support ticket may be reclassified/escalated into one, but that's spec 030's territory).
- SLA-breach automated consequences beyond visibility (e.g. auto-escalation logic can be a
  follow-up, not required for MVP acceptance here).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | SLA deadlines per priority tier | Support Ops | Open |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy.
- **Observability:** ticket volume by category, SLA-breach rate, and AI-resolution rate (vs.
  human escalation) monitored (spec 040).
