# Spec: Notifications

**File:** `docs/specs/2026-08-28-026-notifications.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §57–§58, §100, §117, §132.21–§132.22, §133.5–§133.6, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §6.1, §10, [docs/workflow.md](../workflow.md)

**Depends on:** 003 (the `notifications` / `notification_preferences` baseline skeletons), 004
(`withApiRoute`, the error taxonomy, `parsePageParams`/`buildPage`, `OPENAPI_ROUTES`, rate-limit
domains), 005 (`requireSession`, `requireCsrf`, `recordSecurityEvent`), 008 (export/deletion), 016
(the availability opt-in this spec delivers), 021 (the `PaymentProvider` adapter pattern this spec's
channel adapters copy), 022 (`registerRefundNotificationSink`), 023
(`registerCancellationNotificationSink`).

**Feeds:** nothing. This spec is a terminal consumer — it delivers what other specs decide.

---

## 1. Problem statement

**Today:** No notification delivery exists. `notifications` and `notification_preferences` are still
empty spec 003 baseline skeletons — `notifications` carries only `id`, audit columns, `version` and
`recipient_user_id`; `notification_preferences` carries only `id`, audit, `version` and a
`user_id` that is **`UNIQUE`**, so the baseline shape is deliberately **one preference row per
user**, not one per category (§4 resolves what the draft assumed).

Four specs have already shipped their half of this handoff and are waiting on it — verified in the
repository, not assumed:

| Seam that exists today | Shipped by | What it does now |
|---|---|---|
| `registerRefundNotificationSink()` in `lib/refunds/notifications.ts` | 022 | inert default; logs a structured line |
| `registerCancellationNotificationSink()` in `lib/cancellation/notifications.ts` | 023 | inert default; logs a structured line |
| `provider_availability_notification_requests` + `lib/availability/notify.ts` | 016 | records the opt-in; writes no `notifications` row |
| `notifyProvidersOfCancellation()` in `lib/requests/cancellation-notification.ts` | 015 | returns the provider ids; delivers nothing |

Master spec §57 requires Push, SMS and Email across seven categories, with user-controlled
preferences except that security/payment/necessary operational notifications may remain enabled.
§58 requires marketing to be separately consented, kept apart from transactional sends, and not used
excessively.

**Who is affected:** Every user waiting on a time-sensitive event (an offer arrived, a booking moved,
a refund completed, a no-show needs their response); Trust & Safety and Finance, whose workflows
assume the other party was actually told; growth, who need a consent-gated promotional channel.

**Why it matters now:** Four shipped specs currently end with a `console.log` where a notification
should be. Until this spec lands, "the other party is notified" is false everywhere it is written.

**Success looks like:** An event-producing spec hands over one typed event and stops thinking about
it. This spec decides which categories the recipient allows, writes exactly one durable notification
per event (never two, however often the event is retried), delivers it in-app immediately, attempts
the user's enabled outbound channels through a swappable adapter, retries a failed critical delivery
until it succeeds or is escalated, and never sends a promotional message without consent or beyond
the frequency cap.

---

## 2. Acceptance criteria

The six original criteria are preserved and made deterministic. AC-1's "preferred enabled channel(s)"
is resolved into a defined resolution order (§3 "Preference resolution"); AC-2's "critical booking-
security event" ambiguity is resolved by making criticality a property of the **category**, never of
an individual notification; AC-5's open cap is resolved to an exact number and window; AC-6's
"fallback channel or retry" is resolved into a stated retry policy with a terminal failure state.
AC-7 through AC-10 are added because without them dedup, ordering, authorization and the absence of
real providers are unspecified — each is traceable to a named test in §6.

| # | Criterion |
|---|---|
| AC-1 | **Given** an event from a producing spec (a booking status change, a refund outcome, a no-show request) **When** it is handed to this spec **Then** exactly one `notifications` row is created for the affected recipient, visible in their notification centre immediately, and a delivery attempt is queued for each outbound channel their resolved preferences enable for that category |
| AC-2 | **Given** a user who has disabled an **overridable** category (`booking`, `messages`, `promotions`, `provider_activity`) **When** an event in that category occurs **Then** no outbound channel delivery is attempted, **but** the in-app row is still created — the notification centre stays complete; **given** a user who attempts to disable a **non-overridable** category (`security`, `payments`, `operational`) **Then** the request is rejected `422 CATEGORY_NOT_OVERRIDABLE` and nothing is changed |
| AC-3 | **Given** a user without marketing consent **When** any `promotions` notification is handed over **Then** it is not created and not delivered on any channel, regardless of their `promotions` channel preferences; consent and the `promotions` preference are an **AND**, never an OR, and withdrawal takes effect immediately |
| AC-4 | **Given** any notification **When** created **Then** its `category` is exactly one of the seven master spec §57 values — `booking`, `messages`, `payments`, `security`, `promotions`, `provider_activity`, `operational` — enforced by a database CHECK, and its `type` is one of a closed catalogue owned by this spec |
| AC-5 | **Given** promotional notifications **When** one is handed over **Then** it is suppressed if the recipient has already been sent `MARKETING_MAX_PER_WINDOW` (default **3**) promotional notifications in the trailing `MARKETING_WINDOW_DAYS` (default **7**) — counted per notification, not per channel, with transactional categories never counted — and the suppression is recorded rather than silently dropped (§3 "Marketing") |
| AC-6 | **Given** an outbound delivery failure **When** the category is non-overridable (`security`, `payments`, `operational`) **Then** the attempt is retried with exponential backoff up to `NOTIFICATION_MAX_ATTEMPTS` (default **5**), falling back through the recipient's remaining enabled channels in the fixed order push → email → sms; **when** attempts are exhausted **Then** the delivery row becomes `failed`, is logged as `notification.delivery_exhausted` for operational alerting, and is **never** silently dropped. A non-critical category is retried at most once and then abandoned quietly |
| AC-7 | **Given** the same event handed over more than once — a producing spec retrying, a cron re-running — **When** it carries the same `event_key` **Then** exactly one notification exists for that recipient, guaranteed by `UNIQUE (recipient_user_id, event_key)`, and the duplicate handover is a no-op that returns the existing row rather than an error |
| AC-8 | **Given** a user reading their notification centre **When** they list notifications **Then** results are their own only, ordered `created_at DESC, id DESC` (a total order, so pagination cannot repeat or skip a row), paged through spec 004's existing `parsePageParams`/`buildPage`, and filterable by `unreadOnly` |
| AC-9 | **Given** any notification route **When** called **Then** it operates only on the caller's own notifications: another user's notification id returns `404 NOTIFICATION_NOT_FOUND`, never `403`, so ids cannot be probed; marking read is idempotent (a second call returns `200` with the same `readAt`) and no route allows a client to create a notification |
| AC-10 | **Given** no real push/SMS/email provider exists in this repository **When** an outbound delivery is attempted **Then** it goes through the `NotificationChannelAdapter` seam; the sandbox adapter records the attempt and **never reports a delivery it did not make**, and — exactly as spec 021 AC-10 does for payments — a sandbox adapter refuses to run under `NODE_ENV=production`, so a production deployment without a real adapter fails loudly instead of pretending users were told |

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing mechanism reused | Not created |
|---|---|---|
| Event sources | specs 015/016/022/023's **already-shipped** sinks and opt-in tables (§1) | any new hook in a producing spec |
| Outbound provider abstraction | spec 021's `lib/payments/provider/` shape — env selection, sandbox, production guard — copied, not shared | a real push/SMS/email integration |
| Background processing | spec 021/022/023's Vercel Cron pattern (`app/api/v1/cron/*`, bearer `CRON_SECRET`) | **`apps/worker` — which does not exist in this repository** |
| Session + CSRF | spec 005's `requireSession` / `requireCsrf` | a second auth path |
| Pagination | spec 004's `parsePageParams` / `buildPage` | a cursor scheme |
| Compliance audit trail | spec 005's `recordSecurityEvent` (`security_events`) | a new audit table |
| Optimistic concurrency | spec 003's `version` column on both baseline tables | row locks |
| Privacy export/deletion | spec 008's existing `lib/privacy/export.ts` / `deletion.ts` | a second retention mechanism |

### Ownership boundary (normative)

| Concern | Owner |
|---|---|
| **Whether** an event deserves a notification, and its business meaning | the producing spec (015/016/018/019/020/021/022/023/024/025/…) |
| The notification **catalogue** — type → category → title/body template | **026** |
| Persistence, read/unread, ordering, pagination, dedup, retention | **026** |
| Preference resolution, marketing consent, frequency cap | **026** |
| Channel selection, delivery, retry, fallback, escalation | **026** |
| Real push/SMS/email vendor integration | **out of scope** — a later spec supplies an adapter (§7) |
| AI proactive suggestions | 034 |

**This spec moves no business logic out of another spec.** A producing spec keeps deciding *that*
something happened and *who* it concerns; it hands over a typed event and never learns whether the
recipient has email enabled.

### What a producing spec must supply

One call, `notify(event)`, with four required fields and nothing else:

```typescript
// lib/types/notifications.ts
export interface NotificationEventInput {
  /** The recipient. Always a user id — never a profile id, never a role. */
  recipientUserId: string;
  /** From this spec's closed catalogue; determines category, template and criticality. */
  type: NotificationType;
  /**
   * The producing spec's DETERMINISTIC key for this event — e.g. `refund_completed:{refundId}`.
   * The same event retried must produce the same key (AC-7). Never a timestamp or a random value.
   */
  eventKey: string;
  /**
   * Template variables only — ids, amounts, instants, statuses. NEVER free text from another user,
   * and never another party's personal data (§4 "Retention and privacy").
   */
  params?: Record<string, string | number | null>;
}
```

### Category vocabulary and criticality (AC-2, AC-4)

The seven categories are master spec §57's list, verbatim. Criticality is a property of the
**category**, fixed in code and enforced at the database — never of an individual notification, and
never a per-type override. That is what makes AC-2 deterministic: the draft's "critical booking-
security event" is not a `booking` notification that happens to be important, it is a `security`
notification, and it is classified that way in the catalogue.

| Category | Overridable? | Why |
|---|---|---|
| `booking` | yes | |
| `messages` | yes | |
| `provider_activity` | yes | provider requests and earnings |
| `promotions` | yes — and additionally consent-gated (AC-3) | |
| `security` | **no** | master §57: security notifications may remain enabled |
| `payments` | **no** | master §57 |
| `operational` | **no** | master §57's "necessary operational". Reserved for account/service-critical notices, not product news — product news is `promotions` |

### Preference resolution (AC-1, AC-2)

One resolution function, consulted once per event, in this order:

1. **Category is `promotions`?** → require marketing consent AND the `promotions` preference AND the
   frequency cap. Failing any one: no row, no delivery, suppression recorded (AC-3, AC-5).
2. **Category non-overridable?** → every channel the user has configured is enabled, regardless of
   stored preference. A stored `false` for these categories is unreachable — the API rejects it.
3. **Otherwise** → the user's stored per-category channel map decides.
4. **No preference row yet** → `NOTIFICATION_DEFAULTS`: in-app on for everything; email on for
   non-overridable categories; push and sms off. Defaults are a constant in
   `lib/notifications/defaults.ts`, so a user who never opened settings still receives what §57
   requires and nothing it does not.

**In-app is never suppressed.** A disabled category suppresses *outbound* channels only; the row is
still written (AC-2). A notification centre that silently omits events would make "mark all read"
and the unread count lie, and would leave the user with no record of something that happened to them.

### Channels and the adapter seam (AC-1, AC-6, AC-10)

This repository has **no push, SMS or email infrastructure of any kind** — verified: no provider
directory, no vendor dependency in `package.json`, no worker. Master §57 nonetheless names three
outbound channels, so this spec ships the **seam and the sandbox**, and no vendor integration:

```typescript
// lib/notifications/channels/types.ts
export type NotificationChannel = 'in_app' | 'email' | 'push' | 'sms';

