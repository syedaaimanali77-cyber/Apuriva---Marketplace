# Spec: Payment Processing & Protection

**File:** `docs/specs/2026-08-28-021-payment-processing-protection.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §46–§48, §90, §105, §113, §117, §132.5–§132.7, §132.15, §132.21–§132.22, §133.5–§133.8, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §8, [docs/workflow.md](../workflow.md)

**Depends on:** 003 (the `payments` / `payment_attempts` / `payment_authorizations` /
`payments_status_history` / `payments_status_transitions` baseline skeletons and the generic
`enforce_status_transition()` trigger), 004 (`withApiRoute`, the error taxonomy, the rate-limit
`payment` domain, `OPENAPI_ROUTES`), 005 (`requireSession`, `requireCsrf`), 006 (active mode),
008 (export/deletion retention), 015 (`Idempotency-Key`), 018/019 (the accepted offer a booking's
price is copied from), 020 (booking creation, the booking state machine, `applyBookingTransition`).

**Feeds:** 022 (refunds), 023 (cancellation fees), 024 (payouts — the sole executor of payout),
031 (disputes — the sole resolver of disputes), 028 (execution lifecycle), 033/036 (AI/MCP
reporting).

---

## 1. Problem statement

**Today:** No payment code exists. `lib/payments` is not present; nothing in `lib/` or `app/`
writes `payments`, `payment_attempts`, `payment_authorizations` or `payments_status_history` — all
four are still the empty spec 003 baseline skeletons (`id`, audit columns, `version`, and their
foreign keys, plus a bare `status text` on `payments`). `payments_status_transitions` is empty, so
the spec 003 `payments_status_transition_trg` currently rejects **every** status change on a
payment. Spec 020 ships bookings that confirm with no payment gate at all.

Master spec §46 requires service-aware payment timing built on a real payment provider's
authorization/hold/capture primitives — never claiming to be an escrow service without legal and
technical basis, and never silently charging a changed amount. §47 requires a payment-protection
window before provider payout finalizes, with automatic progression so abandoned bookings do not
stay stuck.

**Who is affected:** Every paying customer; every provider awaiting payout eligibility;
finance/reconciliation.

**Why it matters now:** It is the gate between a created booking and a confirmed one, and the base
for refunds (022), cancellation fees (023) and payouts (024).

**Success looks like:** A booking's payment is authorized and captured through a payment-provider
**adapter** — never fabricated in application code, and never fabricated in production at all;
funds are tracked through a protection window before payout eligibility; price changes always
require explicit customer approval before an additional charge.

---

## 2. Acceptance criteria

AC-1 through AC-8 are preserved from the draft. AC-1/AC-2/AC-3 are re-grounded on what this
repository actually models (§3 "Payment timing"), AC-5a/5b/5c keep their draft wording with the
window's start instant made exact, and AC-9/AC-10 are added because without them the sweep and the
production guard are unspecified — each removes a genuine implementation ambiguity rather than
widening scope.

| # | Criterion |
|---|---|
| AC-1 | **Given** a booking whose resolved payment timing is `at_booking_confirmation` (§3 "Payment timing" — the only timing reachable in this repository today, and the one a fixed/scheduled service resolves to) **When** `POST /bookings/{id}/payment/authorize` succeeds **Then** the authorization was obtained by calling the configured `PaymentProvider` adapter, the resulting `payments.status` and `payment_authorizations` row carry the adapter's own `provider_reference`, and **no** code path sets `authorized`/`captured` without an adapter response — asserted at source level by `lib/payments/no-fabricated-success.test.ts` |
| AC-2 | **Given** an offer-based service **When** the customer accepts an offer **Then** no payment is attempted at acceptance; authorization occurs only at the later, explicit `POST /bookings/{id}/payment/authorize` for the booking created from that offer, and never earlier — no route under `app/api/v1/offers/**` or `app/api/v1/requests/**` reaches `lib/payments` |
| AC-3 | **Given** a deposit-based payment timing **When** `resolvePaymentTiming()` is asked for it **Then** it returns `deposit_then_remainder` with `depositAmountMinorUnits`, and `chargeRemainder()` refuses to charge the remainder without an `approved` customer approval on record; **and** no service in this repository can currently resolve to that timing, because no deposit column exists — the resolver ships, the data does not, and no deposit amount is invented (§3 "Payment timing", the same ship-the-gate-not-the-requirement idiom as spec 020's completion-evidence gate) |
| AC-4 | **Given** a final price adjustment **When** proposed by the provider **Then** it is stored `pending_approval` and charges nothing; the additional charge occurs **only** in `POST /price-adjustments/{id}/approve`, only for the customer who owns the booking, and only for the exact `additionalAmountMinorUnits` + `additionalCurrencyCode` that were shown at approval time — a charge attempted without an `approved` row is `422 ADJUSTMENT_APPROVAL_REQUIRED` |
| AC-5 | **Given** a captured payment **When** the booking has not yet reached `settled` **Then** `protection_state` is not `released` and no payout is eligible; this spec writes no `payouts` row and calls no payout code (spec 024 owns payout execution entirely) |
| AC-5a | **Given** a booking transitions to `completed` **When** the transition is recorded, regardless of whether the customer or the provider marked it complete **Then** the payment-protection window starts at that moment — `protection_window_started_at` is set to the `bookings_status_history.occurred_at` of the `in_progress → completed` row, **not** to the time the sweep observed it — using the payment's configured `protection_window_hours` (default 48), and the booking is transitioned `completed → protected` with `actorRole: 'system'` |
| AC-5b | **Given** a booking's payment-protection window elapses **When** the dispute port reports no dispute for that booking **Then** `protection_state` transitions `held → released` and the booking transitions `protected → settled` with `actorRole: 'system'`, making the provider payout-eligible; spec 024 executes the actual payout |
| AC-5c | **Given** a dispute exists for a booking **When** it was opened before the window elapsed **Then** `protection_state` transitions `held → disputed`, the booking stays `protected` (this spec never transitions a booking to `disputed` — spec 031 owns that transition and seeds it), and neither release nor settlement occurs however much of the window has passed, until spec 031 resolves the dispute |
| AC-6 | **Given** a payment attempt **When** it fails **Then** the response is `422 PAYMENT_FAILED`, the UI shows master spec §105's exact payment wording ("Payment wasn't completed. / No charge was confirmed.") with Try Again / Change Payment Method, a `payment_attempts` row records the failure, and the booking is **not** confirmed — it stays `pending` and remains retryable until the authorization window expires (AC-9) |
| AC-7 | **Given** a duplicate authorization or capture request **When** it carries the same `Idempotency-Key` and the same body fingerprint **Then** the stored result is replayed with `200` and **no** second adapter call is made; the same key is also passed to the adapter as its idempotency key, and the same key with a *different* fingerprint is `409 IDEMPOTENCY_KEY_CONFLICT`. Two concurrent first-time authorizations for one booking produce exactly one `payments` row — enforced by `payments_booking_id_uq`, not only by application logic |
| AC-8 | **Given** any consumer that reports a payment outcome to a person (spec 033's assistant, spec 036's MCP tools, the UI) **When** it does so **Then** it reads `loadPaymentDto()` — the single read-only projection of persisted, adapter-confirmed state — which has no branch that derives, infers or optimistically reports a status the database does not hold, and never returns `provider_reference` or any adapter credential (master spec §132.7) |
| AC-9 | **Given** a booking left `pending` because its payment was never completed **When** `PAYMENT_AUTHORIZATION_WINDOW_MINUTES` (default 30) has elapsed since booking creation on the database clock **Then** the sweep transitions it `pending → failed` with `actorRole: 'system'`, which releases the provider's slot (`failed` is in spec 020's `SLOT_RELEASING_BOOKING_STATUSES`) — resolving spec 020 §8 open question 7, and satisfying master spec §47's "automatic progression prevents abandoned bookings from staying stuck" |
| AC-10 | **Given** `PAYMENT_PROVIDER=sandbox` **When** the process runs with `NODE_ENV=production` **Then** the adapter factory throws at resolution and every payment route answers `503 PAYMENT_PROVIDER_UNAVAILABLE` — a sandbox can never report a real payment success in production (master spec §132.21/§132.22, §133.5/§133.7) |

---

## 3. API contract

### Payment-provider architecture (open question 1) — DECIDED

Master spec §133.5 forbids inventing external credentials and §133.7 requires a sandbox/mock
adapter when credentials are unavailable. No Pakistan payment-provider account, credentials or
sandbox access exists for this repository, and none is assumed here.

- **`lib/payments/provider/` is the only module permitted to hold payment-provider credentials.**
  No other module imports a vendor SDK, reads a `PAYMENT_*` secret, or constructs a provider
  request. `lib/payments/no-fabricated-success.test.ts` asserts this at source level.
- **The seam** is one interface, deliberately small and modelled on the
  authorization/capture/void/status primitives §46 names:

  ```typescript
  // lib/payments/provider/types.ts
  export interface PaymentProvider {
    readonly name: string;
    /** Non-production adapters return true. Routes refuse to run one when NODE_ENV=production. */
    readonly isSandbox: boolean;
    authorize(input: AuthorizeInput): Promise<ProviderResult>;
    capture(input: CaptureInput): Promise<ProviderResult>;
    voidAuthorization(input: VoidInput): Promise<ProviderResult>;
    getStatus(providerReference: string): Promise<ProviderResult>;
  }

  export interface ProviderResult {
    outcome: 'authorized' | 'captured' | 'requires_action' | 'failed';
    providerReference: string;
    failureCode?: string;
    failureMessage?: string;
  }
  ```

  Every input carries `idempotencyKey`, `amountMinorUnits` and `currencyCode`. A real vendor later
  is a new file implementing this interface plus one entry in the factory — not a rewrite of any
  call site. This is the same swappable-adapter idiom `lib/auth/sms-otp-provider.ts` already ships
  for SMS (spec 005 §8 risk #1), and it is reused rather than re-invented.
- **Selection** is `process.env.PAYMENT_PROVIDER`, added to `.env` and `.env.example` so
  `npm run check:env` keeps them in parity. Its only shipped value is `sandbox`. An unknown or
  absent value is a hard failure, never a silent fallback. This is an environment variable per
  master spec §133.6, **not** a feature-flag system — spec 041 remains the owner of runtime
  configuration, exactly as `SEARCH_NL_INTERPRETATION_ENABLED` and `HOME_PERSONALIZATION_ENABLED`
  are handled today.
- **The sandbox adapter** (`lib/payments/provider/sandbox.ts`) mirrors real provider semantics —
  it honours idempotency keys, returns `requires_action` and `failed` outcomes for reserved test
  amounts, and issues references prefixed `sandbox_` so a sandbox reference can never be mistaken
  for a real one. It is honest about what it is: it moves no money and claims no vendor
  relationship.
- **AC-10 is the guard that makes this safe.** `resolvePaymentProvider()` throws when
  `isSandbox && process.env.NODE_ENV === 'production'`; routes map that to
  `503 PAYMENT_PROVIDER_UNAVAILABLE`. A production deployment without a real adapter refuses to
  take payments rather than pretending one succeeded.

### Payment timing (AC-1/AC-2/AC-3) — grounded on this repository

The draft implied three independent timing paths. In this repository **every booking is created
from an accepted offer**: `bookings.offer_id` is `NOT NULL` with a unique index, and
`price_amount_minor_units` / `price_currency_code` are copied verbatim from that offer
(spec 020 §3 step 14). `services.pricing_model` is `fixed | package | hourly | quote | custom`
(spec 010) and there is **no** deposit column, deposit table or payment-model table anywhere in
`lib/db/schema.ts`.

So a resolver ships, with exactly one reachable outcome today:

```typescript
// lib/payments/timing.ts
export type PaymentTiming =
  | { kind: 'at_booking_confirmation' }
  | { kind: 'deposit_then_remainder'; depositAmountMinorUnits: number };

