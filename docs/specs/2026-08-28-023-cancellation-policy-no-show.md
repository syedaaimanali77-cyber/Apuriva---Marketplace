# Spec: Cancellation Policy & No-show

**File:** `docs/specs/2026-08-28-023-cancellation-policy-no-show.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §38, §50–§51, §68, §70, §87, §91, §100, §105, §113, §117, §132.11, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, §8, [docs/workflow.md](../workflow.md)

**Depends on:** 003 (the `policies` / `policy_versions` / `policy_acceptances` baseline skeletons and
the generic `enforce_status_transition()` trigger), 004 (`withApiRoute`, the error taxonomy,
`OPENAPI_ROUTES`, rate-limit domains), 005 (`requireSession`, `requireCsrf`), 006
(`requireActiveMode`), 008 (export/deletion retention), 009 (admin RBAC, risk tiers, the admin audit
log), 012 (the service-area check used as a coarse derived location signal), 015
(`Idempotency-Key`, and `lib/requests/cancellation-consequence.ts`, which explicitly defers fee
policy to this spec), 020 (the booking lifecycle, `applyBookingTransition`,
`registerBookingTransitions`, `bookings_status_history`), 021 (`payment_authorizations.captured_*`
as the authoritative captured amount), 022 (`RefundEligibilityGate` — the seam this spec registers).

**Feeds:** 017 (the `reliability` ranking factor — consumes this spec's verified-no-show fact), 022
(refund execution — consumes this spec's eligibility decision), 026 (notifications — consumes this
spec's event port), 031 (disputes — escalation target once a no-show leaves this spec), 041 (the
admin configuration **UI** over the policy data this spec owns).

---

## 1. Problem statement

**Today:** No cancellation-fee or no-show workflow exists. `policies`, `policy_versions` and
`policy_acceptances` are still empty spec 003 baseline skeletons — `policies` carries only
`id`/audit/`version`, `policy_versions` adds only `policy_id`, and `policy_acceptances` carries only
`policy_version_id` + `user_id` with a `UNIQUE (policy_version_id, user_id)` index that, unchanged,
would allow a customer exactly **one** acceptance of a given policy version across all their
bookings (§4 resolves this). There is no `no_show_reports` table anywhere in the schema, and
`grep -r no_show lib app components` returns nothing.

Spec 015 already isolates its cancellation-consequence opinion into
`lib/requests/cancellation-consequence.ts`, whose header states in terms that "spec 023's
cancellation-policy engine (fees, tiers, no-show consequences) is NOT implemented here" — that file
returns `consequence: null` for every pre-booking request state and is the seam this spec's sibling
behaviour must stay consistent with. Spec 020 reserved every `→ cancelled` booking transition for
this spec (`lib/bookings/state-machine.ts`, "`-> cancelled` (spec 023)"), seeded none of them, and
its `registerBookingTransitions()` extension registry is the mechanism by which this spec performs
them. Spec 022 shipped `RefundEligibilityGate` in `lib/refunds/eligibility.ts` with an inert
`{ eligible: false }` default explicitly waiting for this spec to register the real one.

Master spec §50 requires a smart hybrid policy — platform defaults, service/category overrides,
provider choice from *allowed options only*, customer sees the policy before booking/payment — with
an **example** timing structure (>24h free, 12–24h small fee, <12h higher fee) and the note that the
actual policy must be configurable. §51 requires a no-show flow (report → gather signals → other
party responds → apply policy → resolve) that uses booking timing, status history, location signals
*where appropriate* and communications, and that never automatically accuses anyone on GPS or
timestamps alone. §132.11 forbids an automatic ban.

**Who is affected:** Customers cancelling bookings, who must see the exact consequence before they
commit; providers who lose a paid slot to a late cancellation or a no-show; Trust & Safety, who
resolve contested no-shows; Finance, whose refund execution (spec 022) has had no policy source.

**Why it matters now:** Spec 022 shipped with nothing automatically refundable, because the
eligibility gate it consults has no registered implementation. Until this spec ships, **no
cancellation refund can happen at all** except through a two-admin manual override.

**Success looks like:** A customer sees the exact applicable policy before paying and the exact
computed consequence before confirming a cancellation; the fee is computed server-side from the
policy version snapshotted for that booking, never from anything a client sends; a no-show report
gathers only evidence the platform already holds, requires the other party's response (or a defined
timeout) before any consequence, is resolved by a named Trust & Safety admin, and produces a single
verified-no-show fact that spec 017's ranking may consume — with no automatic accusation and no
automatic ban.

---

## 2. Acceptance criteria

The six original ACs are preserved and made deterministic: AC-2/AC-3's "whatever the configured tier
is" is resolved to exact percentages and exact boundary semantics (§3 "The platform default"); AC-4's
"allowed options" is given a concrete constraint mechanism; AC-5's "location signals where
appropriate" is resolved to a named, privacy-minimising evidence model and given a response timeout;
AC-6 is re-grounded on **spec 017**, which actually owns the `reliability` ranking factor
(`lib/matching/weights.ts`) — the draft's "spec 016" was wrong; spec 016 owns availability and
service areas. AC-7 through AC-10 are added because without them the financial handoff, concurrency,
admin authorization and retention of this spec are unspecified, and each is traceable to a named
test in §6.

| # | Criterion |
|---|---|
| AC-1 | **Given** a service **When** its cancellation policy is read — on the service page, and again on the booking before payment — **Then** the effective policy (every tier, its hour bounds and its fee percentage, and the resolution source) is returned by the server, and for an existing booking it is the **snapshotted** version (§3 "Acceptance and snapshotting"), never a re-resolution of current configuration |
| AC-2 | **Given** a cancellation strictly more than 24 hours before `bookings.scheduled_at` **When** the platform default applies **Then** the fee is **0%** and the consequence is a full refund of the captured amount; the boundary is evaluated on the database clock against the booking's authoritative scheduled time, and **exactly** 24 hours falls in this tier (§3 "Boundary semantics") |
| AC-3 | **Given** a cancellation in `[12h, 24h)` before the scheduled time **Then** the fee is **25%** of the captured amount; **given** `(0h, 12h)` **Then** **50%**; **given** at or after the scheduled time **Then** **100%** — each computed server-side from the booking's snapshotted policy version and the captured amount, rounded half-up to a whole minor unit and clamped to `[0, captured]`. The request body carries **no** fee, amount, tier or timestamp, and any such field is rejected `400 VALIDATION_ERROR` |
| AC-4 | **Given** an active service-level override **When** it conflicts with a category override or the platform default **Then** service wins over category, which wins over platform (§3 "Precedence"); a provider may select only a `key` the effective version publishes in `allowedOptions`, and any other value is `422 POLICY_OPTION_NOT_ALLOWED`. No code path anywhere accepts a provider-supplied percentage |
| AC-5 | **Given** a reported no-show **When** submitted **Then** a `no_show_reports` row is created in `awaiting_response`, carrying only evidence the platform already holds — booking timing, the booking's status history, the presence/absence of communications, and a **coarse derived** location signal where one exists — and **no** policy consequence, booking transition or financial effect occurs until the other party responds or `NO_SHOW_RESPONSE_WINDOW_HOURS` elapses, and in every case only a Trust & Safety admin's resolution applies a consequence. Location is never the sole basis for a fault finding, and a resolution is fully possible with no location signal at all |
| AC-6 | **Given** a no-show report resolved by an admin as `no_show_confirmed_customer` or `no_show_confirmed_provider` **Then** exactly **one** durable verified-no-show fact exists for that booking (a partial unique index makes a second impossible), attributed to the faulted party, readable by spec 017 through `lib/no-show/reliability.ts`; this spec computes no ranking, changes no weight, and **never** suspends, bans or restricts an account (master spec §132.11) |
| AC-7 | **Given** a cancellation whose consequence is computed **When** it is executed **Then** this spec performs the `→ cancelled` booking transition through spec 020's `applyBookingTransition()` and hands spec 022 an eligibility decision `{ eligible, amountMinorUnits, currencyCode, reason, decisionRef }`; it executes no refund, calls no payment provider, writes no `payments`/`refunds` row, and computes no captured amount of its own (it reads spec 021's `payment_authorizations.captured_amount_minor_units`) |
| AC-8 | **Given** two concurrent cancellations of one booking, or a cancellation racing a no-show resolution, a lifecycle transition or a refund **When** they overlap **Then** exactly one succeeds — serialized by `SELECT ... FROM bookings WHERE id = $1 FOR UPDATE` plus the version-conditional transition spec 020 already enforces, never an application-only check — and a repeat of the same `Idempotency-Key` with the same fingerprint replays the first result with `200` rather than cancelling twice or charging twice |
| AC-9 | **Given** a no-show resolution **When** performed **Then** the actor holds `no_show_reports/resolve` through spec 009's existing permission model, is **not** the reporter, and the resolution is written once (a conditional `UPDATE ... WHERE status = 'under_review'`), with a spec 009 audit event naming the admin, the outcome and the reason; a second resolution attempt is `409 NO_SHOW_REPORT_ALREADY_RESOLVED` |
| AC-10 | **Given** any no-show evidence **When** read back **Then** each party sees their own submissions and the report's neutral status only; raw coordinates are never stored or returned by any route, the coarse location signal is retained for `NO_SHOW_EVIDENCE_RETENTION_DAYS` and then nulled by the existing privacy sweep, and the `policy_acceptances` / `no_show_reports` export projection carries no other party's private evidence and no admin note |

---

## 3. API contract

### What this spec reuses rather than re-inventing

| Need | Existing mechanism reused | Not created |
|---|---|---|
| Booking state change | spec 020's `applyBookingTransition()` + `registerBookingTransitions('spec 023 (cancellation)')` | a second booking state machine |
| Status-machine enforcement | spec 003's `enforce_status_transition()` function, via rows seeded into `bookings_status_transitions` and a new `no_show_reports_status_transitions` table | a new trigger function |
| Refund execution | spec 022's `registerRefundEligibilityGate()` / its `RefundEligibility` contract | any refund, provider call or ledger write |
| Captured amount | spec 021's `payment_authorizations.captured_amount_minor_units` (read-only) | a parallel money record |
| Admin authorization + audit | spec 009's permission resolution and `recordAdminAuditEvent()` | a second admin approval system |
| Idempotency | spec 015's `requireIdempotencyKey()` / `idempotencyFingerprint()` | a second idempotency scheme |
| Route guards | `requireSession` + `requireCsrf` + `requireActiveMode`, in the normative order `app/api/v1/payments/route-guards.ts` fixed | a new guard stack |
| Consequence-before-confirmation | spec 015's `GET /requests/{id}/cancel-preview` **pattern**, applied to bookings | a client-inferred preview |
| Coarse location evidence | spec 012's existing service-area containment check | any device-location capture |
| Rate limiting | spec 004's existing `bookings` domain (60 / 60s) | a new rate-limit domain |
| Communications evidence | a port with an inert default, until spec 025 ships messaging | a stand-in message store |
| Background timeout handling | spec 021's Vercel Cron pattern (`app/api/v1/cron/*`, bearer `CRON_SECRET`) | a new scheduler |

### Ownership boundaries (normative)

| Concern | Owner |
|---|---|
| Policy resolution, precedence, versioning, acceptance/snapshotting, allowed options | **023** |
| Cancellation consequence **calculation**, the `→ cancelled` transition, the cancellation workflow | **023** |
| No-show report, response, evidence, resolution, and the verified-no-show fact | **023** |
| Refund **execution**, refund rows, provider refund calls, reconciliation | 022 |
| Payment state, capture, protection window, payment-provider access | 021 |
| Booking lifecycle vocabulary, the transition primitive, status history | 020 |
| Reliability **scoring/ranking** consumption | 017 (`lib/matching/**`) |
| Availability and service areas | 016 |
| Formal dispute resolution after escalation | 031 |
| Admin **UI** for policy configuration | 041 (the data + API seam are this spec's — §3 "Configuration ownership") |

### Policy model

A `policies` row is a scope: `('cancellation', 'platform' | 'category' | 'service', scope_id)`.
A `policy_versions` row is an **immutable** configuration snapshot with a half-open validity interval
`[effective_from, effective_to)`. Versions are append-only: publishing a new version sets the
previous version's `effective_to` to the new version's `effective_from` and never alters any earlier
interval — which is what makes the lazy snapshot in "Acceptance and snapshotting" equal to what an
eager write at booking time would have produced.

```jsonc
// policy_versions.config — validated at write time by lib/cancellation/policy-config.ts
{
  "tiers": [                                    // ordered, contiguous, exhaustive over the real line
    { "minHoursBefore": 24,   "maxHoursBefore": null, "feePercent": 0 },
    { "minHoursBefore": 12,   "maxHoursBefore": 24,   "feePercent": 25 },
    { "minHoursBefore": 0,    "maxHoursBefore": 12,   "feePercent": 50 },
    { "minHoursBefore": null, "maxHoursBefore": 0,    "feePercent": 100 }
  ],
  "allowedOptions": [                           // what a provider may choose from; may be empty
    { "key": "standard", "tiers": [ /* … */ ] },
    { "key": "flexible", "tiers": [ /* … */ ] }
  ]
}
```

**Write-time validation is mandatory** (`validateCancellationPolicyConfig`), and a malformed config
can never be persisted: `tiers` must be a non-empty array ordered by descending `minHoursBefore`,
contiguous (`tiers[n].minHoursBefore === tiers[n+1].maxHoursBefore`), exhaustive (the first tier's
`maxHoursBefore` is `null`, the last tier's `minHoursBefore` is `null`), each `feePercent` an integer
in `[0, 100]`, and `feePercent` non-decreasing as the booking approaches. Every `allowedOptions[].key`
is unique, matches `^[a-z][a-z0-9_]{0,31}$`, and its `tiers` satisfy the same rules. The database
additionally enforces `jsonb_typeof(config) = 'object'` and a non-empty `config->'tiers'`; the full
grammar lives in the domain layer, exactly as spec 017 does for `matching_weights`
(`services_matching_pool_size_ck` at the database, `validateMatchingWeights` in code).

### The platform default (resolves the draft's Open question #1)

Master spec §50 supplies an **example** (">24h: free / 12–24h: small fee / <12h: higher fee") and no
exact numbers, and no number exists anywhere in the approved spec chain or this repository. Leaving
it open would block implementation, so this spec makes the product decision explicitly, keeping the
draft's three-tier structure and adding the fourth tier the draft never named — a cancellation *at or
after* the scheduled time, which the three-tier structure silently left undefined:

| Tier | Window before `scheduled_at` | Fee % of captured | Consequence |
|---|---|---|---|
| T1 | `≥ 24h` | **0** | full refund |
| T2 | `[12h, 24h)` | **25** | partial refund of 75% |
| T3 | `(0h, 12h)` | **50** | partial refund of 50% |
| T4 | `≤ 0h` (at or after the scheduled time) | **100** | no refund |

0/25/50/100 is chosen because it is the simplest monotone ladder that satisfies §50's "small fee /
higher fee" shape, is expressible exactly in integer minor units for any captured amount that halves
or quarters cleanly (and is defined by explicit rounding otherwise), and — being a percentage of what
was actually captured — can never exceed what the customer paid. It is a **default**, not a constant:
it lives in `policy_versions.config`, seeded by the migration, and an admin changes it by publishing
a new version, never by a code change.

### Boundary semantics (normative, AC-2/AC-3)

- `hoursBefore` is `bookings.scheduled_at − clock_timestamp()`, evaluated in a statement issued
  **after** the `FOR UPDATE` lock on the booking — the rule spec 018 established for offer expiry and
  spec 020 restated in `lib/bookings/lifecycle.ts`. Never `now()` (frozen at transaction start), never
  a client clock, never a client-supplied timestamp.
- Tier bounds are **`[min, max)`** — inclusive at the lower (further-from-now) bound, exclusive at the
  upper. So **exactly 24h → T1 (0%)** and **exactly 12h → T2 (25%)**: each boundary instant falls in
  the cheaper tier, the customer-favourable reading and the only one that makes the ladder
  well-defined at its edges.
- **Exactly at the scheduled time → T4 (100%)**, as does any instant after it. `hoursBefore ≤ 0` is a
  single tier; a cancellation after the scheduled time is not a different workflow.
- `bookings.scheduled_at` is `timestamptz` and is the sole authority. `bookings.scheduled_timezone` is
  used for **display only** — rendering the scheduled time and the tier boundaries in the zone the
  slot was booked in — and never enters the arithmetic, so a DST transition cannot move a boundary.
- Money: `feeMinorUnits = round_half_up(captured × feePercent / 100)`, clamped to `[0, captured]`;
  `refundMinorUnits = captured − feeMinorUnits`. Integer minor units throughout (spec 003 AC-1). The
  captured amount is `payment_authorizations.captured_amount_minor_units` — spec 021's authority,
  which already reflects any spec 021 price adjustment — not `bookings.price_amount_minor_units`.

### Precedence (AC-4)

Resolution for a service `S` in category `C`, at an instant `t`:

```
service override for S, active at t
  → category override for C, active at t
  → platform default, active at t