export interface ChannelDeliveryInput {
  notificationId: string;
  channel: Exclude<NotificationChannel, 'in_app'>;
  recipientUserId: string;
  title: string;
  body: string;
}

/** `'unknown'` is never collapsed into `'failed'` — spec 021/022's rule, for the same reason. */
export type ChannelOutcome = 'delivered' | 'failed' | 'unknown';

export interface ChannelResult {
  outcome: ChannelOutcome;
  providerReference: string | null;
  failureCode?: string;
}

export interface NotificationChannelAdapter {
  readonly channel: Exclude<NotificationChannel, 'in_app'>;
  deliver(input: ChannelDeliveryInput): Promise<ChannelResult>;
}
```

- **`in_app` is not an adapter.** It is the `notifications` row itself, delivered the moment it is
  written. It is the only channel this repository can actually deliver, and the only one whose
  success is real.
- Selection is `process.env.NOTIFICATION_CHANNEL_PROVIDER` (default `sandbox`), the same environment
  mechanism spec 021 uses for `PAYMENT_PROVIDER` — not a feature-flag system (spec 041 owns that).
- **The sandbox never fabricates a send.** It records the attempt, returns `delivered` for the
  in-memory record only, and **throws under `NODE_ENV=production`** (spec 021 AC-10's guard, master
  §132.21/§132.22). A production deployment with no real adapter refuses to claim users were
  notified.
- Adding a real provider is a later spec: it implements this interface and registers itself. Nothing
  else in this spec changes.

### Delivery, retry and escalation (AC-6)

Each enabled outbound channel gets one `notification_deliveries` row in `pending`. A cron sweep
claims due rows and attempts them.

```
pending ──► delivered
   │
   ├──► retrying ──► delivered
   │        │
   │        └──► failed        (attempts exhausted)
   └──► skipped                (channel disabled by preference, or no adapter configured)