export function resolvePaymentTiming(input: { pricingModel: PricingModel }): PaymentTiming;
```

- **`at_booking_confirmation`** is what every service resolves to today. For a fixed/scheduled
  service (AC-1) and for an offer-based service (AC-2) this is the *same instant* — offer
  acceptance is what creates the booking — and that is a fact about this repository, not an
  ambiguity to paper over. Authorization happens at the booking's payment step, never at offer
  acceptance.
- **`deposit_then_remainder`** is defined, typed and unit-tested, and is unreachable until a later
  spec adds the deposit data. No deposit column, default or amount is invented here (§133.5).
  `chargeRemainder()` refuses without an approved customer approval on record, so AC-3's
  substantive rule — the remainder is never charged silently — is testable now.

**Exact point of authorization and capture.** Authorization and capture are one adapter round trip
per step, both outside any database transaction (see "Transaction and lock ordering"):

1. Booking created by spec 020 and committed as `pending` (see "Booking boundary" below).
2. `POST /bookings/{id}/payment/authorize` → adapter `authorize()` → on `authorized`, the payment
   row becomes `authorized`, a `payment_authorizations` row is written, and the booking is
   transitioned `pending → confirmed`.
3. Capture depends on the adapter's capability, reported by the same `ProviderResult`: an adapter
   that captures at authorization returns `outcome: 'captured'` and step 4 is a no-op replay; an
   adapter that separates them requires `POST /bookings/{id}/payment/capture`, which this spec
   performs at authorization time for `at_booking_confirmation` timing — there is no state in which
   this repository holds an uncaptured authorization across the service. Both paths converge on
   `payments.status = 'captured'` before the booking is `confirmed`.
4. A **price adjustment** is its own authorize-and-capture round trip against the adjustment's own
   amount, after approval. It never re-captures, re-authorizes or rewrites the original payment,
   and it never rewrites `bookings.price_amount_minor_units` — spec 020 owns that column and made
   it immutable.

### Booking boundary (spec 020 §3 "Payment boundary") — where payment failure blocks confirmation

Spec 020 §3 states the division explicitly and this spec implements exactly it, adding nothing to
the booking status vocabulary and changing none of spec 020's six transitions:

| | Spec 020 | Spec 021 (this spec) |
|---|---|---|
| Booking status vocabulary | owns | reads; adds nothing |
| `pending → confirmed` | performs it via `confirmBooking()`, exported as a separate step | **gates** it |
| `pending → failed`, `completed → protected`, `protected → settled` | not seeded | **seeds in `0017`, and is the only caller**, with `actorRole: 'system'` |
| `bookings.status` writes | `applyBookingTransition()` | calls it; never writes the column with its own SQL |
| Payment state, protection window, payout eligibility | none | owns entirely |

**The gate, and why it is a port.** `confirmBooking()` runs *inside* `createBooking`'s transaction,
which holds `FOR UPDATE` locks on the request and offer rows and a reserved availability slot. An
external provider call must never happen inside that transaction. So the gate is a port in
`lib/bookings`, registered by `lib/payments` — the same inversion spec 020 used for
`CompletionEvidenceGate` and spec 016 for `BusyIntervalLoader`, and the reason spec 020's
`payment-boundary.test.ts` (which forbids `lib/bookings/**` importing any payment module) stays
green unchanged:

```typescript
// lib/bookings/confirmation-gate.ts  (new file in spec 020's module, registered by spec 021)
export type BookingConfirmationGate = (tx: Executor, bookingId: string) => Promise<{ confirmNow: boolean }>;
```

The shipped default is `{ confirmNow: true }` — byte-for-byte today's behaviour. `lib/payments`
registers a gate returning `confirmNow: false`, so the booking commits `pending` and
`POST /api/v1/bookings` returns a `pending` booking.

**Where the registration happens.** `POST /api/v1/bookings` is a spec 020 route and may not import
a payment module, so the two specs are wired together in `instrumentation.ts` at the project root —
Next's own composition root, whose `register()` runs once per server instance before any request is
handled. Tests call the same `registerPaymentIntegration()` directly, because Vitest gives each test
file its own module registry. No new framework is introduced.

**Performing this spec's three booking transitions.** `applyBookingTransition()` guards against a
caller asking for a transition nobody owns. Spec 020's `SPEC_020_TRANSITIONS` is untouched and
`isAllowedBookingTransition()` still answers only "does spec 020 own this pair?" — so spec 020's own
tests, which assert `completed → protected` and `protected → settled` are *not* spec 020's, keep
passing unchanged. A small extension registry (`registerBookingTransitions`) lets the owning spec
declare the pairs it performs, which is exactly the collaboration spec 020 §3 described in prose.
The database `bookings_status_transitions` table remains the real authority either way: a pair
registered but never seeded is still rejected by the spec 003 trigger.

**This is a declared behaviour change to spec 020's creation outcome, not a silent one.** Spec 020
§3 anticipated and designed for it in so many words ("Spec 021 interposes its payment authorization
between steps 15a and 15b … ships `confirmBooking()` as a separately exported step precisely so
spec 021 can gate it"). What changes: spec 020's creation-path test assertions that a freshly
created booking is `confirmed` become `pending`, and the confirmation UI gains a payment step. What
does **not** change: the transition graph, the rows seeded by `0016`, route shapes, `BookingDto`
fields, any constraint, and the rule that `lib/bookings/**` reads no payment state.

Spec 020's `payment-boundary.test.ts` keeps every assertion at full strength; it gains one scoping
change and no weakening. Its file list excludes `app/api/v1/bookings/{id}/payment/**` and
`.../price-adjustments/**`, because those route files are **spec 021's**, not spec 020 files — they
sit in the bookings URL namespace only because a payment belongs to a booking. The architectural
rule the test exists to protect is untouched and still asserted: every module spec 020 actually
owns, and every spec 020 route, imports no payment module and reads no payment state. One further
assertion in spec 020's `complete.integration.test.ts` drops `protected` from its list of
unreachable targets, because `0017` now seeds `completed → protected` — precisely what spec 020 §3
said spec 021 would do. `completed → settled` stays unseeded, since this spec reaches `settled` only
from `protected`.

**Where payment failure prevents booking confirmation — exactly.** `pending → confirmed` is
performed **only** by `lib/payments/authorize.ts`, and only after a `ProviderResult` whose
`outcome` is `authorized` or `captured` has been persisted. A `failed` or `requires_action`
outcome leaves the booking `pending` and returns `422`. The booking never reaches `confirmed` on a
failed payment, and the customer may retry until AC-9's window expires. A `pending` booking still
occupies the provider's slot — spec 020's `SLOT_OCCUPYING_BOOKING_STATUSES` already includes
`pending` — so a retry cannot lose the slot and a failure cannot silently double-book it.

### Protection window (AC-5a/5b/5c)

- Default **48 hours**, held per payment in `protection_window_hours` so a service or payment model
  can be given a different duration without a schema change. Absent configuration, 48 applies.
- Spec 020 signals nothing when a booking completes (by design — reaching `completed` triggers
  nothing there). This spec therefore **observes** booking status from its own sweep, which keeps
  the dependency strictly one-directional. AC-5a's exactness is preserved despite the sweep's lag
  by deriving `protection_window_started_at` from the `bookings_status_history` row's
  `occurred_at`, never from the sweep's own clock.
- `held → released` when the window elapses with no dispute; `held → disputed` when one exists.
- **Disputes are a port, not a table this spec creates.** Spec 031 does not exist yet, so
  `lib/payments/dispute-gate.ts` ships the same inert-default port idiom:
  `DisputeGate = (tx, bookingId) => Promise<{ open: boolean }>`, defaulting to `{ open: false }`
  because no spec has defined a dispute yet. Spec 031 registers the real one. This spec implements
  no dispute creation, listing, evidence or resolution.
- **Payout is spec 024's, entirely.** This spec writes no `payouts` or `payout_methods` row, ships
  no payout route, and computes no fee. "Payout-eligible" here means exactly
  `payments.protection_state = 'released'` and `bookings.status = 'settled'` — the fact spec 024
  reads.

### Price adjustments (AC-4)

1. Provider proposes: `POST /bookings/{id}/price-adjustments` → row `pending_approval`. Charges
   nothing. The exact `additionalAmountMinorUnits` and `additionalCurrencyCode` are fixed at
   proposal and immutable thereafter.
2. Customer sees the exact amount and currency in a structured confirmation (master spec §90's
   financial tier; §132.15 "do not silently change confirmed prices").
3. Customer approves: `POST /price-adjustments/{id}/approve` — the only code path that may charge
   an adjustment. Approval and charge are bound to the same row, so the amount charged is
   necessarily the amount shown.
4. Customer rejects: `POST /price-adjustments/{id}/reject` → `rejected`, terminal, nothing charged.
   Without this the "explicit approval" in AC-4 would have no negative branch.
5. An adjustment's currency must equal the booking's `price_currency_code`; a mismatch is
   `422 ADJUSTMENT_CURRENCY_MISMATCH`, with a database CHECK backstop.

### Idempotency and concurrency

- **Application level.** `payments.idempotency_key` + `payments.idempotency_fingerprint`, unique
  per `booking_id`; `price_adjustments.idempotency_key` + fingerprint, unique per `booking_id`.
  Same key + same fingerprint replays the stored result with `200` and makes **no** adapter call.
  Same key + different fingerprint is `409 IDEMPOTENCY_KEY_CONFLICT`
  (`lib/requests/errors.ts`, re-exported — not redefined). The header is read and validated by the
  existing `requireIdempotencyKey()` / `idempotencyFingerprint()` in `lib/api/idempotency.ts`,
  which already names specs 020/021 as its intended reusers. No second scheme is introduced.
- **Structural anti-double-charge.** `payments_booking_id_uq` — **one payment row per booking** —
  replaces the baseline's non-unique `payments_booking_id_idx`. Two concurrent first-time
  authorizations cannot both insert; the loser catches the unique violation and replays the
  winner's row, exactly as spec 020 handles `bookings_offer_id_uq`.
- **Provider level.** The same `Idempotency-Key` is forwarded to the adapter, so even a retry that
  somehow reached the adapter twice is deduplicated by the provider.
- **Transaction and lock ordering.** A provider call is **never** made inside a database
  transaction. Each money-moving operation is three phases with a fixed lock order
  (`bookings` → `payments` → `price_adjustments`, matching spec 020's fixed-lock-order discipline):

  | Phase | In a transaction? | What happens |
  |---|---|---|
  | 1 — reserve | yes | lock the booking `FOR UPDATE`, then the payment row; check status and idempotency; insert or advance the payment to a non-terminal state and write a `payment_attempts` row; **commit** |
  | 2 — call | no | one adapter call, carrying the idempotency key |
  | 3 — record | yes | re-lock in the same order; apply the outcome **conditionally on the `version` read in phase 1**; write the terminal `payment_attempts` row, the `payment_authorizations` row and the `payments_status_history` row; call `applyBookingTransition()` where the outcome demands it; **commit** |

  A crash between phases 2 and 3 leaves a non-terminal payment; the sweep reconciles it with
  `getStatus(providerReference)` rather than re-charging. The provider remains authoritative for
  money at all times.
- **Concurrent approval/charge of one price adjustment.** Approval is a conditional update
  predicated on `status = 'pending_approval'` AND the `version` the caller read. Of two concurrent
  approvals exactly one matches; the loser gets `409 ADJUSTMENT_ALREADY_RESOLVED` carrying the
  current status, and **no** adapter call is made on the losing path. A concurrent approve and
  reject resolve the same way — first writer wins, the second is told the current state.
- **Concurrent sweep runs.** Every sweep pass selects `FOR UPDATE SKIP LOCKED` and re-checks its
  predicate under the lock, so two overlapping cron invocations cannot release the same protection
  twice.

### Endpoints

Routing follows this repository's actual conventions: `app/api/v1/**/route.ts`, path parameters
read from the URL with a local `*-id.ts` helper (`withApiRoute` forwards no route context), plural
collection segments, and every mutating browser route guarded by `requireSession` → `requireCsrf` →
active mode → rate limit → `Idempotency-Key`, in that order.

| Method | Route | Auth / mode | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/bookings/{id}/payment/authorize` | session, `customer` mode, booking's customer | `200 ApiResponse<PaymentDto>` | CSRF; `Idempotency-Key` required; rate-limit domain `payment` |
| `POST` | `/api/v1/bookings/{id}/payment/capture` | session, `customer` mode, booking's customer | `200 ApiResponse<PaymentDto>` | CSRF; `Idempotency-Key` required; no-op replay when the adapter already captured |
| `GET` | `/api/v1/bookings/{id}/payment` | session, participant, either mode | `200 ApiResponse<PaymentDto>` | read-only projection (AC-8) |
| `POST` | `/api/v1/bookings/{id}/price-adjustments` | session, `provider` mode, booking's provider | `201 ApiResponse<PriceAdjustmentDto>` (`200` on an idempotent replay, as `POST /bookings` already does) | CSRF; `Idempotency-Key`; proposes only, charges nothing |
| `GET` | `/api/v1/bookings/{id}/price-adjustments` | session, participant, either mode | `200 ApiResponse<PriceAdjustmentDto[]>` | |
| `POST` | `/api/v1/price-adjustments/{id}/approve` | session, `customer` mode, booking's customer | `200 ApiResponse<PriceAdjustmentDto>` | CSRF; `Idempotency-Key`; the **only** path that charges an adjustment |
| `POST` | `/api/v1/price-adjustments/{id}/reject` | session, `customer` mode, booking's customer | `200 ApiResponse<PriceAdjustmentDto>` | CSRF; `Idempotency-Key` |
| `GET` | `/api/v1/cron/payment-sweep` | `Bearer ${CRON_SECRET}` | `200` | not a browser route: no session, no CSRF, no rate limit — identical to `/cron/offer-expiry-sweep` |