```

A scope contributes only if its `policies.is_active` is true **and** it has exactly one
`policy_versions` row whose `[effective_from, effective_to)` contains `t`. Every other case is decided
here rather than left to interpretation:

| Case | Behaviour |
|---|---|
| No override exists at a scope | Fall through to the next scope. The platform default always exists (seeded by the migration), so resolution never falls through to nothing |
| An override exists but `is_active = false` | Treated as absent — fall through. Deactivating is the documented way to retire an override without deleting history |
| An override is active but has no version covering `t` | Treated as absent — fall through. A scope with no valid configuration must never make a booking unpriceable |
| Multiple versions cover `t` | **Impossible by construction**: `policy_versions_no_overlap_ex`, a `tstzrange` exclusion constraint per policy, rejects the overlapping insert. If one is nonetheless observed (a manual write), resolution raises and the caller receives `422 CANCELLATION_POLICY_UNAVAILABLE` — never a silent pick |
| Configuration is invalid | Cannot be written (write-time validation + DB checks). A row that fails validation on read is treated as absent and logged as `cancellation.policy_config_invalid`; if that leaves even the platform default unusable, callers get `422 CANCELLATION_POLICY_UNAVAILABLE` and **no** cancellation is processed — never a default-allow, never an invented tier |
| The service or category is `retired` | Resolution is unaffected for **existing** bookings, which use their snapshot; a new read of a retired service still resolves normally. A retired catalog entry must never make its live bookings unpriceable |
| The policy version changes after a booking exists | Never affects that booking. The booking's snapshot governs (below) |
| A provider selected an option | The option's `tiers` replace the effective version's `tiers`, **only** if `provider_services.cancellation_policy_option` matches an `allowedOptions[].key` of the *effective* version at `t`. A stale or unknown key is treated as absent (fall back to the version's own `tiers`) on read, and is rejected `422 POLICY_OPTION_NOT_ALLOWED` on write |

`source` in the DTO is `'platform_default' | 'category_override' | 'service_override'`, with
`providerOptionKey` reported alongside when one applied — so a customer can always see *why* the
policy they are shown is the policy they are shown.

### Acceptance and snapshotting (AC-1)

`policy_acceptances` records the exact `policy_version_id` (and the resolved tiers, including any
provider option, as `accepted_config`) that governs one booking. **A later configuration change can
never alter an existing customer's terms**, because nothing re-resolves a booking that has a row.

Spec 020's booking-creation path is shipped and is **not modified by this spec**. Instead the snapshot
is **materialised lazily and deterministically**: the first time a booking's policy is needed (the
booking policy read, the cancel preview, the cancellation itself, or a no-show resolution), the row is
created inside that transaction by resolving the policy **as of `bookings.created_at`**, not as of
now. Because versions are immutable and their intervals append-only, that resolution is exactly what
an eager write at booking time would have produced — a materialisation, not a re-decision. Races are
handled by `policy_acceptances_booking_uq` (`UNIQUE (booking_id)`): the loser catches the unique
violation and re-reads the winner's row.

`accepted_at` is the instant of materialisation and is reported as such; `booking_created_at` is
stored alongside it so an auditor can see which instant the resolution used. The customer-facing
guarantee — the terms shown before payment are the terms enforced — holds because the pre-payment
read and the enforcement read resolve as of the same `bookings.created_at`.

### Cancellation eligibility by booking state (AC-7)

Spec 020's vocabulary, from `BOOKING_STATUSES` in `lib/db/schema.ts`: `pending`, `confirmed`,
`provider_en_route`, `arrived`, `in_progress`, `completed`, `protected`, `settled`, `cancelled`,
`disputed`, `refunded`, `failed`. This spec introduces **no** new booking status and **no** second
state machine; it registers and seeds exactly the transitions it performs.

| From | Customer may cancel | Provider may cancel | Notes |
|---|---|---|---|
| `confirmed` | yes | yes | A `confirmed` booking always has a provider-confirmed capture: spec 021's confirmation gate keeps a booking `pending` until capture, so there is always a captured amount to compute against |
| `provider_en_route` | yes | yes | |
| `arrived` | yes | yes | |
| `pending` | **no** — `422 BOOKING_NOT_CANCELLABLE` | **no** | Nothing is captured, so there is no consequence to compute and no money to move. An abandoned `pending` booking is closed by spec 021's authorization-window sweep (`pending → failed`), which this spec neither duplicates nor pre-empts |
| `in_progress` | **no** | **no** | The service has started; the remedy is completion, a dispute (031) or a service-execution outcome (028), not a timing-tier fee |
| `completed`, `protected`, `settled` | **no** | **no** | The service was delivered. Money moves only through 022/031 |
| `cancelled` | idempotent replay, else `422 BOOKING_ALREADY_CANCELLED` | same | |
| `disputed` | **no** — `422 BOOKING_NOT_CANCELLABLE` | **no** | Spec 031 owns a disputed booking's outcome |
| `refunded`, `failed` | **no** | **no** | Terminal |

Transitions this spec **owns, registers and seeds** into `bookings_status_transitions` —
`('confirmed','cancelled')`, `('provider_en_route','cancelled')`, `('arrived','cancelled')` — exactly
the rows spec 020 §3 reserved ("`→ cancelled` / no-show | spec 023 | not seeded here"). They are
registered at import time by `lib/cancellation/index.ts` through spec 020's existing
`registerBookingTransitions('spec 023 (cancellation)', …)` — the same idiom `lib/payments/index.ts`
uses — and `instrumentation.ts` imports the barrel once per server instance.
`applyBookingTransition(..., actorRole)` is the **only** writer of `bookings.status`; this spec issues
no `UPDATE bookings SET status` of its own. `actorRole` is `'customer'`, `'provider'` or `'admin'` per
the acting party; `'system'` is never passed, because no cancellation in this spec happens without an
explicit authenticated actor.

### The financial boundary (AC-3, AC-7)

The cancel endpoint computes an **authoritative consequence**. It never executes it.

```typescript
// lib/types/cancellation.ts
export interface CancellationConsequenceDto {
  cancellable: boolean;
  /** Absent when `cancellable` is false. */
  tier?: CancellationTier;
  hoursBefore?: number;               // server-computed, 3 decimals, display only
  capturedAmountMinorUnits?: number;
  feeAmountMinorUnits?: number;
  refundAmountMinorUnits?: number;
  currencyCode?: string;
  policyVersionId?: string;
  policySource?: PolicySource;
  providerOptionKey?: string | null;
  /** Why it is not cancellable — a code from §3 "Error codes", never free text. */
  blockedReason?: string;
}
```

The **same pure function** (`computeCancellationConsequence`) produces the preview
(`GET /bookings/{id}/cancel-preview`) and the executed outcome, so the number the customer confirms is
the number applied — master spec §38's "show consequence before confirmation", implemented the way
spec 015 already implements it for requests rather than by a second code path. The only difference
between them is the clock instant; a preview carries no authority, and the executed value is always
recomputed under the lock.

Handoff to spec 022, inside the cancellation transaction, immediately after the booking transition:

| Outcome | What spec 022's `RefundEligibilityGate` returns |
|---|---|
| Full refund (T1) | `{ eligible: true, amountMinorUnits: captured, currencyCode, reason: 'cancellation_tier_0', decisionRef }` |
| Partial refund (T2/T3) | `{ eligible: true, amountMinorUnits: captured − fee, currencyCode, reason: 'cancellation_tier_25' \| 'cancellation_tier_50', decisionRef }` |
| No refund (T4) | `{ eligible: false }` — the fee consumed the whole captured amount. No refund row is created |
| Nothing captured | Unreachable: `pending` is not cancellable and every cancellable state has a capture. Defensively, `{ eligible: false }` — never a guessed amount |

`decisionRef` is `cancellation:{bookingId}:{policyVersionId}:{cancellationId}` — opaque to spec 022,
which stores it as `refunds.eligibility_decision_ref`.

**There is no "additional charge" path.** The fee is always a *retention* out of an amount already
captured, never a new charge: a cancellation produces a full refund, a partial refund or no refund,
and can never leave the customer owing more. Charging beyond the captured amount would require a
payment-provider call, which is spec 021's exclusively and which this spec deliberately does not reach
for. A product decision to charge more than was captured would be a new spec with spec 021's
participation, not a widening of this one.

The provider's side of the money is not this spec's: the fee is simply not refunded, and what a
provider is ultimately paid follows spec 022's `reconciliation_state` fact into spec 024. This spec
writes no `payouts` row and computes no provider earning.

### Idempotency and concurrency (AC-8)

`Idempotency-Key` is **required** on `POST /bookings/{id}/cancel` and
`POST /bookings/{id}/report-no-show`; the fingerprint is `idempotencyFingerprint()` over the canonical
body. Scope is `UNIQUE (booking_id, idempotency_key)` on `booking_cancellations` and on
`no_show_reports` — per entity, never global, matching specs 015/018/020/021/022.

| Situation | Behaviour |
|---|---|
| Same key, same fingerprint | Replay the stored `CancellationDto` with `200`. No second transition, no second eligibility handoff |
| Same key, different fingerprint | `409 IDEMPOTENCY_KEY_CONFLICT` (re-exported from `lib/requests/errors.ts`) |
| Two concurrent cancellations, same key | The unique index admits one; the loser catches the violation and replays the winner's row |
| Two concurrent cancellations, different keys | Serialized by `SELECT ... FROM bookings WHERE id = $1 FOR UPDATE`. The first transitions the booking; the second re-reads under the lock, finds `cancelled`, and is `422 BOOKING_ALREADY_CANCELLED` |
| Cancellation racing a lifecycle transition (e.g. the provider marks `arrived`) | Both take the booking-row lock and both use `applyBookingTransition`'s version-conditional update. Whichever commits second re-reads the current status and either proceeds from it (if still cancellable) or fails `409 INVALID_STATUS_TRANSITION` / `422 BOOKING_NOT_CANCELLABLE`. The tier is always computed from the clock reading taken **after** the lock, so a race can never move a booking into a cheaper tier |
| Cancellation racing refund execution | Cannot interleave incorrectly: the eligibility gate is consulted **inside** spec 022's refund transaction under its own `payments` row lock, and spec 022's `remainingRefundable` invariants (I-1/I-2) are the single authority on how much may ever be refunded — so even a repeated decision cannot over-refund |
| Cancellation racing a no-show resolution | Both take the booking-row lock. Whichever commits first transitions the booking; the other observes the terminal status and returns `422 BOOKING_ALREADY_CANCELLED` (cancel path) or records its outcome with **no** second transition (resolution path) — an already-`cancelled` booking means "the transition is already done", never an error, because the fault finding is still meaningful |
| Duplicate no-show report by the same reporter | `409 NO_SHOW_REPORT_ALREADY_EXISTS` — enforced by `no_show_reports_booking_reporter_uq` |
| Retry after a successful cancellation, no key | `422 BOOKING_ALREADY_CANCELLED` |

Lock ordering is fixed and extends spec 021/022's: **`bookings → payments → refunds`**, with
`no_show_reports` taken last. No notification emission and no provider call ever happens inside a
transaction.

### No-show workflow (AC-5, AC-9)

```
reported ──► awaiting_response ──► under_review ──► resolved
                     │
                     └──► withdrawn   (reporter only, while awaiting_response)