```

| Situation | Behaviour |
|---|---|
| `delivered` | terminal. Records `provider_reference` when the adapter supplied one |
| `failed` (definitive code), critical category | backoff `2^attempts` minutes, up to `NOTIFICATION_MAX_ATTEMPTS` (default 5), then **fall back** to the next enabled channel in the fixed order push → email → sms |
| `failed`, non-critical category | one retry, then abandoned as `failed` without escalation — a missed promotional message is not worth an alert |
| `unknown` / timeout | stays `retrying`, attempt counted, **never** marked delivered or failed on a guess |
| Attempts exhausted, critical category | `failed` + `notification.delivery_exhausted` structured log for alerting (§9). Never silently dropped |
| No adapter for the channel | `skipped` with `skip_reason = 'no_adapter'` — an honest record that nothing was sent |

The in-app row is **never** subject to any of this: it is written in the same transaction as the
notification and cannot fail separately.

### Marketing consent and the frequency cap (AC-3, AC-5)

**Where consent lives — decided.** Not a new column on `users`, and not a new table. The baseline
`notification_preferences` row is already `UNIQUE (user_id)` — exactly one row per user — which makes
it the natural home:

- `marketing_consent_at timestamptz null` — null means **no consent**. Absence is never treated as
  permission.
- `marketing_consent_source text null` — how it was given (`account_settings` today).
- Every change additionally writes an **append-only compliance record** through spec 005's existing
  `recordSecurityEvent` (`notifications.marketing_consent_granted` / `…_withdrawn`), so the consent
  *history* survives even though the column holds only the current state. This reuses the audit
  store spec 008 already relies on rather than adding one.

Withdrawal sets the column to `null` and takes effect on the next resolution — there is no queue to
drain, because a suppressed promotional notification is never created in the first place.

**The cap — resolved.** The repository offers no precedent and master §58 says only "not
excessively", so this is a deliberate conservative product decision rather than an invented number
dressed up as a requirement:

- **3 promotional notifications per rolling 7 days per user.**
- Counted **per notification**, not per channel — one promo on three channels is one send.
- Transactional categories are **never** counted toward it.
- Both values are environment-configurable (`MARKETING_MAX_PER_WINDOW`, `MARKETING_WINDOW_DAYS`) so
  Product can tune them without a code change.
- At the cap the notification is **not created**; a `notification.marketing_suppressed` log line
  records the recipient and reason, so suppression is measurable (§9) rather than invisible.

### Endpoints

Repository conventions: `app/api/v1/**/route.ts`; `withApiRoute` forwards no route context, so an
`{id}` route reads its parameter from the URL; guard order is **session → CSRF → rate limit**.
Notifications are **user-level, not mode-scoped** — a user has one inbox across customer and provider
mode, so `requireActiveMode` is deliberately **not** used (the same choice
`users/me/personalization-settings` already makes).

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/users/me/notifications` | session | `200 PagedResponse<NotificationDto>` | `parsePageParams`/`buildPage`; `?unreadOnly=true` filter; ordered `created_at DESC, id DESC` |
| `GET` | `/api/v1/users/me/notifications/unread-count` | session | `200 ApiResponse<{ unread: number }>` | what the bell reads; deliberately separate so the badge never pages the whole inbox |
| `POST` | `/api/v1/users/me/notifications/{id}/read` | session | `200 ApiResponse<NotificationDto>` | CSRF; idempotent (AC-9) |
| `POST` | `/api/v1/users/me/notifications/read-all` | session | `200 ApiResponse<{ updated: number }>` | CSRF. **Added**: a notification centre without it forces N calls |
| `GET` | `/api/v1/users/me/notification-preferences` | session | `200 ApiResponse<NotificationPreferencesDto>` | returns resolved defaults when no row exists |
| `PATCH` | `/api/v1/users/me/notification-preferences` | session | `200 ApiResponse<NotificationPreferencesDto>` | CSRF; `422 CATEGORY_NOT_OVERRIDABLE`; `409 CONFLICT` on stale `version` |
| `POST` | `/api/v1/users/me/marketing-consent` | session | `200 ApiResponse<{ marketingConsentAt: string \| null }>` | CSRF; body `{ consent: boolean }`; idempotent |
| `GET` | `/api/v1/cron/notification-dispatch-sweep` | `Bearer ${CRON_SECRET}` | `200` | not a browser route: no session, no CSRF, no rate limit; excluded from OpenAPI like every other cron route |

