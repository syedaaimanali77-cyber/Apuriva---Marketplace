# Spec: Reviews & Ratings

**File:** `docs/specs/2026-08-28-029-reviews-ratings.md`
**Status:** Approved
**Author:** Platform te
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §52, §68, §69, §70, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, §5.4, [docs/workflow.md](../workflow.md)

**Depends on:** spec 003 (the `reviews` / `review_responses` / `review_reports` baseline skeletons
and the `baseColumns()` convention), spec 004 (envelope, error codes, `RateLimitDomain`, pagination,
OpenAPI registry), spec 005 (session, CSRF), spec 006 (`requireActiveMode`), spec 008
(`lib/privacy/export.ts`, the anonymize-on-deletion sweep), spec 009 (`resolvePermission`,
`recordAdminAuditEvent`, the seven admin roles and the four risk tiers), spec 015
(`lib/api/idempotency.ts`), spec 017 (`requireOwnProviderProfile` via `lib/availability/owner.ts`;
the `rating` ranking factor), spec 019 (`redactContactInfo()` in
`lib/negotiation/contact-redaction.ts`), spec 020 (`bookings`, `bookings_status_history`), spec 026
(the `notify()` catalogue), spec 027 (`file_assets`, the `FileContextPolicy` registry, the
upload/finalize/read/delete routes, `app/_components/FileUpload.tsx`, `app/_components/MediaPreview.tsx`),
spec 028 (`hasReachedCompleted()` in `lib/bookings/evidence.ts`) — **all implemented in this
repository and verified against it while writing this document.**