Every route except the cron route is added to `OPENAPI_ROUTES` in `lib/api/openapi-registry.ts` in
the same change, or `npm run check:openapi-drift` fails. Cron routes are excluded from the drift
check, as the existing cron routes already are. Paths in the registry use the OpenAPI `{id}` form
and the tag `payments`.

**Privacy and ownership.** A caller who is not a participant gets `404`, never `403` — booking and
adjustment ids must not be probeable, the rule specs 015/018/019/020 already follow. `403` is
reserved for a participant in the wrong active mode. The provider can see that an adjustment was
approved and that payment succeeded; the provider never sees `provider_reference`, the customer's
payment instrument, or any attempt-level failure code.

### Request and response types

```typescript
// lib/types/payments.ts
export const PAYMENT_STATUSES = [
  'created', 'requires_action', 'authorized', 'captured', 'failed',
  'refunded', 'partially_refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_PROTECTION_STATES = ['held', 'released', 'disputed'] as const;
export type PaymentProtectionState = (typeof PAYMENT_PROTECTION_STATES)[number];

export interface PaymentDto {
  id: string;
  bookingId: string;
  status: PaymentStatus;
  chargeAmountMinorUnits: number;
  chargeCurrencyCode: string;
  /** null until the protection window opens (booking `completed`). */
  protectionState: PaymentProtectionState | null;
  protectionWindowStartedAt: string | null;
  protectionWindowHours: number;
  /** Derived from the two fields above, never stored; null until the window opens. */
  protectionWindowEndsAt: string | null;
  version: number;
}

export interface PriceAdjustmentDto {
  id: string;
  bookingId: string;
  additionalAmountMinorUnits: number;
  additionalCurrencyCode: string;
  reason: string;
  status: 'pending_approval' | 'approved' | 'rejected' | 'charged' | 'failed';
  approvedAt: string | null;
  version: number;
}
```