**There is deliberately no route that creates a notification.** Creation is server-internal, reached
only through `notify()` from a producing spec. A client-creatable notification would be a
spam surface and an impersonation surface at once.

**Rate limiting.** These are the caller's own inbox reads on the account screen. Spec 004's existing
`default` domain (100/60s) covers them; **no new rate-limit domain is added**, because nothing here
reaches an external vendor or a heavy query the way `search`/`payment`/`location` do.

### Request and response types

`lib/types/notifications.ts` — **not `packages/types`**, which does not exist in this repository.

```typescript
export const NOTIFICATION_CATEGORIES = [
  'booking', 'messages', 'payments', 'security', 'promotions', 'provider_activity', 'operational',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Non-overridable per master §57. A closed set, not a per-type flag (AC-2). */
export const CRITICAL_CATEGORIES = ['security', 'payments', 'operational'] as const;

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push', 'sms'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export interface NotificationDto {
  id: string;
  category: NotificationCategory;
  type: NotificationType;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

/** Per-category outbound channel map. In-app is absent because it is never optional. */
export type CategoryChannelMap = Record<NotificationCategory, { email: boolean; push: boolean; sms: boolean }>;

export interface NotificationPreferencesDto {
  categories: CategoryChannelMap;
  /** Which categories the UI must render as locked, with an explanation (§5). */
  nonOverridableCategories: NotificationCategory[];
  marketingConsentAt: string | null;
  version: number;
}
```

`NotificationDto` deliberately carries **no** `eventKey`, `params`, delivery state, provider
reference or failure code — those are internal routing and diagnostic data, not the user's record of
what they were told.

### Error codes