```

`reported` is the creation instant, recorded in history; the row's persisted status becomes
`awaiting_response` in the same transaction, so a report is never left in a state nobody is acting on.
The response window elapsing moves the report to `under_review` — the same edge a filed response uses,
distinguished by `response_status`. Seeded into `no_show_reports_status_transitions` and enforced by
spec 003's **existing** `enforce_status_transition()` trigger:

```
reported          → awaiting_response
awaiting_response → under_review
awaiting_response → withdrawn
under_review      → resolved
```

| Who | May report | May respond | May resolve |
|---|---|---|---|
| Booking's customer | yes, about the provider | yes, to a report against them | **no** |
| Booking's provider | yes, about the customer | yes, to a report against them | **no** |
| Trust & Safety admin | no | no | yes |

- **The reporter can never respond to or resolve their own report** — `403 NO_SHOW_SELF_ACTION_NOT_ALLOWED`
  on the respond route, and an admin who is the reporter is refused on resolve. The check is
  structural, not hypothetical.
- **Reporting window.** A report may be filed only from `NO_SHOW_REPORT_OPENS_MINUTES` (default 15)
  after `scheduled_at` until `NO_SHOW_REPORT_CLOSES_HOURS` (default 72) after it, and only while the
  booking is `confirmed`, `provider_en_route`, `arrived` or `in_progress`. Outside that:
  `422 NO_SHOW_REPORT_WINDOW_CLOSED`.
- **Response is required before consequence** (AC-5). The report sits in `awaiting_response` until the
  other party responds (`POST /no-show-reports/{id}/respond`, moving it to `under_review`) or until
  `NO_SHOW_RESPONSE_WINDOW_HOURS` (default 48) elapses.
- **If the other party never responds**, `GET /api/v1/cron/no-show-response-sweep` — the same Vercel
  Cron + bearer `CRON_SECRET` pattern as `/cron/payment-sweep`, selecting `FOR UPDATE SKIP LOCKED`,
  idempotent (the next minute's run is the retry) — moves the report to `under_review` with
  `response_status = 'no_response'`. **Silence is not an admission**: the sweep applies no consequence,
  makes no fault finding, and the admin sees "no response within the window" as one neutral fact among
  the evidence.
- **Duplicate reports.** One per `(booking_id, reporter_role)` — a second by the same party is
  `409 NO_SHOW_REPORT_ALREADY_EXISTS`.
- **Both parties report each other.** Explicitly permitted: two rows with opposite `reporter_role`,
  each requiring the other party's response. The admin resolves each, but **at most one may carry
  fault** for the booking — `no_show_reports_booking_fault_uq`, a partial unique index on `booking_id`
  where the outcome is a confirmed no-show, makes a second fault-bearing resolution impossible at the
  database (`409 NO_SHOW_FAULT_ALREADY_RECORDED`). The counterpart is resolved `no_fault` or
  `inconclusive`. Each report stores `counterpart_report_id` so the admin reviews them together.
- **No automatic accusation.** No timer, sweep, location signal or timestamp comparison ever sets an
  outcome; only an admin's explicit resolution does. `lib/no-show/no-auto-fault.test.ts` asserts at the
  source level that no module under `lib/no-show/**` writes `outcome` outside the resolution function.

### Evidence model and the location signal (resolves the draft's Open question #2)

The repository captures **no device location anywhere**: spec 020 states that no GPS or geofence can
move the booking state machine, `lib/bookings/**` imports no location module, and the only coordinates
that exist are customers' saved `addresses` (micro-degrees, spec 012) and providers' declared service
areas. Building a location-evidence pipeline would mean **creating surveillance infrastructure that
does not exist**, which §51's "where appropriate" plainly does not require.

**Decision: no location is collected, and no coordinate is ever stored on a report.** The evidence a
report carries is derived entirely from data the platform already holds:

| Signal | Source | Stored as |
|---|---|---|
| Booking timing | `bookings.scheduled_at`, `duration_minutes`, the report instant | timestamps + a derived `minutes_after_scheduled` integer |
| Status history | `bookings_status_history` for this booking | an array of `{ toStatus, actorRole, occurredAt }` — statuses, roles and instants only |
| Attendance lifecycle | whether `provider_en_route` / `arrived` / `in_progress` were reached, and when | booleans + instants derived from the above |
| Communications | the `NoShowCommunicationsEvidence` port (inert default until spec 025) | `{ available: false }` today; later a **count and last-instant only**, never message bodies |
| Location (coarse, derived, optional) | spec 012's existing service-area containment check: does the booking's address fall inside the provider's declared service area? | one enum: `'address_within_service_area' \| 'address_outside_service_area' \| 'unavailable'` |

- **Raw coordinates are never stored** on `no_show_reports` and never returned by any route. The
  location signal is a single enum derived at report time from data both parties already provided for
  another purpose — it is not new collection.
- **It is optional and never decisive.** `'unavailable'` is a first-class value; resolution is fully
  possible without it, and `lib/no-show/resolution.ts` takes no location argument at all — the admin
  sees it as context. Tests assert a complete resolution with the signal absent, and a source-level
  test asserts that no resolution code path branches on it (AC-5: never the sole basis for fault).
- **Who can see what.** Both participants see the report's neutral status and their own submissions.
  The evidence bundle, the location enum and either party's statement verbatim are visible to Trust &
  Safety only; a participant sees *that* a response was filed and when, never the other party's words.
- **Retention.** `location_signal`, `evidence`, `reporter_statement` and `response_statement` are
  nulled `NO_SHOW_EVIDENCE_RETENTION_DAYS` (default 180) after resolution, by an extension to spec
  008's **existing** privacy sweep — no new sweep mechanism. The report's identity, booking, statuses,
  outcome, resolving admin and timestamps are **retained**: they are the audit record of a financial
  consequence and the basis of the AC-6 fact.
- **Evidence is immutable.** `no_show_reports_evidence_immutable_trg` rejects any `UPDATE` changing
  `evidence`, `location_signal`, `reporter_statement` or `response_statement` once set — the single
  exception being the retention sweep's **minimising** write, which can only ever remove: statements
  go to `NULL`, and `evidence` (a `NOT NULL` column) goes to the empty object, which is this table's
  way of spelling "nothing is left here". History rows are append-only
  (`no_show_reports_status_history_append_only_trg`).

### Admin resolution (AC-9)

Spec 009's framework is used exactly as it stands; **no second approval system is created.** The
migration seeds, following spec 017's `matching.config` precedent
(`INSERT ... SELECT ... FROM (VALUES ...) JOIN roles ... ON CONFLICT DO NOTHING`):

| resource | action | risk tier | Roles |
|---|---|---|---|
| `no_show_reports` | `read` | `low` | `trust_safety_admin`, `super_admin` |
| `no_show_reports` | `resolve` | `medium` | `trust_safety_admin`, `super_admin` |
| `cancellation_policy` | `read` | `low` | `operations_admin`, `super_admin` |
| `cancellation_policy` | `configure` | `medium` | `operations_admin`, `super_admin` |

**`resolve` is `medium`, not `high` — deliberately.** Spec 009 routes `low`/`medium` straight through
and `high`/`critical` into the `AdminAction` two-admin approval flow. A no-show resolution is
consequential but not open-ended: the admin picks an **outcome from a closed set**, never an amount;
the financial consequence is computed by this spec from the booking's snapshotted policy version; and
every resolution is attributed and audited. Requiring a second admin for each would stall ordinary
Trust & Safety work and would invent an approval requirement master spec §70 does not state (§70
reserves second-admin approval for high-risk actions "where appropriate"). Where money genuinely
leaves the platform outside policy, spec 022's `refunds/override` remains `high` and unchanged — and
this spec adds no route through which an admin can move an amount of their own choosing.

Resolution outcomes — a closed set, each with a defined consequence:

| `outcome` | Consequence |
|---|---|
| `no_show_confirmed_customer` | Booking → `cancelled` (`actorRole: 'admin'`); consequence computed at the snapshotted policy's `hoursBefore ≤ 0` tier (the platform default's 100%) so the provider is not left uncompensated; verified-no-show fact attributed to the **customer** |
| `no_show_confirmed_provider` | Booking → `cancelled` (`actorRole: 'admin'`); consequence is a **full refund regardless of tier** — a customer must never pay a timing fee for a provider's absence; verified-no-show fact attributed to the **provider** |
| `no_fault` | Booking → `cancelled`, full refund; **no** verified-no-show fact |
| `inconclusive` | No booking transition, no financial consequence, no fact. The report closes as `resolved`; either party may pursue spec 031 |
| `escalated_to_dispute` | No consequence here. The report closes as `resolved` with `escalated = true`; spec 031 owns everything after this point, and this spec creates **no** dispute row and no `→ disputed` transition |

Concurrency: the resolution is a conditional
`UPDATE no_show_reports SET ... WHERE id = $1 AND status = 'under_review'` inside a transaction
holding the booking-row lock; a second resolver's update affects zero rows and receives
`409 NO_SHOW_REPORT_ALREADY_RESOLVED`. Every resolution writes a spec 009 audit event via
`recordAdminAuditEvent()` naming the admin, report, booking, outcome and the required reason.
A resolution attempted while the report is still `awaiting_response` (and the window has not elapsed)
is `422 NO_SHOW_RESPONSE_REQUIRED` — the database-level expression of AC-5.

### Reliability signal (AC-6)

The draft attributed the reliability factor to spec 016. **That is wrong**: spec 016 owns availability
and service areas; the `reliability` ranking factor is spec 017's (`lib/types/matching.ts`'s
`RANKING_FACTORS`, weight 10 in `DEFAULT_MATCHING_WEIGHTS`, and `reliability: null` in
`lib/matching/run.ts`'s `buildFactorInputs`). This spec therefore feeds **017**.

- **Only a resolved report with `outcome IN ('no_show_confirmed_customer','no_show_confirmed_provider')`
  counts.** `reported`, `awaiting_response`, `under_review`, `withdrawn`, `no_fault`, `inconclusive`
  and `escalated_to_dispute` produce nothing.
- **Direction.** The fact is attributed to the party found at fault, never to the reporter. Recording
  is **symmetric** (both customer- and provider-attributed facts are stored, with `subject_role`);
  consumption is asymmetric only because spec 017 ranks providers, so today only provider-attributed
  facts have a consumer. Customer-attributed facts are recorded for Trust & Safety and a future
  customer-side signal, and are read through the same function.
- **Exactly once.** `no_show_reports_booking_fault_uq` — `UNIQUE (booking_id) WHERE outcome IN (…)` —
  makes a second fault-bearing resolution for one booking impossible, so mutual reports can never
  double-count and a duplicated report cannot inflate a count.
- **The seam.** `lib/no-show/reliability.ts` exports
  `countVerifiedNoShows(tx, { subjectRole, subjectProfileId, since? }): Promise<number>` — a read over
  resolved reports that spec 017 calls from `buildFactorInputs` if and when it activates the factor —
  plus a `NoShowReliabilitySink` port with an inert default for prompt reaction. **The rows are the
  record; the port is a latency optimisation.** This spec computes no score, sets no weight and imports
  nothing from `lib/matching/**`: the dependency direction is 017 → 023. Spec 017's current definition
  of `reliability` (accept/decline rate and response latency from `request_provider_matches`) is
  untouched by this spec — widening that factor to include verified no-shows is **spec 017's** change
  to make, and this spec neither performs nor presumes it.
- **No automatic ban** (master spec §132.11). Nothing here suspends, restricts, deactivates or de-ranks
  an account. `lib/no-show/no-auto-ban.test.ts` asserts that no module under `lib/no-show/**` writes any
  user or provider lifecycle status.

### Configuration ownership (resolves the draft's spec 041 circularity)

**Spec 023 owns the policy data, its validation and its API.** Spec 041 owns only the later admin
*configuration UI/surface*. The core system is therefore executable without spec 041: the migration
seeds the platform default, and `GET`/`POST /api/v1/admin/cancellation-policies` are the minimum seam
an admin needs today to read and publish a version. Spec 041 will render that seam, not own it, and
this spec depends on nothing spec 041 must ship first — so there is no circular dependency.

### Notifications

Spec 026 owns notification infrastructure and has not shipped; `notifications` is still a spec 003
skeleton. This spec ships a **port with an inert default** — the idiom specs 020/021/022 established —
emitted **fire-and-forget after commit**, so a notification failure can never roll back a cancellation
or a resolution:

```typescript
// lib/cancellation/notifications.ts
export type CancellationNotificationEvent =
  | { kind: 'booking_cancelled'; bookingId: string; recipientUserId: string; feeAmountMinorUnits: number; refundAmountMinorUnits: number; currencyCode: string }
  | { kind: 'no_show_reported'; reportId: string; bookingId: string; recipientUserId: string }
  | { kind: 'no_show_response_requested'; reportId: string; recipientUserId: string; respondByAt: string }
  | { kind: 'no_show_resolved'; reportId: string; recipientUserId: string; outcome: NoShowOutcome };

export type CancellationNotificationSink = (event: CancellationNotificationEvent) => Promise<void>;
```

The default is a no-op that logs a structured line. Spec 015's existing
`notifyProvidersOfCancellation()` is untouched — it covers *request* cancellation before provider
selection, a different object entirely. Refund-specific events stay spec 022's.

### Endpoints

Repository conventions: `app/api/v1/**/route.ts`; `withApiRoute` forwards no route context, so an
`{id}` route reads its parameter from the URL (`app/api/v1/bookings/booking-id.ts`); guard order is
normative — **session → CSRF → active mode / admin permission → rate limit → `Idempotency-Key`**.

| Method | Route | Auth / mode | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/services/{id}/cancellation-policy` | none (guest-readable, like the service page) | `200 ApiResponse<CancellationPolicyDto>` | effective policy for the service as of now; rate-limit `bookings`, keyed by user id or client IP for guests |
| `GET` | `/api/v1/bookings/{id}/cancellation-policy` | session, either participant in their own mode | `200 ApiResponse<CancellationPolicyDto>` | **the snapshotted version** for this booking — what AC-1's "before paying" guarantee actually rests on. **Added**: the draft had no booking-scoped read, so a customer could only ever see a re-resolution of current configuration |
| `GET` | `/api/v1/bookings/{id}/cancel-preview` | session, either participant | `200 ApiResponse<CancellationConsequenceDto>` | read-only dry run, the spec 015 pattern. No CSRF (a GET changes nothing); rate-limit `bookings`. **Added**: master spec §38 requires the consequence be shown before confirmation |
| `POST` | `/api/v1/bookings/{id}/cancel` | session, either participant in their own mode | `200 ApiResponse<CancellationDto>` (also `200` on idempotent replay) | CSRF; `Idempotency-Key`; rate-limit `bookings`; body carries at most `{ reasonCode?, note? }` — **never** an amount, tier or timestamp |
| `POST` | `/api/v1/bookings/{id}/report-no-show` | session, either participant | `201 ApiResponse<NoShowReportDto>` | CSRF; `Idempotency-Key`; rate-limit `bookings` |
| `GET` | `/api/v1/bookings/{id}/no-show-reports` | session, either participant | `200 ApiResponse<NoShowReportDto[]>` | each party's own view (§3 "Evidence"). **Added**: without it neither party can see a report's state |
| `POST` | `/api/v1/no-show-reports/{id}/respond` | session, the **other** party | `200 ApiResponse<NoShowReportDto>` | CSRF; rate-limit `bookings`. Naturally single-shot — a second response is `409 NO_SHOW_RESPONSE_ALREADY_FILED` — so no `Idempotency-Key` is required |
| `POST` | `/api/v1/no-show-reports/{id}/withdraw` | session, the reporter, while `awaiting_response` | `200 ApiResponse<NoShowReportDto>` | CSRF. **Added**: the state machine has a `withdrawn` state and a mistaken report must be retractable before it consumes the other party's time |
| `GET` | `/api/v1/admin/no-show-reports` | admin holding `no_show_reports/read` | `200 PagedResponse<AdminNoShowReportDto>` | spec 004's `parsePageParams`/`buildPage`; filterable by `status` and `outcome` |
| `GET` | `/api/v1/admin/no-show-reports/{id}` | admin holding `no_show_reports/read` | `200 ApiResponse<AdminNoShowReportDto>` | the full evidence bundle for review |
| `POST` | `/api/v1/admin/no-show-reports/{id}/resolve` | admin holding `no_show_reports/resolve` | `200 ApiResponse<AdminNoShowReportDto>` | CSRF; `reason` required; `outcome` from the closed set |
| `GET` | `/api/v1/admin/cancellation-policies` | admin holding `cancellation_policy/read` | `200 ApiResponse<AdminCancellationPolicyDto[]>` | every scope with its current and historical versions |
| `POST` | `/api/v1/admin/cancellation-policies` | admin holding `cancellation_policy/configure` | `201 ApiResponse<AdminCancellationPolicyDto>` | publishes a **new immutable version** for a scope (creating the `policies` row if absent). Never edits a version in place |
| `PUT` | `/api/v1/providers/me/services/{id}/cancellation-option` | session, `provider` mode, the caller's own `provider_services` row | `200 ApiResponse<{ optionKey: string \| null }>` | CSRF; the only provider-facing policy write, constrained to `allowedOptions[].key`. Path follows the existing `app/api/v1/providers/me` convention |
| `GET` | `/api/v1/cron/no-show-response-sweep` | `Bearer ${CRON_SECRET}` | `200` | not a browser route: no session, no CSRF, no rate limit |

