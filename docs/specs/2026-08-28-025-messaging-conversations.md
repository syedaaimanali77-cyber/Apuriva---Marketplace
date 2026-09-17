# Spec: Messaging & Conversations

**File:** `docs/specs/2026-08-28-025-messaging-conversations.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §53, §54, §55, §72, §100, §117, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §6.1, §6.2, §12, §19, [docs/workflow.md](../workflow.md)

**Depends on:** 003 (the `conversations` / `conversation_participants` / `messages` /
`message_attachments` baseline skeletons, `baseColumns()`, the `restrict`-FK-plus-covering-index
convention), 004 (`withApiRoute`, the error taxonomy, the **existing** `messaging` rate-limit
domain, `OPENAPI_ROUTES`, `parsePageParams`/`buildPage`), 005 (`requireSession`, `requireCsrf`,
`security_events`), 006 (`requireActiveMode`), 008 (privacy export and the account-deletion
anonymization sweep — both of which this spec extends), 009 (admin RBAC `resolvePermission`,
`permissions` seeding, `recordAdminAuditEvent`), 015 (`requireIdempotencyKey`,
`idempotencyFingerprint`, `IDEMPOTENCY_KEY_CONFLICT`), 019 (`lib/negotiation/contact-redaction.ts`
— the **existing** pure contact detector this spec reuses, and
`app/_components/RequestMessageThread.tsx` — the **existing** thread component this spec reuses),
020 (`bookings`, `BOOKING_STATUSES`, `requireBookingParticipant`), 021 (booking `confirmed` means
payment is authorized — the gate this spec reads for contact-sharing permission).

**Feeds:** 026 (notifications — consumes this spec's notification port), 027 (file uploads — owns
attachments, which this spec explicitly defers), 030 (blocking — registers this spec's
`ConversationBlockGate`), 031 (disputes — owns `dispute_messages`, a separate channel), 039 (audit
logging — takes over the audit events this spec emits through spec 009's helper), 041 (platform
configuration — may later make this spec's retention window runtime-configurable).

---

## 1. Problem statement

**Today:** Spec 019 shipped request-scoped, **pre-selection** chat on `offer_messages`: a thread is
the `(request, provider)` pair, it closes as soon as the request leaves `matching`/`offers_open`,
and it is capped at 5 messages per sender per 10 minutes. Once a booking exists, the two parties
have **no channel at all** — `conversations`, `conversation_participants`, `messages` and
`message_attachments` are still the empty spec 003 baseline skeletons carrying only `id`, audit
columns, `version` and structural foreign keys. Nothing has ever inserted a row into any of them.
`lib/privacy/export.ts` already *reads* `messages` for the data export, so it currently exports the
id, conversation id, sender id and timestamp of rows that cannot yet exist.

Master spec §54 requires post-booking conversation with personal phone/email never publicly
exposed and risky off-platform contact sharing detected without over-blocking legitimate service
information; §55 requires active chats to stay accessible, historical retention to follow a
configurable policy, and admin access to be restricted and audited; §53 requires an active block to
prevent future contact while leaving existing-booking communication reachable for safety and
support.

**Who is affected:** Every customer/provider pair with a booking, who today must coordinate arrival,
access, scope and completion with no channel; Trust & Safety, who need the off-platform signal;
Support, who need to read a conversation to resolve a ticket without that read being invisible.

**Why it matters now:** Spec 020 created the booking relationship and spec 021 made `confirmed` mean
"payment authorized". Those two together are exactly the relationship master spec §54's "after
booking" half attaches to, and nothing downstream (028 execution, 029 reviews, 031 disputes, 032
support) can assume a coordination channel until it exists.

**Success looks like:** A booking has exactly one conversation with exactly two participants; both
parties can read its full history for as long as the booking is live; contact details are masked
while the booking is not yet confirmed and flagged-but-preserved once it is; an active block stops
new messages without hiding history; a Support or Trust & Safety admin can read a conversation only
with an explicit reason that is audited; archived conversations expire on a documented, server-
configurable window by anonymizing bodies rather than deleting the record.

---

## 2. Acceptance criteria

The draft's six criteria are preserved in intent. AC-1 drops "WebSocket" for the transport that
actually exists in this repository (§3 "Real-time transport"), and drops "optimistic" for the
server-confirmed rule architecture §12 requires. AC-2's "before the platform explicitly allows
contact sharing" is resolved to a concrete booking-status gate (§3 "Contact-sharing protection").
AC-4's "handled per the configured retention rule" is resolved to a concrete anonymization
behaviour and a concrete default window (§4 "Retention and privacy"). AC-5 names the exact roles and
the mandatory reason. AC-6 names the exact effect of a block. AC-7 to AC-10 are added because
without them conversation identity, concurrency, immutability and the privacy seam are unspecified —
the four ways a messaging system silently loses or leaks a message.

| # | Criterion |
|---|---|
| AC-1 | **Given** a booking whose status is not archived (§3 "Conversation lifecycle") **When** either party opens it **Then** exactly one conversation exists for that booking, both parties can read its full history and post to it, and each party sees the other's new messages within one live-update interval without reloading the page. A message is rendered **only** after the server has confirmed it (architecture §12: never claim message success without a confirmed server response) |
| AC-2 | **Given** a message containing a phone number or email pattern **When** it is sent while the booking has **not** reached `confirmed` **Then** the matched token — and only the matched token — is replaced with `[contact removed]` before storage, the message is stored and delivered with `contactRedacted: true`, and the sender is shown in-context guidance. The message is never rejected and the surrounding service information is never altered. **When** the booking has reached `confirmed` or beyond **Then** master spec §54's "after booking: operational information can be shared as needed" applies: the body is stored verbatim, nothing is masked or blocked, and the message is recorded with `contactFlagged: true` as the Trust & Safety signal |
| AC-3 | **Given** a conversation whose booking is not archived **When** either participant accesses it **Then** its full message history is readable to them, paged, in a single stable total order, with no retention expiry applied |
| AC-4 | **Given** an archived conversation **When** `archived_at` is older than the configured retention window **Then** the scheduled sweep replaces every message body with the platform redaction sentinel and stamps `retention_applied_at`; the conversation, its participants, its message rows, ids and timestamps are retained. No message row is ever deleted, and no active conversation is ever swept |
| AC-5 | **Given** an admin **When** they read a conversation or its messages **Then** they are permitted only if they hold `messaging/read_conversation` (seeded for `support_admin`, `trust_safety_admin` and `super_admin` only), they must supply a non-empty `reason`, and each read writes an audit event carrying actor, roles, action, target conversation, reason and correlation id. An admin without that permission receives `403 FORBIDDEN` and no conversation data |
| AC-6 | **Given** an active block between the two participants (spec 030) **When** either attempts to post **Then** the post is rejected `403 BLOCKED` and no row is written; **reading** the existing conversation remains available to both parties and to authorized safety/support admins (master spec §53: existing-booking communication required for safety/support remains available) |
| AC-7 | **Given** a booking **When** any number of concurrent requests try to open its conversation **Then** exactly one `conversations` row exists for it, with exactly one `customer` and exactly one `provider` participant — guaranteed by database unique indexes, not by an application read-then-write check |
| AC-8 | **Given** the same `Idempotency-Key` submitted twice by one sender **When** both reach the server **Then** exactly one message row exists; the replay returns the original message with `200` rather than `201`, and a reused key with a different body is rejected `409 IDEMPOTENCY_KEY_CONFLICT` |
| AC-9 | **Given** a stored message **When** any code path attempts to edit or delete it **Then** the database refuses: there is no edit or delete endpoint, and a trigger rejects any `UPDATE` to `body`, `conversation_id`, `sender_user_id` or `created_at` other than the two sanctioned anonymizations (retention sweep, account-deletion sweep), and rejects every `DELETE` |
| AC-10 | **Given** a user who exports their data or deletes their account **When** either runs **Then** the export includes the bodies of messages in conversations they participate in, and the deletion sweep replaces the bodies **they authored** with the redaction sentinel while leaving the counterparty's messages and the conversation record intact |

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing mechanism reused | Not created |
|---|---|---|
| Contact detection | spec 019's pure `redactContactInfo()` in `lib/negotiation/contact-redaction.ts` | a second detector or a second pattern set |
| Thread UI | spec 019's `app/_components/RequestMessageThread.tsx`, generalized | a second chat component |
| Participant authorization | spec 020's `requireBookingParticipant()` in `lib/bookings/read.ts` | a bespoke ownership query |
| Rate limiting | spec 004's **already-declared** `messaging` domain (30 / 60s) | a new rate-limit domain |
| Idempotency | spec 015's `requireIdempotencyKey()` / `idempotencyFingerprint()` | a second idempotency scheme |
| Pagination | spec 004's `parsePageParams()` / `buildPage()` | a second pagination contract |
| Admin permission | spec 009's `resolvePermission()` and a seeded `permissions` row | a bespoke role check |
| Admin audit | spec 009's `recordAdminAuditEvent()` (writes `security_events`, namespaced) | a second audit store ahead of spec 039 |
| Scheduled work | the Vercel Cron pattern (`app/api/v1/cron/*`, bearer `CRON_SECRET`) | a new scheduler |
| Server-side config | the `process.env` + documented `.env.example` idiom spec 008 used for `DELETION_GRACE_PERIOD_DAYS` | a settings table ahead of spec 041 |

### Cross-spec ownership boundaries

These are binding. Where this spec needs something another spec owns, it consumes a seam and
implements none of that spec's logic.

| Concern | Owner | What spec 025 does |
|---|---|---|
| Pre-booking, request-scoped chat | **018** (the offer/`offer_messages` foundation) and **019** (the thread itself: send, list, closure, redaction) | Nothing. `offer_messages` is untouched; it is a different table, a different scope and a different lifecycle. The two are never merged, never migrated into each other, and a message never moves between them |
| Post-booking conversation | **025 (this spec)** | Owns `conversations`, `conversation_participants`, `messages`, their lifecycle, and their retention |
| Booking relationship and state | **020** | Reads `bookings.status` and calls `requireBookingParticipant()`. Performs **no** booking transition and writes no booking column |
| "Payment authorized" (`confirmed`) | **021** | Reads the status only, as the contact-sharing gate |
| Blocking and reporting mechanics | **030** | Consumes `ConversationBlockGate`; creates no block table, endpoint or override |
| Audit and compliance logging | **039** | Emits events through spec 009's existing helper; stands up no audit store |
| Configurable platform settings | **041** | Owns feature flags. This spec's retention window is server-side config (§4), not a flag, and spec 041 may take it over later |
| File storage and attachments | **027** | Defers attachments entirely; `message_attachments` is left as the spec 003 skeleton |
| Notification delivery | **026** | Emits to an inert port |
| Dispute / support correspondence | **031** / **032** | Separate channels on `dispute_messages` / `support_messages`; this spec neither reads nor writes them |

No business logic from any of these specs is pulled into spec 025.

### Conversation lifecycle (AC-1, AC-7)

**When it is created.** Lazily and idempotently, on the first participant request that touches it —
`GET /bookings/{id}/conversation` or `POST .../messages`. Creation runs inside the request's
transaction as `INSERT INTO conversations (booking_id) ... ON CONFLICT DO NOTHING` followed by a
`SELECT`, then the same for the two participant rows. This spec deliberately does **not** hook into
spec 020's `createBooking()` transaction: a conversation is not part of the booking's financial
invariant, and the unique index (§4) makes the lazy path race-proof without widening spec 020's
critical section. Concurrent first-touches therefore converge on one row (AC-7).

**Who the participants are, and their roles.** Exactly two, resolved once at creation from the
booking and then frozen: `bookings.customer_profile_id → customer_profiles.user_id` with
`role = 'customer'`, and `bookings.provider_profile_id → provider_profiles.user_id` with
`role = 'provider'`. No one else is ever added; there is no add-participant and no leave endpoint.

**What happens if the booking/provider relationship changes.** It cannot. `bookings.offer_id` is
`not null` under `bookings_offer_id_uq`, and `provider_profile_id` / `customer_profile_id` are
copied from the accepted offer at creation and never updated by any spec-020 path. Participants are
therefore permanently correct. If a future spec ever introduces provider reassignment, it **must**
open a new conversation against the new relationship rather than mutate `conversation_participants`
— rewriting a participant would retroactively hand a third party a conversation they were never in.
That constraint is recorded here as the owning spec's rule.

**One user who is both parties.** Impossible on a real booking (a provider cannot accept their own
request), but the participant unique index is on `(conversation_id, role)` as well as
`(conversation_id, user_id)`, so such a row could not be written even by a test fixture.

**Active vs. archived.** Derived from `bookings.status`, never stored as an independent truth:

| Booking status | Conversation | Rationale |
|---|---|---|
| `pending`, `confirmed`, `provider_en_route`, `arrived`, `in_progress`, `completed`, `protected`, `disputed` | **active** — read and write | The service, the payment-protection window or a dispute is still open; coordination is still needed |
| `settled`, `cancelled`, `refunded`, `failed` | **archived** — read-only | Money is final and no service relationship remains |

`conversations.archived_at` is a **cache** of that derivation, stamped by the first read or write
that observes an archived booking status, and never cleared (no archived status has an outgoing
transition back to an active one in any shipped or planned transition table). Posting to an archived
conversation is `422 CONVERSATION_ARCHIVED`; reading it always succeeds for participants until
retention anonymizes the bodies. A dispute does **not** move the conversation into spec 031's
`dispute_messages`: those are two separate channels, and this one stays open because `disputed` is
an active status above.

### Messaging behaviour (AC-1, AC-3, AC-8, AC-9)

**Allowed senders.** Only the two participants, each only in their own active mode
(`requireActiveMode(session, 'customer' | 'provider')` matched to their participant role), only
while the conversation is active, and only while no active block exists. Admins can never post —
there is no admin write endpoint. A non-participant receives `404 CONVERSATION_NOT_FOUND`, never
`403`, so conversation existence is not probeable.

**Ordering.** The single total order is `created_at ASC, id ASC`. The insert **explicitly derives
`created_at` from `clock_timestamp()`** rather than relying on spec 003's `defaultNow()` column
default: `now()` is the transaction start instant and would tie for any two rows written in one
transaction, whereas `clock_timestamp()` advances within a transaction — the same thing spec 019's
`insertThreadRow()` already does (`lib/negotiation/threads.ts`). Every read path — participant list,
admin list, delta poll, retention sweep, export — uses exactly this order.

`created_at` is additionally **strictly increasing per conversation and stored at millisecond
precision**: the send transaction holds the `conversations` row `FOR UPDATE` and writes
`GREATEST(date_trunc('milliseconds', clock_timestamp()), last_message_at + 1 ms)`, then advances
`conversations.last_message_at` to it. This is what makes the `after` cursor exact rather than merely
approximate. Without it, a message committed later could carry an equal timestamp and a smaller random
`id` than one a poller already holds, and the poller would never see it; and a microsecond timestamp
would not survive the round trip through a JavaScript ISO string. Serializing sends per conversation
also means commit order equals timestamp order, so no delta read can observe message N+1 before N.
`id` therefore never actually has a tie to break, but stays in the order as the documented tiebreak.

**Pagination.** Spec 004's offset contract, unchanged: `?limit` (default 20, max 100) and `?offset`,
answered with `apiPaged` and `buildPage`. Offsets are stable for this table specifically because the
order is **ascending** over an **append-only** table: a new message lands at the end and shifts no
earlier offset, and no row is ever deleted (AC-9). No cursor pagination contract is introduced.

**Incremental reads for live update.** `GET .../messages?after=<createdAtISO>|<id>` returns only
messages strictly after that point in the total order, up to `limit`. `after` is not an alternative
pagination scheme; it is the delta read the poller uses, and passing both `after` and `offset` is
`400 VALIDATION_ERROR`. A malformed `after` is `400 VALIDATION_ERROR`, never silently ignored, and is
rejected before the conversation is lazily created. The response keeps spec 004's paged envelope: in
`after` mode `page.total` is the number of messages after the cursor and `page.offset` is always `0`;
a client drains a longer gap by re-polling from the last message it received, never by offset.

One optional, telemetry-only parameter is accepted on a delta read: `resumed=<failedAttempts>:<gapSeconds>`,
which the client appends to its first successful poll after failed ones (§9 "Observability"). It never
changes the read, and because it is telemetry rather than input, a malformed value is ignored instead
of failing a participant's message fetch.

**Duplicate and concurrent sends.** `Idempotency-Key` is required on every send (spec 015). The key
is scoped **per sender** by `messages_sender_idempotency_key_uq`, never globally. The flow is spec
019's proven one: pre-check, insert, and on a unique violation re-read and return the original. A
replay returns `200` with the original message; a reused key with a different fingerprint is
`409 IDEMPOTENCY_KEY_CONFLICT` (AC-8). Two different keys arriving simultaneously both succeed —
concurrent sends are legitimate in a conversation and are simply ordered by their timestamps.

**Immutability, edit, delete.** Messages are immutable. There is no `PATCH` and no `DELETE`
endpoint, and `messages_append_only_trg` (§4) rejects every `DELETE` and every `UPDATE` that changes
`conversation_id`, `sender_user_id`, `created_at` or `body` — except a `body` change whose new value
is exactly the platform redaction sentinel, which is how the retention sweep (AC-4) and the
account-deletion sweep (AC-10) do their one sanctioned write. `updated_at` and `version` may change
with those. There is no "delete for me" and no unsend.

**Unread and read semantics.** `conversation_participants.last_read_at` is the only read state.
`POST /bookings/{id}/conversation/read` takes `{ lastReadMessageId }`, resolves that message's
`created_at`, and advances `last_read_at` **monotonically** — a stale client can never move it
backwards, so an older client cannot resurrect an unread badge. `unreadCount` on `ConversationDto`
is the count of messages from the **other** participant with `created_at > last_read_at`
(`last_read_at IS NULL` means all of them). A sender's own messages are never unread to them.

**Delivery and read indicators.** Two states only, both server-derived: **sent** (the row exists —
the only thing the server can honestly assert) and **read** (the counterparty's `last_read_at` is at
or after that message's `created_at`, surfaced per message as `readByCounterpartyAt`). There is
deliberately **no** "delivered" tick: with the transport below there is no delivery receipt distinct
from storage, and inventing one would be a claim the server cannot support.

**Optimistic-send reconciliation.** There is none, by decision. The composer shows a pending state
and the drafted text stays in the input until the server answers; the message appears in the thread
only from an authoritative server response. This is architecture §12's rule ("never claim booking/
payment/message success without confirmed server response") applied literally, and it removes an
entire class of reconciliation ambiguity: there is no client-generated message identity to
reconcile. A failed send keeps the draft **and** its `Idempotency-Key`, so retrying cannot duplicate.

**Body bounds.** Trimmed input 1–2000 characters, measured **before** redaction (spec 019 measures
before redaction too). The stored column check allows 1–2400 to leave headroom for redaction
placeholders and the retention sentinel. 2000 rather than spec 019's 1000 because post-booking
coordination carries access instructions and scope detail that 1000 characters routinely truncates.

**Anti-spam.** The `messaging` rate-limit domain (30 / 60s, already declared in
`lib/api/rate-limit.ts`) is the only throttle. Spec 019's extra 5-per-10-minutes per-thread cap is
deliberately **not** applied post-booking: it exists to stop pre-selection spam from strangers,
whereas these two parties have a contract with each other and a burst of short coordination messages
on arrival is normal.

### Contact-sharing protection (AC-2)

**The authority for when contact sharing becomes allowed is master spec §54 itself** — its "Before
selection" / "After booking" split — read through spec 020's booking status. No new policy system,
no configurable rule set, and no per-stage policy table is introduced.

The gate is a single predicate: **has this booking reached `confirmed`?** `confirmed` is the status
at which spec 021 has authorized payment and the parties are committed, which is precisely master
spec §54's "after booking". Because a conversation only exists once a booking exists, the only
pre-confirmation state reachable here is `pending`.

| Booking status | Behaviour on a detected phone/email pattern |
|---|---|
| `pending` | **Mask.** The matched token — and only that token — is replaced with `[contact removed]` by spec 019's `redactContactInfo()`. The message is stored and delivered with `contactRedacted = true`. The sender sees in-context guidance explaining that contact details can be shared once the booking is confirmed. The message is never rejected |
| `confirmed` and every later active status | **Flag, do not mask.** The body is stored verbatim; `contact_flagged = true` is recorded as the Trust & Safety signal. Nothing is masked, nothing is blocked, and the recipient sees the message exactly as written |

**Detection rules** are spec 019's, unchanged and reused rather than re-specified: an email pattern,
and a maximal run of Unicode decimal digits (so Urdu/Arabic-Indic digits count) of **≥ 10 digits**
joined only by at most two of space, `-`, `.`, `(`, `)`. Commas, `/` and `:` are not separators, so
prices ("3,500"), dates ("12/05/2026") and times ("10:30") never merge into a false positive. This
conservatism is master spec §54's "do not aggressively block legitimate service information", and it
is already unit-tested in `lib/negotiation/contact-redaction.test.ts`.

**Is the original stored?** For a masked (`pending`) message, **no** — the unredacted text is never
persisted and never logged, exactly as spec 019 does, because storing the thing §54 says must not be
exposed would defeat the rule. For a flagged (`confirmed`+) message, the body **is** the original,
because sharing it is permitted at that stage. There is no third "store the original alongside the
mask" mode.

**Nothing is silently dropped.** Masking replaces only the matched token; every other character is
preserved byte-for-byte. The response carries `contactRedacted`, so the sender is always told. A
message is never rejected, never truncated for this reason, and never withheld from the recipient.

**The flag signal.** One structured log line per flagged or redacted message, carrying
`conversationId`, `bookingId`, `senderUserId` and a count — never the content, redacted or not. Spec
038 consumes it, exactly as it consumes spec 019's `negotiation.contact_redacted`.

### Blocking (AC-6)

Spec 030 owns blocking mechanics — the `UserBlock` table, the block/unblock endpoints, and the
safety-team override. **This spec implements none of them.** It consumes a port, the same idiom spec
020 used for `CompletionEvidenceGate` and spec 022 for `RefundEligibilityGate`, because spec 030 has
not shipped and `user_blocks` does not exist:

```typescript
// lib/messaging/block-gate.ts
export interface ConversationBlockStatus {
  blocked: boolean;
  /** Which direction, for the sender-facing message. Opaque to this spec. */
  reason?: 'blocked_by_counterparty' | 'blocked_counterparty';
}