None belongs in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status` explicitly —
the pattern specs 005/016/020/021/022/023 follow.

| HTTP | `code` | When |
|---|---|---|
| `404` | `NOTIFICATION_NOT_FOUND` | no such notification, **or** it belongs to another user (deliberately indistinguishable — AC-9) |
| `422` | `CATEGORY_NOT_OVERRIDABLE` | an attempt to disable `security`, `payments` or `operational`; `details.category` names it |
| `400` | `VALIDATION_ERROR` | an unknown category or channel key, a non-boolean value, or a malformed preference map |
| `409` | `CONFLICT` | stale `version` on a preference update (spec 003 AC-6) |
| `429` | `RATE_LIMITED` | spec 004's existing code, `default` domain |

### OpenAPI

Every route above except the cron route is added to `OPENAPI_ROUTES` in
`lib/api/openapi-registry.ts` in the same change, tagged `notifications`, or
`npm run check:openapi-drift` fails. The pre-existing spec 010 `{categoryId}` drift is **not** touched
by this spec.

### Breaking-change check

- [x] New routes; new columns on two empty spec 003 baseline tables; one new table.
- [x] No shipped API contract changes. The four existing sinks are *registered*, never modified.

---

## 4. Data model changes

`notifications` and `notification_preferences` **already exist** as spec 003 baseline skeletons.
This spec **alters** them and adds one table. `0001_baseline_schema.sql` is immutable
(`npm run check:schema-checksum`) and is not touched. `baseColumns()` already supplies `id`,
`created_at`, `updated_at` and `version`.

### Entities

| Entity | Change | Columns added |
|---|---|---|
| `notifications` | **alter** (baseline: `recipient_user_id`) | `category text not null`, `type text not null`, `title text not null`, `body text not null`, `params jsonb not null default '{}'`, `event_key text not null`, `read_at timestamptz null` |
| `notification_preferences` | **alter** (baseline: `user_id` UNIQUE) | `categories jsonb not null`, `marketing_consent_at timestamptz null`, `marketing_consent_source text null` |
| `notification_deliveries` | **new** | `id`, audit, `version`, `notification_id uuid not null fk->notifications restrict`, `channel text not null`, `status text not null default 'pending'`, `attempts integer not null default 0`, `next_attempt_at timestamptz null`, `delivered_at timestamptz null`, `provider_reference text null`, `failure_code text null`, `skip_reason text null` |

**The draft's `User.marketing_consent_at` is removed.** `notification_preferences` is already
one-row-per-user; adding a consent column to `users` would put one user's notification settings in
two tables for no gain.

**Why `categories` is jsonb.** Seven categories × three outbound channels is 21 booleans. As columns
that is an unreadable table and a migration for every new category; as a validated map it is one
column, read back whole, never queried or filtered on in SQL — the same judgement spec 017 made for
`matching_weights` and spec 023 for `policy_versions.config`. It is validated at **write time** by
`validateCategoryChannelMap()`, and it must be added to `lib/db/schema-lint.test.ts`'s reviewed-jsonb
allowlist in the same change, with its AC-5 rationale, exactly as spec 023 did.

### Constraints and indexes

| # | Constraint | Why |
|---|---|---|
| C-1 | `notifications_category_ck`: `category in (…seven…)` | AC-4 at the database |
| C-2 | `notifications_event_key_uq` **unique** on `(recipient_user_id, event_key)` | AC-7 — dedup is structural, not advisory |
| C-3 | `notifications_recipient_created_idx` on `(recipient_user_id, created_at DESC, id DESC)` | AC-8's exact ordering, served by the index that matches it |
| C-4 | `notifications_unread_idx` on `(recipient_user_id)` where `read_at is null` | the badge count, without scanning a long inbox |
| C-5 | `notification_deliveries_status_due_idx` on `(status, next_attempt_at)` | the sweep's claim path |
| C-6 | `notification_deliveries_notification_channel_uq` unique on `(notification_id, channel)` | one delivery row per channel per notification |
| C-7 | `notification_deliveries_status_ck` in `('pending','retrying','delivered','failed','skipped')`; `channel_ck` in `('email','push','sms')` — **`in_app` is absent**: it is the row itself and has no delivery record | closed vocabularies |
| C-8 | `notification_deliveries_delivered_pairing_ck`: `(status = 'delivered') = (delivered_at is not null)` | a delivered row always has its instant |
| C-9 | `notification_preferences_categories_ck`: `jsonb_typeof(categories) = 'object'` | structural floor; the grammar lives in the domain layer |
| C-10 | `notifications_read_at_immutable_trg` — `read_at` may go null → set, never set → different | reading is not reversible, and a shifting timestamp would make "unread since" meaningless |

**No status column on `notifications` itself**, and therefore no `notifications_status_transitions`
table and no `enforce_status_transition()` trigger: a notification is created and read, which
`read_at` already expresses. Delivery state lives on `notification_deliveries` where it belongs.

### Migration

- **Name:** `<next>_add_notifications.sql`, with a hand-written `<next>_add_notifications_down.sql` —
  the repository's convention (`0012`–`0019` all follow it; drizzle-kit generates no down migration).
- **Number — determined from the repository, not assumed.** `drizzle/meta/_journal.json`'s head is
  **`0019_add_cancellation_policy_no_show`** (spec 023). Specs **024 and 025 are both still `Draft`**
  and will take `0020`/`0021` if they land first, so this spec's number is **`0020` only if it
  implements next**; otherwise it is the then-current head plus one. Prompt 2 must read the journal
  and use what it finds — never this line.
- **Precondition guard:** a `DO $$ ... RAISE EXCEPTION` unless `notifications` and
  `notification_preferences` are empty — the same guard `0016`–`0019` use, which is what makes
  `NOT NULL` columns without defaults safe to add directly.
- **No backfill.** Both tables are empty, and `notification_preferences` rows are created lazily on
  first write; absent rows resolve to `NOTIFICATION_DEFAULTS` (§3). **No existing row is modified.**
- **Reversible:** yes. The down migration drops only what this migration added and touches no other
  table. It is gated on `notifications` being empty, because once real notifications exist they are
  the user's record of what they were told and their consent history is a compliance record (§9).
- **Downtime:** none — every added column is defaulted or nullable, and the new table is empty.

### Retention and privacy

- **Bodies are rendered, never relayed.** A notification's title and body come from this spec's
  template catalogue with `params` substituted; a producing spec passes ids and amounts, never free
  text written by another user. This is what stops a notification becoming a channel for one user to
  send another arbitrary content, and what keeps another party's personal data out of the row.
- **Export (spec 008).** `lib/privacy/export.ts` already exports `notification_preferences` as
  `{ id, createdAt }`; this spec extends that to the resolved `categories` map and
  `marketingConsentAt` (a compliance record the user is entitled to see), and adds the caller's own
  notifications as `{ id, category, type, title, body, readAt, createdAt }`. **Never exported:**
  `event_key`, `params`, and every `notification_deliveries` column — internal routing and
  diagnostics, not the user's own record.
- **Deletion (spec 008).** On anonymization a notification's `title`, `body` and `params` are
  redacted (they can quote the user's own booking detail), while the row, its category and its
  timestamps are retained as the record that a required notice was sent.
  `marketing_consent_at`/`_source` are **retained** as a compliance record — the evidence that
  consent was held is precisely what must survive the account.
- **Retention.** Read notifications older than `NOTIFICATION_RETENTION_DAYS` (default **180**) are
  deleted by the existing `/cron/account-deletion-sweep` route, which spec 023 already extended for
  its own minimisation — **no new sweep is introduced**. Unread notifications are never auto-deleted.

---

## 5. UI states

**Scope note.** `app/components/NavShell.tsx`, `AppHeader.tsx` and `app/account/page.tsx` currently
carry **uncommitted in-flight design-system work**. This spec therefore adds its entry point as one
row in the existing account list and **does not restructure the header or navigation**; a global
notification bell is deliberately deferred so this spec never collides with that work. No visual
redesign, no token change, no new design-system primitive.

### Notification centre — `app/account/notifications` (new)

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` list, matching the existing account screens |
| **Empty** | "You're all caught up" via the existing `EmptyState` — never a bare blank list |
| **Unread** | a `Badge` and a non-colour-only marker (text plus weight), so unread is not conveyed by colour alone |
| **Read** | the marker is removed; the row stays in place rather than jumping |
| **Error** | `ErrorState` with retry; a failed "mark read" restores the previous state **and says so** rather than silently reverting |
| **Paging** | "Load more" over spec 004's `page` envelope |