**Validation order and failure semantics.** On every participant route: session → CSRF → active mode →
rate limit → `Idempotency-Key` → **then** load the booking and check participation → **then** state
eligibility → **then** policy resolution → **then** the financial computation. A caller who is not a
participant on the booking, and any caller addressing an id that does not exist, receives
`404 BOOKING_NOT_FOUND` / `404 NO_SHOW_REPORT_NOT_FOUND`, never `403`, so ids cannot be probed by
observing a different status. `403 FORBIDDEN` is reserved for a participant in the **wrong active
mode** and for an admin lacking a permission on a non-id-bearing route.

### Request and response types

All types live in `lib/types/cancellation.ts` and `lib/types/no-show.ts`. **This repository has no
`packages/types`** — the draft's path is wrong; `lib/types/*` is the convention specs
012/015/016/017/020/021/022 follow.

```typescript
// lib/types/cancellation.ts
export const POLICY_SOURCES = ['platform_default', 'category_override', 'service_override'] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

export interface CancellationTier {
  /** Inclusive lower bound in hours before the scheduled time; null = unbounded (at/after it). */
  minHoursBefore: number | null;
  /** Exclusive upper bound; null = unbounded (arbitrarily far ahead). */
  maxHoursBefore: number | null;
  /** Integer 0–100. */
  feePercent: number;
}

export interface CancellationPolicyDto {
  policyVersionId: string;
  source: PolicySource;
  providerOptionKey: string | null;
  tiers: CancellationTier[];
  /** Booking-scoped read only: the instant the snapshot resolved as of. */
  snapshotAsOf?: string;
}

export interface CancellationDto {
  id: string;
  bookingId: string;
  cancelledByRole: 'customer' | 'provider' | 'admin';
  reasonCode: string | null;
  policyVersionId: string;
  tier: CancellationTier;
  capturedAmountMinorUnits: number;
  feeAmountMinorUnits: number;
  refundAmountMinorUnits: number;
  currencyCode: string;
  bookingStatus: 'cancelled';
  createdAt: string;
  version: number;
}

/** POST /bookings/{id}/cancel — deliberately has NO amount, tier or timestamp field. */
export interface CancelBookingRequest {
  /** From a closed list; free text is never the recorded reason. */
  reasonCode?: string;
  /** The customer's own words. Never used in the computation. */
  note?: string;
}
```

