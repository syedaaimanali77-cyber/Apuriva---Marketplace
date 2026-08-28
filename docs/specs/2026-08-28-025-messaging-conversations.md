# Spec: Messaging & Conversations

**File:** `docs/specs/2026-08-28-025-messaging-conversations.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §54–§55, §132.13, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §6.1, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 018 provides limited pre-booking, request-scoped chat. Master spec §54 requires
full post-booking conversation once a provider is selected, with personal phone/email never
publicly exposed, and detection of risky off-platform contact-sharing without over-blocking
legitimate service info. §55 requires retention rules: active chats accessible, historical
retention configurable, admin access restricted and audited.

**Who is affected:** Every customer/provider pair with a confirmed booking; Trust & Safety
monitoring for off-platform circumvention.

**Why it matters now:** Booking (020) creates the relationship that full messaging attaches to;
it's the natural next step once a booking exists.

**Success looks like:** A confirmed booking has a full conversation thread; personal contact
info stays private by default; risky off-platform-transaction language is flagged without
blocking legitimate service-related messages; retention and admin-access rules are enforced and
audited.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a confirmed booking **When** either party opens the conversation **Then** they can send/receive messages in real time (WebSocket), tied to that booking |
| AC-2 | **Given** a message containing a phone number or email pattern **When** sent before the platform explicitly allows contact sharing for that booking stage **Then** it is flagged/masked and the sender is shown guidance, without silently dropping legitimate content |
| AC-3 | **Given** an active booking conversation **When** either party accesses it **Then** full history for that booking remains accessible to them |
| AC-4 | **Given** historical (non-active) conversations **When** retention policy expires them **Then** they are handled per the configured retention rule, not kept indefinitely by default |
| AC-5 | **Given** an admin accessing a conversation for support/safety purposes **When** they view it **Then** the access is logged to the audit trail (spec 039) with reason |
| AC-6 | **Given** a blocked user (spec 030) **When** the block is active **Then** new messages between the two are prevented, except where safety/support access is explicitly required |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/bookings/{id}/conversation` | session (participant) | `200` `ApiResponse<ConversationDto>` | |
| `POST` | `/api/v1/bookings/{id}/conversation/messages` | session (participant) | `201` `ApiResponse<MessageDto>` | rate-limited |
| `GET` | `/api/v1/bookings/{id}/conversation/messages` | session (participant) | `200` `PagedResponse<MessageDto>` | |
| `WS` | `/api/v1/ws/conversations/{id}` | session (participant) | — | real-time delivery, reconnect/resume supported |
| `GET` | `/api/v1/admin/conversations/{id}` | admin (Support/Trust&Safety) | `200` `ApiResponse<ConversationDto>` | audited access |

### Request and response types

```typescript
// packages/types/src/messaging.ts
export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  flaggedForContactSharing: boolean;
  attachmentIds: string[];
  createdAt: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `BLOCKED` | one party has blocked the other |
| `429` | `RATE_LIMITED` | message-send rate limit exceeded |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Conversation` | new | `id uuid pk`, `booking_id uuid fk->Booking unique`, `created_at`, `archived_at timestamptz nullable` |
| `ConversationParticipant` | new | `id uuid pk`, `conversation_id uuid fk->Conversation`, `user_id uuid fk->User`, `role text` |
| `Message` | new | `id uuid pk`, `conversation_id uuid fk->Conversation`, `sender_id uuid fk->User`, `body text`, `flagged_for_contact_sharing boolean`, `created_at` |
| `MessageAttachment` | new | `id uuid pk`, `message_id uuid fk->Message`, `file_asset_id uuid fk->FileAsset` |

### Migration

- **Name:** `AddMessagingTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

This spec **is** the retention mechanism for booking-level messaging: active-booking
conversations always accessible to participants; historical retention window is admin-
configurable (spec 041); admin reads are always audited (AC-5).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | message thread skeleton; new messages appear via WebSocket with optimistic send state reconciled against server confirmation |
| **Empty** | new conversation shows a neutral "Say hello" prompt |
| **Error** | send failure keeps the drafted message in the input, shows retry |
| **Success** | delivered/read indicators where supported; contact-sharing flag shown as a gentle in-context notice, not a punitive block |

Fully keyboard operable; screen-reader announces new incoming messages appropriately (not overly
chatty). RTL support for Urdu conversations.

**Route(s):** `apps/web/app/bookings/[id]/chat`
**Shared components used/added:** `packages/ui` `Chat` (extends spec 018's request-scoped
component), `MessageBubble`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | contact-sharing pattern detection, retention-window calculation | `apps/api/messaging/**/*.test.ts` |
| **Integration** | full send/receive round trip; blocked-user prevention; admin-access audit logging | `apps/api/messaging/*.integration.test.ts` |
| **Component** | chat UI states, optimistic-send reconciliation | `apps/web` (Testing Library) |
| **E2E** | customer and provider exchange messages on a confirmed booking in real time | `apps/web-e2e/messaging.spec.ts` |
| **Accessibility** | chat thread keyboard/screen-reader tested | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/web-e2e/messaging.spec.ts::real-time exchange` |
| AC-2 | `apps/api/messaging/contact-detection.test.ts::flags without dropping legitimate content` |
| AC-5 | `apps/api/messaging/admin-access.integration.test.ts::logs audited access` |
| AC-6 | `apps/api/messaging/blocking.integration.test.ts::prevents messages between blocked users` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Pre-booking, request-scoped chat (spec 018 — reuses this spec's
`Chat` component but is a distinct, more restricted conversation scope).

---

## 7. Out of scope

- Blocking/reporting mechanics themselves (spec 030) — this spec only enforces their effect on
  messaging.
- Message translation (referenced by i18n spec 042, not detailed here).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Default historical retention window length | Legal/Product | Open |
| 2 | Real-time transport choice (native WebSocket vs. a managed real-time service) | — | Open — architecture doc §6.1 mandates WebSockets for chat; implementation detail open |

---

## 9. Rollout

- **Feature flag:** none — core to the post-booking experience.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; WebSocket clients reconnect and resume via authoritative
  message history fetch.
- **Observability:** message delivery latency, WebSocket reconnect rate, contact-sharing-flag
  rate monitored (master spec §117).