Marking read is explicit (a per-row action and "Mark all read"). **Notifications are not marked read
merely by rendering** — the draft's "mark read on view" would destroy the unread state of anything a
user scrolled past, and makes the badge unreliable.

### Preferences — same route, second section

| State | Behaviour |
|---|---|
| **Per-category toggles** | one row per category × outbound channel, from the existing form primitives |
| **Locked categories** | `security`, `payments`, `operational` render as locked **with the reason shown** ("Security notifications can't be turned off"), not as a disabled toggle with no explanation |
| **Marketing consent** | a separate, explicit opt-in control, visibly distinct from the `promotions` channel toggles, stating that both are required |
| **Save error** | inline error; the toggle reverts **and** the user is told why |

**Components:** `Badge`, `Button`, `Card`, `EmptyState`, `ErrorState`, `Skeleton`, `Switch`,
`FormField` from `@/components` — all existing. **The draft's `packages/ui` `NotificationCenter` and
`Toggle` do not exist and are not created.**

**Route(s):** `app/account/notifications` (new page + one link row on `app/account`).

---

## 6. Test plan

Vitest is the **only** runner (`npm test` → `vitest run`). There is no Playwright; `e2e/*.spec.ts` is
a Vitest pattern already configured in `vitest.config.ts`. **The draft's `apps/api/**`,
`apps/worker/**` and `apps/web-e2e/**` paths do not exist.** Integration tests live beside their
domain module in `lib/**`.

| Level | What it covers | Where |
|---|---|---|
| **Unit — preferences** | resolution across category × channel × overridability; defaults when no row exists; a stored `false` on a non-overridable category is ignored; map validation rejects unknown categories/channels and non-booleans | `lib/notifications/preferences.test.ts` |
| **Unit — catalogue** | every `NotificationType` maps to exactly one category; every template renders with its declared params and leaves no placeholder unsubstituted | `lib/notifications/catalogue.test.ts` |
| **Unit — retry policy** | backoff schedule, attempt ceiling, the fixed push → email → sms fallback order, critical vs non-critical divergence | `lib/notifications/retry.test.ts` |
| **Source guard** | `lib/notifications/**` writes no booking/payment/refund row and imports no producing spec's domain module (delivery must not acquire business logic); no notification route creates a notification | `lib/notifications/boundaries.test.ts` |
| **Integration — creation** | one row per event; the in-app row exists even when the category is disabled; a disabled category creates no outbound delivery rows; non-overridable categories ignore a disabled preference | `lib/notifications/create.integration.test.ts` |
| **Integration — dedup** | the same `eventKey` twice creates one notification and returns the existing row; concurrent handovers of the same event admit exactly one (unique-violation path) | `lib/notifications/dedup.integration.test.ts` |
| **Integration — marketing** | no consent → nothing created; consent + disabled `promotions` → nothing created; consent withdrawn mid-stream → immediately suppressed; the cap suppresses the 4th in the window and logs it; transactional sends never count toward the cap; the window rolls | `lib/notifications/marketing.integration.test.ts` |
| **Integration — delivery** | sandbox delivery marks `delivered`; a definitive failure on a critical category retries and falls back in order; attempts exhausted → `failed` + escalation log; `unknown` never becomes `delivered` or `failed`; a non-critical failure is abandoned after one retry; `no_adapter` records `skipped` | `lib/notifications/delivery.integration.test.ts` |
| **Integration — sweep** | the cron claims only due rows, is idempotent across overlapping runs (`FOR UPDATE SKIP LOCKED`), and honours backoff | `lib/notifications/sweep.integration.test.ts` |
| **Adapter** | the sandbox records rather than fabricates, and the factory **refuses a sandbox under `NODE_ENV=production`** (AC-10) | `lib/notifications/channels/sandbox.test.ts` |
| **API/authorization** | session required; CSRF on every mutation; another user's notification id is `404` never `403`; mark-read is idempotent; read-all returns the count; `422 CATEGORY_NOT_OVERRIDABLE`; `409` on stale version; ordering and `unreadOnly`; pagination does not repeat or skip across pages; no route can create a notification | `lib/notifications/routes.integration.test.ts` |
| **OpenAPI** | all seven browser routes registered and tagged `notifications`; the cron route deliberately absent | `lib/notifications/routes.integration.test.ts` |
| **Privacy** | export carries the caller's notifications, preferences and consent instant, and **no** `event_key`, `params` or delivery column; deletion redacts title/body/params and retains the consent record; retention deletes read rows past the window and never unread ones | `lib/notifications/privacy.integration.test.ts` |
| **Cross-spec boundary** | registering this spec's sinks makes spec 022's refund and spec 023's cancellation/no-show events produce exactly one notification each, without either spec changing | `lib/notifications/integration-seams.integration.test.ts` |
| **Migration** | reversible on an empty database; the baseline tables gain their columns; the dedup and ordering indexes exist; `check:schema-baseline` passes | `lib/db/migrations.integration.test.ts` (extended) |
| **UI** | loading, empty, error; unread not conveyed by colour alone; rendering does **not** mark read; locked categories show their reason; a failed save tells the user | `app/account/notifications/page.test.tsx` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `create.integration.test.ts::one event creates one notification and queues its enabled channels` |
| AC-2 | `create.integration.test.ts::a disabled category still creates the in-app row and no deliveries`; `routes.integration.test.ts::disabling a non-overridable category is 422` |
| AC-3 | `marketing.integration.test.ts::no consent creates nothing`; `::consent plus disabled promotions creates nothing`; `::withdrawal takes effect immediately` |
| AC-4 | `catalogue.test.ts::every type maps to exactly one category`; `migrations::the category CHECK rejects an unknown value` |
| AC-5 | `marketing.integration.test.ts::the fourth promotion in the window is suppressed and logged`; `::transactional sends do not count` |
| AC-6 | `delivery.integration.test.ts::a critical failure retries with backoff and falls back in order`; `::exhausted attempts fail loudly`; `::unknown is never collapsed` |
| AC-7 | `dedup.integration.test.ts::the same event key creates one notification`; `::concurrent handovers admit exactly one` |
| AC-8 | `routes.integration.test.ts::lists only the caller's notifications in created_at DESC, id DESC`; `::pagination neither repeats nor skips` |
| AC-9 | `routes.integration.test.ts::another user's notification is 404`; `::mark read is idempotent`; `boundaries.test.ts::no route creates a notification` |
| AC-10 | `channels/sandbox.test.ts::the sandbox records rather than fabricates`; `::the factory refuses a sandbox under NODE_ENV=production` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** real push/SMS/email deliverability — no vendor account or sandbox
exists, and a test against an adapter this repository does not have would test nothing (spec 021 §3's
position, unchanged); the notification copy of events whose producing spec has not shipped
(`messages` awaits 025, payout/earnings types await 024 — §7); AI proactive suggestions (034).