```typescript
// lib/types/no-show.ts
export const NO_SHOW_STATUSES = ['reported', 'awaiting_response', 'under_review', 'resolved', 'withdrawn'] as const;
export type NoShowStatus = (typeof NO_SHOW_STATUSES)[number];

export const NO_SHOW_OUTCOMES = [
  'no_show_confirmed_customer',
  'no_show_confirmed_provider',
  'no_fault',
  'inconclusive',
  'escalated_to_dispute',
] as const;
export type NoShowOutcome = (typeof NO_SHOW_OUTCOMES)[number];

export const NO_SHOW_LOCATION_SIGNALS = [
  'address_within_service_area',
  'address_outside_service_area',
  'unavailable',
] as const;
export type NoShowLocationSignal = (typeof NO_SHOW_LOCATION_SIGNALS)[number];

/** The participant view. Carries NO other party's statement and NO admin note. */
export interface NoShowReportDto {
  id: string;
  bookingId: string;
  reporterRole: 'customer' | 'provider';
  /** True when the caller filed this report. */
  isOwnReport: boolean;
  status: NoShowStatus;
  respondByAt: string | null;
  responseFiled: boolean;
  responseFiledAt: string | null;
  outcome: NoShowOutcome | null;
  resolvedAt: string | null;
  createdAt: string;
  version: number;
}

/** The Trust & Safety view. Never served from a participant route. */
export interface AdminNoShowReportDto extends Omit<NoShowReportDto, 'isOwnReport'> {
  reporterStatement: string | null;
  responseStatement: string | null;
  responseStatus: 'pending' | 'filed' | 'no_response';
  locationSignal: NoShowLocationSignal;
  evidence: {
    scheduledAt: string;
    minutesAfterScheduled: number;
    reachedProviderEnRouteAt: string | null;
    reachedArrivedAt: string | null;
    reachedInProgressAt: string | null;
    statusHistory: Array<{ toStatus: string; actorRole: 'customer' | 'provider' | 'system'; occurredAt: string }>;
    communications: { available: boolean; messageCount?: number; lastMessageAt?: string };
  };
  resolutionReason: string | null;
  resolvedByAdminId: string | null;
  counterpartReportId: string | null;
}
```

### Error codes