export type ConversationBlockGate = (
  tx: Executor,
  a: string,
  b: string,
) => Promise<ConversationBlockStatus>;
```

The shipped default returns `{ blocked: false }` — correct rather than a stub, because with no
blocking feature nobody is blocked. Spec 030 registers the real gate at startup and nothing else in
this spec changes. A gate that **throws** is treated as `blocked: false` and logged: a failure in an
unshipped safety dependency must not silently sever a live booking's coordination channel, and the
block's real enforcement point when it matters is spec 030's own.

Exact effect of an active block, in either direction:

| Operation | While blocked |
|---|---|
| `POST .../messages` | `403 BLOCKED`, no row written, no notification emitted |
| `GET .../conversation`, `GET .../messages` | **Allowed, unchanged** — master spec §53: existing-booking communication required for safety/support remains available. History is never hidden from either party |
| `POST .../read` | Allowed — marking already-visible history read is not contact |
| Admin read (§ "Admin and support access") | Allowed and unaffected — this is the explicit safety/support exception; a block must never be able to hide a conversation from Trust & Safety |

The gate is consulted **inside** the send transaction, after the participant and archive checks, so
a block applied mid-request cannot be raced past.

### Real-time transport (AC-1)

Architecture §6.1 names WebSockets for chat. **No WebSocket layer exists in this repository**, and
none of the infrastructure one needs exists either: `app/api/v1/**` is entirely Next.js Route
Handlers, deployment is Vercel serverless functions (`vercel.json`), there is no socket server, no
connection registry, no pub/sub, no managed real-time vendor in `package.json`, and there is no
`apps/worker`. Specs 018, 019, 020, 021 and 022 each hit this and each resolved it the same way, in
code that ships today: `app/_components/RequestMessageThread.tsx`,
`app/requests/[id]/OffersPanel.tsx`, `app/bookings/booking-client.ts` and
`app/bookings/_components/RefundSection.tsx` all poll, and all say so in their headers.

**Decision: authenticated polling of the authoritative REST endpoints, not WebSockets.** This is the
smallest deterministic choice consistent with architecture §6.1's own binding sentence — "the server
is always the source of truth; clients reconnect, retry, and refresh authoritative state rather than
trusting local state during disconnects" — which polling satisfies completely.
`WS /api/v1/ws/conversations/{id}` is **removed** from this spec's API contract. Introducing a
WebSocket tier is a platform decision for spec 046 (engineering operations), and when it lands it
replaces the transport underneath these same endpoints without changing a single DTO, error code or
table defined here.

Concretely:

- Live-update interval **5 seconds** while the conversation is active, focused and visible; polling
  **stops** when the conversation is archived, when the tab is hidden, and after a `403 BLOCKED`
  send. It resumes on focus with an immediate delta read. (Spec 019's interval is 10s; 5s here
  because arrival-time coordination is more latency-sensitive than pre-selection negotiation, and
  the `messaging` domain's 30/60s budget accommodates it.)
- Each poll is a delta read: `GET .../messages?after=<cursor>&limit=50`, where the cursor is the
  last message the client holds in the total order.
- **Reconnect/resume semantics.** There is no connection to resume, which is the point: after a
  network failure, a sleep, or a redeploy, the client simply issues the same delta read from its
  last known cursor. It can therefore never miss a message and never needs a replay buffer. On a
  failed poll the client keeps its rendered history, shows a non-blocking "reconnecting" state,
  retries with exponential backoff capped at 30 seconds, and never discards or reorders what the
  server already confirmed.
- A `429` from a poll backs off for the returned `Retry-After` and never escalates its rate.

### Admin and support access (AC-5)

| Requirement | Resolution |
|---|---|
| Exact roles | `support_admin`, `trust_safety_admin`, `super_admin` — and no others. Migration 0021 seeds `permissions` rows for `(resource: 'messaging', action: 'read_conversation')` for exactly those three role names |
| Authorization boundary | `resolvePermission(userId, 'messaging', 'read_conversation')` (spec 009). An authenticated admin without that permission gets `403 FORBIDDEN` and zero conversation data. An `operations_admin`, `finance_admin`, `content_admin` or `analytics_admin` therefore cannot read any conversation — this is the "prevent ordinary admins" requirement, enforced by the seed being narrow, not by a filter in application code |
| Risk tier | `medium`. Reading private correspondence is sensitive enough to be audited and narrowly granted, but spec 009 requires a second approver only at `high`/`critical`, and gating an in-progress support ticket or safety investigation behind a second admin would make the access useless at the moment it is needed |
| Mandatory reason | `?reason=` is **required** on every admin read, trimmed, 10–500 characters. Absent, blank or too short is `400 VALIDATION_ERROR` before any data is loaded. It is stored in the audit event verbatim |
| Audit (spec 039) | Every admin read calls spec 009's `recordAdminAuditEvent()` with `eventType` `messaging.admin_conversation_read` or `messaging.admin_messages_read`, `resource: 'messaging'`, `action: 'read_conversation'`, `targetType: 'conversation'`, `targetId`, the actor's roles, the reason, and the request's correlation id. Paging is audited **per page**, not once per investigation. The audit event is written **before** the response is returned, so if the audit write fails the request fails and no conversation data leaves unaudited; a lookup of an unknown conversation returns `404` and writes nothing. Spec 039 owns the audit store; until it ships these land in `security_events` through spec 009's existing helper, namespaced `messaging.*` — the same choice spec 009 itself documented, not a second audit system. Spec 009's helper had no correlation-id field, so it gains one **optional** `correlationId` input (added to the event metadata only when supplied); every existing caller is unaffected |
| Guard order | Session, then the `messaging` rate limit, then permission (`403`), then `reason` (`400`), then the conversation lookup (`404`), then the audit write, then the response — so an unauthorized admin learns nothing about the conversation, not even whether its id exists |
| Write access | None. There is no admin post, edit, delete or unarchive endpoint in this spec |
| Blocking | An active block never restricts admin read (§ "Blocking") |

### Endpoints

All paths are relative to `/api/v1`. Every route is a Next.js Route Handler under `app/api/v1/`
wrapped in `withApiRoute`; **the draft's `apps/api` / `packages/*` paths do not exist in this
repository and are corrected throughout.**

| Method | Route | File | Auth | Success | Notes |
|---|---|---|---|---|---|
| `GET` | `/bookings/{id}/conversation` | `app/api/v1/bookings/[id]/conversation/route.ts` | session, booking participant, matching active mode | `200` `ApiResponse<ConversationDto>` | Creates the conversation on first access (idempotent). Rate-limited `messaging` |
| `GET` | `/bookings/{id}/conversation/messages` | `app/api/v1/bookings/[id]/conversation/messages/route.ts` | same | `200` `PagedResponse<MessageDto>` | `limit`/`offset`, or `after` for the delta read. Rate-limited `messaging` |
| `POST` | `/bookings/{id}/conversation/messages` | same file | same + `requireCsrf` + `Idempotency-Key` | `201` `ApiResponse<MessageDto>` (`200` on replay) | Rate-limited `messaging` |
| `POST` | `/bookings/{id}/conversation/read` | `app/api/v1/bookings/[id]/conversation/read/route.ts` | same + `requireCsrf` | `200` `ApiResponse<ConversationReadStateDto>` | Monotonic. No `Idempotency-Key` — it is naturally idempotent |
| `GET` | `/admin/conversations/{id}` | `app/api/v1/admin/conversations/[id]/route.ts` | session + `messaging/read_conversation` | `200` `ApiResponse<AdminConversationDto>` | `reason` required; audited. Metadata and participants only — no bodies |
| `GET` | `/admin/conversations/{id}/messages` | `app/api/v1/admin/conversations/[id]/messages/route.ts` | same | `200` `PagedResponse<AdminMessageDto>` | `reason` required; audited **per page**. Carries bodies |
| `GET` | `/cron/message-retention-sweep` | `app/api/v1/cron/message-retention-sweep/route.ts` | `Authorization: Bearer ${CRON_SECRET}` | `200` | Vercel Cron, daily. Excluded from OpenAPI drift like every other cron route |

CSRF is required on every mutating route via `requireCsrf(request, session.id)`; `GET` routes do not
take it, matching every shipped route in this repository. Every one of the six non-cron routes is
added to `OPENAPI_ROUTES` in `lib/api/openapi-registry.ts` **in the same PR** —
`npm run check:openapi-drift` fails CI otherwise.

### Request and response types

```typescript
// lib/types/messaging.ts — this repository has no `packages/types`; every DTO lives under lib/types/*.

export type ConversationParticipantRole = 'customer' | 'provider';

export interface ConversationParticipantDto {
  userId: string;
  role: ConversationParticipantRole;
  /** Business name for the provider, display name for the customer. Never a phone or email. */
  displayName: string | null;
  lastReadAt: string | null;
}