---

## 7. Out of scope

- **Real push, SMS or email provider integration** — this spec ships the adapter seam and a sandbox.
  A later spec supplies a vendor and implements `NotificationChannelAdapter`; nothing else changes.
- **A global notification bell in the app header** — deferred so this spec does not collide with the
  uncommitted navigation/design-system work in flight (§5). The account entry point is complete
  without it.
- ~~`messages` / payout event sources~~ — **superseded at implementation**: specs 024 and 025 shipped
  before this spec, each with an inert notification port (`registerPayoutNotificationSink`,
  `registerMessagingNotificationSink`). They are registered exactly like the 022/023 sinks (§10).
- **The decision to notify, and every producing spec's business logic** — owned by 015/016/018–025.
- **Notification copy catalogues for other specs' events beyond the template this spec defines.**
- **AI proactive suggestions** — spec 034.
- **Runtime feature-flag configuration** — spec 041. Channel selection is an environment variable,
  as spec 021's is.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Push/SMS/email provider selection for the Pakistan market (the draft's Open #1) | Platform | **Resolved as a boundary**: no vendor is chosen here. The `NotificationChannelAdapter` seam plus a sandbox that refuses to run in production (AC-10) means the system is complete and honest without one, and a vendor is a drop-in later |
| 2 | Exact marketing frequency cap (the draft's Open #2) | Product | **Resolved** (§3 "Marketing"): 3 per rolling 7 days, per notification, transactional excluded, both values environment-configurable. Master §58 mandates no number; leaving it open would block AC-5 |
| 3 | The draft assumed one preference row per category; the baseline has `UNIQUE (user_id)` | Platform | **Resolved** (§4): one row per user holding a validated per-category map. No baseline index is dropped |
| 4 | "Critical" was ambiguous — category or individual notification? | Platform | **Resolved** (§3): criticality is a property of the CATEGORY, fixed in code and CHECK-enforced. A critical booking event is classified `security`, not `booking` |
| 5 | The draft's `apps/worker` does not exist | Platform | **Resolved** (§3): the existing Vercel Cron + `CRON_SECRET` pattern, as five shipped sweeps already use. No new job system |
| 6 | A disabled category could have hidden events from the user entirely | Product/Platform | **Resolved** (AC-2): preferences gate OUTBOUND channels only; the in-app row is always written, so the notification centre is always complete |
| 7 | Notification bodies could leak another party's data | Platform | **Resolved** (§4): bodies are rendered from this spec's templates with id/amount params. No free text from another user is ever relayed |
| 8 | Marking read on render would destroy unread state | Product | **Resolved** (§5): reading is an explicit action. The draft's "mark read on view" is removed |
| 9 | Two producing specs had not shipped, so two categories had no events | Platform | **Resolved at implementation** (§10): 024 and 025 shipped first; their ports are registered |
| 10 | Adding a global header bell would collide with in-flight navigation work | Platform | **Resolved** (§5/§7): deferred; the account entry point is the surface this spec ships |

**No open question remains that blocks implementation.**

---

## 9. Rollout

- **Feature flag:** none for the system as a whole. Marketing is gated by **consent**, which is
  stronger than a flag and is required regardless; the draft's `marketing-notifications` flag is
  removed because spec 041 (which owns flags) has not shipped and consent already provides the
  control.
- **Environment:** five variables, kept in parity by `npm run check:env` —
  `NOTIFICATION_CHANNEL_PROVIDER` (default `sandbox`), `NOTIFICATION_MAX_ATTEMPTS` (5),
  `MARKETING_MAX_PER_WINDOW` (3), `MARKETING_WINDOW_DAYS` (7), `NOTIFICATION_RETENTION_DAYS` (180).
- **Migration order:** the migration ships with the code as one unit; the routes depend on its
  columns.
- **Cron:** `/api/v1/cron/notification-dispatch-sweep` added to `vercel.json` at `*/5 * * * *`, the
  same mechanism and bearer secret as the five existing sweeps.
- **Rollback — what it can and cannot mean.** "Revert the deploy" is not a sufficient statement for
  consent and delivery records, so:
  1. **Roll the code back, not the record.** Reverting stops new notifications being created and
     dispatched. The four producing specs' sinks return to their inert defaults — each already logs
     rather than throws, so **no producing spec breaks when this spec is rolled back**. That is the
     property that makes this safe, and it is worth preserving deliberately.
  2. **Do not apply the down migration once notifications exist.** It is gated on an empty table:
     notifications are the user's record of what they were told, and `marketing_consent_at` is a
     compliance record. Deleting either to undo a code defect would destroy evidence spec 008
     requires be retained. The correct response after launch is a forward fix.
  3. **Queued deliveries are safe to leave.** A `pending`/`retrying` row is claimed idempotently by
     whatever code version is deployed; an un-dispatched row sends late, never twice — the
     `(notification_id, channel)` unique index is what guarantees that.
  4. **Consent is never re-derived.** If preference rows are ever restored from backup, absent
     consent means **no consent**; it is never inferred from a `promotions` preference.
- **Observability (master §117):** structured logs for `notification.created`,
  `notification.delivery_attempted`, `notification.delivery_exhausted`,
  `notification.marketing_suppressed` and `notification.consent_changed`, each carrying
  `correlationId`, `notificationId`, `category` and `channel` — never a title, body, `params` value or
  recipient contact detail. Alert on: delivery failure rate per channel; any critical delivery
  exhausting its attempts; sustained `no_adapter` skips in production (which AC-10's guard should
  have made impossible); opt-out rate per category; and marketing suppression volume.

---

## 10. Implementation notes and verification

Implemented on `spec/026-notifications` on top of specs 023–025. Decisions the draft left open, resolved
in code without changing the scope above:

- **Migration number:** `_journal.json`'s head was `0021_add_messaging_conversations`, so this is
  `0022_add_notifications` (+ hand-written `_down`, gated on both tables being empty).
- **Non-overridable resolution (§3 step 2):** a critical category's *floor* channels are the defaults'
  `true` channels (email). They are always on; a stored `false` on them is ignored, and a PATCH setting one
  `false` is `422 CATEGORY_NOT_OVERRIDABLE` with nothing changed. Push/SMS may be additionally switched on.
  The UI renders these categories locked with their reason and no toggles.
- **Promotions preference:** "enabled" means at least one `promotions` outbound channel is on (all are off
  by default), so consent alone never produces a promotion.
- **Fallback (AC-6):** when a critical delivery is exhausted (or skipped `no_adapter`), the first channel
  after it in push → email → sms that the recipient currently has enabled is queued if it has no delivery
  row; a channel already delivered or in flight *is* the fallback. An `unknown` outcome at the attempt
  ceiling stays `retrying` with `next_attempt_at = null` (never guessed terminal) and is escalated.
- **Dispatch re-resolution:** a queued delivery whose channel was since switched off, whose promotion lost
  consent, or whose recipient was deleted is `skipped` (`preference_disabled` / `consent_withdrawn` /
  `account_deleted`), never sent. Under `NODE_ENV=production` with a sandbox the sweep touches nothing and
  the cron route answers `503`.
- **Catalogue:** 14 types. `no_show_response_requested` (a deadline affecting account standing) is
  `operational`; refund and payout outcomes are `payments`; `request_cancelled` is `provider_activity`.
- **Handoffs:** 022/023/024/025 sinks registered in `instrumentation.ts` via
  `registerNotificationIntegration()`; admin/finance-audience events (no user recipient) are logged, not
  notified. Spec 015's `notifyProvidersOfCancellation` now calls `notify()` for each *distributed* provider;
  spec 016's pending opt-ins are delivered by `lib/availability/notify-dispatch.ts`, run from the dispatch
  cron, then marked `sent`.
- **Retention:** run at the end of spec 008's `sweepDeletions()` (i.e. by `/cron/account-deletion-sweep`),
  so no new sweep exists and the route file itself is unchanged.

**Verification (every AC traced to a passing test in §6):** AC-1/AC-2 `create.integration.test.ts`,
`routes.integration.test.ts`; AC-3/AC-5 `marketing.integration.test.ts`; AC-4 `catalogue.test.ts`,
`lib/db/migrations.integration.test.ts`; AC-6 `retry.test.ts`, `delivery.integration.test.ts`,
`sweep.integration.test.ts`; AC-7 `dedup.integration.test.ts`; AC-8/AC-9 `routes.integration.test.ts`,
`boundaries.test.ts`; AC-10 `channels/sandbox.test.ts`, `delivery.integration.test.ts`. Privacy:
`privacy.integration.test.ts`; cross-spec seams (015/016/022/023/024/025):
`integration-seams.integration.test.ts`; UI: `app/account/notifications/page.test.tsx`.
