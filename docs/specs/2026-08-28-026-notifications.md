# Spec: Notifications

**File:** `docs/specs/2026-08-28-026-notifications.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §57–§58, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §6.1, §10, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No notification system exists. Master spec §57 requires push/SMS/email across
booking, messages, payments, security, promotions, provider-requests/earnings, and operational
categories, with user-controlled preferences except that security/payment/necessary operational
notifications may remain enabled. §58 requires marketing notifications to be separately consented
and never sent excessively.

**Who is affected:** Every user needing to be informed of time-sensitive events (offer arrived,
booking status changed, payment result); marketing/growth needing an opt-in channel.

**Why it matters now:** Nearly every prior spec (offers, bookings, payments, messaging)
references "the user is notified" — this spec is what actually delivers those notifications, so
it's sequenced once those event sources exist.

**Success looks like:** Every category of notification defined in master spec §57 is delivered
through the right channel(s), respecting user preferences except where the category is
non-optional (security/payment/critical operational), with marketing kept strictly separate and
consent-gated.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a booking-status change **When** it occurs **Then** the affected user receives a notification via their preferred enabled channel(s) |
| AC-2 | **Given** a user disables "Promotions" preferences **When** a marketing notification is queued **Then** it is not sent to them; **given** they disable "Booking" **When** a critical booking-security event occurs anyway **Then** it is still sent if classified as security/payment-critical |
| AC-3 | **Given** a user has not given marketing consent **When** any marketing notification is queued **Then** it is not sent, regardless of other notification preferences |
| AC-4 | **Given** a notification category **When** categorized **Then** it maps to exactly one of: Booking, Messages, Payments, Security, Promotions, Provider requests/earnings, Operational updates |
| AC-5 | **Given** marketing sends **When** measured **Then** frequency stays within a configured cap to avoid excessive promotional messaging |
| AC-6 | **Given** a notification delivery failure on one channel **When** it occurs **Then** it does not silently fail if the event is critical — a fallback channel or retry is attempted for security/payment categories |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/users/me/notifications` | session | `200` `PagedResponse<NotificationDto>` | in-app notification center |
| `POST` | `/api/v1/users/me/notifications/{id}/read` | session | `200` | |
| `GET` | `/api/v1/users/me/notification-preferences` | session | `200` `ApiResponse<NotificationPreferenceDto[]>` | |
| `PATCH` | `/api/v1/users/me/notification-preferences` | session | `200` | |
| `POST` | `/api/v1/users/me/marketing-consent` | session | `200` | explicit opt-in/opt-out |

### Request and response types

```typescript
// packages/types/src/notifications.ts
export interface NotificationDto {
  id: string;
  category: 'booking' | 'messages' | 'payments' | 'security' | 'promotions' | 'provider_activity' | 'operational';
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPreferenceDto {
  category: string;
  channels: { push: boolean; sms: boolean; email: boolean };
  isOverridable: boolean; // false for security/payment/critical operational
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `CATEGORY_NOT_OVERRIDABLE` | attempt to disable a non-optional category |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Notification` | new | `id uuid pk`, `user_id uuid fk->User`, `category text`, `title text`, `body text`, `read_at timestamptz nullable`, `created_at` |
| `NotificationPreference` | new | `id uuid pk`, `user_id uuid fk->User`, `category text`, `push_enabled boolean`, `sms_enabled boolean`, `email_enabled boolean` |
| `User` | extend | `marketing_consent_at timestamptz nullable` |

Dispatch itself runs through the background job queue (`apps/worker`, per architecture §10),
never inline in the request/response cycle of the triggering action.

### Migration

- **Name:** `AddNotificationTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Notification content may reference personal/booking data — retained per platform policy,
included in export (spec 008); marketing consent timestamp is itself a compliance record.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | notification center skeleton list |
| **Empty** | "You're all caught up" — not a bare blank list |
| **Error** | preference-save failure shows inline error, does not silently revert the toggle without telling the user |
| **Success** | preference toggle confirms immediately; in-app notifications mark read on view |

Non-overridable categories are shown as locked/explained (e.g. "Security notifications can't be
turned off") rather than a disabled toggle with no explanation.

**Route(s):** `apps/web/app/account/notifications`, in-app notification bell/center globally
**Shared components used/added:** `packages/ui` `NotificationCenter`, `Toggle`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | preference-resolution logic (category × channel × overridability) | `apps/api/notifications/**/*.test.ts` |
| **Integration** | end-to-end dispatch respecting preferences; marketing consent gating; non-overridable category enforcement | `apps/api/notifications/*.integration.test.ts` |
| **Background job** | worker dispatch retry/backoff on channel failure | `apps/worker/notification-dispatch.test.ts` |
| **E2E** | user disables promotions, does not receive a marketing notification; still receives a security alert | `apps/web-e2e/notifications.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-2 | `apps/api/notifications/preferences.integration.test.ts::respects category preference except critical` |
| AC-3 | `apps/api/notifications/marketing.integration.test.ts::requires explicit consent` |
| AC-5 | `apps/api/notifications/marketing-cap.integration.test.ts::respects frequency cap` |
| AC-6 | `apps/worker/notification-dispatch.test.ts::retries critical category on channel failure` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Push/SMS/email provider-specific deliverability (external
dependency, sandbox-tested).

---

## 7. Out of scope

- The content/copy of every individual notification triggered by other specs (each owning spec
  references "notify the user"; this spec is the delivery mechanism, not the full copy catalog).
- In-app AI proactive suggestions (spec 034) — related but distinct: those are AI-generated
  contextual nudges, not this spec's rule-based transactional notifications.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Push/SMS/email provider selection for the Pakistan market | — | Open — sandbox/mock adapters required in the interim |
| 2 | Exact marketing frequency cap | Product | Open |

---

## 9. Rollout

- **Feature flag:** `marketing-notifications` (default off until consent flow is verified in
  production).
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; queued notifications in the worker are idempotent/safe to
  reprocess.
- **Observability:** delivery success rate per channel, opt-out rate per category monitored
  (master spec §117).