export interface ConversationDto {
  id: string;
  bookingId: string;
  participants: ConversationParticipantDto[];
  /** Derived from bookings.status (§3 "Active vs. archived"); false means read-only. */
  isActive: boolean;
  archivedAt: string | null;
  /** True once the booking has reached `confirmed` — drives the composer's guidance copy. */
  contactSharingAllowed: boolean;
  messageCount: number;
  lastMessageAt: string | null;
  /** Messages from the OTHER participant newer than the caller's lastReadAt. */
  unreadCount: number;
  createdAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderUserId: string;
  senderRole: ConversationParticipantRole;
  /** Stored form: masked while the booking is pre-`confirmed`, verbatim after. */
  body: string;
  /** AC-2: a contact pattern was masked before storage. */
  contactRedacted: boolean;
  /** AC-2: a contact pattern was detected and PERMITTED (post-confirmation). */
  contactFlagged: boolean;
  /** Set once the counterparty's lastReadAt reaches this message. Null otherwise. */
  readByCounterpartyAt: string | null;
  /** AC-4/AC-10: the body has been anonymized by a retention or deletion sweep. */
  redactedByRetention: boolean;
  createdAt: string;
}

export interface SendMessageRequest {
  /** Trimmed, 1–2000 characters, measured BEFORE redaction. */
  body: string;
}