None belongs in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status` explicitly —
the pattern specs 005/016/020/021/022 follow. Codes owned by an earlier spec are **re-exported, never
redefined**.

| HTTP | `code` | When |
|---|---|---|
| `404` | `BOOKING_NOT_FOUND` | re-exported from `lib/bookings/errors.ts` — no such booking, or the caller is not a participant (deliberately indistinguishable) |
| `404` | `NO_SHOW_REPORT_NOT_FOUND` | no such report, or the caller is neither party nor an authorized admin |
| `422` | `BOOKING_NOT_CANCELLABLE` | the booking's status is outside the cancellable set; `details.status` carries the current status |
| `422` | `BOOKING_ALREADY_CANCELLED` | a second cancellation that is not an idempotent replay |
| `409` | `INVALID_STATUS_TRANSITION` | re-exported from `lib/bookings/errors.ts` — the status moved under the lock, or the spec 003 trigger rejected the pair |
| `409` | `CONFLICT` | stale `version` on the booking (spec 003 AC-6) |
| `422` | `CANCELLATION_POLICY_UNAVAILABLE` | no resolvable, valid policy version — including a stored config that fails validation. **Never a default-allow**; no cancellation is processed |
| `422` | `POLICY_OPTION_NOT_ALLOWED` | a provider option key outside the effective version's `allowedOptions` |
| `422` | `POLICY_CONFIG_INVALID` | an admin publish whose config fails `validateCancellationPolicyConfig`, with `errors[]` naming each field |
| `409` | `POLICY_VERSION_OVERLAP` | a publish whose validity interval overlaps an existing version for the same scope |
| `422` | `CANCELLATION_CONSEQUENCE_UNAVAILABLE` | no captured amount to compute against — structurally unreachable from the cancellable states; a defensive code, never a guess |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | re-exported from `lib/requests/errors.ts` — same key, different fingerprint |
| `409` | `NO_SHOW_REPORT_ALREADY_EXISTS` | duplicate report by the same reporter on the same booking |
| `422` | `NO_SHOW_REPORT_WINDOW_CLOSED` | filed before the open time or after the close time, or the booking is in a status from which a no-show is not reportable |
| `403` | `NO_SHOW_SELF_ACTION_NOT_ALLOWED` | the reporter attempting to respond to or resolve their own report |
| `409` | `NO_SHOW_RESPONSE_ALREADY_FILED` | a second response by the other party |
| `422` | `NO_SHOW_RESPONSE_REQUIRED` | a resolution attempted while the report is still `awaiting_response` and the window has not elapsed |
| `409` | `NO_SHOW_REPORT_ALREADY_RESOLVED` | a second resolution, or a withdrawal attempted after `under_review` |
| `422` | `NO_SHOW_OUTCOME_INVALID` | an outcome outside the closed set, or a missing resolution reason |
| `409` | `NO_SHOW_FAULT_ALREADY_RECORDED` | a fault-bearing resolution when the counterpart report already carries fault for this booking |
| `403` | `FORBIDDEN` | wrong active mode, or an admin lacking `no_show_reports/*` / `cancellation_policy/*` |
| `429` | `RATE_LIMITED` | spec 004's existing code, `bookings` domain |

### OpenAPI

Every route above except the cron route is added to `OPENAPI_ROUTES` in
`lib/api/openapi-registry.ts` in the same change — tagged `cancellation` (policy, preview, cancel) or
`no-show` — or `npm run check:openapi-drift` fails. Cron routes are excluded from the drift check, as
the existing cron routes already are. Paths use the OpenAPI `{id}` form matching the directory name
exactly. The pre-existing spec 010 `{id}` vs `{categoryId}` drift is **not** touched by this spec.

### Breaking-change check

- [x] New routes; new columns on empty spec 003 baseline tables; two new tables; one nullable column on
      `provider_services`; one baseline index replaced (`policy_acceptances_policy_version_user_uq` →
      `policy_acceptances_booking_uq`, §4) on a table that has never held a row.
- [x] No shipped API contract changes. Spec 022's `RefundEligibilityGate` is *registered*, not modified.

---

## 4. Data model changes

`policies`, `policy_versions` and `policy_acceptances` **already exist** as spec 003 baseline
skeletons with their FKs and indexes. This spec **alters** them and adds the no-show tables.
`0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.
`baseColumns()` already supplies `id`, `created_at`, `updated_at` and `version`, so those are not
listed as additions. Money follows spec 003 AC-1's `<base>_amount_minor_units` +
`<base>_currency_code` convention via `moneyColumns()`.

### Entities

| Entity | Change | Columns added |
|---|---|---|
| `policies` | **alter** (baseline: audit only) | `type text not null` (`'cancellation'`), `scope text not null` (`'platform'\|'category'\|'service'`), `scope_id uuid null`, `is_active boolean not null default true` |
| `policy_versions` | **alter** (baseline: `policy_id`) | `config jsonb not null`, `effective_from timestamptz not null`, `effective_to timestamptz null`, `created_by_admin_id uuid null fk->admin_profiles restrict`, `note text null` |
| `policy_acceptances` | **alter** (baseline: `policy_version_id`, `user_id`) | `booking_id uuid not null fk->bookings restrict`, `accepted_config jsonb not null`, `provider_option_key text null`, `source text not null`, `booking_created_at timestamptz not null`, `accepted_at timestamptz not null default now()` |
| `booking_cancellations` | **new** | `id`, audit, `version`, `booking_id uuid not null fk->bookings restrict`, `policy_version_id uuid not null fk->policy_versions restrict`, `cancelled_by_user_id uuid null fk->users restrict`, `cancelled_by_role text not null`, `reason_code text null`, `note text null`, `tier_min_hours_before integer null`, `tier_max_hours_before integer null`, `tier_fee_percent integer not null`, `hours_before_milli integer not null`, `captured_amount_minor_units integer not null`, `fee_amount_minor_units integer not null`, `refund_amount_minor_units integer not null`, `currency_code text not null`, `decision_ref text not null`, `no_show_report_id uuid null fk->no_show_reports restrict`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `no_show_reports` | **new** | `id`, audit, `version`, `booking_id uuid not null fk->bookings restrict`, `reporter_user_id uuid not null fk->users restrict`, `reporter_role text not null`, `status text not null`, `reporter_statement text null`, `evidence jsonb not null`, `location_signal text not null`, `respond_by_at timestamptz not null`, `response_status text not null default 'pending'`, `response_statement text null`, `response_filed_at timestamptz null`, `outcome text null`, `resolution_reason text null`, `resolved_by_admin_id uuid null fk->admin_profiles restrict`, `resolved_at timestamptz null`, `counterpart_report_id uuid null fk->no_show_reports restrict`, `escalated boolean not null default false`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `no_show_reports_status_history` | **new** | `id`, audit, `version`, `no_show_report_id uuid not null fk->no_show_reports restrict`, `from_status text null`, `to_status text not null`, `actor_user_id uuid null fk->users restrict`, `actor_role text not null`, `detail text null`, `occurred_at timestamptz not null default now()` |
| `no_show_reports_status_transitions` | **new** | `id`, audit, `version`, `from_status text not null`, `to_status text not null`, unique `(from_status, to_status)` — the lookup table spec 003's **existing** `enforce_status_transition()` derives by name |
| `provider_services` | **alter** | `cancellation_policy_option text null` — the provider's selected option key (AC-4). Nullable: no selection is the normal case |
| `bookings_status_transitions` | **seed only** | `('confirmed','cancelled')`, `('provider_en_route','cancelled')`, `('arrived','cancelled')` — the rows spec 020 §3 reserved for this spec |
| `permissions` | **seed only** | the four rows in §3 "Admin resolution" |
| `policy_versions` | **seed only** | the platform-default cancellation policy (§4 "Migration") |

**Deliberately not stored** (avoiding redundancy with rows that already hold the fact): the booking's
scheduled time, its price, its status history, the payment's captured amount, and any refund state.
`booking_cancellations` stores the **computed** consequence (which is a decision, not a copy) plus the
inputs needed to audit it; everything else is read from `bookings`, `bookings_status_history`,
`payment_authorizations` and `refunds` by join. `no_show_reports.evidence` is a *snapshot at report
time* of history that is itself append-only — it is retained because the retention sweep may later
null it while the underlying history persists, and because an admin must see what the reporter saw.

`hours_before_milli` stores `hoursBefore × 1000` as an integer, so the audited timing carries
sub-second fidelity without a float anywhere (spec 003 AC-1 forbids `numeric`/`real`/`double
precision`, and `lib/db/schema-lint.test.ts` enforces it).

### The baseline `policy_acceptances` uniqueness defect

The spec 003 baseline ships `policy_acceptances_policy_version_user_uq UNIQUE (policy_version_id, user_id)`.
Left in place, a customer could accept a given policy version for **one booking only** — their second
booking under the same unchanged policy would violate it. The correct grain is one acceptance per
booking, so `0019` **drops** that index and creates `policy_acceptances_booking_uq UNIQUE (booking_id)`,
plus a non-unique `policy_acceptances_user_id_idx` (already present) and
`policy_acceptances_policy_version_id_idx` (already present) for the read paths. This is safe and
non-breaking: the table has never held a row (the migration's precondition guard asserts it) and no
code anywhere references the dropped index.

### No-show status machine

`no_show_reports_status_ck`: `status in ('reported','awaiting_response','under_review','resolved','withdrawn')`.
Seeded into `no_show_reports_status_transitions`, and **only** these:

```
reported          → awaiting_response
awaiting_response → under_review
awaiting_response → withdrawn
under_review      → resolved
```

`resolved` and `withdrawn` have no outgoing transition: a resolved report is never reopened *in this
spec* — the escalation path is spec 031, which owns what happens next. `no_show_reports_status_transition_trg`
attaches spec 003's **existing** `enforce_status_transition()` function; no new trigger function is
written.

### Constraints and invariants

| # | Constraint | Why |
|---|---|---|
| C-1 | `policies_scope_ck`: `scope in ('platform','category','service')`, and `(scope = 'platform') = (scope_id is null)` | a platform policy has no target; a scoped one always does |
| C-2 | `policies_scope_uq` unique on `(type, scope, scope_id)` where `is_active`, plus a partial unique index allowing at most one active platform policy per `type` | one active policy per scope — resolution can never face a tie |
| C-3 | `policy_versions_no_overlap_ex`: `EXCLUDE USING gist (policy_id WITH =, tstzrange(effective_from, effective_to) WITH &&)` (requires `btree_gist`) | "multiple active versions" is impossible rather than merely discouraged |
| C-4 | `policy_versions_interval_ck`: `effective_to is null or effective_to > effective_from` | no inverted or empty interval |
| C-5 | `policy_versions_config_ck`: `jsonb_typeof(config) = 'object' and jsonb_typeof(config->'tiers') = 'array' and jsonb_array_length(config->'tiers') > 0` | a structural floor at the database; the full grammar is `validateCancellationPolicyConfig` (spec 017's `matching_weights` precedent) |
| C-6 | `policy_versions_immutable_trg` | a published version is never edited — a change is a new version. Only `effective_to` may be updated, and only from `null` to a value |
| C-7 | `policy_acceptances_booking_uq` unique on `(booking_id)` | one snapshot per booking; the race-loser replays the winner |
| C-8 | `policy_acceptances_immutable_trg` | a snapshot is never rewritten, which is the whole point of AC-1 |
| C-9 | `booking_cancellations_booking_uq` unique on `(booking_id)` | one cancellation per booking, independent of the application check |
| C-10 | `booking_cancellations_idempotency_uq` unique on `(booking_id, idempotency_key)` | AC-8 |
| C-11 | `booking_cancellations_amounts_ck`: `captured_amount_minor_units >= 0`, `fee_amount_minor_units between 0 and captured_amount_minor_units`, `refund_amount_minor_units = captured_amount_minor_units - fee_amount_minor_units` | the fee can never exceed what was captured, and the two halves always reconcile — at the database, not only in code |
| C-12 | `booking_cancellations_fee_percent_ck`: `tier_fee_percent between 0 and 100`; `booking_cancellations_currency_format_ck`: `^[A-Z]{3}$`; `booking_cancellations_role_ck`: `cancelled_by_role in ('customer','provider','admin')`; `booking_cancellations_actor_pairing_ck`: `cancelled_by_user_id is not null` | closed vocabularies; every cancellation has a human actor |
| C-13 | `booking_cancellations_immutable_trg` | a recorded consequence is a financial record — append-only |
| C-14 | `no_show_reports_booking_reporter_uq` unique on `(booking_id, reporter_role)` | one report per party per booking |
| C-15 | `no_show_reports_idempotency_uq` unique on `(booking_id, idempotency_key)` | AC-8 |
| C-16 | `no_show_reports_booking_fault_uq`: `UNIQUE (booking_id) WHERE outcome IN ('no_show_confirmed_customer','no_show_confirmed_provider')` | AC-6 "exactly once" — a second fault finding for one booking is impossible |
| C-17 | `no_show_reports_status_ck`, `no_show_reports_outcome_ck`, `no_show_reports_location_signal_ck`, `no_show_reports_response_status_ck`, `no_show_reports_reporter_role_ck` | closed vocabularies at the database |
| C-18 | `no_show_reports_resolution_pairing_ck`: `(status = 'resolved') = (outcome is not null)` and `(outcome is null) = (resolved_at is null)` and `(outcome is null) = (resolved_by_admin_id is null)` and `(outcome is not null) = (resolution_reason is not null)` | a resolution always has an outcome, an instant, a named admin and a reason (master spec §68) |
| C-19 | `no_show_reports_response_pairing_ck`: `(response_status = 'filed') = (response_filed_at is not null)` | |
| C-20 | `no_show_reports_evidence_immutable_trg` (evidence/statement columns immutable except a `NULL`-ing retention write) and `no_show_reports_status_history_append_only_trg` | AC-10 |
| C-21 | `no_show_reports_counterpart_ck`: `counterpart_report_id is null or counterpart_report_id <> id` | a report is never its own counterpart |
| C-22 | Indexes: `policy_versions_policy_effective_idx` on `(policy_id, effective_from desc)`, `policies_scope_idx` on `(type, scope, scope_id)`, `policy_acceptances_booking_idx`, `booking_cancellations_booking_id_idx`, `no_show_reports_booking_id_idx`, `no_show_reports_status_idx`, `no_show_reports_respond_by_idx` on `(status, respond_by_at)` — the sweep's access path — `no_show_reports_outcome_idx` on `(outcome, resolved_at)` — the AC-6 read path — and `no_show_reports_status_history_report_id_idx` | resolution, the sweep, the reliability read and the admin queue |

### Migration

- **Name:** `0019_add_cancellation_policy_no_show.sql`, with a hand-written
  `0019_add_cancellation_policy_no_show_down.sql` — the repository's convention (`0012`–`0017` all
  follow it; drizzle-kit generates no down migration, and the down file carries no `_journal.json`
  entry so `npm run db:migrate` never applies it).
  **Determined from the repository, not from the draft** (whose `AddCancellationPolicyNoShowTables`
  name matches no convention here): spec 022 landed `0018_add_refunds` and is
  `drizzle/meta/_journal.json`'s head, so `0019` is the next number.
- **Precondition guard:** a `DO $$ ... RAISE EXCEPTION` unless `policies`, `policy_versions` and
  `policy_acceptances` are empty — the same guard `0016`/`0017` use, and what makes `NOT NULL` columns
  without defaults safe to add directly and the baseline index swap safe.
- **Extension:** `CREATE EXTENSION IF NOT EXISTS btree_gist` for C-3. If the deployment target cannot
  grant it, the fallback is a partial unique index on `(policy_id) WHERE effective_to IS NULL` (at most
  one open-ended version per policy) **plus** the domain-layer interval check — weaker, and recorded as
  such, never silently substituted.
- **Seed (deterministic).** Exactly one platform-default policy and one version:
  `policies` ← `('cancellation', 'platform', NULL, true)`;
  `policy_versions` ← that policy, `effective_from = '1970-01-01T00:00:00Z'` (so **every** existing and
  future booking resolves to it — no booking is ever left unpriceable by a seed that starts "now"),
  `effective_to = NULL`, `created_by_admin_id = NULL` (a platform seed has no admin author), and
  `config` = the exact T1–T4 ladder in §3 "The platform default" with `allowedOptions: []`. No category
  or service override is seeded: an override must always be a deliberate admin act.
- **Reversible:** yes. The down migration drops only what `0019` added, restores
  `policy_acceptances_policy_version_user_uq`, deletes only the `bookings_status_transitions`,
  `permissions` and policy rows `0019` inserted, and touches no other table. It is gated on
  `booking_cancellations` and `no_show_reports` being empty — see §9 for why that gate matters.
- **Backfill required:** no (all three policy tables are empty; `provider_services.cancellation_policy_option`
  is nullable).
- **Downtime:** none. Every added column is nullable or has a default, the index swap is on an empty
  table, and no existing query plan depends on the dropped index. **Verified against this repository's
  migration mechanism** (`lib/db/migrate.ts`, sequential and transactional), not assumed.
- **Reviewed SQL:** hand-reviewed in PR; `npm run check:schema-baseline` must pass.

### Retention and privacy

- **Retention (spec 008).** `policy_acceptances`, `booking_cancellations` and the resolved
  `no_show_reports` skeleton (identity, booking, status, outcome, resolving admin, timestamps) are
  records of a financial consequence and are **retained** regardless of account deletion, under spec
  008's existing rule — every FK here is `restrict`, so `lib/privacy/deletion.ts` retains them keyed to
  the now-anonymized user exactly as it already does for `Payment`/`Refund`. No new retention mechanism
  is introduced.
- **Evidence minimisation (AC-10).** `no_show_reports.evidence`, `location_signal`,
  `reporter_statement` and `response_statement` are nulled `NO_SHOW_EVIDENCE_RETENTION_DAYS` (default
  180) after `resolved_at` by a step added to spec 008's **existing** privacy sweep. No raw coordinate
  is ever written to these tables — the only location datum is a three-valued enum derived from data
  both parties already supplied.
- **Export boundary (spec 008).** `lib/privacy/export.ts` gains, for the caller's own bookings: the
  cancellation's `feeAmountMinorUnits`, `refundAmountMinorUnits`, `currencyCode`, `tierFeePercent`,
  `reasonCode` and `createdAt`; the acceptance's `policyVersionId`, `acceptedConfig` and `acceptedAt`;
  and for each no-show report the caller is a party to: `id`, `bookingId`, `reporterRole`, `status`,
  `outcome`, `createdAt`, `resolvedAt`, plus **their own** statement. **Never exported:** the other
  party's statement, the `evidence` bundle, `location_signal`, `resolution_reason`,
  `resolved_by_admin_id`, `idempotency_key`, `idempotency_fingerprint`, `decision_ref` and
  `counterpart_report_id` — the other party's private evidence and internal/admin detail.
- **Admin visibility.** The full evidence bundle is reachable only through the two
  `no_show_reports/read`-gated admin routes, and every read of it is an ordinary spec 009 admin route
  subject to that spec's audit conventions.

---

## 5. UI states

**There is no WebSocket layer in this repository** — specs 018, 019, 020 and 022 all say so, and the
booking screens poll (`BOOKING_POLL_MS = 10_000` in `app/bookings/booking-client.ts`, refetching on
that cadence and on window focus). Nothing here introduces a realtime mechanism; a report awaiting
response or under review is refreshed by that same existing polling.

**Design system.** Every screen is composed from existing primitives imported from `@/components` —
`Card`, `Badge`, `Button`, `ConfirmDialog`, `Table`, `FormField`, `Input`, `Select`, `Alert`,
`EmptyState`, `ErrorState`, `Skeleton`, `PriceDisplay` — with tokens from
`app/styles/apuriva-tokens.css`. **The draft's `packages/ui` path and its new `PolicyDisplay`
component are removed**: neither exists, and the policy table is a `Card` + `Table` composition, not a
new primitive. No token, no `ui/` file and no entry in `components/index.ts` is added or changed; no
existing screen is visually redesigned; no brand mark is added — the nav shell already provides the one
intentional placement.

### Customer

Policy and cancellation live on the existing booking routes; no new customer route is added except the
report/response screen.

| Surface | State | Behaviour |
|---|---|---|
| `app/explore/[category]/[service]` (existing service detail page) | Loading / Success | the effective policy tiers render as a small table in the existing service detail layout, before any booking action |
| `app/bookings/[id]/payment` (existing, spec 021) | Success | the **snapshotted** policy is shown on the payment screen before the customer authorizes — AC-1's "sees the policy before paying" |
| `app/bookings/[id]` (existing) | Loading | skeleton in the cancellation section while the preview loads |
| `app/bookings/[id]` | Success | a "Cancel booking" action, shown only for a cancellable status |
| `app/bookings/[id]/cancel` (new) | Success | the preview states the exact fee and exact refund in the booking's currency, the tier that applies and why, and the scheduled time in `scheduled_timezone`; `ConfirmDialog` requires an explicit confirmation naming both amounts. **Never** a surprise charge, and never a client-computed number |
| `app/bookings/[id]/cancel` | Error | `422 BOOKING_NOT_CANCELLABLE` / `BOOKING_ALREADY_CANCELLED` / `CANCELLATION_POLICY_UNAVAILABLE` each render a plain sentence saying what happened and what to do next — never a bare code, never a dead end |
| `app/bookings/[id]` | Empty | a booking with no cancellation and no report renders no extra section at all, not an empty-state card |

### No-show (both parties)

`app/bookings/[id]/no-show` (new) — report, respond and status, in one route whose content depends on
the caller's role and the report's state.

| State | Behaviour |
|---|---|
| **Report** | neutral framing ("Report that the other party did not attend"), an optional statement, and an explicit statement that the other party will be asked to respond and that a Trust & Safety reviewer decides the outcome |
| **Awaiting response** | "Waiting for a response — respond by {instant}". No verdict language, no fault attribution, no countdown pressure |
| **Under review** | "Under review by our team." Identical copy whichever party reported, and whether the response was filed or the window elapsed — §51's "do not automatically accuse", carried in the copy and not only in the backend |
| **Resolved** | the outcome in neutral terms plus any financial consequence in exact amounts; `escalated_to_dispute` points to spec 031's flow without pre-judging it |
| **Withdrawn** | stated plainly, with no residue on either party |
| **Error** | window closed, duplicate report, self-action — each a plain sentence |

The other party's statement is **never** rendered on a participant screen (AC-10).

### Admin (Trust & Safety)

`app/admin/actions/no-show-reports` (new page in the existing admin area; the existing
`app/admin/actions/review` page gains a link). Queue → detail, built from `Table`/`Card`/`Badge`.

| State | Behaviour |
|---|---|
| **Queue** | reports filterable by status and outcome, newest first, with `awaiting_response` visibly distinguished from `under_review` |
| **Detail** | the evidence bundle rendered as facts, never as a conclusion: timing, status history, attendance instants, communications availability, and the location enum **labelled as supporting context only** |
| **Resolution** | outcome from the closed set, a **required** reason, and a `ConfirmDialog` naming the exact financial consequence before submission |
| **Audit context** | the resolving admin, instant and reason are shown on an already-resolved report; a second resolution is not offered |

**Policy configuration has no screen in this spec.** The DATA and the API are this spec's and ship
here (`GET`/`POST /api/v1/admin/cancellation-policies`, §3 "Configuration ownership"); the admin
*surface* over them is spec 041's, and building a second one now would be exactly the duplication
that section sets out to avoid. The seeded platform default means nothing waits on it.

**Route(s):** `app/bookings/[id]` (cancellation-policy section and the two entry points added),
`app/bookings/[id]/payment` (snapshotted policy shown before authorization),
`app/bookings/[id]/cancel` (new), `app/bookings/[id]/no-show` (new),
`app/admin/actions/no-show-reports` (new).
`app/bookings/_components/CancellationPolicySection.tsx` is the one shared piece, used by both the
booking detail and payment screens.

---

## 6. Test plan

Vitest is the **only** runner (`npm test` → `vitest run`). There is no Playwright; `e2e/*.spec.ts` is a
Vitest pattern already configured in `vitest.config.ts` (`e2e/auth.spec.ts` and `e2e/payment.spec.ts`
exist), driving real route handlers against the isolated `*_test` database. **The draft's
`apps/api/**`, `apps/web-e2e/**` and `packages/types` paths do not exist here.** Integration tests live
beside their domain module in `lib/**`, the shape `lib/bookings/*.integration.test.ts` and
`lib/payments/*.integration.test.ts` established.

**These tests exist and pass** — 188 of them across the ten files named below.

| Level | What it covers | Where |
|---|---|---|
| **Unit — policy** | the exact seeded ladder, asserted literally and cross-checked against `0019`'s own JSON so code and migration cannot drift; config validation over every malformed shape (non-contiguous, non-exhaustive, out-of-range percent, decreasing ladder, duplicate/invalid option key, a bare percentage in place of a ladder) | `lib/cancellation/policy-config.test.ts` |
| **Unit — tiers and money** | tier selection at and around every boundary, including the exact instants a live clock cannot hold (24h, 12h, 0h); half-up rounding; the clamp; `fee + refund = captured` over many amounts; rejection of non-integer/negative inputs; the integer-scaled audited timing | `lib/cancellation/tiers.test.ts` |
| **Unit — no-show graph** | the transition matrix over every status pair; no transition out of a terminal state; review and resolution unreachable without passing through `awaiting_response` | `lib/no-show/no-auto-fault.test.ts` |
| **Source guard** | no module under `lib/cancellation/**` or `lib/no-show/**` writes `bookings.status` with its own SQL, writes a `refunds`/`payments`/`payouts` row, imports a payment-provider module, imports `lib/matching/**`, writes a user/provider lifecycle status, stores a coordinate, or hard-codes a fee percentage outside the seeded default; `lib/refunds/**` still contains no cancellation rule and `lib/bookings/**` imports nothing of this spec | `lib/cancellation/boundaries.test.ts` |
| **Source guard — no auto-accusation** | `outcome` is assigned in `resolution.ts` and nowhere else (and really is assigned there, so the guard cannot pass vacuously); the sweep never mentions an outcome, a booking transition or a refund; the resolution path never reads the location signal or the timing figures | `lib/no-show/no-auto-fault.test.ts` |
| **Source guard — no auto-ban** | no lifecycle write, no suspend/ban/deactivate/restrict call, no strike threshold, no score or weight arithmetic anywhere in the domain | `lib/no-show/no-auto-ban.test.ts` |
| **Integration — resolution and precedence** | platform default with no override; category beats platform; service beats both; an inactive override falls through; an override whose version does not cover the instant falls through; an invalid stored config is treated as absent; the exclusion constraint rejects an overlapping version | `lib/cancellation/cancellation.integration.test.ts` |
| **Integration — snapshot** | the acceptance materialises once per booking, resolved as of `bookings.created_at`; a later published version does not change an existing booking's terms or its enforced consequence; the snapshot is immutable at the database | `lib/cancellation/cancellation.integration.test.ts` |
| **Integration — boundaries on the live clock** | every tier end to end, a few seconds either side of each boundary, computed from the database clock after the row lock; the executed cancellation equals the preview; `fee + refund = captured` recorded at the database | `lib/cancellation/cancellation.integration.test.ts` |
| **Integration — cancellation and authorization** | customer and provider may each cancel, attributed correctly; `provider_en_route` and `arrived` are cancellable; `in_progress` and a fully refunded booking are not; a non-participant gets `404`, never `403`; a customer acting in provider mode is not treated as the provider; a second cancellation is refused; the preview reports a blocked booking rather than throwing | `lib/cancellation/cancellation.integration.test.ts` |
| **Integration — the spec 022 handoff** | the eligibility decision carries amount, currency, reason and decision ref; a free cancellation produces one completed FULL refund; a 25% tier produces a partial refund of the remainder; a 100% tier produces NO refund and an ineligible decision; the gate declines for a booking that was never cancelled; a fully refunded cancellation ends at `refunded` through spec 022's own transition | `lib/cancellation/cancellation.integration.test.ts` |
| **Integration — idempotency and concurrency** | the same key replays one cancellation and one refund; the same key with a different body is `409`; two concurrent cancellations admit exactly one; exactly one cancellation row per booking; a recorded cancellation rejects `UPDATE` and `DELETE`; exactly one `cancelled` history row, attributed to the acting party | `lib/cancellation/cancellation.integration.test.ts` |
| **Integration — provider options** | an allowed option applies; an option the policy does not publish is `422 POLICY_OPTION_NOT_ALLOWED`; a stale key falls back to the version's own tiers rather than failing a cancellation | `lib/cancellation/cancellation.integration.test.ts` |
| **Integration — no client-controlled money** | the domain ignores anything the caller says about money; at the route, a body carrying `feeAmountMinorUnits`, `refundAmountMinorUnits`, `feePercent`, `tier`, `hoursBefore`, `cancelledAt` or `policyVersionId` is rejected `400`, not silently ignored | `lib/cancellation/cancellation.integration.test.ts`, `lib/cancellation/routes.integration.test.ts` |
| **Integration — no-show flow** | a report changes nothing (no transition, no cancellation, no refund); both history steps are written; evidence is derived facts only and carries no coordinate; duplicate report `409`; an identical retry replays; both parties may report each other and the pair is linked; the reporting window is enforced at both ends; a stranger gets `404` | `lib/no-show/no-show.integration.test.ts` |
| **Integration — response and timeout** | the other party's response moves the report to `under_review` with still no consequence; the reporter gets `403` and a stranger `404`; a second response is `409`; withdrawal works while awaiting and is refused after; the sweep moves an unanswered report to `under_review`/`no_response` applying **no** consequence, attributes it to `system`, leaves a live window alone and is idempotent | `lib/no-show/no-show.integration.test.ts` |
| **Integration — Trust & Safety resolution** | resolution before the other party is heard is `422 NO_SHOW_RESPONSE_REQUIRED`; an admin without the permission is `403`; a reason and a known outcome are required; each outcome's defined consequence (customer no-show → no refund; provider no-show → full refund regardless of tier, with the overridden tier still recorded; inconclusive and escalation change nothing financial); a second resolution is `409`; two concurrent resolutions admit one; a spec 009 audit event names admin, outcome and reason; a second fault finding on the booking is `409` | `lib/no-show/no-show.integration.test.ts` |
| **Integration — reliability** | only a resolved confirmed outcome counts; attribution is to the faulted party and never the reporter or the other party; `no_fault` counts nothing; the signal is emitted exactly once; a throwing sink does not fail the resolution; repeated verified no-shows raise the count; no account's lifecycle status changes | `lib/no-show/no-show.integration.test.ts` |
| **Integration — privacy and retention** | a participant sees neither party's statement, no evidence, no location signal and no admin field, whichever party they are; Trust & Safety sees the full bundle; `isOwnReport` is marked correctly; the retention sweep nulls evidence and statements after the window while retaining outcome, resolving admin and reason; a recent resolution is untouched; evidence rejects rewriting; history rejects `UPDATE`/`DELETE` | `lib/no-show/no-show.integration.test.ts` |
| **API/authorization** | session, CSRF, `Idempotency-Key`, guest-readable service policy, booking-scoped snapshot, non-mutating preview, `201` on report creation, participant responses carrying no admin field, admin permission checks on the queue, policy publish including the refusal of a caller-chosen `effectiveFrom` and an invalid config | `lib/cancellation/routes.integration.test.ts` |
| **OpenAPI** | all fourteen new routes are registered and tagged `cancellation`/`no-show`, and the cron route is deliberately absent; `npm run check:openapi-drift` agrees | `lib/cancellation/routes.integration.test.ts` |
| **UI** | the cancel screen states the exact fee, refund and tier before confirmation; the dialog repeats both amounts and says it cannot be undone; the request body carries no amount and does carry an idempotency key; completion never claims "refunded" before the provider confirms; blocked and error states explain themselves; no-show copy is neutral in every state, identical whichever party reported, and never renders the other party's statement | `app/bookings/[id]/cancel/page.test.tsx`, `app/bookings/[id]/no-show/page.test.tsx` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/cancellation/cancellation.integration.test.ts::materialises one snapshot per booking, resolved as of the booking's creation`; `::a later policy change does NOT alter an existing booking's terms`; `::is immutable at the database`; `lib/cancellation/routes.integration.test.ts::serves the booking-scoped snapshot to a participant`; `::serves the service policy to a guest` |
| AC-2 | `lib/cancellation/tiers.test.ts::exactly 24 hours before is the 0% tier`; `::more than 24 hours before is the 0% tier`; `lib/cancellation/cancellation.integration.test.ts::charges 0% ten seconds beyond 24 hours`; `::a free cancellation produces a completed FULL refund through spec 022` |
| AC-3 | `lib/cancellation/tiers.test.ts::exactly 12 hours before is the 25% tier`; `::exactly at the scheduled time is the 100% tier`; `::rounds half up on an amount that does not divide cleanly`; `lib/cancellation/cancellation.integration.test.ts::charges 25%/50%/100% …` (eight boundary cases); `::ignores everything the caller says about money`; `lib/cancellation/routes.integration.test.ts::rejects a client-supplied fee, tier or timestamp outright` |
| AC-4 | `lib/cancellation/cancellation.integration.test.ts::a service override beats both the category override and the platform default`; `::a category override beats the platform default`; `::an INACTIVE override is treated as absent and falls through`; `::applies an option the effective version publishes`; `::refuses an option the policy does not allow` |
| AC-5 | `lib/no-show/no-show.integration.test.ts::creates a report awaiting the other party, with no consequence of any kind`; `::refuses to resolve before the other party has been heard`; `::moves an unanswered report to under_review with no consequence at all`; `::gathers evidence made only of derived facts — and never a coordinate`; `lib/no-show/no-auto-fault.test.ts::never branches on the location signal when resolving` |
| AC-6 | `lib/no-show/no-show.integration.test.ts::counts a verified provider no-show against the provider`; `::counts nothing for a no_fault resolution`; `::emits the signal exactly once, attributed to the faulted party`; `::repeated verified no-shows raise the count`; `::refuses a second fault finding on the same booking`; `::never changes any account's lifecycle status`; `lib/no-show/no-auto-ban.test.ts` (whole file) |
| AC-7 | `lib/cancellation/cancellation.integration.test.ts::writes exactly one cancellation history row, attributed to the acting party`; `::produces an eligibility decision spec 022 can execute`; `::a fully refunded cancellation ends at refunded, via spec 022 own transition`; `lib/cancellation/boundaries.test.ts::writes no refunds, refund_lines, payments or payouts row`; `::never writes bookings.status with its own SQL` |
| AC-8 | `lib/cancellation/cancellation.integration.test.ts::the same key replays one cancellation and one refund`; `::the same key with a different body is a conflict`; `::two concurrent cancellations admit exactly one`; `::records exactly one cancellation row per booking`; `lib/no-show/no-show.integration.test.ts::two concurrent resolutions admit exactly one` |
| AC-9 | `lib/no-show/no-show.integration.test.ts::an admin without the permission is refused`; `::requires a reason and a known outcome`; `::refuses a second resolution`; `::writes a spec 009 audit event naming the admin, outcome and reason`; `lib/cancellation/routes.integration.test.ts::refuses an admin without the permission` |
| AC-10 | `lib/no-show/no-show.integration.test.ts::shows a participant neither party's statement, the evidence, nor any admin field`; `::shows Trust & Safety the full bundle`; `::nulls evidence after the retention window but keeps the outcome and resolving admin`; `::evidence cannot be rewritten, only removed`; `::history rows are append-only`; `lib/cancellation/routes.integration.test.ts::never serves admin fields from a participant route` |

**Coverage:** 188 tests across 10 files, all passing. The financial-flow tests are mandatory, not
optional, and are part of that number.

**A note on the two fixture concessions.** `setHoursBeforeScheduled` and `reassignBookingProvider`
suspend spec 020's `bookings_terms_immutable_trg` for one statement inside one transaction. That
trigger exists to stop application code rewriting a booking's terms, and no application code does —
the guard tests assert it. What a test cannot do is wait twelve hours for a tier boundary, or seed
two full offer→booking→payment scenarios that happen to share a provider. Both helpers are confined
to `lib/cancellation/cancellation-test-support.ts` and documented there.

**Not covered, deliberately:** refund execution mechanics and the provider refund call (spec 022 — this
spec hands over a decision); payment capture, void and protection (spec 021); the ranking algorithm and
weight arithmetic (spec 017 — this spec supplies a count); notification delivery, channels and
preferences (spec 026 — this spec ships only the port); message-content evidence (spec 025 — the port's
inert default is tested, the real integration is not); dispute mechanics after escalation (spec 031).

**Cross-spec tests this spec legitimately changed**, each a minimal correction and no more:

- `lib/db/schema-coverage.test.ts` — this spec's four new tables added to `EXPECTED_TABLES`, the same
  allowance specs 009 and 016 took for their own additions.
- `lib/db/schema-lint.test.ts` — `policy_versions.config`, `policy_acceptances.accepted_config` and
  `no_show_reports.evidence` added to the reviewed-jsonb allowlist, each with its AC-5 rationale.
- `lib/bookings/lifecycle.integration.test.ts` — one assertion retargeted. It asserted that a raw
  `UPDATE ... SET status = 'cancelled'` is rejected by the spec 003 trigger; `0019` seeds
  `confirmed → cancelled`, which spec 020 §3 always reserved for this spec, so that pair is now
  legitimately allowed. The assertion now uses `disputed` (spec 031's, still unseeded), preserving
  exactly what the test exists to prove: a raw `UPDATE` cannot invent a transition nobody owns.

**Pre-existing failures this spec deliberately did NOT absorb.** `lib/db/migrations.integration.test.ts`
asserts a hard-coded table count that specs 010/017/018/021/022 have already outgrown (87 before this
spec's four), and `lib/db/concurrency.integration.test.ts` inserts `categories DEFAULT VALUES` against
a table spec 010 gave a `NOT NULL` name. Both are the spec 003 enumeration drift spec 021 §6 first
recorded and spec 022 §6 left in place. Updating those numbers here would silently absorb another
spec's defect into this one's diff.
The five pre-existing spec 003 schema-enumeration failures documented in spec 021 §6 remain out of
scope; this spec adds its new tables to the same enumerations, which their owner absorbs when the spec
010/011 defect is fixed.

---

## 7. Out of scope

- **Refund execution, refund rows, provider refund calls and reconciliation** — spec 022. This spec
  registers the eligibility gate and hands over a decision.
- **Payment authorization, capture, void, protection window and any payment-provider access** — spec
  021. This spec reads one captured amount and writes nothing.
- **Booking lifecycle vocabulary and the transition primitive** — spec 020. This spec registers and
  seeds only the three `→ cancelled` pairs spec 020 reserved for it.
- **The reliability score, ranking weights and any change to spec 017's existing factor definition** —
  spec 017. This spec supplies a count through a read function and imports nothing from `lib/matching/**`.
- **Formal dispute creation, mediation and resolution** — spec 031. `escalated_to_dispute` closes the
  no-show report and creates no dispute row and no `→ disputed` transition.
- **Notification delivery, templates, channels and preferences** — spec 026. This spec ships only the sink port.
- **Message content as evidence** — spec 025. Only an availability/count port, with an inert default.
- **The admin configuration UI as a platform surface** — spec 041. The policy *data and API* are this
  spec's, so nothing here waits on 041.
- **Any device-location capture, GPS, geofence or location history** — deliberately never built (§3
  "Evidence model").
- **Any automatic ban, suspension or account restriction** — master spec §132.11.
- **Cancellation of a `pending` (unpaid) booking** — closed by spec 021's authorization-window sweep.
- **Request cancellation before provider selection** — spec 015, already shipped.
- **Known spec 010/011 catalog defects and the spec 010 OpenAPI `{categoryId}` drift.**
- **Any change to Home, `ui/`, `app/styles/apuriva-tokens.css`, or the primitive set in
  `components/index.ts`.**

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact default fee percentages per tier (the draft's Open #1) | Product | **Resolved** (§3 "The platform default"): 0 / 25 / 50 / 100 across `≥24h`, `[12h,24h)`, `(0h,12h)`, `≤0h`. The master spec gives only an example, so this is recorded as an explicit product decision rather than left blocking — and it lives in configurable policy data, not in code |
| 2 | Which location signals are "appropriate" for no-show evidence (the draft's Open #2) | Trust & Safety | **Resolved** (§3 "Evidence model"): **none is collected.** A single coarse enum is derived from the service-area check on data both parties already supplied; no coordinate is stored or returned; it is optional, never the sole basis for fault, and is deleted after 180 days. No surveillance infrastructure is created |
| 3 | The draft named spec 016 as the reliability consumer | Platform | **Resolved** (§3 "Reliability signal"): the `reliability` ranking factor is **spec 017's** (`lib/matching/weights.ts`); spec 016 owns availability. AC-6 and the "Feeds" list are corrected, and the seam is a read function 017 calls |
| 4 | The baseline `policy_acceptances` unique index is at the wrong grain | Platform | **Resolved** (§4): `0019` replaces `(policy_version_id, user_id)` with `UNIQUE (booking_id)` on a table that has never held a row. Left unfixed, a customer's second booking under one policy version would fail |
| 5 | Spec 020 owns booking creation, so this spec cannot write the policy snapshot at booking time | Platform | **Resolved** (§3 "Acceptance and snapshotting"): the snapshot is materialised lazily but resolved **as of `bookings.created_at`** against immutable, non-overlapping version intervals — identical to an eager write, with no change to spec 020's shipped creation path |
| 6 | A provider could otherwise invent a fee | Product | **Resolved** (AC-4): a provider may only select an `allowedOptions[].key` the effective version publishes; no route, DTO or column anywhere accepts a provider-supplied percentage, and `POLICY_OPTION_NOT_ALLOWED` rejects anything else |
| 7 | An admin resolution moves money, so it might warrant two-admin approval | Trust & Safety / Platform | **Resolved** (§3 "Admin resolution"): `medium` tier. The admin picks an outcome from a closed set, never an amount; the consequence is computed from the booking's snapshot; every resolution is audited. Spec 022's `refunds/override` stays `high` for genuinely discretionary money |
| 8 | Both parties reporting each other could double-count reliability | Platform | **Resolved** (AC-6, C-16): a partial unique index permits at most one fault-bearing resolution per booking — a database guarantee, not a convention |
| 9 | Silence from the other party could be read as an admission | Trust & Safety | **Resolved** (§3 "No-show workflow"): the sweep only moves the report to `under_review` with `no_response`; it sets no outcome and applies no consequence. A human admin always decides |
| 10 | Spec 041 owns the config UI, which could make this spec unexecutable | Platform | **Resolved** (§3 "Configuration ownership"): this spec owns the policy data and its admin API, and the migration seeds a working default. 041 renders the seam later; there is no circular dependency |
| 11 | Spec 026 has not shipped, so notifications have no delivery mechanism | Platform | **Resolved** (§3 "Notifications"): an inert-default sink, emitted after commit, whose failure can never roll back a cancellation or resolution |
| 12 | `btree_gist` may be unavailable on a deployment target | Platform | **Named, with a stated fallback** (§4 "Migration"): a partial unique index on the open-ended version plus the domain-layer interval check — weaker, recorded as such, never silently substituted |
| 13 | A cancellation might be expected to charge *more* than was captured | Product | **Out of scope, named rather than invented** (§3 "The financial boundary"): the fee is always a retention from the captured amount. Charging beyond it needs a provider call, which is spec 021's, and would be a new spec |
| 14 | Multi-currency | Product | **Out of scope, as in specs 021/022**: the fee is computed in the booking's own currency and no conversion exists anywhere in this spec |

No open question remains that blocks implementation.

---

## 9. Rollout

- **Feature flag:** none. Cancellation is core, and spec 041 (which owns flags) has not shipped. Policy
  *values* are admin-configurable **data** from day one, which is what §50's "must be configurable"
  actually requires.
- **Environment:** four variables added to `.env` / `.env.example`, kept in parity by
  `npm run check:env` — `NO_SHOW_RESPONSE_WINDOW_HOURS` (48), `NO_SHOW_REPORT_OPENS_MINUTES` (15),
  `NO_SHOW_REPORT_CLOSES_HOURS` (72), `NO_SHOW_EVIDENCE_RETENTION_DAYS` (180).
- **Migration order:** `0019` ships with the code as one unit — the routes depend on its columns, and
  the seeded platform default is what makes the eligibility gate return anything at all.
- **Cron:** `/api/v1/cron/no-show-response-sweep` added to `vercel.json`, scheduled `*/5 * * * *` —
  the same mechanism and bearer `CRON_SECRET` as `/cron/payment-sweep`, no new scheduler. A five-minute
  cadence is ample for a window measured in days.
- **Schema compatibility.** Every added column is nullable or defaulted, the one replaced index is on an
  empty table, and no existing query references anything this migration changes — so the new schema runs
  correctly under the *old* code, which is what makes the code rollback below safe.
- **Policy-version safety.** Versions are immutable and interval-bounded, and acceptances snapshot them.
  **A policy change is never retroactive**: republishing, correcting or deactivating a policy cannot alter
  the terms of any booking that already has an acceptance. There is no "edit the live policy" path in this
  spec at all.
- **Rollback — and what it can and cannot mean for money.** The draft said "revert deploy", which is
  unsafe wording once a cancellation has produced a refund:
  1. **Roll the code back, not the money.** Reverting the deploy stops new cancellations and resolutions
     being processed. It does not, and must not, attempt to undo a refund spec 022 has already executed.
     With the code rolled back, spec 022's eligibility gate returns to its inert `{ eligible: false }`
     default — nothing is automatically refundable again, and no half-applied policy remains.
  2. **Do not apply the down migration once any `booking_cancellations` or `no_show_reports` row exists.**
     It is gated on those tables being empty for exactly that reason: those rows are the audit record of
     a financial consequence and of a Trust & Safety decision, which spec 008 requires be retained. The
     correct response to a defect after launch is a forward fix, and a policy error is corrected by
     publishing a new version — never by rewriting or deleting an old one.
  3. **A booking already cancelled stays cancelled.** `bookings.status = 'cancelled'` is terminal in this
     spec's graph; no rollback path re-opens one, and none should — the slot has already been released
     and the other party already told.
  4. **Financial recovery runs through spec 022.** A refund that is `processing` across a rollback is
     resolved by spec 022's reconcile sweep on whatever code version is deployed; one that should have
     been issued and was not is issued by a Finance Admin through spec 022's `refunds/override` path,
     under its existing two-admin approval. This spec provides no manual money-movement path of its own.
  5. **In-flight no-show reports survive.** A report left `awaiting_response` or `under_review` across a
     rollback stays exactly there — nothing times out into an outcome, because only an admin sets one.
- **Observability (master spec §117):** structured logs for `cancellation.previewed`,
  `cancellation.executed`, `cancellation.policy_unavailable`, `cancellation.policy_config_invalid`,
  `no_show.reported`, `no_show.responded`, `no_show.no_response`, `no_show.resolved` and
  `no_show.fault_recorded`, each carrying `correlationId`, `bookingId`, the report or cancellation id and
  the status — never a statement body, never an evidence bundle, never a location value, and never an
  amount tied to an identifiable person in a log line. Alert on: cancellation-fee dispute rate; any
  report in `awaiting_response` past its `respond_by_at` plus a grace margin (a stalled sweep); any report
  `under_review` beyond a Trust & Safety SLA; `CANCELLATION_POLICY_UNAVAILABLE` at any rate above zero
  (it should be structurally impossible); and repeated-offender patterns routed to Trust & Safety for
  **human** review, never to an automated action (master spec §132.11).