`PaymentDto` deliberately carries **no** `providerReference`, provider name, attempt list or
failure code. The draft exposed `providerReference` to the client; it is removed — it is an
internal reconciliation handle, no UI needs it, and AC-8/§4 "Retention and privacy" require the
payment surface to leak nothing about the provider relationship. It stays server-side in `payments`
and `payment_authorizations`.

### Error codes

None of these is in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status`
explicitly — the pattern spec 005's `MFA_REQUIRED`, spec 016's `SLOT_OVERLAP` and spec 020's
`BOOKING_NOT_FOUND` already use. They live in `lib/payments/errors.ts`; codes owned by earlier
specs are **re-exported, never redefined**.

| HTTP | `code` | When |
|---|---|---|
| `404` | `PAYMENT_NOT_FOUND` | no such booking/payment/adjustment, **or** the caller is not a participant (deliberately indistinguishable) |
| `422` | `PAYMENT_FAILED` | the adapter declined or errored; `details.failureCode` is the adapter's code, never a raw vendor payload |
| `422` | `PAYMENT_REQUIRES_ACTION` | 3DS or equivalent step-up required; `details.providerActionKind` only |
| `422` | `BOOKING_NOT_AWAITING_PAYMENT` | the booking is not `pending` (already confirmed, failed or cancelled) |
| `422` | `PAYMENT_NOT_AUTHORIZED` | capture attempted on a payment the provider has not authorized yet. Distinct from `PAYMENT_FAILED`, which means the provider actually refused — reporting a failure here would itself be a fabricated outcome |
| `409` | `PAYMENT_ALREADY_CAPTURED` | capture attempted on an already-captured payment under a *different* idempotency key |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | re-exported from `lib/requests/errors.ts` — same key, different fingerprint |
| `409` | `CONFLICT` | stale `version` on a payment or adjustment (spec 003 AC-6 concurrency) |
| `422` | `ADJUSTMENT_APPROVAL_REQUIRED` | an additional charge attempted with no `approved` adjustment on record. **The draft's `403` is wrong** — this is a domain-rule violation, not a permission failure, and `403` in this repository means wrong active mode |
| `409` | `ADJUSTMENT_ALREADY_RESOLVED` | approve/reject on an adjustment no longer `pending_approval`; `details.currentStatus` |
| `422` | `ADJUSTMENT_CURRENCY_MISMATCH` | the adjustment currency differs from the booking's |
| `503` | `PAYMENT_PROVIDER_UNAVAILABLE` | no usable adapter — AC-10's production guard, or an adapter outage |

### Rate limits

The existing `payment` domain in `lib/api/rate-limit.ts` (10 requests / 60s per user) is used
as-is. No new domain, no new threshold, no change to `RATE_LIMIT_DEFAULTS`.

### AI and MCP boundary (AC-8)

Spec 033's assistant and spec 036's tool catalog do not exist yet; `lib/ai/` currently holds only
`intent-interpreter.ts`. This spec therefore ships the **mechanism** those specs will consume
rather than a stub of them:

- `loadPaymentDto()` in `lib/payments/read.ts` is the single read-only projection of persisted
  state. It has no branch that infers a status, no optimistic path, and no default that could read
  as success.
- `lib/payments/no-fabricated-success.test.ts` asserts at source level — the idiom spec 020's
  `payment-boundary.test.ts` established — that no file outside `lib/payments/provider/` imports a
  vendor SDK or reads a `PAYMENT_*` secret; that no file outside `lib/payments/record.ts` writes
  `status = 'authorized' | 'captured'`; and that `lib/ai/**` contains no payment status literal.

### Breaking-change check

- [x] New routes, new columns on empty baseline tables — no shipped API contract changes.
- [x] One declared behaviour change: `POST /api/v1/bookings` now returns a `pending` booking
      instead of `confirmed`, exactly as spec 020 §3 designed for. Documented above, not silent.

---

## 4. Data model changes

**The draft declared `Payment`, `PaymentAttempt` and `PaymentAuthorization` as new tables. They are
not.** Spec 003's baseline already creates `payments`, `payment_attempts`,
`payment_authorizations`, `payments_status_history` and `payments_status_transitions`, with their
foreign keys, indexes and the `payments_status_transition_trg` trigger. This spec **alters** those
skeletons and seeds the transition table — it creates exactly one new table. The baseline migration
`0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.

`baseColumns()` already supplies `id uuid pk`, `created_at`, `updated_at` and `version` on every
table, so those are not listed as additions. Money follows spec 003 AC-1's convention — a
semantically named `<base>_amount_minor_units integer` + `<base>_currency_code text` pair, never
`numeric`/`float` (`npm run check:schema-money-lint` enforces it).

### Entities

| Entity | Change | Columns added |
|---|---|---|
| `payments` | **alter** (baseline: `booking_id`, `status`) | `charge_amount_minor_units integer not null`, `charge_currency_code text not null`, `protection_state text null`, `protection_window_started_at timestamptz null`, `protection_window_hours integer not null default 48`, `provider_name text not null`, `provider_reference text null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `payment_attempts` | **alter** (baseline: `payment_id`) | `status text not null`, `failure_code text null`, `failure_reason text null`, `provider_reference text null`, `attempted_at timestamptz not null default now()` |
| `payment_authorizations` | **alter** (baseline: `payment_id`) | `authorized_amount_minor_units integer not null`, `authorized_currency_code text not null`, `authorized_at timestamptz not null`, `captured_amount_minor_units integer null`, `captured_currency_code text null`, `captured_at timestamptz null`, `provider_reference text not null` |
| `payments_status_history` | **alter** (baseline: `payment_id`, `from_status`, `to_status`, `actor_user_id`, `occurred_at`) | `actor_role text not null` — `actor_user_id` is nullable for this spec's system transitions, so attribution needs its own column, exactly as spec 020 added to `bookings_status_history` |
| `payments_status_transitions` | **seed only** | the payment transition graph below |
| `bookings_status_transitions` | **seed only** | `('pending','failed')`, `('completed','protected')`, `('protected','settled')` — the three rows spec 020 §3 reserved for this spec |
| `price_adjustments` | **new** — the only new table | `booking_id uuid not null fk->bookings restrict`, `payment_id uuid null fk->payments restrict`, `additional_amount_minor_units integer not null`, `additional_currency_code text not null`, `reason text not null`, `status text not null`, `proposed_by_user_id uuid not null fk->users restrict`, `approved_by_user_id uuid null fk->users restrict`, `approved_at timestamptz null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |

No `refunds`, `refund_lines`, `payouts`, `payout_methods`, `payouts_status_history` or
`payouts_status_transitions` row, column or constraint is touched — those baseline skeletons belong
to specs 022 and 024.

### Payment status machine

The whole `payments.status` vocabulary is authored **once, here**, the way spec 020 authored the
booking vocabulary — including `refunded` and `partially_refunded`, whose *transitions* spec 022
seeds in its own migration. Later specs add transitions; none adds a status name.

`payments_status_ck`: `status in ('created','requires_action','authorized','captured','failed','refunded','partially_refunded')`.

Seeded into `payments_status_transitions` by `0017` — the transitions this spec performs, and only
those:

```
created         → requires_action | authorized | captured | failed
requires_action → authorized | captured | failed
authorized      → captured | failed
```

Deliberately absent, each seeded by its owner: `captured → refunded` and
`captured → partially_refunded` (spec 022). `captured` has no outgoing transition here. The spec
003 trigger rejects anything not seeded, so nothing else is performable.

The draft's `pending` payment status is dropped: `created` and `requires_action` already cover
every pre-terminal state, and an unreachable status name would still have to be seeded to be legal.

### Constraints and invariants

| # | Constraint | Why |
|---|---|---|
| I-1 | `payments_booking_id_uq` unique on `(booking_id)`, replacing the baseline `payments_booking_id_idx` | one payment per booking — the structural anti-double-charge guarantee (AC-7), mirroring spec 020's `bookings_offer_id_uq` |
| I-2 | `payments_booking_idempotency_key_uq` unique on `(booking_id, idempotency_key)` | idempotency scoped to the entity, never globally — spec 015/018/020 precedent |
| I-3 | `payments_charge_pair_ck`, `payments_charge_currency_format_ck` (`^[A-Z]{3}$`), `payments_charge_positive_ck` (`> 0`) | spec 020's money constraints, applied identically |
| I-4 | `payments_protection_pairing_ck`: `(protection_state is null) = (protection_window_started_at is null)`, plus `payments_protection_state_ck` restricting the value to `held`/`released`/`disputed` | a protection state without a start instant is meaningless, and the vocabulary is closed at the database |
| I-5 | `payments_protection_requires_capture_ck`: `protection_state is null or status in ('captured','refunded','partially_refunded')` | nothing is protected that was never captured (AC-5) |
| I-6 | `payments_protection_window_hours_ck`: `between 1 and 720` | a configurable window, bounded |
| I-7 | `payments_status_history_actor_role_ck` in `('customer','provider','system','admin')` and `payments_status_history_actor_pairing_ck`: `(actor_user_id is null) = (actor_role = 'system')` | spec 020's attribution rule, applied to payments |
| I-8 | `payment_attempts_append_only_trg` and `payments_status_history_append_only_trg` | both are financial audit trails — no UPDATE, no DELETE, mirroring `bookings_status_history_append_only_trg`. "What the provider said" and "who caused this transition" must stay unrewritable |
| I-9 | `payment_authorizations_captured_pair_ck` (all three capture columns null or all non-null) and `payment_authorizations_capture_not_over_ck`: `captured_amount_minor_units is null or captured_amount_minor_units <= authorized_amount_minor_units` | a capture can never exceed its authorization |
| I-10 | `price_adjustments_status_ck` in `('pending_approval','approved','rejected','charged','failed')` | |
| I-11 | `price_adjustments_approval_pairing_ck`: `(approved_by_user_id is null) = (approved_at is null)`, and `approved_at is not null` whenever `status in ('approved','charged')` | an approved or charged adjustment always has a named approver and instant (AC-4) |
| I-12 | `price_adjustments_amount_positive_ck`, `price_adjustments_currency_format_ck` | money convention |
| I-13 | `price_adjustments_booking_idempotency_key_uq` unique on `(booking_id, idempotency_key)` | |
| I-14 | `price_adjustments_charged_requires_payment_ck`: `status <> 'charged' or payment_id is not null` | a charged adjustment always points at the payment that carried it |
| I-15 | Indexes: `payments_protection_sweep_idx` on `(protection_state, protection_window_started_at)`, `price_adjustments_booking_id_idx`, `payment_attempts_payment_attempted_at_idx` on `(payment_id, attempted_at)` | the sweep's and the read path's access patterns |

The generic `enforce_status_transition()` trigger is **not** attached to `price_adjustments` — it
derives its lookup table name as `<table>_status_transitions` and only the five baseline
state-machine tables have one. Adjustment status is guarded in the domain layer plus I-10/I-11. No
`price_adjustments_status_transitions` table is created.

### Migration

- **Name:** `0017_add_payment_processing_protection.sql`, with a hand-written
  `0017_add_payment_processing_protection_down.sql` — the repository's actual convention
  (`0012`–`0016` all follow it; drizzle-kit generates no down migration, and the down file carries
  no `_journal.json` entry so `npm run db:migrate` never applies it). The draft's `AddPaymentTables`
  is wrong on both counts: wrong naming scheme, and no tables are added.
- **Precondition guard:** `RAISE EXCEPTION` unless `payments`, `payment_attempts`,
  `payment_authorizations` and `payments_status_history` are empty — the same `DO $$` guard `0016`
  uses, which is what makes `NOT NULL` columns without defaults safe to add directly.
- **Reversible:** yes. The down migration drops only what `0017` added, deletes only the
  `bookings_status_transitions` and `payments_status_transitions` rows `0017` inserted, and touches
  no other table. The standard caveat applies: rolling back discards the data those columns held.
- **Backfill required:** no (all four tables are empty).
- **Downtime:** none.
- **Reviewed SQL:** hand-reviewed in PR; `npm run check:schema-baseline` must pass.

### Retention and privacy

- **No raw card or payment-instrument data is ever stored by Apuriva.** There is no PAN, CVV,
  expiry, token-vault or wallet-credential column in this spec, and the adapter interface has no
  parameter that could carry one — a payment instrument is collected by the provider's own
  hosted/embedded UI and never transits an Apuriva route (master spec §48).
- **Retention (spec 008).** `payments`, `payment_attempts`, `payment_authorizations`,
  `payments_status_history` and `price_adjustments` are financial records, retained regardless of
  account deletion, under spec 008's **existing** rule — `lib/privacy/deletion.ts` already names
  `Payment`/`Payout`/`Refund` as retained, and every FK here is `restrict`. No new retention
  mechanism, sweep or policy is introduced.
- **Export boundary (spec 008).** `lib/privacy/export.ts` already exports the caller's payments as
  `{ id, bookingId, status, createdAt }`. This spec extends that projection with
  `chargeAmountMinorUnits`, `chargeCurrencyCode`, `protectionState` and
  `protectionWindowStartedAt`, and adds the caller's own price adjustments
  (`additionalAmountMinorUnits`, `additionalCurrencyCode`, `reason`, `status`, `approvedAt`).
  **Never exported:** `provider_reference`, `provider_name`, `idempotency_key`,
  `idempotency_fingerprint`, and attempt-level `failure_code`/`failure_reason` — internal
  reconciliation and anti-abuse data, not the user's own personal data. Export scope stays
  per-participant: a provider's export contains its own bookings' payment *status*, never the
  customer's payment detail.
- **Secrets.** `PAYMENT_PROVIDER` is the only payment variable this spec adds to `.env` /
  `.env.example`; any real vendor key added later lives in the environment and is read only inside
  `lib/payments/provider/`. No secret is logged: the structured logs emit `paymentId`, `bookingId`,
  `status` and the adapter's `failureCode` only — never a provider payload and never a provider
  reference.

---

## 5. UI states

Payment gets its own route, `app/bookings/[id]/payment`, reached from the booking detail page. The
booking now commits `pending`, so its confirmation *is* the payment step, and giving that step an
addressable URL is what lets a customer leave a `requires_action` step-up and come back to it, and
lets a price-adjustment notification link straight to the decision.

| State | Behaviour |
|---|---|
| **Loading** | "Processing payment…" progress; the confirm control is disabled for the whole round trip. No optimistic success is ever rendered before the response (AC-8) |
| **Empty** | N/A |
| **Error** | master spec §105's exact payment wording: "Payment wasn't completed. / No charge was confirmed." + **Try Again** / **Change Payment Method** — rendered as `ErrorState`'s retry plus its secondary action, so exactly one of each appears. Both re-run the payment with a fresh `Idempotency-Key`: a new attempt, never a replay of the one that failed |
| **Requires action** | `422 PAYMENT_REQUIRES_ACTION`'s message is shown in the same honest error surface, the payment stays `requires_action` and the booking stays `pending`. This spec does **not** embed a provider step-up surface: no real adapter exists to supply one, and rendering a fake one would be the "fake working integration" master spec §132.21 forbids |
| **Success** | the booking shows `confirmed` **only** after the response carries an adapter-confirmed `captured` payment |
| **Protection** | once `protectionState` is `held`, a plain-language protection line shows the window's end instant; `released` and `disputed` are stated flatly, with no dispute UI (spec 031) |

Price-adjustment approval is a structured, high-risk financial confirmation — master spec §90's
"Financial/security — secure authorization" tier, bound to exact parameters: a `ConfirmDialog` that
names the exact additional amount, its currency and the reason, and states that nothing is charged
until the customer approves.

**Components.** Built from the existing design system — `Button`, `Card`, `Badge`, `ConfirmDialog`,
`ErrorState`, `Skeleton` from `@/components`, and tokens from `app/styles/apuriva-tokens.css`. The
draft's shared `components/PaymentForm` is **not** added: it would be a new global primitive for a
single screen. No design-system token, primitive or `ui/` file is added or changed; Home and the
global design system are untouched. No brand mark is added — the nav shell already provides the one
intentional brand placement.

**Route(s):** `app/bookings/[id]/payment` (new).

---

## 6. Test plan

Vitest is the **only** runner in this repository (`npm test` → `vitest run`). There is no
Playwright and no browser-driven E2E; `e2e/*.spec.ts` is a Vitest pattern already configured in
`vitest.config.ts`, exercising real route handlers against the isolated `*_test` database — that is
what "E2E" means here, and no new runner is introduced. Integration tests live beside their domain
module in `lib/**` (`lib/bookings/*.integration.test.ts` is the established shape), not under
`app/api/v1/**` as the draft's paths assumed.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | `resolvePaymentTiming()` over every pricing model including the unreachable deposit branch; protection-window duration resolution and end-instant arithmetic; the payment transition matrix over every status pair, including the pairs specs 022/031 own; error-code construction | `lib/payments/timing.test.ts`, `lib/payments/protection-window.test.ts`, `lib/payments/state-machine.test.ts` |
| **Adapter** | the sandbox adapter honours idempotency keys, returns each `ProviderResult.outcome`, and never returns a reference lacking its `sandbox_` prefix; the factory rejects an unknown `PAYMENT_PROVIDER` and rejects a sandbox under `NODE_ENV=production` | `lib/payments/provider/sandbox.test.ts`, `lib/payments/provider/factory.test.ts` |
| **Source guard** | no vendor SDK import or `PAYMENT_*` secret read outside `lib/payments/provider/`; no `authorized`/`captured` write outside `lib/payments/record.ts`; `lib/ai/**` holds no payment status literal; no offer or request route reaches `lib/payments`; no `payouts` row, refund or dispute write anywhere; `bookings.status` never written with this spec's own SQL; no provider call inside a transaction | `lib/payments/no-fabricated-success.test.ts` |
| **Boundary regression** | spec 020's whole suite, including `payment-boundary.test.ts`, still passes with this spec loaded | `lib/bookings/**` (99 tests, unchanged behaviour) |
| **Integration** | authorize success → booking `pending → confirmed`; authorize failure → booking stays `pending`, attempt row written, `422 PAYMENT_FAILED`; capture; `requires_action`; the price-adjustment approval gate and its reject path; protection opens on `completed` at the history row's instant; release with no dispute; a dispute holding past elapse; the pending-authorization expiry sweep | `lib/payments/authorize.integration.test.ts` (authorization AND capture), `price-adjustment.integration.test.ts`, `protection-window.integration.test.ts`, `sweep.integration.test.ts` |
| **Concurrency** | two concurrent first-time authorizations for one booking → one `payments` row, one adapter call; two concurrent approvals of one adjustment → one charge, loser `409`; two overlapping sweep runs → one release | `lib/payments/concurrency.integration.test.ts` |
| **Financial (mandatory)** | master spec §113's list, restricted to what this spec owns: successful payment, failed payment, pending payment, duplicate payment attempts, idempotency, price-change confirmation. Refund, partial refund, cancellation fee, payout pending and payout failure belong to **specs 022/023/024** and are not tested here | `lib/payments/financial.integration.test.ts` |
| **API/authorization** | auth, CSRF, active mode, participant-vs-stranger (`404` not `403`), rate limiting, missing/duplicate/conflicting `Idempotency-Key`, and that `PaymentDto` never serializes `providerReference` | `lib/payments/routes.integration.test.ts` |
| **E2E (Vitest)** | a customer drives booking creation → authorize → confirmed through the real route handlers; a failed payment shows the correct error and leaves no confirmed booking | `e2e/payment.spec.ts` |
| **Privacy** | the export carries the new payment columns and the caller's adjustments and none of `provider_reference` / `provider_name` / `idempotency_*` / attempt failure codes; every payment FK is `RESTRICT`, so financial records cannot be swept; no payment-instrument column exists anywhere | `lib/payments/privacy.integration.test.ts` |
| **UI** | the §105 failure copy with exactly one Try Again and one Change Payment Method; no success shown before a captured response; the price-adjustment dialog naming the exact amount and currency; protection reported flatly with no dispute action | `app/bookings/[id]/payment/page.test.tsx` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/payments/authorize.integration.test.ts::authorizes through the adapter and records its reference`; `lib/payments/no-fabricated-success.test.ts::writes authorized or captured only in record.ts` |
| AC-2 | `lib/payments/authorize.integration.test.ts::attempts no payment at offer acceptance`; `lib/payments/no-fabricated-success.test.ts::is unreachable from any offer or request route` |
| AC-3 | `lib/payments/timing.test.ts::resolves deposit timing with its deposit amount when deposit data exists`; `::is unreachable without real deposit data — no deposit is defaulted into existence`; `lib/payments/price-adjustment.integration.test.ts::chargeRemainder succeeds only once an approval is on record` |
| AC-4 | `lib/payments/price-adjustment.integration.test.ts::proposal charges nothing`; `::approval charges exactly the amount shown`; `::charge without approval is 422 ADJUSTMENT_APPROVAL_REQUIRED`; `::reject charges nothing` |
| AC-5 | `lib/payments/protection-window.integration.test.ts::a captured payment is not released before settlement`; `lib/payments/no-fabricated-success.test.ts::writes no payouts row and computes no fee` |
| AC-5a | `lib/payments/protection-window.integration.test.ts::window starts at the completion history instant regardless of who completed it, and transitions the booking completed → protected`; `lib/payments/protection-window.test.ts::uses the configured duration, defaulting to 48h` |
| AC-5b | `lib/payments/protection-window.integration.test.ts::an elapsed window with no dispute releases protection and settles the booking` |
| AC-5c | `lib/payments/protection-window.integration.test.ts::an open dispute holds protection past elapse and never transitions the booking to disputed` |
| AC-6 | `lib/payments/authorize.integration.test.ts::failure leaves the booking pending and records an attempt`; `::stays retryable after a decline`; `app/bookings/[id]/payment/page.test.tsx::renders the §105 payment error wording and offers retry and change payment method`; `e2e/payment.spec.ts::failed payment confirms no booking` |
| AC-7 | `lib/payments/financial.integration.test.ts::idempotency: same key and fingerprint replays without a second adapter call`; `::a conflicting reuse is 409, not a second charge`; `lib/payments/concurrency.integration.test.ts::concurrent authorizations produce one payment row` |
| AC-8 | `lib/payments/read.test.ts::returns only persisted state and omits providerReference`; `lib/payments/no-fabricated-success.test.ts::keeps lib/ai free of payment status literals` |
| AC-9 | `lib/payments/sweep.integration.test.ts::an unpaid pending booking past the window transitions to failed and releases the slot` |
| AC-10 | `lib/payments/provider/factory.test.ts::a sandbox adapter is refused under NODE_ENV=production`; `lib/payments/routes.integration.test.ts::answers 503 PAYMENT_PROVIDER_UNAVAILABLE when no adapter resolves` |

**Coverage:** ≥80% on new code. The financial-flow tests above are mandatory, not optional.

**Not covered, deliberately:** a real payment vendor's behaviour — no vendor account, credentials
or sandbox exists (§3 "Payment-provider architecture"), and a certification suite against an
adapter this repository does not have would test nothing. Refunds (022), cancellation fees (023),
payouts (024) and disputes (031) are each other specs' financial tests.

**Pre-existing failures this spec does not fix.** Five spec 003 schema-enumeration tests were
already failing before this spec, from the known spec 010/011 catalog defects, and are deliberately
left untouched: `lib/db/schema-coverage.test.ts` (its table list omits `catalog_suggestions`),
`lib/db/schema-lint.test.ts` (six spec 010/011 `jsonb` columns are undocumented exceptions),
`lib/db/migrations.integration.test.ts` (its hardcoded table count predates the catalog tables) and
`lib/db/concurrency.integration.test.ts` × 2 (`INSERT INTO categories DEFAULT VALUES` cannot work
now that spec 010 made `categories.name` NOT NULL — nothing to do with payments). Spec 021 adds one
further expected delta to two of them — `price_adjustments`, and a table count one higher — which
the spec 003 enumeration should absorb when the spec 010/011 defect is fixed by its owner. Fixing
them here would mean editing failing tests this spec does not own.

---

## 7. Out of scope

- **Refund processing** — spec 022, including the `captured → refunded` / `→ partially_refunded`
  transitions and the `refunds` / `refund_lines` baseline tables.
- **Cancellation and no-show fees** — spec 023. This spec charges what it is told to charge.
- **Payout execution, provider earnings, fee calculation, payout methods** — spec 024, including
  every `payouts*` baseline table. This spec produces only the eligibility *fact*.
- **Disputes** — spec 031: creation, evidence, resolution, and the booking `→ disputed` transition.
  This spec ships only the inert dispute port it reads.
- **Booking creation and the booking lifecycle** — spec 020. This spec adds no booking status,
  changes none of spec 020's six transitions, and writes `bookings.status` only through
  `applyBookingTransition()`.
- **A feature-flag system** — spec 041. `PAYMENT_PROVIDER` is an environment variable
  (master spec §133.6), like the two toggles already in `.env.example`.
- **Any change to Home, `ui/`, `app/styles/apuriva-tokens.css`, or `components/index.ts`'s
  primitive set.**
- **Known defects in specs 010/011** — untouched.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Payment provider for the Pakistan market; sandbox credential availability | Platform | **Resolved** (§3 "Payment-provider architecture"): ship the `PaymentProvider` seam plus a clearly labelled sandbox adapter, selected by `PAYMENT_PROVIDER`, with AC-10 refusing a sandbox in production. No credentials are invented and no vendor relationship is claimed (master spec §133.5/§133.7, §132.21/§132.22). Choosing the vendor stays a commercial decision; adopting it is a new file plus a factory entry |
| 2 | Whether the protection language may use the term "escrow" | Legal | **Resolved for implementation**: the word "escrow" appears nowhere in this spec's code, copy, DTOs or error messages. The UI says "payment protection" and describes the mechanism plainly. Master spec §46 cautions against the claim; using it later is a legal decision, not a code change |
| 3 | Booking creation now returns `pending` instead of `confirmed` | Platform | **Resolved, and declared** (§3 "Booking boundary"): spec 020 §3 designed for exactly this by exporting `confirmBooking()` as a separate step. Implemented through a registered port, so `lib/bookings/**` still imports no payment module and spec 020's `payment-boundary.test.ts` passes unmodified. Spec 020's creation-path test assertions change; nothing else of spec 020 does |
| 4 | Protection opens via a sweep, so it lags the completion instant | Platform | **Resolved** (§3 "Protection window"): spec 020 explicitly permits the lag and forbids a callback from booking into payment. AC-5a's exactness is preserved by taking the window's start from the `bookings_status_history` row's `occurred_at`, never from the sweep clock |
| 5 | A crash between the adapter call and recording its outcome | Platform | **Resolved** (§3 "Transaction and lock ordering"): the payment is left non-terminal and reconciled by the sweep through `getStatus(providerReference)`, never re-charged. The provider stays authoritative for money |
| 6 | Multi-currency payments | Product | **Out of scope, named rather than invented**: every amount is copied from one booking in one currency, and I-3/I-12 plus `ADJUSTMENT_CURRENCY_MISMATCH` make a mixed-currency payment impossible rather than silently wrong. Multi-currency is a later product decision |
| 7 | A decline would strand a booking if it marked the payment `failed` | Platform | **Resolved** (§3 "Booking boundary"): `failed` is terminal and I-1 allows one payment row per booking, so marking the row `failed` on the first decline would make the booking permanently unpayable — the opposite of AC-6's retry requirement. A decline writes an append-only `payment_attempts` row and leaves the payment `created`/`requires_action`; only AC-9's sweep, the one moment retrying is genuinely over, moves it to `failed` |

No open question remains that blocks implementation.

---

## 9. Rollout

- **Feature flag:** none. Payments are core, not optional. The *adapter* is swappable by
  `PAYMENT_PROVIDER`; no feature-flag system is introduced (spec 041 owns that).
- **Migration order:** `0017` ships with the code. Because it gates booking confirmation, the
  migration and the deploy are one unit — a deployed gate without the schema would strand every new
  booking in `pending`.
- **Cron:** `/api/v1/cron/payment-sweep` added to `vercel.json` at `* * * * *`, matching
  `/cron/offer-expiry-sweep` — same mechanism, same bearer `CRON_SECRET` check, no new scheduling
  framework. It is idempotent and retry-safe: the next minute's run is the retry, and every pass
  re-checks its predicate under `FOR UPDATE SKIP LOCKED`. Each invocation runs three independent
  passes — open protection on completed bookings, release elapsed undisputed protection, fail
  expired unpaid `pending` bookings — and reconciles any non-terminal payment through `getStatus`.
- **Environment:** two variables are added to `.env` / `.env.example`, kept in parity by
  `npm run check:env` — `PAYMENT_PROVIDER` (adapter selection, §3) and
  `PAYMENT_AUTHORIZATION_WINDOW_MINUTES` (AC-9's window, defaulting to 30 when unset or invalid).
  `NODE_ENV` is also documented there because AC-10's guard reads it. All are environment variables
  per master spec §133.6, not a feature-flag system.
- **Rollback:** revert the deploy and apply `0017_add_payment_processing_protection_down.sql`.
  In-flight payment state is provider-authoritative and reconciled on the next sweep regardless of
  app-code version. Rolling back after real payments exist discards payment rows — the standard
  caveat on every down migration here, and the reason `0017` is gated on empty tables.
- **Observability (master spec §117):** structured logs for `payment.authorize`, `payment.capture`,
  `payment.failed`, `payment.protection_opened`, `payment.protection_released`,
  `payment.authorization_expired` and `price_adjustment.charged`, each carrying `correlationId`,
  `paymentId`, `bookingId` and `status` — never a provider payload and never a provider reference.
  Alert on payment failure rate, adapter latency, protection-window aging, and any payment left
  non-terminal across more than one sweep.