export interface MarkConversationReadRequest {
  /** Must be a message in this conversation. */
  lastReadMessageId: string;
}

export interface ConversationReadStateDto {
  conversationId: string;
  lastReadAt: string;
  unreadCount: number;
}

/** Admin metadata view — deliberately carries NO message bodies. */
export interface AdminConversationDto {
  id: string;
  bookingId: string;
  participants: Array<{ userId: string; role: ConversationParticipantRole }>;
  isActive: boolean;
  archivedAt: string | null;
  retentionAppliedAt: string | null;
  messageCount: number;
  contactFlaggedCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

/** Admin message view. Same body the participants see — never an "unmasked" variant. */
export interface AdminMessageDto extends MessageDto {}
```

**Attachments are out of scope for this spec.** The draft's `attachmentIds: string[]` is removed and
`message_attachments` is left exactly as spec 003's baseline skeleton. `file_assets` is still a bare
skeleton with no `storage_key`, `visibility`, `size_bytes` or `status`, and spec 027 — which owns
upload, scanning, private-bucket storage and signed URLs — has not shipped. Specifying an attachment
contract against a table that cannot store a file would be inventing infrastructure that does not
exist. Spec 027 adds message attachments on top of the `messages` rows this spec creates.

### Error codes

New codes this spec adds to spec 004's taxonomy, following its SCREAMING_SNAKE_CASE and stability
rule. All are thrown as `ApiRouteError` with an explicit `status`, since they are not in the baseline
`API_ERROR_CODES` map.

| HTTP | `code` | When |
|---|---|---|
| `404` | `CONVERSATION_NOT_FOUND` | The booking does not exist, or the caller is not one of its two participants, or the id is not a uuid. Deliberately indistinguishable from "no such booking" so existence is not probeable |
| `422` | `CONVERSATION_ARCHIVED` | A send or read-marker against a conversation whose booking has reached `settled`/`cancelled`/`refunded`/`failed`. Reads still succeed |
| `403` | `BLOCKED` | An active block between the participants. Defined once, in `lib/messaging/errors.ts`, and re-exported to spec 030 when it ships — spec 030's draft declares the same code, and one definition must serve both |
| `422` | `MESSAGE_NOT_IN_CONVERSATION` | `lastReadMessageId` names a message that is not in this conversation |

Reused, not redefined: `400 VALIDATION_ERROR` (body bounds, missing/short `reason`, malformed
`after`, `after` combined with `offset`, missing `Idempotency-Key`), `401 UNAUTHENTICATED`,
`403 FORBIDDEN` (admin without `messaging/read_conversation`; wrong active mode),
`409 IDEMPOTENCY_KEY_CONFLICT` (spec 015, `lib/requests/errors.ts`), `429 RATE_LIMITED` (`messaging`
domain, with `Retry-After`), `500 INTERNAL_ERROR`.

### Breaking-change check

- [x] N/A — new spec. It adds columns to four never-written baseline tables and extends two spec 008
      functions (§4 "Retention and privacy"); no existing endpoint, DTO or error code changes shape.

---

## 4. Data model changes

### What already exists (inspected before anything was added)

`lib/db/schema.ts` **already** declares `conversations`, `conversation_participants`, `messages` and
`message_attachments` as spec 003 baseline skeletons, created by `0001_baseline_schema.sql`. No spec
has ever written to them. `conversations` already has both `request_id` and `booking_id` nullable
FKs and covering indexes; `conversation_participants` already has `conversation_id`, `user_id`, both
covering indexes and `conversation_participants_conversation_user_uq`; `messages` already has
`conversation_id`, `sender_user_id` and both covering indexes; `message_attachments` already has
`message_id`.

**This spec therefore creates no messaging table.** It extends the four skeletons in place, exactly
as spec 019 extended `offer_messages` and spec 022 extended `refunds`. Creating parallel tables would
orphan the reads `lib/privacy/export.ts` already performs against `messages` and
`conversation_participants`.

Spec 018/019's pre-selection chat lives on `offer_messages` and is **untouched**: it does not use
`conversations` at all, and `conversations.request_id` stays unused and nullable for whatever later
spec claims it.

### Entities

| Entity | Change | Fields added by this spec |
|---|---|---|
| `Conversation` | extend skeleton | `archived_at timestamptz null`, `retention_applied_at timestamptz null`, `last_message_at timestamptz null` |
| `ConversationParticipant` | extend skeleton | `role text not null`, `last_read_at timestamptz null` |
| `Message` | extend skeleton | `body text not null`, `sender_role text not null`, `contact_redacted boolean not null default false`, `contact_flagged boolean not null default false`, `redacted_by_retention boolean not null default false`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `MessageAttachment` | **unchanged** | none — spec 027 owns attachments (§3) |
| `Permission` | seed rows | `(messaging, read_conversation, medium)` for `support_admin`, `trust_safety_admin`, `super_admin` |

**No money columns, and none possible.** Nothing in this spec is monetary, so no `moneyColumns()`
pair is added and there is no numeric/real/double column anywhere in it — `npm run
check:schema-money-lint` already bans float types schema-wide and continues to pass. `message_count`
is not stored; it is counted, so there is no denormalized integer to drift.

### Indexes, constraints and uniqueness

Added to the existing tables; every pre-existing index and FK is retained, and every FK stays
`onDelete: 'restrict'` per spec 003 AC-4.

| Object | Definition | Why |
|---|---|---|
| `conversations_booking_id_uq` | `unique (booking_id) where booking_id is not null` | AC-7: one conversation per booking, enforced by the database. Partial, so the unused `request_id` scope is not constrained |
| `conversation_participants_conversation_role_uq` | `unique (conversation_id, role)` | AC-7: exactly one customer and exactly one provider |
| `conversation_participants_role_ck` | `role in ('customer','provider')` | |
| `messages_conversation_created_at_id_idx` | `(conversation_id, created_at, id)` | The one index every read path uses: the paged list, the `after` delta read, the retention sweep and the export all order by exactly this |
| `messages_sender_idempotency_key_uq` | `unique (sender_user_id, idempotency_key)` | AC-8, scoped per sender, never globally — the same shape as `offer_messages_sender_idempotency_key_uq` and `bookings_customer_idempotency_key_uq` |
| `messages_sender_role_ck` | `sender_role in ('customer','provider')` | |
| `messages_body_length_ck` | `char_length(body) between 1 and 2400` | Input bound 2000 plus headroom for redaction placeholders and the sentinel |
| `messages_contact_exclusive_ck` | `not (contact_redacted and contact_flagged)` | A message is masked **or** permitted-and-flagged, never both — AC-2's two branches are mutually exclusive by construction |
| `messages_append_only_trg` | trigger (below) | AC-9 |

`messages_append_only_trg` uses a new function `enforce_messages_append_only()` — the same
hand-appended pattern `0018_add_refunds.sql` used for `enforce_refund_lines_append_only()`, since
Drizzle's schema DSL has no trigger builder:

```sql
CREATE FUNCTION enforce_messages_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'messages rows are immutable and cannot be deleted';
  END IF;
  IF NEW.conversation_id <> OLD.conversation_id
     OR NEW.sender_user_id <> OLD.sender_user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'messages identity columns are immutable';
  END IF;
  -- The ONLY sanctioned body write: anonymization to the platform redaction sentinel,
  -- by the retention sweep (spec 025 AC-4) or the deletion sweep (spec 008 / AC-10).
  IF NEW.body <> OLD.body AND NEW.body <> '[redacted]' THEN
    RAISE EXCEPTION 'message bodies are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

The sentinel is spec 008's existing `REDACTED_DESCRIPTION` constant
(`lib/privacy/deletion.ts`, value `'[redacted]'`), already used there for request descriptions,
offer `provider_message` and `offer_messages.body` — reused, not reinvented, so one sentinel means
"anonymized" everywhere in the schema and the trigger's allowance has exactly one legal value.

### Migration

- **Name / number:** `0021_add_messaging_conversations` — the next number in the actual committed
  sequence, which now ends at `0019_add_cancellation_policy_no_show.sql` (spec 023) and
  `0020_add_provider_payouts_earnings.sql` (spec 024). Neither touches a messaging table. Migration
  numbers are strictly sequential and never reused: if another spec (e.g. 026, whose branch also
  exists) merges a `0021` first, this migration takes the next free number at implementation time,
  with no change to its content. The draft's `AddMessagingTables` is wrong on both counts: it names
  tables that already exist, and it carries no number.
- **Down file:** `drizzle/0021_add_messaging_conversations_down.sql`, hand-written (drizzle-kit
  generates none), carrying **no** entry in `drizzle/meta/_journal.json` so `npm run db:migrate`
  never applies it — the same arrangement as 0018.
- **Reversible:** yes, with a gate. See §9 "Rollback".
- **Backfill required:** no. Every added column is nullable or has a default, and all four tables are
  empty in every environment (nothing has ever inserted into them).
- **Downtime:** none. Adding nullable/defaulted columns and indexes to empty tables takes no
  meaningful lock.
- **Baseline immutability:** `0001_baseline_schema.sql` and its `.sha256` sidecar are **not** touched;
  `npm run check:schema-checksum` must still pass.
- **Reviewed SQL:** generated with `npm run db:generate`, then hand-appended with the trigger
  function, the trigger, and the `permissions` seed `INSERT ... SELECT` joined to `roles` — the same
  structure as `0018_add_refunds.sql` lines 133–139.

### Retention and privacy

This spec **is** the retention mechanism for booking-level messaging (master spec §55).

**The open question is resolved.** The draft left "default historical retention window length" Open
and pointed at spec 041. Inspection shows spec 041 owns **feature flags** — `FeatureFlag` plus
`FeatureFlagEnvironmentValue`, a per-environment **boolean** — and nothing in it stores a numeric
policy value; there is no platform-settings table in this repository, shipped or specified. Pointing
a window length at it would be a dangling reference.

**Decision:** the window is a server-side configuration value read from the environment, using the
exact idiom spec 008 established for the same class of Legal/Product-owned question
(`DELETION_GRACE_PERIOD_DAYS`, `lib/privacy/deletion.ts`):

- `MESSAGE_RETENTION_DAYS`, documented in `.env.example` (required — `npm run check:env` fails
  otherwise), **default 730 days (24 months)** when unset or invalid, clamped to a minimum of 90.
- 730 because the conversation is the evidentiary record behind reviews (029), disputes (031) and
  chargebacks, and it must outlive every downstream window that could need it; 90 as a floor so a
  misconfiguration cannot destroy a conversation that is still operationally relevant.
- Legal/Product confirm the final value before production. Changing it is a config change, not a code
  change, and — as with spec 008 — this is an implemented default, not an open question.
- Ownership boundary: if spec 041 later grows a genuine numeric platform-configuration store, it may
  take this value over. That is a spec 041 decision; spec 025 does not pre-build a settings table for
  it.

**Active vs. historical.** An active conversation (§3 "Active vs. archived") is **never** swept and
its full history stays readable to both participants for as long as the booking is live — master
spec §55's "active booking/request chats remain accessible", and AC-3. Only `archived_at` starts the
clock.

**What "handled per the retention rule" means, exactly.** `GET /cron/message-retention-sweep` runs
daily, in two steps:

1. **Start the clock for unobserved archives.** `archived_at` is a cache stamped by the first request
   that observes an archived booking status; the sweep is an observer too. It stamps `archived_at` on
   every conversation whose booking is in an archived status and whose `archived_at` is still null.
   Without this step, a conversation nobody reopened after its booking was cancelled would never start
   its retention window and would be kept indefinitely — exactly what AC-4 forbids.
2. **Anonymize expired archives.** For every conversation with
   `archived_at < clock_timestamp() - MESSAGE_RETENTION_DAYS` and `retention_applied_at IS NULL`, whose
   booking status is **re-checked in the same statement** to still be archived, in one transaction:
   set every one of its messages' `body = '[redacted]'` and `redacted_by_retention = true`, then stamp
   the conversation's `retention_applied_at`.

Idempotent — `retention_applied_at IS NULL` is the guard and the selection takes `FOR UPDATE SKIP
LOCKED`, so a double run, an overlapping run or a retry does nothing twice. Bounded per invocation
(1000 conversations, oldest archive first) so a backlog drains over successive days rather than in one
long transaction.

**Deletion vs. anonymization.** Rows are **anonymized, never deleted**. Every FK in this schema is
`restrict`, the conversation is the parent of nothing this spec owns but the child of a booking that
spec 008 requires be retained as a financial record, and the message count and timestamps remain a
legitimate operational record. This is also exactly what specs 015, 018 and 019 do with their own
free text. `redacted_by_retention` makes the state visible in the DTO rather than presenting an
anonymized thread as if the words were the user's.

**Privacy export (spec 008), extended.** `lib/privacy/export.ts` already selects `messages` joined to
`conversation_participants` on the exporting user — the correct participant boundary, already
written. This spec **extends the selected columns** to include `body`, `senderRole`,
`contactRedacted`, `contactFlagged` and `redactedByRetention`, and adds the conversation's
`bookingId`, so the export is the user's actual correspondence rather than a list of ids. The
boundary itself is unchanged: only conversations the user participates in, counterparty messages
included (they were sent to the user), never messages the user merely sent to a conversation they are
not in.

**Account deletion (spec 008), extended.** `lib/privacy/deletion.ts`'s sweep gains one statement,
mirroring the existing `offer_messages` redaction statement:

```sql
UPDATE messages SET body = ${REDACTED_DESCRIPTION}, redacted_by_retention = true,
                    updated_at = clock_timestamp()
 WHERE sender_user_id = ${id} AND body <> ${REDACTED_DESCRIPTION}
```

The counterparty's messages, the conversation, the participant rows, every id and every timestamp
survive — the deleted user's words are removed, not the other party's record of the booking.

**What is never stored or logged.** The unredacted body of a pre-confirmation message (§3
"Contact-sharing protection"). The contact-flag log line carries identifiers and counts only, never
content. No message body is ever written to an application log by any code path in this spec.

---

## 5. UI states

**Placement.** The conversation is rendered **inside the existing booking detail pages**, not on a
new route: `app/bookings/[id]/page.tsx` for the customer and
`app/provider/schedule/bookings/[id]/page.tsx` for the provider — the same way spec 022's
`RefundSection` is embedded. No new page chrome, no second header, and per CLAUDE.md's branding rule
no logo of its own: the booking page already carries the page's one intentional brand placement. The
draft's `apps/web/app/bookings/[id]/chat` does not exist and is not created.

**Components.** `packages/ui` does not exist in this repository, and there is no `Chat` or
`MessageBubble` component anywhere in `ui/` or `components/`. What **does** exist is spec 019's
`app/_components/RequestMessageThread.tsx` — a complete, tested, accessible thread already composed
from the design system (`Textarea`, `Button`, `Alert`, `Badge`, `FormField`, `Skeleton`, `ErrorState`
via `@/components`), already driving a list URL plus a post URL with `Idempotency-Key`, CSRF,
redaction notices and closed-thread handling.

This spec **reuses that component** rather than building a second one: it is generalized in place
(its props already parameterize the endpoints, the viewer role, the counterparty label, the can-send
flag and the closed message), and a thin `app/bookings/_components/BookingConversation.tsx` supplies
the booking-scoped endpoints, the `ConversationDto` it polls, and the read-marker call. No
design-system component is added, no existing one is restyled, no CSS file is added or changed, and
**no visual redesign or Design System polishing is performed** — the existing tokens and primitives
are used exactly as they are.

The generalization is strictly additive: `RequestMessageThread` becomes generic over a minimal
`ThreadMessage` shape (both spec 019's `OfferMessageDto` and this spec's `MessageDto` satisfy it) and
gains optional props — `live` (the polling transport), `closedCodes`, `blockedCodes`/`blockedMessage`,
`retainKeyOnFailure`, `announceIncoming`, `emptyContent`, `composerHelp`, `maxLength`,
`redactionNotice` and `renderMessageMeta`. **Every default reproduces spec 019's behaviour exactly**:
without `live` it still refetches its first page every 10 seconds, it still sends a fresh
`Idempotency-Key` on every submission, `THREAD_CLOSED` still closes it, and its copy is unchanged.
Spec 019's component tests pass unmodified; two are added for the new props.

`BookingConversation` loads the `ConversationDto` on mount and refreshes it every 30 seconds (the read
markers behind "Seen" and the active state), well inside the `messaging` rate-limit budget alongside
the 5-second delta poll. That refresh stops once the conversation is archived (nothing can change)
and whenever the endpoint answers with an error or an unusable shape — the rule spec 022's
`RefundSection` follows: an endpoint that is not answering usefully will not start doing so because it
is asked again, so the retry is left to the viewer. The read marker is posted only when a newer
counterparty message has arrived while the tab is visible, and again when the tab becomes visible.
Customers have no display-name column in this schema, so `ConversationParticipantDto.displayName` is
`null` for the customer and the provider's screen labels the counterparty "Your customer".

| State | Behaviour |
|---|---|
| **Loading** | A "Messages" card renders the existing `Skeleton` placeholders until the conversation summary loads; no composer is shown yet. The booking detail page around it is unaffected |
| **Empty** | `EmptyState` with a neutral prompt ("No messages yet — say hello") plus, while the booking is pre-`confirmed`, the one-line contact-sharing guidance. Never an error styling |
| **Error** | A failed **load** shows `ErrorState` with retry, keeping any history already rendered. A failed **send** keeps the drafted text and its `Idempotency-Key` in the composer and shows an inline retry. `429` shows the `Retry-After` wait. `403 BLOCKED` disables the composer with a plain explanation and stops polling; history stays visible. `422 CONVERSATION_ARCHIVED` disables the composer and states the conversation is read-only |
| **Success** | The message appears **only** after the server confirms it (§3 "Optimistic-send reconciliation"). `contactRedacted` shows a gentle, non-punitive in-context notice explaining the mask and when details may be shared — never a warning banner, never a strike. Read state is a quiet timestamp on the sender's own last read message, not a tick on every bubble |

**Accessibility.** Fully keyboard operable: the composer is a labelled `Textarea`, Enter inserts a
newline, and the send control is a real `<button>` reachable by Tab (never a keyboard trap, never a
key-only send that a screen-reader user cannot discover). The message list is a semantic list with
each message's sender and time available to assistive technology. New incoming messages are announced
through a **polite** live region reporting an aggregate ("2 new messages from {counterparty}") rather
than reading every body aloud — the draft's "not overly chatty" requirement made concrete. Sending,
failure and the redaction notice are each announced once. Focus never moves on its own when a poll
returns. This is spec 043's baseline applied, not extended.

**RTL.** The thread inherits the app's existing direction handling — logical CSS properties
(`margin-inline`, `padding-inline`, `text-align: start`) only, no physical left/right — so an Urdu
conversation mirrors correctly. Message alignment (own vs. counterparty) is expressed as start/end,
not left/right. Spec 042 owns translation of message **content**; it is out of scope here.

---

## 6. Test plan

Paths corrected to this repository: there is no `apps/api`, no `apps/web`, no `apps/web-e2e` and **no
Playwright**. Unit and integration tests are Vitest under `lib/messaging/`, component tests are Vitest
+ Testing Library beside the component, and `e2e/*.spec.ts` is the Vitest pattern already configured
in `vitest.config.ts` that drives real route handlers against the isolated `*_test` database (see
`e2e/refund.spec.ts`).

**There is no WebSocket E2E infrastructure in this repository, and this plan requires none** — the
transport is polling (§3), so "real-time exchange" is testable as a delta read returning the
counterparty's message, with no socket harness, no browser and no new tooling.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | the contact gate (pre-`confirmed` masks, `confirmed`+ flags without masking); active/archived derivation across all twelve booking statuses; `after`-cursor parse and validation; retention-window resolution including the 90-day clamp and the invalid-env fallback; unread counting | `lib/messaging/*.test.ts` |
| **Integration** | send/read round trip both directions; lazy creation under concurrency (AC-7); idempotent replay and key conflict (AC-8); blocked send rejected with history still readable (AC-6); archived conversation read-only; non-participant gets `404`; wrong active mode gets `403`; immutability trigger rejects update and delete (AC-9); retention sweep anonymizes only expired archived conversations and is idempotent (AC-4); admin permission boundary, mandatory reason, one audit event per page (AC-5); export includes bodies and deletion redacts only the author's (AC-10) | `lib/messaging/*.integration.test.ts` |
| **Component** | loading/empty/error/success states; failed send keeps draft **and** key; redaction notice; blocked and archived composer states; polite live region announces an aggregate, not bodies; no message renders before server confirmation | `app/bookings/_components/BookingConversation.test.tsx`, `app/_components/RequestMessageThread.test.tsx` (extended) |
| **E2E (Vitest)** | full path with nothing mocked: book → confirm → customer posts → provider reads it → provider replies → customer's delta read receives exactly the reply → customer marks read → unread returns to zero; and a booking reaching an archived status (`pending → failed`, the archived transition reachable through already-shipped specs) leaves the conversation read-only with its history intact | `e2e/messaging.spec.ts` |
| **Accessibility** | keyboard-only send; labelled composer; list semantics; live-region politeness and aggregate wording; logical-property/RTL check | `app/bookings/_components/BookingConversation.a11y.test.tsx` |

**Traceability — every AC has at least one test.**

| AC | Test |
|---|---|
| AC-1 | `e2e/messaging.spec.ts::both parties exchange messages on a live booking`; `lib/messaging/delta-read.integration.test.ts::after-cursor returns only newer messages` |
| AC-2 | `lib/messaging/contact-gate.test.ts::masks before confirmation without altering surrounding text`; `::flags without masking after confirmation`; `::never rejects a message and leaves legitimate service information untouched in both stages`; `lib/messaging/contact-sharing.integration.test.ts` (stored and delivered forms on each side of the gate; the log carries no content) |
| AC-3 | `lib/messaging/read.integration.test.ts::active conversation exposes full paged history in one stable order` |
| AC-4 | `lib/messaging/retention.integration.test.ts::anonymizes expired archived conversations, never active ones, idempotently` |
| AC-5 | `lib/messaging/admin-access.integration.test.ts::only support/trust-safety/super admins`; `::rejects a missing or short reason`; `::writes one audit event per page read` |
| AC-6 | `lib/messaging/blocking.integration.test.ts::blocked send rejected, history still readable, admin read unaffected` |
| AC-7 | `lib/messaging/create-race.integration.test.ts::concurrent first access yields one conversation and two participants` |
| AC-8 | `lib/messaging/idempotency.integration.test.ts::replay returns 200 with the original; changed body is 409` |
| AC-9 | `lib/messaging/immutability.integration.test.ts::update and delete are refused; sentinel write is allowed` |
| AC-10 | `lib/messaging/privacy.integration.test.ts::export carries bodies for participated conversations only`; `::deletion redacts only the author's messages` |

**Coverage:** ≥ 80% on new code (`lib/messaging/**`, the new route handlers, and
`app/bookings/_components/BookingConversation.tsx`).

### Implementation verification

Recorded when this spec moved to Approved (branch `spec/025-messaging-conversations`, built on spec 024).
Every run used the isolated `apuriva_test` database that `vitest.config.ts` enforces; the developer's
normal database was never touched.

| AC | Verified by | Result |
|---|---|---|
| AC-1 | `e2e/messaging.spec.ts` (2), `lib/messaging/delta-read.integration.test.ts` (4), `lib/messaging/read.integration.test.ts` (8), `BookingConversation.test.tsx` (13: 5-second cursor delta poll, resume from the same cursor, nothing rendered before server confirmation) | Pass |
| AC-2 | `lib/messaging/contact-gate.test.ts` (5), `lib/messaging/contact-sharing.integration.test.ts` (4) | Pass |
| AC-3 | `lib/messaging/read.integration.test.ts` (full paged history, one stable strictly increasing order, archived stays readable) | Pass |
| AC-4 | `lib/messaging/retention.integration.test.ts` (3), `lib/messaging/retention-config.test.ts` (4) | Pass |
| AC-5 | `lib/messaging/admin-access.integration.test.ts` (5: all seven admin roles, reason bounds, one audit event per page with correlation id, 404 writes nothing, seed is exactly three roles at `medium`) | Pass |
| AC-6 | `lib/messaging/blocking.integration.test.ts` (3) | Pass |
| AC-7 | `lib/messaging/create-race.integration.test.ts` (2) | Pass |
| AC-8 | `lib/messaging/idempotency.integration.test.ts` (4) | Pass |
| AC-9 | `lib/messaging/immutability.integration.test.ts` (2) | Pass |
| AC-10 | `lib/messaging/privacy.integration.test.ts` (2), plus spec 008's `lib/privacy/export.integration.test.ts` updated for the new NOT NULL columns | Pass |
| §5 accessibility / RTL | `BookingConversation.a11y.test.tsx` (4) | Pass |
| §9 observability | `delta-read.integration.test.ts` (delivery latency and recovered-poll events, no content), `contact-sharing.integration.test.ts` (flag signal, no content) | Pass |

**Coverage, measured** with the v8 provider over the new code (`lib/messaging/**`, the six route
handlers and the cron route, `BookingConversation.tsx`, and the generalized `RequestMessageThread.tsx`,
which also contains spec 019's existing code): **90.18% statements, 81% branches, 87.5% functions,
94.7% lines** — every metric at or above the 80% target. The repository has no coverage provider
dependency, so it was run from a scratch install without changing `package.json`.

**Repository checks:** `tsc --noEmit` passes for all project source (the gitignored `.next/dev` cache was
excluded because an interrupted `next dev` write left it corrupt); `npm run check:env` and
`npm run check:schema-baseline` (checksum + money lint) pass; `npm run check:openapi-drift` lists all six
new routes as in sync, and fails only on the pre-existing `admin/categories/{id}` vs `{categoryId}`
mismatch already present at the spec 024 commit.

**Full suite:** every spec 025 test passed. The suite still fails on five pre-existing spec 003 baseline
tests unrelated to messaging (`lib/db/schema-coverage`, `schema-lint`, `migrations.integration`,
`concurrency.integration` — earlier specs added tables, jsonb columns and a NOT NULL `categories.name`
without updating them). Every other failure seen across the two full runs was load-induced (the shared
registration fixture's queries failing and 60–90s timeouts while the machine was saturated) and passed
when those files were re-run in isolation: `otp`, `services/page`, `payouts/reconciliation`,
`bookings/complete`, `cancellation`, `negotiation/revise`, `no-show`, `refunds/financial` and
`refunds/routes`.

**Not covered, deliberately:** Pre-booking request-scoped chat (specs 018/019, `offer_messages` — a
different table, a different lifecycle, already tested there). Blocking mechanics (spec 030 — this
spec tests only the effect of a registered gate). Attachment upload (spec 027). Message translation
(spec 042). Notification delivery (spec 026 — this spec tests only that the port is called).

---

## 7. Out of scope

- **Blocking and reporting mechanics** (spec 030) — this spec ships a port and enforces its effect;
  it creates no `user_blocks` table, no block endpoint and no safety-team override.
- **Audit storage, retention and audit querying** (spec 039) — this spec emits audit events through
  spec 009's existing helper.
- **Attachments and any file storage** (spec 027) — `message_attachments` is left untouched.
- **Notification delivery, channels, templates and preferences** (spec 026) — this spec emits
  `message_received` to an inert port with the same fire-and-forget, never-fail-the-write contract as
  `lib/refunds/notifications.ts`.
- **Message translation** (spec 042).
- **Dispute correspondence** (spec 031, `dispute_messages`) — a separate channel.
- **Support-ticket correspondence** (spec 032, `support_messages`) — a separate channel.
- **Pre-selection chat** (specs 018/019) — untouched, on a different table.
- **A WebSocket tier** — a platform decision for spec 046, replaceable underneath these endpoints
  without changing this spec's contract.
- **Any runtime platform-settings store** (spec 041, if it ever takes one on).

---

## 8. Risks and open questions

Both of the draft's open items are resolved; nothing in this spec is left Open.

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Default historical retention window length | Legal/Product | **Resolved.** Implemented as `MESSAGE_RETENTION_DAYS`, default 730 days, minimum 90, server-side config (§4). Spec 041 stores per-environment booleans, not policy numbers, so the draft's pointer at it was dangling. Legal/Product confirm the value before production; changing it is a config change, not a code change — the same disposition spec 008 gave `DELETION_GRACE_PERIOD_DAYS` |
| 2 | Real-time transport (native WebSocket vs. managed service) | Platform | **Resolved.** Neither exists. No socket server, no pub/sub, no managed vendor, and Vercel serverless route handlers cannot hold connections. Ships as 5-second authenticated polling of the authoritative REST endpoints with cursor-based resume — architecture §6.1's binding requirement ("the server is always the source of truth; clients reconnect and refresh authoritative state") in full, and the same choice specs 018–022 already shipped. The `WS` route is removed. Spec 046 may add a socket tier later without changing any contract here |
| 3 | 5s polling load at scale | Platform | Accepted for now. Bounded by the existing `messaging` 30/60s limit; the delta read is a single indexed range scan on `messages_conversation_created_at_id_idx` and returns an empty array in the common case. Revisit with spec 046's transport decision, not before |
| 4 | Contact masking pre-`confirmed` could inconvenience a legitimate early exchange | Product | Accepted and bounded. A booking normally reaches `confirmed` within minutes (spec 021 authorizes payment at creation), the message is delivered rather than blocked, only the matched token is replaced, and the sender is told why. Loosening it would contradict master spec §54's "before selection" half |
| 5 | The block gate's default is permissive until spec 030 ships | Trust & Safety | Accepted and explicit. With no blocking feature, nobody is blocked; a permissive default is correct rather than a stub. A throwing gate is also treated as not-blocked and logged, so an unshipped safety dependency can never sever a live booking's channel |

---

## 9. Rollout

- **Feature flag:** none — core to the post-booking experience, and the first release is additive
  (nothing reads these tables today).
- **Migration order:** `0021_add_messaging_conversations` ships with the code. Every added column is
  nullable or defaulted on tables that are empty in every environment, so old code running against
  the new schema is unaffected and the deploy order does not matter.
- **Cron:** one entry added to `vercel.json`, `/api/v1/cron/message-retention-sweep`, `0 3 * * *`
  (daily). Same bearer-secret check as every other cron route; no new scheduler.
- **Environment:** `MESSAGE_RETENTION_DAYS` added to `.env.example` with its documented default
  (`npm run check:env` enforces the parity).

### Rollback

The draft's "revert deploy" is replaced, because it is not safe once a single message exists.

| Layer | Rollback | Safety |
|---|---|---|
| **Client/UI** | Revert the deploy | Fully safe at any time. Polling simply stops; nothing is queued client-side and no state lives in the browser |
| **API routes** | Revert the deploy | Safe. The endpoints disappear; message rows are untouched. Participants lose access to the channel but lose no data |
| **Cron** | Remove the `vercel.json` entry | Safe and reversible. Retention pauses; `retention_applied_at IS NULL` makes the next run pick up exactly where it left off |
| **Schema** | `drizzle/0021_add_messaging_conversations_down.sql` | **Gated.** The down file aborts with an explicit error if `SELECT count(*) FROM messages > 0`. `messages.body` is authoritative user correspondence; dropping the column would destroy it irrecoverably, and spec 008 requires participated-conversation data be exportable. So the down file is safe **only** before the first real message, which is the window it exists for |

Once messages exist, **the correct response to a defect is a forward fix, never the down file** — the
same rule and the same gating idiom `0018_add_refunds_down.sql` documents for refund rows. The down
file reverses exactly what 0021 added and touches nothing else: it drops the added columns, indexes
and checks on `conversations`, `conversation_participants` and `messages`, drops
`messages_append_only_trg` and `enforce_messages_append_only()`, and deletes only the `permissions`
rows where `resource = 'messaging' AND action = 'read_conversation'`. It also deletes
`conversation_participants` rows: they carry no correspondence (the gate guarantees no message exists),
and 0021's own precondition requires that table to be empty, so leaving them would make a re-apply of
0021 fail. It carries no entry in
`drizzle/meta/_journal.json`, so `npm run db:migrate` never applies it. It never touches
`0001_baseline_schema.sql`, `offer_messages`, or any table another spec owns.

### Observability

Structured `console.log` JSON lines — the repository's existing convention — all carrying identifiers
and counts only, **never a message body**:

| Event | Fields | Answers |
|---|---|---|
| `messaging.message_sent` | `conversationId`, `bookingId`, `senderRole`, `contactRedacted`, `contactFlagged` | Send volume; the contact-sharing-flag rate master spec §117 asks for |
| `messaging.contact_flagged` | `conversationId`, `bookingId`, `senderUserId`, `mode` (`masked`/`flagged`), `count24h` | The Trust & Safety signal spec 038 consumes, mirroring spec 019's `negotiation.contact_redacted` |
| `messaging.delivery_latency_ms` | `conversationId`, `latencyMs` (server `created_at` → the delta read that first returned it) | The delivery-latency metric, measured on the transport that actually ships. Logged server-side for each COUNTERPARTY message a delta read returns; a cursor read returns a message to a poller once, so this is first delivery |
| `messaging.poll_recovered` | `conversationId`, `failedAttempts`, `gapSeconds` | The reconnect-rate metric in polling terms: how often a client had to back off and resume, and how large a gap it resumed across. Reported by the client through the delta read's `resumed=<failedAttempts>:<gapSeconds>` parameter (§3 "Incremental reads") — no separate telemetry endpoint is introduced |
| `messaging.blocked_send_rejected` | `conversationId`, `reason` | Whether the block gate is firing as spec 030 expects |
| `messaging.admin_conversation_read` / `messaging.admin_messages_read` | audit event via spec 009 (actor, roles, target, reason, correlation id) | AC-5; the surface spec 039 takes over |
| `messaging.retention_swept` | `conversationsSwept`, `messagesRedacted`, `windowDays` | AC-4 is actually running, and the backlog is draining |