**Feeds:** spec 017 (the `rating` ranking factor gains a data source), specs 013 / 014 / 019 (three
`rating` DTO seams whose own comments say "spec 029 owns the aggregate" and which currently emit
`null`/absent), spec 031 (a review disagreement escalates to a dispute), spec 038 (a future general
moderation console reads this spec's queue rather than building a second one), spec 040
(observability counters).

> **Repository-shape note (normative).** This repository is a **single Next.js application**. There
> is no `apps/web`, `apps/api`, `apps/worker`, `apps/web-e2e`, `packages/ui` or `packages/types`.
> API routes are `app/api/v1/**/route.ts`, domain logic is `lib/**`, DTOs are `lib/types/*.ts`,
> design-system primitives live in `ui/` and are re-exported through `@/components`, app-level
> components live in `app/_components/` or a route-local `_components/` folder, and migrations are
> `drizzle/NNNN_*.sql` with a hand-written `_down.sql` sibling. The only test runner is **Vitest**,
> whose `include` is `**/*.test.{ts,tsx}` and `e2e/**/*.spec.{ts,tsx}`; there is no Playwright and
> no Cypress. Every path in this document was checked against the working tree. The previous
> draft's `packages/types/src/reviews.ts`, `apps/api/reviews/**`, `apps/web-e2e/reviews.spec.ts`,
> `apps/web/app/bookings/[id]/review`, `apps/web/app/providers/[id]` and `packages/ui`
> `RatingInput`/`ReviewCard` **do not exist and are not created**; §3, §5 and §6 name their real
> counterparts.

---

## 1. Problem statement

**Today:** No review system exists. The `reviews`, `review_responses` and `review_reports` tables
exist only as spec 003 baseline skeletons — `reviews` has exactly `booking_id` and `author_user_id`
and nothing else, so there is no rating, no text, no status and no way to publish anything. Master
spec §52 requires that only eligible completed bookings generate verified reviews, with a rating,
text, optional media, a provider response and a report path; moderation must surface
spam/manipulation/profanity signals for an admin to resolve, and must **never automatically
suppress legitimate criticism**.

**Who is affected:** Customers, who finish a job today with no way to record what happened;
providers, whose reputation and ranking position depend on review integrity and who have no right
of reply; and every ranking and discovery surface that already reserves a place for a rating and
receives nothing. Four such seams exist in shipped code and all are inert: `lib/matching/run.ts`
emits `rating: null` (so spec 017's 10-weight `rating` factor is excluded from scoring entirely),
`lib/negotiation/compare.ts` emits `rating: null`, and `lib/types/search.ts` and `lib/types/home.ts`
both declare `rating?: number` documented as "absent until spec 029".

**Why it matters now:** Spec 028 shipped, so bookings genuinely reach `completed` with an auditable
completion instant. That is the precondition for a *verified* review, and it now exists.

**Success looks like:** A customer who actually completed a booking can rate and describe that
specific job exactly once; the provider can reply once; anyone can read the result; a suspicious
review is queued for a named human to judge while remaining publicly visible; and no review is ever
hidden except by an authorized admin who recorded a reason.

### What this spec owns, and what it deliberately does not

**Owns:** the `Review`, `ReviewResponse`, `ReviewReport` and `ReviewMedia` records; review
eligibility; the rating/text validation rules; the `review_media` file context policy; the
deterministic flagging signals; the review moderation lifecycle and its admin routes; the public
provider review list; and the provider rating **aggregate** that ranking consumes.

**Does not own, and does not modify:**

| Concern | Owner | How this spec relates to it |
|---|---|---|
| Booking status and transitions | spec 020 / 028 | Read-only. This spec calls no transition, writes no booking column, and imports `hasReachedCompleted()` only. |
| Payment / protection / settlement | spec 021 / 022 | Never read. Eligibility is independent of money (§3 "Eligibility"). |
| File upload, scanning, storage, deletion, signed URLs | spec 027 | Reused wholesale. This spec registers **one** context policy and creates **no** second storage system. |
| Ranking algorithm, weights, renormalization | spec 017 | Untouched. This spec supplies a value through a registered port; `lib/matching/ranking.ts` and `lib/matching/weights.ts` are not edited. |
| AI provider selection, prompts, quota, usage accounting | spec 033 | Not consumed at MVP (§3 "Spec 033 dependency"). If consumed later, only through `completeAi()` from `@/lib/ai`. |
| Disputes | spec 031 | A disagreement about a review escalates there; this spec opens no dispute. |
| Generic user blocking and safety incidents | spec 030 | `safety_reports` is spec 030's unimplemented skeleton and is **not** reused; `review_reports` is the baseline table purpose-built for this and is what this spec fills in. |
| Admin role/permission model | spec 009 | Reused verbatim: two new `permissions` rows, no new authorization framework. |
| Audit storage | spec 009 → 039 | `recordAdminAuditEvent()` only. No second audit store. |

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a booking that has never reached `completed` **When** its customer submits a review **Then** it is rejected `422 BOOKING_NOT_ELIGIBLE_FOR_REVIEW`, and the booking's payment/protection state is never consulted |
| AC-2 | **Given** a booking that has reached `completed` and is inside the review window **When** its own customer submits a rating (and optionally text and ready image media) **Then** a `published` review is created, linked to exactly that booking, with the provider and service taken from the booking row and never from the request body |
| AC-3 | **Given** a visible review **When** the booking's provider posts a response **Then** exactly one response is attached and returned alongside the review to every reader, and a second response attempt is rejected `409 RESPONSE_ALREADY_EXISTS` |
| AC-4 | **Given** a review matching a deterministic spam/manipulation/profanity signal **When** it is submitted **Then** its status is `flagged`, it appears in the admin moderation queue, and it is **still returned by the public provider review list** — nothing is deleted, hidden, suppressed or down-weighted before a human resolution |
| AC-5 | **Given** a 1-star review whose text matches no signal **When** it is submitted **Then** it is `published` and publicly visible, and no rule anywhere derives a flag from the rating value |
| AC-6 | **Given** any authenticated user reporting a visible review with a reason from the closed set **When** submitted **Then** a `review_reports` row is created, the review enters the moderation queue, its visibility is unchanged, and a repeat report by the same user returns the same report rather than creating a second |
| AC-7 | **Given** a booking that already has a review **When** a second review is submitted for it — including two submissions racing concurrently — **Then** exactly one review exists and the loser receives `409 REVIEW_ALREADY_EXISTS` |
| AC-8 | **Given** a `flagged` or `published` review **When** an admin holding `reviews/moderate` resolves it as `remove` with a reason **Then** it becomes `removed`, disappears from every public read and from the rating aggregate, its media stops being publicly readable, its open reports are resolved, and an audit event carrying actor, roles, target and reason is written — and **no other code path in the repository can produce `removed`**, enforced at the database |
| AC-9 | **Given** an admin without `reviews/moderate` **When** they call any admin review route **Then** they receive `403 FORBIDDEN` resolved server-side, and the attempt is logged |
| AC-10 | **Given** a customer exporting their data **When** the export is generated **Then** it contains their own reviews (rating, text, status, timestamps) and the reports they filed, and contains no flag signals, no other user's report, and no reporter identity |

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing mechanism (verified in this repository) |
|---|---|
| Response envelope, correlation id, error mapping | `withApiRoute` + `apiSuccess`/`apiPaged`/`apiError` (`lib/api/handler.ts`, `lib/api/response.ts`) |
| Error taxonomy | `ApiRouteError` + `API_ERROR_CODES` (`lib/api/errors.ts`); domain codes pass an explicit `status` |
| Session / CSRF | `requireSession`, `getOptionalSession`, `requireCsrf` (`lib/auth/require-session.ts`) |
| Active mode | `requireActiveMode(session, 'customer' \| 'provider')` (`lib/auth/require-mode.ts`) |
| Provider ownership | `requireOwnProviderProfile(userId)` (`lib/availability/owner.ts`) |
| Idempotency | `requireIdempotencyKey` + `idempotencyFingerprint` (`lib/api/idempotency.ts`), scoped per author/review at the database — never globally |
| Pagination | `parsePageParams` / `buildPage` (`lib/api/pagination.ts`), `DEFAULT_PAGE_LIMIT` 20, `MAX_PAGE_LIMIT` 100 |
| Rate limiting | `checkRateLimit(domain, identifier)` (`lib/api/rate-limit.ts`) |
| Admin authorization | `resolvePermission(userId, resource, action)` (`lib/admin-rbac/permissions.ts`) behind a `requireReviewModeratePermission()` helper — the shape `lib/ai/permissions.ts` and `lib/no-show/resolution.ts` already use |
| Admin audit | `recordAdminAuditEvent()` (`lib/admin-rbac/audit.ts`) → `security_events` |
| Booking completion fact | `hasReachedCompleted(bookingId)` (`lib/bookings/evidence.ts`, re-exported from `lib/bookings/index.ts`) |
| Contact / off-platform detection | `redactContactInfo()` (`lib/negotiation/contact-redaction.ts`), reused by spec 025 the same way |
| Media | spec 027's whole pipeline: `POST /files/upload-url`, `POST /files/{id}/finalize`, `GET /files/{id}`, `GET /files/{id}/content`, `DELETE /files/{id}` |
| Notifications | `notify()` (`lib/notifications`) |
| OpenAPI | every route added to `OPENAPI_ROUTES` (`lib/api/openapi-registry.ts`); `npm run check:openapi-drift` fails CI otherwise |

### Repository paths (normative)

| Draft said | Actual path |
|---|---|
| `packages/types/src/reviews.ts` | `lib/types/reviews.ts` |
| `apps/api/reviews/**` | `lib/reviews/**` |
| `apps/web/app/bookings/[id]/review` | `app/bookings/[id]/review/page.tsx` |
| `apps/web/app/providers/[id]` | **does not exist** — there is no public provider profile page in this repository (§5) |
| `packages/ui` `RatingInput`, `ReviewCard` | `components/RatingInput.tsx`, `components/ReviewCard.tsx` (app-level, re-exported from `@/components`) |
| `apps/web-e2e/reviews.spec.ts` | `e2e/reviews.spec.ts` |

New modules: `lib/reviews/{create,read,aggregate,response,report,moderation,signals,validation,media-policy,errors,limits,index}.ts`
and `lib/types/reviews.ts`.

### Eligibility (AC-1, AC-2) — normative

**The reviewable fact is `hasReachedCompleted(bookingId)`, not `bookings.status = 'completed'`.**
This is the single most important correction to the draft. Verified in this repository:
`lib/payments/sweep.ts` pass A moves every `completed` booking with a captured payment to
`protected` on the next cron tick, and pass B moves it to `settled` once
`DEFAULT_PROTECTION_WINDOW_HOURS` (48) elapses. A rule keyed on the literal status `completed`
would therefore give most customers a review window roughly one minute wide.
`hasReachedCompleted()` reads `bookings_status_history` for a `to_status = 'completed'` row — an
append-only table (`bookings_status_history_append_only_trg`) — so the answer is permanent and
cannot drift.

| Question | Decision | Evidence |
|---|---|---|
| Which state makes a booking reviewable | It has **ever** recorded a `to_status = 'completed'` history row | `lib/bookings/evidence.ts::hasReachedCompleted`; spec 028 uses the same predicate to open customer access to completion evidence |
| Does payment/protection state affect it | **No.** `lib/reviews/**` reads no payment table and imports no payment module | Spec 020 §3 "Payment boundary"; enforced here by `lib/reviews/boundary.test.ts`, the pattern `lib/bookings/payment-boundary.test.ts` and `lib/files/boundaries.test.ts` already establish |
| Do later statuses revoke it | **No.** A booking that completed and was later `refunded` or `disputed` stays reviewable — a bad experience is precisely what a review reports, and auto-revoking on refund would itself be an automatic suppression of criticism (master §52) | Transition graphs in `lib/payments/index.ts`, `lib/refunds/index.ts`, `lib/cancellation/index.ts`: neither `cancelled` nor `failed` is reachable from `completed` |
| Who may review | Only the booking's own customer: `bookings.customer_profile_id → customer_profiles.user_id = session.userId`, in `customer` active mode. A non-participant gets `404`, indistinguishable from a missing booking | The same ownership join spec 027's `bookingEvidencePolicy` and spec 025's `resolveConversationAccess` use |
| Submission window opens | At the `in_progress → completed` history instant (`bookings_status_history.occurred_at`) | as above |
| Submission window closes | `completedAt + REVIEW_WINDOW_DAYS` | see below |
| Configurable | **Yes, bounded**: `REVIEW_WINDOW_DAYS`, default **14**, accepted range 1–90, read through `reviewWindowDays()` in `lib/reviews/limits.ts` | The precedent this repository already uses for a policy duration with no master-spec value: `DEFAULT_PAYMENT_AUTHORIZATION_WINDOW_MINUTES` (`lib/payments/sweep.ts`) and spec 008's `DELETION_GRACE_PERIOD_DAYS`. Not a feature-flag system — spec 041 owns that |
| Why 14 days | A **product decision recorded here**, because neither the master specification nor any approved spec states one. It is long enough that a customer who finishes a job on a Friday still has two weekends, and short enough that the review describes a job the reviewer remembers. It sits deliberately outside the 48-hour protection window so that reviewing is never a lever on money | — |
| Enforcement | Entirely server-side, against the **database** clock read from `bookings_status_history.occurred_at`; never a client clock and never a browser timer | Architecture §5.4; the rule specs 018/020 already follow |
| Window evaluated when | At submit time, from the completion instant — not snapshotted per booking. Consequence, stated deliberately: changing `REVIEW_WINDOW_DAYS` changes eligibility for already-completed bookings. That is acceptable for a non-financial courtesy window and avoids a column whose only purpose is to freeze an environment variable | mirrors `paymentAuthorizationWindowMinutes()` |
| Concurrency | `reviews_booking_id_uq` is the authority. Two racing submissions both pass the eligibility read; exactly one `INSERT` succeeds and the other raises `23505`, mapped to `409 REVIEW_ALREADY_EXISTS`. No advisory lock, no `SELECT … FOR UPDATE`, no application-level check-then-insert | the pattern `bookings_offer_id_uq` and `no_show_reports_booking_reporter_uq` already use |

### Ownership (AC-2, AC-7) — normative

The request body carries **no** `providerId`, `customerId`, `serviceId` or `authorId`. Every one of
those is derived server-side, inside the creating transaction, from the booking row the URL names:

```
reviews.booking_id           := the {id} path segment, after the ownership + eligibility check
reviews.author_user_id       := session.userId          (baseline column, spec 003)
reviews.provider_profile_id  := bookings.provider_profile_id
reviews.service_id           := bookings.service_id
```

A client therefore has no interface through which to attribute a review to a different provider or
to review on someone else's behalf. `ReviewDto` exposes `providerProfileId` and never a user id,
following spec 020 §4's rule that a counterparty's `users.id` never reaches a client. `reviews`
keeps the baseline `author_user_id` (a **user** id, not a customer-profile id) because spec 003
already shipped that column and its foreign key, and spec 008's existing export and anonymization
both key off it; changing it would be a baseline edit for no benefit.

One review per booking is enforced **twice**: `reviews_booking_id_uq` at the database (the
authority) and a pre-insert existence check in `lib/reviews/create.ts` (the friendly error). A
required `Idempotency-Key`, unique per `(author_user_id, idempotency_key)`, makes an honest client
retry replay `200` instead of colliding.

### Rating and text (AC-2, AC-5) — normative

| Rule | Value | Why this value |
|---|---|---|
| Rating type | integer, **required** | Master §52 lists "Rating" first; a review with no rating produces no ranking signal |
| Rating range | **1–5 inclusive**, `reviews_rating_ck` at the database | The scale the existing design-system `ui/components/marketplace/Rating` renders (five stars, `value.toFixed(1)`). No half-stars: the primitive rounds (`Math.round(value)`), and storing a precision it cannot display would be dishonest |
| Text | **optional** | Master §52 lists "Rating" and "Text" as separate capabilities. Forcing prose to record a rating depresses response rates and manufactures filler text, which is itself a spam signal. The draft's `text: string` is corrected to `text: string \| null` |
| Text minimum, when present | **10 characters** after normalization | Below that the text carries no information a reader can act on, and one- or two-character bodies are the cheapest bulk-spam vector |
| Text maximum | **2000 characters** after normalization | Reuses `MESSAGE_BODY_MAX_LENGTH` (`lib/messaging/limits.ts`) rather than inventing a second platform prose bound |
| Stored maximum | 2000; `reviews_text_length_ck` = `text is null or char_length(text) between 10 and 2000` | The stored form equals the validated form: unlike spec 025 this spec performs **no** redaction, so there is no placeholder headroom to reserve |
| Normalization, in order | 1. Unicode NFC. 2. CRLF/CR → LF. 3. Strip all C0/C1 control characters except LF and TAB, and strip zero-width and bidi-override characters. 4. Collapse 3+ consecutive LFs to 2. 5. Trim leading/trailing whitespace. 6. Empty result → `NULL` | Step 3 keeps homograph and bidi tricks off a public surface; step 6 is what makes "whitespace-only text" behave as "no text" rather than as a validation error |
| Measurement order | Bounds are checked **after** normalization and **before** fingerprinting, so a retry differing only in whitespace replays rather than conflicting | the order `app/api/v1/bookings/[id]/milestones/route.ts` already uses |
| Failure | `400 VALIDATION_ERROR` with an `errors[]` entry naming `rating` and/or `text` | spec 004 AC-3 |
| Rating is never a signal | No flagging rule, no ranking penalty and no visibility rule anywhere may read `reviews.rating`. `lib/reviews/signals.ts` takes **text only** and is a pure function with no access to the rating | AC-5; asserted by its type signature and directly by its unit test |

### Media (AC-2) — normative

Spec 027 is reused in full; **no second storage system is created.** This spec adds exactly one
`FileContextPolicy`.

| Question | Decision | Evidence |
|---|---|---|
| How review media references `FileAsset` | Through a new `review_media` join table holding `(review_id, file_asset_id, position)` | Mirrors `message_attachments` (specs 025/027), which exists for exactly this reason: the asset is uploaded before the record that carries it exists |
| Context type | A **new** `review_media` value, added to `FILE_CONTEXT_TYPES` (`lib/types/files.ts`) and to `file_assets_context_type_ck` by migration 0026 | The vocabulary is closed at the database, so a new value requires a migration. It is **not** `verification_document`: that reserved value's comment says "spec 029", but a verification document is a provider identity document, not review media. See Open Question 5 |
| `contextId` | The **booking** id | Media is chosen before the review exists, so a review id cannot be the context. This is spec 027's own stated reasoning for `message_attachment`, verbatim |
| `publicEligible` | **true** | A review is public content; private media would be invisible to every reader and the capability would be pointless. This makes it the second public-eligible context after `portfolio` |
| `allowedKinds` | **`['image']` only** | Deliberately narrower than `booking_evidence`. Video and documents on a public surface widen the disclosure and moderation surface for no reviewer benefit |
| `maxPerContext` | **5** | The same cap spec 027 chose for `request_attachment` and `message_attachment` |
| Size / MIME | Spec 027's existing `FILE_MAX_IMAGE_BYTES` (default 10 MiB) and its MIME allowlist. This spec adds no size rule | `lib/files/config.ts` |
| `canUpload` | The booking's customer, in `customer` mode, only while the booking has reached `completed` **and** the review window is open — so media cannot be pre-staged before the job ends or bolted on months later | the shape of `bookingEvidencePolicy.canUpload` |
| `canRead` | `ready` **and** `visibility = 'public'` **and** the owning review is `published` or `flagged` → anyone, including guests. Otherwise the author, or an admin holding `reviews/moderate` (audited through `recordAdminAuditEvent`, the pattern `messageAttachmentPolicy` uses). An asset attached to a `removed` review is readable by nobody else | AC-8: removing a review must remove its pictures from public view, and spec 027 re-runs `canRead` on **every** URL issue and content fetch, so this is a live answer, never cached at upload time |
| Only `ready` assets may be attached | Each id in `mediaFileAssetIds` must be a live `file_assets` row with `status = 'ready'`, `context_type = 'review_media'`, `context_id` = the booking being reviewed, and `uploaded_by_user_id` = the caller. Anything else fails the whole request with `422 REVIEW_MEDIA_ASSET_INVALID` | the rule spec 028 applies to `evidenceFileAssetIds` |
| `scanning` / `rejected` | Never attachable (they are not `ready`) and never rendered. Surfacing `rejectionReason` is spec 027's | `file_assets_ready_requires_clean_ck` |
| Are spec 027's APIs sufficient | **Yes.** Upload, finalize, read, signed content and delete are all spec 027 routes. This spec adds **no** media route | — |

### Provider response (AC-3) — normative

| Question | Decision |
|---|---|
| Who may respond | The owner of `bookings.provider_profile_id` for the reviewed booking, in `provider` active mode: `requireActiveMode(session, 'provider')`, then `requireOwnProviderProfile(session.userId)`, then a join asserting that profile id equals `reviews.provider_profile_id`. Anyone else gets `404` |
| How many | **Exactly one**, enforced by `review_responses_review_id_uq` at the database and a pre-insert check in application code |
| Editing | **Not allowed.** A response is immutable once posted — the stance spec 025 takes for messages (`lib/messaging/immutability.integration.test.ts`) and spec 028 takes for milestones. It also closes an obvious abuse: a provider who could edit could post an innocuous reply, wait for the review to be reported, and silently rewrite history |
| Deletion | **Not by the provider.** A response is removed only by an authorized moderation decision, which sets `review_responses.status = 'removed'` and records a reason — the same one-way rule the review itself follows |
| Which reviews accept a response | `published` or `flagged` only. A `removed` review accepts none: `422 REVIEW_NOT_RESPONDABLE` |
| Text | Required, 10–2000 characters, identical normalization to review text |
| Duplicate / concurrent | `Idempotency-Key` required. A true duplicate loses the unique index and receives `409 RESPONSE_ALREADY_EXISTS`; an idempotent retry replays `200` |
| Flagging | A response runs through the same `lib/reviews/signals.ts` evaluation and can be `flagged`, under the same never-auto-hidden guarantee |

### Moderation (AC-4, AC-5, AC-8, AC-9) — normative

**Lifecycle.** `reviews.status ∈ { 'published', 'flagged', 'removed' }`, and the same three for
`review_responses.status`. Three states, no more — a fourth "pending" state would mean a review that
is invisible while it waits, which is the automatic suppression master §52 forbids.

```
                 signal hit / user report
   published ─────────────────────────────▶ flagged        (BOTH are publicly visible)
       ▲                                       │
       │  admin: keep                          │  admin: keep
       └───────────────────────────────────────┘
       │                                       │
       │  admin: reinstate      admin: remove  ▼
       └────────────────────────────────── removed          (hidden; human-authored only)
```

**The invariant, and how it is actually enforced.** `flagged` is *identical to* `published` for
every reader: the public list returns both, the rating aggregate counts both, and the DTO's `status`
field is the only difference — which is why `status` is **not** exposed on the public read path at
all (§4 "Retention and privacy"). Only `removed` hides anything, and `removed` is reachable only
through `resolveReviewModeration()`. Three independent layers make that true:

1. **Database.** `reviews_removal_pairing_ck`:
   `(status = 'removed') = (removal_reason is not null and moderated_by_admin_id is not null and moderated_at is not null)`.
   A removal without a named human admin and a recorded reason is physically unrepresentable. This
   is the mechanical form of AC-4 and AC-8 and it holds no matter what application code does.
2. **Module boundary.** `lib/reviews/signals.ts` is a pure function returning a `ReviewSignalResult`
   — a list of signal codes and nothing else. It performs no I/O, writes no column and cannot reach
   a status. `lib/reviews/boundary.test.ts` asserts at the source level that no module other than
   `lib/reviews/moderation.ts` contains the literal `'removed'` in a write position, and that
   `lib/reviews/**` imports no payment module and no `lib/ai/provider/**`.
3. **Route surface.** There is exactly one route that can set `removed`, and it requires
   `reviews/moderate`.

**Deterministic MVP flagging.** Rule-based, pure, no model call. This is not a placeholder: it is
the resolution `docs/workflow.md` already records for this spec — "**029** … and **038** each note
an optional, explicitly-deferred AI-assisted flagging path through 033 — rule-based logic ships
first". `lib/reviews/signals.ts` evaluates the **normalized text only**:

| Code | Rule | Notes |
|---|---|---|
| `profanity` | Whole-word match against a maintained list in `lib/reviews/profanity-list.ts`, case- and diacritic-insensitive, applied after normalization so zero-width obfuscation is already stripped | Whole-word, not substring — substring matching produces the classic false positives on ordinary words |
| `contact_sharing` | `redactContactInfo(text).count > 0` | Spec 019's pattern set, reused unchanged, exactly as spec 025 reuses it. One pattern set for the whole platform |
| `spam_shape` | Any of: ≥ 2 URLs; a single token repeated ≥ 10 times; ≥ 70 % non-alphabetic characters over a body of ≥ 40 characters | Structural properties, never sentiment |
| `burst_submission` | The same `author_user_id` has ≥ 3 reviews created in the preceding 1 hour | The one signal that reads the database rather than the text; evaluated in the creating transaction |
| `repeat_pair` | The same `(author_user_id, provider_profile_id)` pair has ≥ 3 reviews in the preceding 30 days | Manipulation signal per master §52 |

Any hit ⇒ `status = 'flagged'` and `flag_signals` = the JSON array of codes. No hit ⇒ `published`.
**Nothing here reads `rating`, and a flag changes nothing a reader can observe.** The draft's
`ai_flag_reason` column is renamed `flag_signals jsonb`: naming a rule-based result `ai_*` would be
false, and a list of codes is queryable where a prose string is not.

**Who moderates.** Spec 009's existing model, with **two** new `permissions` rows seeded by
migration 0026 for `trust_safety_admin` and `super_admin` only:

| resource | action | risk tier | Why |
|---|---|---|---|
| `reviews` | `read_moderation_queue` | `low` | Reading a queue of already-public content |
| `reviews` | `moderate` | `medium` | Master §70: "Medium risk — authorized admin + reason/audit". The admin picks an outcome from a closed set, never an amount. The exact tier spec 023 chose for `no_show_reports/resolve` |

This corrects the draft's "Trust & Safety / Content". Master §69 scopes Content/Marketplace Admin to
services, categories and FAQs; reviews are a trust-and-safety matter. **No new permission model, no
`AdminAction` record and no four-eyes framework is created** — `medium` needs one authorized admin
plus reason and audit, which is exactly what this route requires.

**Resolution.** `POST /api/v1/admin/reviews/{id}/resolve`, body `{ decision, reason, expectedStatus }`
with `decision ∈ { 'keep', 'remove', 'reinstate' }` and a required 10–2000-character reason. In one
transaction it sets the review's status, stamps `moderated_by_admin_id` / `moderated_at` /
`removal_reason`, resolves every `open` report on that review to `resolved` (for `remove`) or
`dismissed` (for `keep`), and writes one `recordAdminAuditEvent` carrying
`eventType: 'reviews.moderation_resolved'`, the actor, **all** roles held, the target, the reason
and the request's `correlationId`. `reinstate` is master §68's required appeal/review mechanism: a
`removed` review can be returned to `published`, with its own audit entry. If the audit write fails,
the transaction fails and the status does not change.

### Review reporting (AC-6) — normative

No generic reporting infrastructure exists to reuse. `no_show_reports` is booking-attendance
specific (spec 023), and `safety_reports` is spec 030's baseline skeleton with no columns, no
implementation and no owner yet. `review_reports` is spec 003's purpose-built skeleton for exactly
this, and it is what this spec fills in.

| Question | Decision |
|---|---|
| Who may report | Any authenticated user, either mode. Not guests: a report with no accountable author is an unpriced denial-of-service on the moderation queue |
| Own review | Rejected `422 CANNOT_REPORT_OWN_REVIEW` |
| Reasons (closed set, `review_reports_reason_ck`) | `spam`, `offensive`, `false_information`, `personal_information`, `off_topic`, `other` |
| `details` | Optional free text 10–2000 characters, **required** when `reason = 'other'` |
| Duplicate | `review_reports_review_reporter_uq` on `(review_id, reporter_user_id)`. A repeat by the same reporter returns `200` with the existing report — not an error, because the reporter owns that row and telling them so enumerates nothing |
| Report status | `open` → `resolved` \| `dismissed`, set only by the moderation route |
| Effect on the review | A report on a `published` review moves it to `flagged`. **It never hides it, and no report count ever auto-removes anything** — a brigade of reports produces a queue entry, not a takedown (AC-4, AC-6) |
| Admin resolution | Through the single review-resolve route above; reports are resolved as a side effect of resolving their review, so there is no second queue and no second decision surface |
| Audit | The resolving audit event names the review; reporter identities are never written into it |
| Abuse limiting | The `reviews` rate-limit domain (below), plus a per-user cap of **20 reports per rolling 24 hours** counted from `review_reports.created_at`, returned as `429 RATE_LIMITED` with `retryAfterSeconds` |

### Spec 033 dependency — normative

**Spec 033 is not consumed at MVP.** Its status in this repository is `Draft`; `lib/ai` exists in
the working tree but is unapproved and uncommitted. Spec 029 must not take a hard dependency on an
unapproved spec, and `docs/workflow.md` already records rule-based-first as the agreed sequencing
for this spec. So **no AI provider interface is invented here, and none is duplicated.**

The seam is `lib/reviews/signals.ts`'s pure `evaluateReviewSignals(text) → ReviewSignalResult`. If
and when an AI-assisted signal is added, these conditions are binding:

- It is consumed **only** through `completeAi()` exported from `@/lib/ai`. No module under
  `lib/reviews/**` may import `lib/ai/provider/**` — that is spec 033's vendor boundary, which
  `lib/ai/boundary.test.ts` already enforces from its side and `lib/reviews/boundary.test.ts` will
  enforce from this one.
- It needs a new `AI_TASKS` member (e.g. `moderation`). `AI_TASKS` is spec 033's vocabulary, closed
  by `ai_usage_events_task_ck` (`drizzle/0025_add_ai_usage_tracking.sql`); adding a member is spec
  033's migration to write, not this spec's.
- **Degradation is total and silent.** `isAiAssistantEnabled() === false`, `AiUnavailableError`,
  `AiRateLimitedError`, `AiQuotaExceededError` or any thrown error ⇒ fall back to the rule-based
  result and publish normally. An AI outage must never change a review's visibility, never block a
  submission, and never produce a flag. `isAiDegradable()` is the existing predicate for this.
- An AI verdict remains a **signal**: it can only ever move `published → flagged`.

### Ranking (specs 016 / 017) — normative

Verified: spec 017's `buildFactorInputs()` in `lib/matching/run.ts` returns `rating: null`, and
`lib/matching/ranking.ts` excludes a `null` factor from **both** the numerator and the denominator,
so no provider is penalised for an absent signal. Its own comment states the factors "activate on
their own as specs 018/020/028/029/031 land".

This spec **does not modify the ranking algorithm, the weights, the renormalization, or
`lib/matching/ranking.ts`.** It supplies data through a port — the pattern this repository already
uses for exactly this situation (spec 020 supplies occupied time to spec 016 through
`registerBusyIntervalLoader`):

- `lib/reviews/aggregate.ts` exports
  `getProviderRatingAggregates(providerProfileIds) → Map<string, ProviderRatingAggregate>` — one
  batched query counting only **visible** reviews (`published` and `flagged`; never `removed`), with
  `average` rounded to one decimal to match what `Rating` renders.
- A `ProviderRatingSource` port is added to `lib/matching/` whose **default is the existing
  behaviour**: unregistered ⇒ `null` for every provider. `lib/reviews/index.ts`'s
  `registerReviewsIntegration()` registers the real source, wired from `instrumentation.ts` after
  spec 028's registration — the composition root specs 021–028 already use. Rolling this spec back
  returns the port to `null`, and no shipped spec breaks.
- Deliberate consequence, stated rather than hidden: because a `flagged` review is visible, it also
  counts toward the aggregate until a human resolves it. That is the price of never
  auto-suppressing, and it is the correct trade.

`lib/types/search.ts`, `lib/types/home.ts` and `lib/types/negotiation.ts` each declare a `rating`
field documented as this spec's to fill. Populating those three DTOs is **out of scope here** (§7):
the aggregate they need now exists, and each is a one-line read inside its owning spec's module.

### Routes added by this spec

All seven are added to `OPENAPI_ROUTES`. Every mutating route requires CSRF (`requireCsrf`); no GET
does. All use the new `reviews` `RateLimitDomain` (**30 requests / 60 s** — the write-surface budget
specs 015/017/018/020/027 already share), keyed by `session.userId`, or by `hashRequestIp()` for the
one guest-readable route.

| # | Method | Route | Auth | Authorization | Idem. | Success |
|---|---|---|---|---|---|---|
| R1 | `POST` | `/api/v1/bookings/{id}/reviews` | session | `customer` mode + booking's customer + reached `completed` + window open | **required** | `201` `ApiResponse<ReviewDto>` (`200` on replay) |
| R2 | `GET` | `/api/v1/bookings/{id}/reviews` | session | either participant, either mode | — | `200` `ApiResponse<BookingReviewStateDto>` |
| R3 | `GET` | `/api/v1/providers/{id}/reviews` | **none** (session or guest) | public | — | `200` `PagedResponse<PublicReviewDto>` |
| R4 | `POST` | `/api/v1/reviews/{id}/response` | session | `provider` mode + owner of the reviewed `provider_profile_id` | **required** | `201` `ApiResponse<ReviewResponseDto>` (`200` on replay) |
| R5 | `POST` | `/api/v1/reviews/{id}/reports` | session | any authenticated user except the review's author | **required** | `201` `ApiResponse<ReviewReportDto>` (`200` on duplicate) |
| R6 | `GET` | `/api/v1/admin/reviews/moderation-queue` | session | `reviews/read_moderation_queue` | — | `200` `PagedResponse<AdminReviewDto>` |
| R7 | `POST` | `/api/v1/admin/reviews/{id}/resolve` | session | `reviews/moderate` | — | `200` `ApiResponse<AdminReviewDto>` |

Changes from the draft: `/reviews/{id}/report` → `/reviews/{id}/reports` (resource-plural, matching
`/bookings/{id}/no-show-reports`); **R2 is added**, because the customer UI needs a
server-authoritative answer to "can I review, and until when" — a client must never compute the
deadline (architecture §5.4); R6/R7 are scoped to `reviews/*` permissions rather than an
unspecified "admin". No route duplicates an existing one — verified against all `route.ts` files
under `app/api/v1/`. `GET /api/v1/providers/{id}/reviews` sits beside the existing
`providers/[id]/availability`, `providers/[id]/availability-notify` and
`providers/[id]/service-area-check` routes and collides with none.

**Concurrency per route.** R1 and R4: the unique index decides, the loser gets `409`. R5: the unique
index decides, the loser replays `200`. R7: the resolve `UPDATE` is conditional on the status the
admin was shown (`expectedStatus`); a mismatch is `409 CONFLICT` carrying `details.currentStatus`,
so two admins resolving simultaneously cannot silently overwrite each other — the
conditional-update shape `applyBookingTransition()` uses.

### Request and response types

```typescript
// lib/types/reviews.ts
// This repository has no `packages/types`; every DTO lives under `lib/types/*`.
// Every DTO exposes PROFILE ids, never user ids (spec 020 §4).
import type { FileAssetDto } from './files';

export const REVIEW_STATUSES = ['published', 'flagged', 'removed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_SIGNAL_CODES = [
  'profanity', 'contact_sharing', 'spam_shape', 'burst_submission', 'repeat_pair',
] as const;
export type ReviewSignalCode = (typeof REVIEW_SIGNAL_CODES)[number];

export const REVIEW_REPORT_REASONS = [
  'spam', 'offensive', 'false_information', 'personal_information', 'off_topic', 'other',
] as const;
export type ReviewReportReason = (typeof REVIEW_REPORT_REASONS)[number];

export const REVIEW_REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReviewReportStatus = (typeof REVIEW_REPORT_STATUSES)[number];

export const REVIEW_MODERATION_DECISIONS = ['keep', 'remove', 'reinstate'] as const;
export type ReviewModerationDecision = (typeof REVIEW_MODERATION_DECISIONS)[number];

export type ReviewRating = 1 | 2 | 3 | 4 | 5;

export interface CreateReviewRequest {
  rating: ReviewRating;
  /** Optional. Normalized server-side; 10..2000 chars when present, else null. */
  text?: string | null;
  /**
   * OPTIONAL. Each id must be a live `ready` `file_assets` row with
   * `context_type = 'review_media'`, `context_id` = this booking, uploaded by the caller.
   * Anything else fails the whole request with `422 REVIEW_MEDIA_ASSET_INVALID`.
   */
  mediaFileAssetIds?: string[];
}

/**
 * What a guest or any reader sees. Deliberately carries NO reviewer identity and NO `status`:
 * `published` and `flagged` are indistinguishable to a reader by construction (AC-4).
 */
export interface PublicReviewDto {
  id: string;
  providerProfileId: string;
  serviceId: string;
  rating: ReviewRating;
  text: string | null;
  /** Spec 027 `FileAssetDto`s — public, `ready` images only. */
  media: FileAssetDto[];
  response: { text: string; createdAt: string } | null;
  createdAt: string;
}

/** The author's / participant's view. Adds the fields only they may see. */
export interface ReviewDto extends PublicReviewDto {
  bookingId: string;
  status: ReviewStatus;
  version: number;
}

/** R2 — the server-authoritative eligibility answer the UI renders. */
export interface BookingReviewStateDto {
  bookingId: string;
  eligible: boolean;
  /** Why not, when `eligible` is false. */
  reason: 'not_completed' | 'window_closed' | 'already_reviewed' | 'not_customer' | null;
  /** ISO-8601. Null when the booking never completed. */
  windowClosesAt: string | null;
  /** The caller's own review, if it exists. */
  review: ReviewDto | null;
}

export interface CreateReviewResponseRequest {
  text: string;
}

export interface ReviewResponseDto {
  id: string;
  reviewId: string;
  text: string;
  status: ReviewStatus;
  createdAt: string;
}

export interface CreateReviewReportRequest {
  reason: ReviewReportReason;
  /** Required when `reason` is 'other'; 10..2000 chars. */
  details?: string | null;
}

export interface ReviewReportDto {
  id: string;
  reviewId: string;
  reason: ReviewReportReason;
  status: ReviewReportStatus;
  createdAt: string;
}

/** R6/R7 only. `flagSignals` and report detail never leave the admin surface. */
export interface AdminReviewDto extends ReviewDto {
  flagSignals: ReviewSignalCode[];
  reportCount: number;
  /** Reason and details only — a reporter's identity is never returned by any route. */
  reports: Array<{ id: string; reason: ReviewReportReason; details: string | null; createdAt: string }>;
  moderatedAt: string | null;
  removalReason: string | null;
}

export interface ResolveReviewRequest {
  decision: ReviewModerationDecision;
  /** Required, 10..2000 chars (master §68). */
  reason: string;
  /** Optimistic concurrency: the status the admin was looking at. */
  expectedStatus: ReviewStatus;
}

/**
 * Spec 017's port payload, and the value `listProviderReviews()` computes alongside a page.
 *
 * NOT part of `GET /providers/{id}/reviews`'s HTTP response: spec 004's `PagedResponse` is
 * `{ data, page, correlationId }` and has no `meta` field. Widening a shipped envelope to carry
 * one provider's average would be a spec 004 change this spec does not own, so the aggregate stays
 * a server-side value — consumed by spec 017's port, and by whichever spec builds the provider
 * profile page (§8 question 4). `page.total` already gives a reader the review count.
 */
export interface ProviderRatingAggregate {
  /** One decimal place, matching what `ui/components/marketplace/Rating` renders. */
  average: number;
  /** Visible reviews only — `published` and `flagged`, never `removed`. */
  count: number;
}
```

### Error codes

Added to spec 004's taxonomy in this spec's §3, per spec 004's extension rule. Each is thrown with
an explicit `status`, since none is a member of the shared `API_ERROR_CODES` map.

| HTTP | `code` | When |
|---|---|---|
| `422` | `BOOKING_NOT_ELIGIBLE_FOR_REVIEW` | the booking has never reached `completed` |
| `422` | `REVIEW_WINDOW_CLOSED` | past `completedAt + REVIEW_WINDOW_DAYS`; `details.windowClosesAt` carries the instant |
| `409` | `REVIEW_ALREADY_EXISTS` | a review already exists for that booking, including the concurrent-race loser |
| `422` | `REVIEW_MEDIA_ASSET_INVALID` | a supplied media id is not a live `ready` `review_media` asset for this booking owned by the caller |
| `409` | `RESPONSE_ALREADY_EXISTS` | the review already has a provider response |
| `422` | `REVIEW_NOT_RESPONDABLE` | responding to a `removed` review |
| `422` | `CANNOT_REPORT_OWN_REVIEW` | the reporter is the review's author |
| `409` | `CONFLICT` | R7's `expectedStatus` no longer matches; `details.currentStatus` carries the truth |
| `403` | `FORBIDDEN` | wrong active mode, non-owner provider response, or missing admin permission |
| `404` | `NOT_FOUND` | a non-participant addressing a booking, or a non-existent review |
| `429` | `RATE_LIMITED` | the `reviews` domain budget, or the 20-reports/24 h cap |

### Breaking-change check

- [x] N/A — new spec. No existing route, DTO, column or permission changes meaning. The three
  `ALTER TABLE`s add only columns to tables that are empty in every environment (nothing in `lib/`
  or `app/` has ever inserted a `reviews`, `review_responses` or `review_reports` row — verified;
  `lib/privacy/export.ts` only *reads* `reviews`). `FILE_CONTEXT_TYPES` gains a member, which is
  additive.

---

## 4. Data model changes

### Entities

Spec 003 already ships all three tables as baseline skeletons. They are **ALTERed, never
re-created**, exactly as spec 021 did for `payments` and spec 027 for `file_assets`.
`0001_baseline_schema.sql` is immutable and untouched (`npm run check:schema-checksum`).

| Entity | Change | Columns |
|---|---|---|
| `reviews` | **ALTER** (baseline has `id`, `created_at`, `updated_at`, `version`, `booking_id`, `author_user_id`) | `+ provider_profile_id uuid not null fk→provider_profiles`, `+ service_id uuid not null fk→services`, `+ rating integer not null`, `+ text text null`, `+ status text not null default 'published'`, `+ flag_signals jsonb not null default '[]'::jsonb`, `+ moderated_by_admin_id uuid null fk→admin_profiles`, `+ moderated_at timestamptz null`, `+ removal_reason text null`, `+ idempotency_key text not null`, `+ idempotency_fingerprint text not null` |
| `review_responses` | **ALTER** (baseline has the base columns, `review_id`, `responder_user_id`) | `+ text text not null`, `+ status text not null default 'published'`, `+ flag_signals jsonb not null default '[]'::jsonb`, `+ moderated_by_admin_id uuid null fk→admin_profiles`, `+ moderated_at timestamptz null`, `+ removal_reason text null`, `+ idempotency_key text not null`, `+ idempotency_fingerprint text not null` |
| `review_reports` | **ALTER** (baseline has the base columns, `review_id`, `reporter_user_id`) | `+ reason text not null`, `+ details text null`, `+ status text not null default 'open'`, `+ resolved_by_admin_id uuid null fk→admin_profiles`, `+ resolved_at timestamptz null`, `+ idempotency_key text not null`, `+ idempotency_fingerprint text not null` |
| `review_media` | **NEW** table | the `baseColumns()` set, `review_id uuid not null fk→reviews`, `file_asset_id uuid not null fk→file_assets`, `position integer not null` |
| `file_assets` | **ALTER constraint only** | `file_assets_context_type_ck` is dropped and re-added including `'review_media'`. No column and no data change |
| `permissions` | **seed** | two rows (`reviews/read_moderation_queue` low, `reviews/moderate` medium) for `trust_safety_admin` and `super_admin`, `ON CONFLICT DO NOTHING` |

The draft's `Review.customer_id uuid fk->CustomerProfile` is **dropped**: the baseline
`author_user_id` already identifies the author, and a customer-profile id would duplicate what
`bookings.customer_profile_id` already holds. The draft's `ai_flag_reason text` is replaced by
`flag_signals jsonb` (§3 "Moderation"). `service_id` is denormalized from the booking so the public
per-provider list can be filtered and indexed without joining `bookings`. Every new table and every
new column follows spec 003's conventions: `baseColumns()`, `RESTRICT` foreign keys, a covering
btree index per foreign-key column, closed vocabularies expressed as CHECK constraints, and no
floating-point type anywhere.

**Indexes and constraints**

| # | Object | Purpose |
|---|---|---|
| I-1 | `uniqueIndex reviews_booking_id_uq (booking_id)` | **AC-7** at the database — one review per booking, independent of application code |
| I-2 | `uniqueIndex reviews_author_idempotency_uq (author_user_id, idempotency_key)` | Idempotency scoped per author, never globally (specs 015/018/020/028) |
| I-3 | `index reviews_provider_visible_idx (provider_profile_id, created_at desc) where status in ('published','flagged')` | R3's read path and the aggregate's, in one partial index |
| I-4 | `index reviews_status_idx (status, created_at desc)` | R6's queue, oldest-first |
| I-5 | `index reviews_service_id_idx`, `index reviews_provider_profile_id_idx`, `index reviews_moderated_by_admin_id_idx` | Spec 003 AC-4: every FK column carries a covering btree index |
| C-1 | `reviews_rating_ck` — `rating between 1 and 5` | §3 "Rating and text" |
| C-2 | `reviews_status_ck` — `status in ('published','flagged','removed')` | Closed vocabulary at the database, like every other status column here |
| C-3 | `reviews_text_length_ck` — `text is null or char_length(text) between 10 and 2000` | §3 "Rating and text" |
| C-4 | **`reviews_removal_pairing_ck`** — `(status = 'removed') = (removal_reason is not null and moderated_by_admin_id is not null and moderated_at is not null)` | **AC-4 / AC-8 mechanically.** A removal with no named human and no recorded reason cannot be stored |
| C-5 | `reviews_flag_signals_ck` — `jsonb_typeof(flag_signals) = 'array'` | mirrors `notification_preferences_categories_ck` |
| I-6 | `uniqueIndex review_responses_review_id_uq (review_id)` | **AC-3** — one response per review |
| I-7 | `uniqueIndex review_responses_idempotency_uq (review_id, idempotency_key)` | per-review idempotency |
| C-6 | `review_responses_status_ck`, `review_responses_text_length_ck` (`between 10 and 2000`), `review_responses_removal_pairing_ck` | the same three guarantees as the review |
| I-8 | `uniqueIndex review_reports_review_reporter_uq (review_id, reporter_user_id)` | **AC-6** — one report per reporter per review |
| I-9 | `index review_reports_status_idx (status, created_at)`, `index review_reports_resolved_by_admin_id_idx` | queue read path and FK covering index |
| C-7 | `review_reports_reason_ck`, `review_reports_status_ck` | closed vocabularies |
| C-8 | `review_reports_details_ck` — `(reason <> 'other' or details is not null) and (details is null or char_length(details) between 10 and 2000)` | `other` must be explained |
| C-9 | `review_reports_resolution_pairing_ck` — `(status = 'open') = (resolved_at is null and resolved_by_admin_id is null)` | a resolution always names its admin |
| I-10 | `uniqueIndex review_media_review_asset_uq (review_id, file_asset_id)`, `index review_media_review_id_idx`, `index review_media_file_asset_id_idx` | no asset attached twice; FK covering indexes |
| C-10 | `review_media_position_ck` — `position between 0 and 4` | the 5-item cap, at the database |

### Migration

- **Name:** `0026_add_reviews_ratings` (`drizzle/0026_add_reviews_ratings.sql`) with a hand-written
  `drizzle/0026_add_reviews_ratings_down.sql` carrying no `_journal.json` entry, exactly as 0023,
  0024 and 0025 do. `_journal.json`'s head is `0025_add_ai_usage_tracking` (idx 25), so **this is
  0026** — verified, not assumed.
- **Content:** three `ALTER TABLE … ADD COLUMN` groups; one `CREATE TABLE review_media`; one
  `ALTER TABLE file_assets DROP CONSTRAINT file_assets_context_type_ck` plus a re-add including
  `'review_media'`; the indexes and checks above; two `INSERT INTO "permissions" … ON CONFLICT DO
  NOTHING` statements. Nothing else. No booking, payment, matching or file **data** is touched.
- **Precondition:** `reviews`, `review_responses` and `review_reports` receive `NOT NULL` columns
  without defaults, so the migration guards on each being empty and raises otherwise — the pattern
  0023 used for `message_attachments` and 0024 for `booking_milestones`. All three are empty in
  every environment: no code in `lib/` or `app/` has ever inserted into them.
- **Reversible:** **yes, and safely.** The down migration drops exactly what was added, drops
  `review_media`, and restores `file_assets_context_type_ck` to its 0023 form. It refuses if any of
  the four tables is non-empty, so a rollback can never silently destroy published reviews. It
  orphans no bytes: review media lives in `file_assets`, which the down migration does not delete —
  those rows simply become unreferenced and fall to spec 027's existing soft-delete/purge sweep.
  Rolling back also returns spec 017's rating port to its `null` default, which is the exact pre-029
  behaviour, so no shipped spec breaks.
- **Backfill required:** **no.** There is no existing data.
- **Downtime:** none. `ADD COLUMN` on empty tables is metadata-only; the `file_assets` check swap is
  added as `NOT VALID` and validated in a separate `VALIDATE CONSTRAINT` statement, so the exclusive
  lock is momentary rather than held for a full table scan.
- **Reviewed SQL:** generated, then hand-reviewed in the PR. `npm run check:schema-checksum` keeps
  `0001_baseline_schema.sql` untouched; `npm run check:schema-money-lint` is unaffected, since this
  spec adds no money column and no floating-point column.

### Retention and privacy

A review is **semi-public content tied to a real, completed transaction.** It is retained for the
life of the platform record, like `bookings_status_history` and `messages`.

- **Publicly visible** (R3, guests included): `rating`, `text`, ready public `media`, the provider
  `response` text, and `createdAt`. **Nothing else.** In particular: no reviewer identity — verified
  that this repository has no customer display-name field anywhere (`users` carries only
  `phone_number` and `email`; `customer_profiles` carries no name), so there is nothing to expose
  even if the product wanted it (Open Question 3); no `status`, so `published` and `flagged` are
  indistinguishable by construction (AC-4); no `bookingId`, `authorUserId`, `flagSignals`,
  `moderatedBy`, `removalReason`, report count or reporter identity.
- **Participant-visible** (R1/R2/R4): additionally `bookingId`, `status` and `version`, to the
  review's own author and to the booking's provider.
- **Moderation-restricted** (R6/R7 only, behind `reviews/read_moderation_queue` /
  `reviews/moderate`): `flagSignals`, `moderatedAt`, `removalReason`, and the reports with their
  reasons and details. **Reporter identity is never returned by any route and never written into an
  audit event** — a reporter whose identity can leak to the reviewed provider will not report.
- **Export (spec 008):** `lib/privacy/export.ts` already has a `reviews` section that today returns
  only `{ id, bookingId, createdAt }`, because the columns did not exist. This spec extends it to
  `{ id, bookingId, rating, text, status, createdAt }` for reviews the user **authored**, adds a
  `reviewResponses` section for responses they **wrote**, and adds a `reviewReports` section for
  reports they **filed** (`{ id, reviewId, reason, details, status, createdAt }`). It adds **no**
  `flag_signals`, no other user's report, no reporter identity, no idempotency material and no
  moderation field. Attached media metadata already flows through spec 027's existing
  `exportFileAssetData`. This extends one existing section; it creates no second export system.
- **Deletion (spec 008):** review, response, report and media rows are **never deleted or
  anonymized in place**. Every FK is `RESTRICT`, and spec 008's existing sweep anonymizes the `users`
  row they point at — the treatment spec 018's offers, spec 025's messages and spec 026's
  notifications already receive. A deleted user's review text remains, attributed to an anonymized
  account: it is a record of a real transaction that the counterparty's reputation rests on.
- **Audit:** every moderation decision goes through `recordAdminAuditEvent()` into spec 005's
  `security_events`, namespaced `reviews.*`, carrying actor, all roles held, resource, action,
  target, reason and `correlationId`. **No second audit store is created** — spec 039 will query
  whatever store it ends up owning, exactly as spec 009's own comment describes.
- **Removal is reversible but never invisible:** a `removed` review's text and `removal_reason` are
  retained for audit and appeal; only public exposure stops.

---

## 5. UI states

**Scope note.** This spec adds **one** customer route, **one** admin page, and four route-local or
shared components. It redesigns nothing else and creates no new design token — this repository
already ships `--rating-star` and `--rating-star-empty` (`app/styles/apuriva-tokens.css`) and a
`star` icon (`ui/assets/icons/star.svg`). Each page keeps a single intentional brand placement;
none adds a logo header.

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` rows in the provider review list and in the moderation queue |
| **Empty** | A provider with no reviews: a neutral `EmptyState` — "No reviews yet", never phrasing that implies poor quality |
| **Error** | A submission refused for eligibility explains *exactly when*, using `windowClosesAt` from R2 — never a client-computed deadline |
| **Success** | The review renders in place on the booking page; the provider is notified |
| **Flagged** | Renders identically to published, to everyone. The words "flagged", "pending", "under review" or "removed" are **never** shown on a public surface for a review no human has removed (AC-4) |
| **Removed** | Disappears from public reads. Its author sees a neutral notice with the recorded reason on their own booking page |

**Accessibility.** The star input is fully keyboard-operable: a radiogroup of five inputs with
arrow-key navigation, a visible focus ring, and an accessible name per option ("2 out of 5") — never
a mouse- or touch-only widget. The display `Rating` primitive already carries
`aria-label="{value} out of 5, {count} reviews"`.

**Design-system gap (reported, not silently worked around).** `ui/components/marketplace/Rating` is
**display-only** — it takes a numeric `value` and renders stars; there is no input primitive and no
`ReviewCard` anywhere in `ui/`. Two app-level components are therefore built in `components/` and
re-exported from `@/components`, following the documented precedent in `components/index.ts` for
`ConfirmDialog`, `PriceDisplay`, `SearchBar`, `ResultCard` and `AddressForm` ("named by the spec, no
`ui/` implementation exists, built here"). Both compose existing primitives and existing tokens
only; neither forks `Rating`, and the `components/index.ts` header comment is extended to record
why.

| Path | Kind | Notes |
|---|---|---|
| `app/bookings/[id]/review/page.tsx` | **new route** | Customer submission: `RatingInput`, `Textarea`, `FileUpload` (spec 027's existing component, `contextType: 'review_media'`), `Button`. Calls R2 first and renders the ineligible reason instead of a form when `eligible` is false |
| `app/bookings/_components/ReviewSection.tsx` | new component | On the **existing** `app/bookings/[id]/page.tsx`: the review CTA with its deadline while eligible, then the submitted review afterwards |
| `app/provider/schedule/bookings/[id]/_components/ReviewResponseSection.tsx` | new component | On the **existing** provider booking detail page: the review, and a one-time response form, hidden once a response exists |
| `app/_components/ReportReviewDialog.tsx` | new component | Reason `Select` plus optional `Textarea`, built on the existing `ConfirmDialog`. Used from `ReviewCard` |
| `app/admin/actions/review-moderation/page.tsx` | **new route** | The moderation queue and the resolve form, modelled directly on the existing `app/admin/actions/no-show-reports/page.tsx`. **Name check:** `app/admin/actions/review/page.tsx` already exists and is spec 009's *post-action review* queue, an unrelated feature — this page must **not** be placed there |
| `components/RatingInput.tsx` | new shared component | Keyboard-operable 1–5 input; `Icon name="star"`, `--rating-star` / `--rating-star-empty` |
| `components/ReviewCard.tsx` | new shared component | `Card` + `Rating` + text + `MediaPreview` (spec 027's existing component) + the provider response + a report affordance |

**No public provider profile page exists in this repository** (`app/providers/[id]` is absent, and
the draft named it). `GET /api/v1/providers/{id}/reviews` therefore ships as a public API with no
page of its own yet, and `ReviewCard` is the unit that page will use when its owning spec builds it.
This is recorded as Open Question 4 rather than resolved by inventing a provider profile page here,
which is scope this spec does not own.

---

## 6. Test plan

Vitest only. Unit and component tests are `*.test.ts(x)` beside the code; database-touching tests
are `*.integration.test.ts`; the end-to-end flow is `e2e/reviews.spec.ts`. Integration tests run
only against the isolated `*_test` database (`vitest.config.ts` rewrites `DATABASE_URL`, and
`test/db-reset.ts` refuses any other name), so the developer's own database is never touched.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | Text normalization and bounds; `evaluateReviewSignals` for each of the five codes and for clean negative text; rating-independence; `reviewWindowDays()` bounds | `lib/reviews/{validation,signals,limits}.test.ts` |
| **Boundary** | Source-level: `lib/reviews/**` imports no payment module and no `lib/ai/provider/**`; only `lib/reviews/moderation.ts` writes `'removed'` | `lib/reviews/boundary.test.ts` |
| **Integration** | Eligibility, ownership, duplicates, races, media authorization, response authorization, reporting, moderation, admin RBAC, privacy/export | `lib/reviews/*.integration.test.ts` |
| **Component** | Keyboard operation of `RatingInput`; the page's loading/empty/error/success states; the moderation form | `components/RatingInput.test.tsx`, `app/bookings/[id]/review/page.test.tsx`, `app/admin/actions/review-moderation/page.test.tsx` |
| **E2E** | Complete a booking → customer reviews with media → provider responds → another user reports → admin resolves | `e2e/reviews.spec.ts` |

**Traceability — every AC maps to a named, objectively testable case**

| AC | Test |
|---|---|
| AC-1 | `lib/reviews/eligibility.integration.test.ts::rejects a booking that never reached completed`; `::still accepts a booking now protected, settled or refunded`; and `lib/reviews/boundary.test.ts::reviews never import a payment module` |
| AC-2 | `lib/reviews/create.integration.test.ts::publishes a review linked to the booking`; `::takes provider and service from the booking, ignoring body-supplied ids`; `::attaches ready review_media assets` |
| AC-3 | `lib/reviews/response.integration.test.ts::attaches one response visible to every reader`; `::rejects a second response with 409`; `::rejects a non-owner provider with 404` |
| AC-4 | `lib/reviews/moderation.integration.test.ts::flags without hiding` — a signal-matching review is `flagged` **and still returned by `GET /providers/{id}/reviews`**; `::no automated path can set removed` (attempts the write directly and asserts `reviews_removal_pairing_ck` rejects it) |
| AC-5 | `lib/reviews/moderation.integration.test.ts::a 1-star review with clean text stays published and publicly visible`; `lib/reviews/signals.test.ts::signal evaluation receives no rating` |
| AC-6 | `lib/reviews/report.integration.test.ts::creates a report and queues the review`; `::a duplicate report returns the same report`; `::reporting never changes visibility`; `::rejects reporting your own review`; `::enforces the 20-per-24h cap` |
| AC-7 | `lib/reviews/create.integration.test.ts::rejects a duplicate with 409`; `lib/reviews/create-race.integration.test.ts::two concurrent submissions produce exactly one review` (the shape `lib/bookings/create-race.integration.test.ts` uses) |
| AC-8 | `lib/reviews/moderation.integration.test.ts::remove hides the review, its media and its aggregate contribution, resolves open reports, and writes one audit event`; `::reinstate restores it`; `::a stale expectedStatus is 409` |
| AC-9 | `lib/reviews/admin-authorization.integration.test.ts::each non-Trust-and-Safety role receives 403 on both admin routes`; `::a forbidden attempt is logged` |
| AC-10 | `lib/reviews/privacy.integration.test.ts::export contains own reviews, responses and filed reports`; `::export contains no flag signals, no other user's report and no reporter identity` |

Additional non-AC coverage required before this spec may be marked Approved: media context
authorization (a non-customer cannot upload `review_media` for a booking; a `removed` review's media
is not publicly readable; a `scanning` or `rejected` asset cannot be attached); the `reviews`
rate-limit domain; the aggregate excluding `removed` and including `flagged`; and the spec 017 port
defaulting to `null` when unregistered.

**Coverage:** ≥ 80 % on new code.

**Not covered, deliberately:** the *quality* (precision/recall) of the flagging heuristics. The
flag → queue → resolve pipeline's correctness is fully tested; how good the wordlist is at catching
real spam is a product-iteration concern, not a specification guarantee. Also not covered: any AI
path, because this spec ships none.

---

## 7. Out of scope

- **Provider ranking use of the rating signal.** Spec 029 produces the aggregate and registers the
  source; spec 017 owns weights, renormalization and how the factor is scored. Neither
  `lib/matching/ranking.ts` nor `lib/matching/weights.ts` is edited.
- **Populating the three existing `rating` DTO seams** in `lib/types/search.ts`, `lib/types/home.ts`
  and `lib/types/negotiation.ts`. The aggregate each documents as "spec 029's" now exists; the
  one-line read belongs in each owning spec's module.
- **A public provider profile page.** None exists (§5). The API ships; the page is its owner's.
- **AI-assisted flagging.** Spec 033, deferred by `docs/workflow.md`. The seam is defined; no
  implementation is attempted here.
- **A general admin moderation console.** Spec 038. This spec ships one focused queue; 038 reads it
  rather than building a second.
- **Formal disputes** arising from a review disagreement — spec 031.
- **Blocking a reviewer, and platform-level user sanctions** (warning, restriction, suspension,
  ban) — specs 030 / 038. This spec's only consequence is a review's visibility.
- **Provider-reviews-customer.** Master §52 describes a one-directional review of a provider. A
  reciprocal review needs its own eligibility, privacy and retaliation rules.
- **Editing a review after submission.** Not specified by master §52; deliberately excluded rather
  than invented, for the same retroactive-rewrite reason a provider response is immutable.

---

## 8. Risks and open questions

The draft's two open questions are both **resolved** below.

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | *(draft #1)* Exact eligibility window | Product | **RESOLVED.** Opens at the `completed` history instant; closes 14 days later; `REVIEW_WINDOW_DAYS` environment variable, bounds 1–90, enforced server-side against the database clock. Rationale and precedent in §3 "Eligibility" |
| 2 | *(draft #2)* Rule-based vs. AI flagging | — | **RESOLVED.** Rule-based, deterministic, five named signals. This is the sequencing `docs/workflow.md` already records for spec 029. The AI seam and its degradation rules are specified; no AI code ships |
| 3 | Reviewer identity on the public surface | Product | **Genuinely undeterminable from this repository, so not guessed.** No customer display-name field exists anywhere (`users` has only `phone_number`/`email`; `customer_profiles` has none). Implementation-safe decision: `PublicReviewDto` carries **no** reviewer identity at all. If a display name is later added by a profile spec, adding an optional field to this DTO is additive and breaks nothing |
| 4 | No public provider profile page exists to host the review list | Frontend | The API (R3) and `ReviewCard` ship; the page is built by whichever spec owns the provider profile. Nothing in this spec is blocked |
| 5 | `verification_document`'s comment in `lib/types/files.ts` says "spec 029 — reserved", but a verification document is a provider identity document, not review media | Spec 027 owner | **Reported, not silently changed.** Spec 027 is Approved and is not edited by this review. This spec adds its own `review_media` context and leaves `verification_document` reserved for whichever spec actually needs it. Correcting that one-line source comment is a safe follow-up in the implementation PR |
| 6 | `review_media` becomes the second `publicEligible` context, making spec 027's source comment "`portfolio` is the one public-eligible context today" stale | Spec 027 owner | Factual staleness in a comment, not a behavioural conflict: the registry has always supported any number of public-eligible contexts. Noted for the implementation PR |
| 7 | A `flagged` review counts toward the rating aggregate until a human resolves it | Trust & Safety | **Accepted deliberately.** Excluding it would be an automatic, invisible penalty applied by a heuristic — exactly what master §52 forbids. The mitigation is moderation-queue latency, monitored per §9 |
| 8 | `REVIEW_WINDOW_DAYS` is evaluated at submit time, so changing it retroactively changes eligibility for already-completed bookings | Platform | Accepted; §3 states it explicitly. Snapshotting it per booking would add a column whose only job is to freeze an environment variable |
| 9 | The `reviews` rate limit is in-memory and single-process, like every other domain | spec 041 | Pre-existing platform-wide characteristic (`lib/api/rate-limit.ts` header), not introduced here |
| 10 | Moderation queue backlog could grow faster than Trust & Safety can resolve it | Operations | Queue depth and oldest-unresolved age are §9 counters; the queue is paginated and ordered oldest-first |

---

## 9. Rollout

- **Feature flag:** none. Spec 041 owns the flag mechanism and does not exist; this spec ships no
  parallel one. Its safe disable is the migration rollback, which is clean (§4).
- **Migration order:** `0026_add_reviews_ratings` ships with the code, as every prior spec has.
- **Composition root:** `instrumentation.ts` gains one line — `registerReviewsIntegration()` from
  `@/lib/reviews`, imported **after** spec 028's `registerServiceExecutionIntegration()`, since it
  registers a file context policy and spec 027's registration resets that registry. It registers the
  `review_media` policy and the spec 017 rating source. **No existing line in `instrumentation.ts`
  is modified.**
- **Notification catalogue:** two entries are added to spec 026's closed `NOTIFICATION_TYPES`
  catalogue (`lib/types/notifications.ts` plus `lib/notifications/catalogue.ts`) —
  `review_received` (category `provider_activity`, to the provider) and `review_response_posted`
  (category `booking`, to the reviewer). Additive to a catalogue whose `type` column carries no
  database check constraint, exactly as spec 023 added its no-show types. Neither is a critical
  category, so both honour the recipient's existing preferences.
- **Rollback:** revert the deploy and run `0026_add_reviews_ratings_down.sql`. It refuses if any
  review, response, report or media row exists, so a rollback after real usage is a deliberate
  decision rather than silent data loss. The spec 017 rating port and the `review_media` context both
  return to their documented pre-029 defaults (`null`, and `422 FILE_CONTEXT_NOT_AVAILABLE`), so no
  shipped spec breaks.
- **Observability (spec 040):** review submission rate; flag rate by signal code; moderation queue
  depth and oldest-unresolved age; time-to-resolution; report rate; and — as the direct guard on
  AC-4/AC-5 — a removal counter, which must always equal the number of
  `reviews.moderation_resolved` audit events carrying `decision = 'remove'` and never exceed it.
