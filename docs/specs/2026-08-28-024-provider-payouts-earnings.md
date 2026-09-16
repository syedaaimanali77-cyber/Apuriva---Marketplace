# Spec: Provider Payouts & Earnings

**File:** `docs/specs/2026-08-28-024-provider-payouts-earnings.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §6, §48, §49, §50, §68, §69, §70, §72, §73, §105, §113, §117, §124, §125, §132.7, §132.21–§132.22, §133.5–§133.7, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5.2, §8, §9.2, [docs/workflow.md](../workflow.md)

**Depends on:** 003 (the `payouts` / `payout_methods` / `payouts_status_history` /
`payouts_status_transitions` baseline skeletons, the generic `enforce_status_transition()` trigger,
the integer-minor-units money convention), 004 (`withApiRoute`, the error taxonomy, the `payment`
rate-limit domain, `parsePageParams`/`buildPage`, `OPENAPI_ROUTES`), 005 (`requireSession`,
`requireCsrf`, `requireStepUp`, `deriveKey`, `recordSecurityEvent`), 006 (`requireActiveMode`), 008
(retention and the `sweepDeletions` join-in idiom, the privacy export projection, the non-envelope
download idiom), 009 (admin RBAC, risk tiers, `authorizeAndInitiate` / `decideAction` /
`executeApprovedAction` and its audit log), 015 (`requireIdempotencyKey`, `idempotencyFingerprint`),
020 (booking lifecycle, `bookings.provider_profile_id`), 021 (`payments`, `payment_authorizations`,
the protection window, the `PaymentProvider` adapter directory and its production guard, the
`instrumentation.ts` composition root), 022 (`refunds.reconciliation_state`, the implemented
`RefundReconciliationSink` port in `lib/refunds/reconciliation.ts`, and
`refunds_completed_immutable_trg`'s reconciliation exception), 023 (the cancellation fee as a
retention out of captured money — no provider-side money rule).

**Feeds:** 026 (notifications — consumes the notification port this spec ships inert), 031 (disputes
— a dispute reaches this spec only through spec 021's `disputed` protection state or spec 022's
refund fact), 037/040 (admin dashboard, analytics — consume the payout/earnings read models), 038
(moderation/fraud — registers the real `PayoutHoldGate` this spec ships inert), 039 (audit logging —
consumes the admin audit events spec 009 already records for this spec's admin actions), 041
(platform configuration — takes over the environment knobs §9 lists).

---

## 1. Problem statement

**Today:** No payout or earnings mechanism exists anywhere in the repository. `payouts`,
`payout_methods`, `payouts_status_history` and `payouts_status_transitions` are still the spec 003
baseline skeletons: `payouts` carries only `id`, the audit columns, `version`, `provider_profile_id`
and a bare `status text` with **no** `CHECK` and an **empty** `payouts_status_transitions` table
behind its already-attached `payouts_status_transition_trg`; `payout_methods` carries only
`provider_profile_id`. `app/provider/earnings/page.tsx` is a `PlaceholderPage` that names this spec
by number. `lib/payouts/` does not exist. No platform fee, commission or take-rate exists in any
column, module or migration — searching `lib`, `app` and `drizzle` for `platform_fee`, `commission`
or `take_rate` returns nothing financial.

Spec 021 shipped the protection window and stated its boundary exactly (`lib/payments/sweep.ts`):
*"Payout-eligible here means exactly `protection_state = 'released'` and `bookings.status =
'settled'` — a fact spec 024 reads"*, and its `no-fabricated-success.test.ts` asserts that spec 021
*writes no `payouts` row and computes no fee*.

Specs 022 and 023 are **implemented and committed** (`e2e2d08`, `aab5a33`; migrations
`0018_add_refunds` and `0019_add_cancellation_policy_no_show`; `drizzle/meta/_journal.json`'s head is
`0019`). Spec 022 shipped `refunds.reconciliation_state` (`pending`|`reconciled`, default `pending`),
`reconciled_at`, `refunds_reconciliation_idx`, and a live `RefundReconciliationSink` port whose
default only logs `refund.reconciliation_pending`. Its contract: *"a provider must not be reported as
paid, or advanced to payout-eligible, for an amount carried by a refund whose `reconciliation_state`
is still `pending`"*, with `reconciled` reserved as **this spec's only write into `refunds`** — and
`refunds_completed_immutable_trg` permits exactly that write. Spec 022 admits refunds on `protected`
**and `settled`** bookings (`REFUNDABLE_BOOKING_STATUSES` in `lib/refunds/execute.ts`), so refunds
after payout eligibility, and after payment, are real and must be handled. Spec 023's cancellation fee
is a *retention* out of an already-captured amount; `lib/cancellation/**` writes no payout row and
defines no provider-side money rule.

Master spec §48 requires a `Pending → Eligible → Paid` payout lifecycle, an earnings dashboard
(gross, platform fee, refunds, adjustments, net, pending, upcoming, paid, booking-level detail,
filters, exportable statements), payout methods (bank, supported mobile wallets, a default method,
secure payout details, re-authentication for changes, failed-payout recovery), and that the payment
provider handle sensitive credentials where possible.

**Who is affected:** Every provider earning money on the platform; Finance Admins who reconcile,
adjust and recover payouts; Support Admins fielding "where is my money" questions.

**Why it matters now:** It is the last piece of the money-flow milestone. Specs 021, 022 and 023 all
terminate in a fact this spec is the sole consumer of; until it ships, money captured from customers
has no path to providers and no reconciled record of what they are owed.

**Success looks like:** Every settled booking produces exactly one immutable-cored, booking-level
earnings line whose gross, platform fee and net are computed from server-side records only. Lines
become payable only once spec 021's protection window has released **and** no refund against that
booking is in flight or awaiting reconciliation. Payable lines accrue into one open payout batch per
provider per currency, which closes on a schedule and moves
`pending → eligible → processing → paid|failed` through spec 003's **existing** status-transition
trigger, and can never pay the same earnings line twice — structurally, by a unique index, not by an
application check. A refund reconciled after a line has left its open batch reduces the provider's
future payouts through exactly one mechanical recovery item per refund, rather than a second refund
mechanism. Changing a
payout method requires spec 005's step-up token, and no full bank or wallet credential is ever
stored, logged, exported or returned by any route.

---

## 2. Acceptance criteria

The draft's AC-1 … AC-6 are preserved and made testable. AC-7 … AC-15 are added because without them
the four ways a payout system loses money — double payment, ambiguous rail results, post-payment
refunds, and provider-controlled adjustments — are unspecified.

| # | Criterion |
|---|---|
| AC-1 | **Given** a booking whose payment has `protection_state = 'released'` and whose `bookings.status = 'settled'` **When** the payout sweep runs **Then** its earnings line transitions `pending → eligible`; and a booking failing **either** condition, or having any refund in status `requested`/`processing`, or any `completed` refund with `reconciliation_state = 'pending'`, is **not** advanced (§3.4) |
| AC-2 | **Given** a completed refund on a booking that already has an earnings line **When** the reconciliation consumer runs **Then** the line's refunded, fee-reversal and net figures are recomputed from source; if the line's earnings item sits in a `pending` batch it is detached, otherwise exactly one `refund_recovery` payout item of `−Δnet` is written for that refund; `refunds.reconciliation_state` becomes `reconciled` in the same transaction; and no figure anywhere counts the refunded money as still owed, or deducts it twice (§3.7) |
| AC-3 | **Given** a provider's earnings dashboard **When** viewed **Then** gross, platform fee, refunds, adjustments, net, pending, upcoming and paid are all shown, every figure is a sum over persisted rows in one currency, and both identities hold exactly in integer minor units with no client-side arithmetic: `net = gross − fee + adjustments − refunds` and `pending + upcoming + paid = net` (§3.3) |
| AC-4 | **Given** a provider creating, defaulting or removing a payout method **When** the request is made **Then** it is rejected `403 STEP_UP_REQUIRED` unless it carries a valid, unconsumed, action-matched step-up token issued by spec 005's `POST /api/v1/auth/step-up` within the last five minutes, and the successful mutation writes a spec 005 `recordSecurityEvent` row whose metadata carries no destination token |
| AC-5 | **Given** a payout the rail definitively failed **When** the result is recorded **Then** the payout becomes `failed`, its items stay attached, the failure code is stored, the provider and Finance Admins are notified through the notification port, the amount returns to the provider's payable balance, and it remains visible on both the provider dashboard and the Finance surface — it never silently disappears and is never auto-retried without a usable payout method |
| AC-6 | **Given** a provider requesting a statement for a date range **When** the range is valid **Then** a CSV is returned synchronously with one row per earnings line and per adjustment in that range, booking-level detail, and totals that equal the dashboard's figures for the same range and currency, carrying no payout-method detail beyond the stored mask |
| AC-7 | **Given** a payout whose rail call times out or returns an unrecognised result **When** the outcome is recorded **Then** the payout stays `processing` — **never** `failed` and **never** `paid` — no second transfer call is ever issued for that attempt, and the reconcile sweep resolves it via `getPayoutStatus()`, escalating to Finance after `PAYOUT_AMBIGUITY_ESCALATION_MINUTES` rather than guessing |
| AC-8 | **Given** two concurrent payout sweeps, or a sweep overlapping an approved Finance retry **When** they run **Then** exactly one transfer is issued per payout attempt and no earnings line, adjustment or refund recovery is ever paid twice — enforced by `SELECT ... FOR UPDATE SKIP LOCKED`, a per-attempt rail idempotency key, and the partial unique indexes on `payout_items` (I-10) |
| AC-9 | **Given** an earnings adjustment (`credit` or `debit`) **When** it is requested **Then** only a Finance/Super Admin can request it, through spec 009's `authorizeAndInitiate()` on `(resource: 'payouts', action: 'adjust')` at risk tier `high`; the row is created unapplied with immutable amount, currency, kind and provider bound to that `AdminAction`; it affects no figure until a second, distinct admin approves and execution applies it exactly once; a provider can never create, edit or delete one; and nothing but its `applied_at` can ever change |
| AC-10 | **Given** any API response, log line, privacy export, analytics record, error message or statement **When** it concerns a payout method **Then** it carries at most the stored mask, institution label and type — never a full account number, IBAN, wallet number, or the destination token — and the platform stores no payout credential in plaintext at rest |
| AC-11 | **Given** a provider with more than one payout method **When** any method mutation commits **Then** exactly one of that provider's non-removed methods per currency is `is_default = true`, enforced by a partial unique index, and the last remaining method cannot be removed while any payout is `eligible` or `processing` |
| AC-12 | **Given** a payout in any state **When** a transition is attempted **Then** only the transitions seeded into `payouts_status_transitions` are possible — enforced by spec 003's **already-attached** `payouts_status_transition_trg` — and every transition writes exactly one append-only `payouts_status_history` row naming the actor and role |
| AC-13 | **Given** a Support Admin, an Operations Admin, a provider, or a different provider **When** they read any payout, earnings or payout-method resource **Then** each sees exactly the fields §3.14's RBAC matrix grants, an unauthorized id-bearing read is `404` rather than `403`, and no admin below Finance can see a payout-method mask or initiate a payout action |
| AC-14 | **Given** an earnings line **When** anything downstream of its creation changes **Then** its `booking_id`, `payment_id`, `provider_profile_id`, `gross_amount_minor_units`, `platform_fee_bps` and `fee_amount_minor_units` are immutable — enforced by a database trigger — so a later fee-rate change can never retroactively alter what a provider already earned |
| AC-15 | **Given** a provider whose `PayoutHoldGate` reports a hold, or whose account has been anonymized by spec 008's deletion sweep **When** the sweep tries to close that provider's batch **Then** the batch stays `pending`, nothing is transferred, no earned amount is forfeited or deleted, and the batch is surfaced to Finance by the stale-pending alert |

---

## 3. API contract

### 3.0 What this spec reuses rather than re-inventing

| Need | Existing mechanism reused | Deliberately not created |
|---|---|---|
| Payout status enforcement | spec 003's `enforce_status_transition()` and the **already-attached** `payouts_status_transition_trg`; this spec only seeds `payouts_status_transitions` | a new trigger function or a second state-machine framework |
| Payout eligibility fact | spec 021's `payments.protection_state = 'released'` + `bookings.status = 'settled'` | a second protection window or any new duration |
| Refund deduction fact | spec 022's `refunds.reconciliation_state` column and `RefundReconciliationSink` port | a second refund mechanism, a refund policy, or any `provider.refund()` call |
| Credential boundary | `lib/payments/provider/` — the only directory permitted to hold provider credentials or import a vendor SDK | a second credential directory |
| Adapter-selection idiom | spec 021's `resolvePaymentProvider()` shape: an env var, no silent fallback, a hard refusal of a sandbox under `NODE_ENV=production` | a feature-flag system (spec 041 owns that) |
| Step-up re-authentication | spec 005's `requireStepUp(request, session, action)`, `STEP_UP_HEADER_NAME`, 5-minute single-use tokens | a payout-specific re-auth scheme |
| Security audit of credential changes | spec 005's `recordSecurityEvent()` in `lib/auth/security-event.ts` (`security_events` table) | a payout-specific audit table |
| Startup wiring of ports | the `instrumentation.ts` composition root and the `register*Integration()` idiom specs 021/022/023 use | module-import side effects as the only registration |
| Inert-default ports | spec 021's `DisputeGate` / spec 022's sink idiom: `register…` / `get…` / `reset…` with a safe default | a hard dependency on unshipped specs 026/038 |
| Account-deletion behaviour | spec 008's `sweepDeletions()` in `lib/privacy/deletion.ts`, which each spec joins with its own in-transaction redaction step | a payout-specific deletion sweep |
| At-rest encryption | spec 005's `deriveKey(purpose)` + AES-256-GCM, the exact idiom of `lib/auth/totp-secret-crypto.ts` | a new key-management scheme |
| Admin authorization & approval | spec 009's `authorizeAndInitiate()` / `decideAction()` / `executeApprovedAction()` and its audit log, plus its existing `GET /admin/approvals/pending` and approve/reject routes | a payout-specific approval surface |
| Idempotency | spec 015's `requireIdempotencyKey()` / `idempotencyFingerprint()` | a second idempotency scheme |
| Rate limiting | spec 004's existing `payment` domain (10 / 60s) | a new rate-limit domain |
| Pagination | spec 004's `parsePageParams` / `buildPage` | a payout-specific paging shape |
| Background execution | the existing Vercel Cron mechanism: `app/api/v1/cron/*` with bearer `CRON_SECRET`, registered in `vercel.json` | a new scheduler, queue or worker process |
| Non-envelope file response | spec 008's `app/api/v1/users/me/data-export/[id]/download/route.ts` idiom — `NextResponse` with a content type plus the correlation-id header, errors still enveloped | a parallel export framework |

### 3.1 Ownership boundary

| Concern | Owner |
|---|---|
| Authorization, capture, payment status, protection window, `price_adjustments` (the **customer-side** extra charge) | **021**. This spec reads `payments`/`payment_authorizations` and writes none of them. It does not read `price_adjustments` for earnings at all (§3.3) |
| Holding a provider's payouts for fraud, abuse or safety reasons | **038**. This spec ships only the inert `PayoutHoldGate` port it consults (§3.6) |
| Refund creation, execution, rail refund calls, refund status and amounts | **022**. This spec calls no `refund()` and writes exactly two `refunds` columns: `reconciliation_state = 'reconciled'` and `reconciled_at` |
| Cancellation/no-show policy, fee percentages, refund eligibility decisions | **023**. This spec contains no cancellation rule and no fee-tier literal |
| Earnings ledger, platform fee computation, payout lifecycle, payout batching, payout methods, earnings adjustments, statements, rail transfers, recovery | **024 — this spec, entirely** |
| Notification delivery, templates, channels, preferences | **026**. This spec ships an inert port only |
| Dispute creation/resolution | **031**. A dispute reaches this spec only as spec 021's `disputed` protection state (which blocks eligibility) or a spec 022 refund |
| Tax withholding, invoices, statutory statements, multi-currency settlement, instant/on-demand payout | **not owned by any spec yet.** Explicitly out of scope (§7), not invented here |

**Terminology, disambiguated once.** Spec 021's `price_adjustments` table is a **customer-side
additional charge** approved by the customer. Master spec §48's "Adjustments" line on the earnings
dashboard is a different thing: a **Finance-approved correction to the provider's earnings** (a
credit or a debit). This spec calls the latter `earnings_adjustments` and never conflates the two. A
third thing — the **refund recovery** that settles a refund against money already committed to a
payout — is neither: it is a settlement item on `payout_items` (§3.7), not an earnings adjustment, so
it can never be counted twice.

### 3.2 Payout-rail seam (resolves the draft's open question #1)

**Payouts do not belong on spec 021's `PaymentProvider` interface.** `PaymentProvider` models money
coming *in* from a customer's instrument on an acquiring rail (`authorize`, `capture`,
`voidAuthorization`, `getStatus`, and spec 022's `refund`/`getRefundStatus` — a reversal on that same
rail, on the same instrument). A payout is money going *out* to a provider's registered bank account
or mobile wallet on a **disbursement rail**, which in Pakistan is routinely a different vendor, with
different credentials and a different settlement cycle. Adding `payout()` to `PaymentProvider` would
force every acquiring adapter to implement a disbursement product it may not have, and would couple
rail selection to `PAYMENT_PROVIDER`.

**This is not a second competing abstraction.** It is a second *port* inside the **same** credential
boundary using the **same** selection idiom:

- It lives in `lib/payments/provider/` — the one directory permitted to hold provider credentials or
  import a vendor SDK. Spec 021's source guard (`lib/payments/no-fabricated-success.test.ts`) is
  extended to cover it on identical terms.
- `resolvePayoutProvider()` mirrors `resolvePaymentProvider()` exactly: reads `PAYOUT_PROVIDER` fresh
  on every call (never memoized), throws `PayoutProviderUnavailable` on an absent or unknown value
  with **no silent fallback**, and throws when `isSandbox` under `NODE_ENV=production`.
- Exactly one sandbox adapter ships, `sandbox-payout.ts`, self-describing via `isSandbox` and a
  `sandbox_payout_` reference prefix, so a simulated transfer can never be mistaken for a real one in
  the database, in logs or in operator tooling.
- Files: `lib/payments/provider/payout-types.ts`, `lib/payments/provider/sandbox-payout.ts`, and
  `lib/payments/provider/payout-factory.ts` (`PAYOUT_PROVIDER_ENV_VAR`, `resolvePayoutProvider`,
  `PayoutProviderUnavailable`), re-exported from `lib/payments/provider/index.ts` beside the payment
  exports. **Adapters are pure rail clients: they read and write no database table.** This is not
  merely style — spec 021's `lib/payments/no-fabricated-success.test.ts` scans every production file
  under `lib/payments/` and fails on any `INSERT INTO payouts`, `UPDATE payouts`, `payout_methods` or
  `payoutMethods` in code. All payout persistence lives in `lib/payouts/**`, so that guard keeps
  passing **unedited**; this spec adds its own guard instead (§6).
- A rail credential is read only inside these files, as `process.env.PAYOUT_*` names ending in
  `KEY`/`SECRET`/`TOKEN`/`CREDENTIAL`; spec 024's guard fails on such a read anywhere else in `lib/`
  or `app/`, mirroring spec 021's `PAYMENT_*` rule.

```typescript
// lib/payments/provider/payout-types.ts — NEW, this spec
/** Mirrors spec 022's refund trichotomy. `unknown` is NEVER collapsed into `failed`. */
export type PayoutOutcome = 'paid' | 'failed' | 'unknown';

export interface PayoutTransferInput {
  /** The rail's opaque handle for a registered destination. Never an account number. */
  destinationToken: string;
  /** Forwarded as the RAIL's idempotency key. One key per payout ATTEMPT (§3.8). */
  idempotencyKey: string;
  amountMinorUnits: number;
  currencyCode: string;
  /** Opaque correlation for rail-side support. Carries no personal data. */
  reference: string;
}

export interface PayoutResult {
  outcome: PayoutOutcome;
  /** The rail's own handle for THIS transfer. Stored server-side, never serialized to a client. */
  payoutReference: string | null;
  /** A stable machine code, safe to store and echo as `failureCode`. Never a raw rail payload. */
  failureCode?: string;
  /** Operator-facing detail. Never rendered to a provider. */
  failureMessage?: string;
}

/**
 * What the rail returns after its own hosted/embedded onboarding UI has collected the account or
 * wallet details. There is NO parameter anywhere in this file that could carry an account number,
 * IBAN, wallet number or PIN — exactly as spec 021's `types.ts` carries no PAN, CVV or expiry.
 */
export interface RegisteredDestination {
  destinationToken: string;
  type: 'bank' | 'mobile_wallet';
  /** Rail-supplied display mask, e.g. `****1234`. The ONLY detail this platform ever renders. */
  maskedDetail: string;
  /** Rail-supplied label, e.g. a bank or wallet brand. Never free text from the client. */
  institutionLabel: string;
  payoutCurrencyCode: string;
}

export interface PayoutProvider {
  /** Stored on `payouts.provider_name` / `payout_methods.provider_name`. */
  readonly name: string;
  readonly isSandbox: boolean;
  /** Exchanges a single-use setup token from the rail's hosted UI for a stored destination. */
  registerDestination(setupToken: string): Promise<RegisteredDestination>;
  /** Revokes a destination at the rail when a provider removes a payout method. */
  revokeDestination(destinationToken: string): Promise<void>;
  transfer(input: PayoutTransferInput): Promise<PayoutResult>;
  /** Reconciliation READ — the escape hatch for AC-7. Can never move money. */
  getPayoutStatus(payoutReference: string): Promise<PayoutResult>;
  /**
   * Reconciliation READ for an attempt that has no stored reference (a crash between claiming the
   * payout and calling `transfer`, or a rail that returned no handle). Mandatory: an adapter whose
   * rail cannot be queried by idempotency key cannot be adopted without revisiting this spec.
   * Returns `failed` + `transfer_not_received` only when the rail's lookup is authoritative.
   */
  getPayoutStatusByIdempotencyKey(idempotencyKey: string): Promise<PayoutResult>;
}
```

**Stable failure codes.** Adapters map rail responses onto this closed set, which is the only
vocabulary stored in `payouts.failure_code` and echoed in DTOs: `destination_invalid`,
`destination_unavailable`, `rail_temporarily_unavailable`, `transfer_rejected`,
`transfer_not_received`, `unknown_failure`. The sandbox adapter produces each deterministically by
amount suffix, exactly as `lib/payments/provider/sandbox.ts` does for payments.

**Pakistan rail selection is resolved as far as the repository permits.** No payout-rail account,
credentials or vendor decision exists in this repository, and none is invented here. The seam above
plus the sandbox adapter is the whole of what ships; adopting a real rail is a new file implementing
`PayoutProvider` and one entry in `resolvePayoutProvider()`'s adapter map — no call site changes.
A deployment with `NODE_ENV=production` and a sandbox adapter refuses to run, so it cannot report a
payout nobody made (master spec §132.21, §132.22, §133.5).

### 3.3 Financial source of truth and earnings calculation (AC-3, AC-14)

All money is integer minor units — master spec §6 and spec 003 AC-1, enforced by
`npm run check:schema-money-lint`, which forbids `numeric`/`real`/`double precision` **anywhere** in
the schema. No floating-point arithmetic appears in any calculation below.

**Authoritative inputs**, all server-side rows, never a client value:

| Term | Authoritative source | Notes |
|---|---|---|
| `gross` | `SUM(payment_authorizations.captured_amount_minor_units) WHERE payment_id = p.id AND captured_at IS NOT NULL` for the booking's single payment | **Exactly the query spec 022 uses** for its refund cap (`lib/refunds/amounts.ts`), so refunds can never exceed gross (I-4). Spec 021 enforces `UNIQUE (booking_id)` on `payments`. Zero/`NULL` ⇒ nothing was captured ⇒ **no earnings line is created** |
| `feeBps` | `platform_fee_bps`, **snapshotted onto the line at creation** from `resolvePlatformFeeBps()` | Immutable afterwards (AC-14) |
| `refundedTotal` | `SUM(refunds.total_amount_minor_units)` over that payment's refunds with `status = 'completed' AND reconciliation_state = 'reconciled'` | Spec 022 owns the rows. A refund enters this sum only in the transaction that marks it reconciled, so each refund's effect is applied exactly once (§3.7) |
| `adjustments` | `SUM(earnings_adjustments.adjustment_amount_minor_units) WHERE applied_at IS NOT NULL`, signed | Credits positive, debits negative. An unapproved or rejected adjustment counts nowhere (§3.10) |

**Charged `price_adjustments` are not earnings in this spec — verified in code, not assumed.**
`lib/payments/price-adjustment.ts` charges an approved adjustment through a separate
`provider.authorize()` call, treats either `authorized` **or** `captured` as success, writes only a
`payment_attempts` row and `price_adjustments.status = 'charged'`, and writes **no**
`payment_authorizations` row. The repository therefore holds no evidence that adjustment money was
ever *captured*, and spec 022 cannot refund it (its cap is the same captured sum). Counting it as gross
would pay providers money the platform may never have received. This spec takes captured money only;
the missing capture record is a **spec 021 gap reported, not patched here** (§8 #5). Until spec 021
records adjustment captures in `payment_authorizations` — at which point they enter `gross` through the
query above with no change to this spec — a provider owed for approved extra work is paid through a
Finance-approved `credit` adjustment.

**Rounding is defined once, is integer-only, and is half-up on the fee:**

```
feeOn(base) = trunc((base * feeBps + 5000) / 10000)      // base >= 0, feeBps in [0, 10000]
```

Half-up rounds the *platform's* fee, so the result is identical on every machine and no remainder is
silently taken from a provider twice. `base * feeBps` is bounded well inside `Number.MAX_SAFE_INTEGER`
for any amount an `integer` column can hold.

**Per earnings line**, recomputed from the sources above on every change — never incrementally
patched, so it cannot drift:

```
feeGross    = feeOn(gross)                 // stored as fee_amount_minor_units; immutable
netBase     = gross − refundedTotal        // always >= 0; see I-4
feeNet      = feeOn(netBase)
feeReversal = feeGross − feeNet            // stored as fee_reversal_amount_minor_units; >= 0
lineNet     = netBase − feeNet             // stored as net_amount_minor_units; always >= 0
```

`feeOn` is monotonic in its argument, so `feeNet ≤ feeGross` and `feeReversal ≥ 0` always hold.

The platform therefore **charges no fee on refunded money**, and a partial refund proportionally
reverses the fee. Because `feeNet` is recomputed from the cumulative `refundedTotal` rather than
accumulated per refund, a sequence of partial refunds produces exactly the same result as one refund
of the same total — no rounding drift, asserted by a test.

**Dashboard totals**, per currency, summed over the provider's lines and applied adjustments. Every
figure is a `SUM` over persisted integer columns — none is a difference computed in application code
from other figures:

```
gross       = Σ line.gross_amount
fee         = Σ (line.fee_amount − line.fee_reversal_amount)   // fee net of reversals
refunds     = Σ line.refunded_amount
adjustments = Σ applied adjustment.amount                      // signed
net         = gross − fee + adjustments − refunds              // identity 1 (AC-3)

pending     = Σ line.net_amount WHERE line has no earnings item
                                  AND line.state = 'pending'
upcoming    = Σ line.net_amount WHERE line.state = 'eligible' AND line has no earnings item
            + Σ applied adjustment.amount WHERE adjustment has no payout item
            + Σ item.amount WHERE item's payout.status IN ('pending','eligible','processing','failed')
paid        = Σ item.amount WHERE item's payout.status = 'paid'
pending + upcoming + paid = net                                // identity 2 (AC-3)
balance     = upcoming                                         // may be negative; see §3.7
```

Identity 2 holds because every unit of net is in exactly one place: an unattached line or adjustment,
or a payout item. An attached line's `net_amount` always equals its earnings item plus every recovery
item written for it (I-24), which is what the reconciliation rules in §3.7 preserve. Both identities
hold over the **unfiltered** (all-time) summary and are asserted by tests over mixed ledgers, not by
inspection. When `from`/`to` are supplied, each figure sums only the rows selected by date (§3.11's
selection columns); identity 1 still holds per line, but identity 2 is not claimed for a filtered
view, because an item can fall in a different period from the line it settles. The client performs **no** arithmetic;
the DTO carries finished integers and the UI formats them (master spec §6: formatting at the
presentation layer).

**Currency.** One currency per earnings line — the booking's `price_currency_code`, which specs 021
and 022 already force to equal the payment's and the refund's. Summaries, balances, payouts and
statements are **always scoped to a single currency**; cross-currency netting is impossible by
construction (I-6, I-9). A provider with lines in more than one currency has one balance and one
payout stream per currency.

**Negative values.** No stored amount on an earnings line is ever negative (I-4). Negative amounts
exist in exactly two places: a `debit` adjustment, and a `refund_recovery` payout item. A `pending`
batch's running total may therefore be negative; a payout **never closes** unless its total is
strictly positive (I-2), so no negative transfer is representable. A negative balance simply means no
payout is sent until later earnings bring it back above zero (§3.7).

**Duplicate events.** Every input is keyed, so idempotency is structural rather than advisory:

- one earnings line per booking — `UNIQUE (booking_id)`;
- at most one live earnings item per line — `UNIQUE (earnings_line_id) WHERE kind = 'earnings_line'`;
- at most one item per adjustment — `UNIQUE (adjustment_id) WHERE kind = 'adjustment'`;
- at most one recovery item per refund — `UNIQUE (source_refund_id) WHERE kind = 'refund_recovery'`;
- a refund is reconciled once — the conditional `UPDATE refunds ... WHERE reconciliation_state = 'pending'`.

A replayed sweep, a duplicated port callback and a concurrent cron invocation therefore all collapse
to the same row.

**The platform fee rate is configured, never guessed.** `resolvePlatformFeeBps()` reads
`PLATFORM_FEE_BPS`, requires an integer in `[0, 10000]`, and otherwise throws
`PlatformFeeUnconfigured` — the same no-silent-fallback rule spec 021 applies to `PAYMENT_PROVIDER`,
for the same reason: guessing a commission is how a provider is quietly underpaid. An earnings line
is **not created** while the rate is unconfigured; the sweep logs `earnings.fee_unconfigured`, alerts
(§9), and the booking is picked up on a later run once the rate is set. Nothing is paid on a guess and
nothing is lost. No commercial rate is invented here: `.env.example` documents the variable with the
neutral value `0` so `npm run check:env` passes and local runs work, every test sets its own explicit
rate, and a production deployment must set the real rate deliberately (§8 #3).

### 3.4 Eligibility (AC-1) — spec 021's semantics, unchanged

**No new protection duration is invented.** Spec 021's window is the window: default
`DEFAULT_PROTECTION_WINDOW_HOURS = 48`, per-payment configurable in `[1, 720]` via
`payments.protection_window_hours`, resolved by `resolveProtectionWindowHours()` and released by
`/api/v1/cron/payment-sweep`. This spec reads the resulting state and adds no second window, no
separate "refund window" and no additional delay.

An earnings line moves `pending → eligible` only when **every** condition holds, evaluated in one
transaction with the booking and payment rows locked `FOR UPDATE`:

| # | Condition | Why |
|---|---|---|
| E-1 | `payments.protection_state = 'released'` | Spec 021's authoritative release. `held` and `disputed` both block |
| E-2 | `bookings.status = 'settled'` | The other half of the same fact; both are required, never either |
| E-3 | `payments.status IN ('captured','partially_refunded')` | A payment that reached `refunded` was returned in full — its line's net is `0` and there is nothing to pay |
| E-4 | No refund for that payment in `status IN ('requested','processing')` | Spec 022 holds a reservation against those; paying now could pay money about to be returned |
| E-5 | No refund for that payment with `status = 'completed' AND reconciliation_state = 'pending'` | Spec 022's stated contract, quoted in §1, honoured literally |
| E-6 | The line exists with its immutable `gross`, `feeBps` and `fee_amount`; a line with `lineNet = 0` still becomes `eligible` and contributes nothing | a zero-value line is not an error, and must not wedge the sweep |

E-1 through E-5 are re-checked **under the lock** before the line is attached to a batch and again
before the batch closes, so a refund arriving between passes cannot slip through.

**Payment status alone never gates money already committed.** A full refund on a settled booking
moves the payment to `refunded` and the booking `settled → refunded` (spec 022's seeded transitions).
E-2/E-3 only decide whether an *unattached* line may advance; a line already attached to a closed
payout is settled through recovery items (§3.7), never by re-evaluating E-1…E-5.

A booking that never settles never produces a payable line. In particular, a **cancelled** booking
carrying a retained cancellation fee (spec 023's tier T4) produces **no provider earnings line**: no
spec assigns the retained fee to the provider, and inventing a revenue-share rule here would be a
product decision this spec has no authority to make. Where a provider should be compensated for a
cancelled booking, an auditable mechanism already exists — a two-admin Finance adjustment (§3.10).
Recorded as **DECIDED**, not open (§8 #4).

### 3.5 Payout state machine (AC-12, AC-7, AC-8)

```
  pending ──► eligible ──► processing ──► paid
                 ▲              │
                 │              └──► failed
                 └──── recovery ─────┘
```

Seeded into `payouts_status_transitions` — **exactly these five pairs and no others**:

```
pending    → eligible
eligible   → processing
processing → paid
processing → failed
failed     → eligible      -- the single recovery transition (§3.8)
```

`paid` is terminal and has no outgoing transition. `pending → failed` and `eligible → failed` are
deliberately absent: nothing can fail before the rail has been asked. `processing → eligible` is
absent: an in-flight transfer is resolved by a **read** (`getPayoutStatus`), never by rewinding.

Enforcement is spec 003's **existing** mechanism. `payouts_status_transition_trg` is already attached
to `payouts` in the baseline; this spec only seeds the lookup table and adds `payouts_status_ck`. No
new trigger function is written, and `STATE_MACHINE_ENTITIES` stays at five — no sixth status machine
is introduced.

| State | Meaning | Items | Money |
|---|---|---|---|
| `pending` | The provider's single **open accruing batch** for a currency. Eligible lines, applied adjustments and refund recoveries attach here as they arise; its total may be negative | mutable (attach; detach only of an earnings item, §3.7) | none moved |
| `eligible` | The batch is **closed and snapshotted**: total fixed, destination fixed, ready to transfer | frozen | none moved |
| `processing` | A transfer attempt is in flight, or its outcome is unknown | frozen | possibly moved — never assumed either way |
| `paid` | The rail definitively confirmed the transfer | frozen | moved |
| `failed` | The rail definitively refused | frozen; the amount returns to the payable balance | not moved |

**One open `pending` payout per `(provider_profile_id, payout_currency_code)`** — a partial unique
index (I-18), which is what makes "attach to the open batch" a single conflict-safe upsert rather
than a race. **Items are frozen the moment their payout leaves `pending`**: `payout_items_frozen_trg`
rejects any `INSERT` into, and any `UPDATE` or `DELETE` of an item belonging to, a payout whose status
is not `pending` (I-25). Once a batch closes, nothing can change what it will pay.

`payouts_status_history.actor_role` records who caused each transition: `system` for the sweeps
(with `actor_user_id` null) and `admin` for an approved Finance retry. No transition is ever caused
by a provider, so `provider` is not in the vocabulary (I-19).

The earnings **line** carries a separate, deliberately minimal marker — `pending | eligible | paid` —
with monotonic `eligible_at`/`paid_at` instants and an immutability trigger (I-7, I-8). It is not a
second status machine: it has no transition table, no trigger function and no history table, because
every line movement is already provable from durable evidence elsewhere (its instants, and its
`payout_items` row). Backwards movement is rejected by trigger, with one explicit exception —
`eligible → pending`, used only when a refund returns a line for re-evaluation (§3.7) — which is
permitted only while the line has no earnings item, i.e. it was never attached or has just been
detached from a still-`pending` batch. A `paid` line can never move.

### 3.6 Payout creation and aggregation (AC-1, AC-8)

The draft's "one `Payout` row per booking" is **rejected**: it cannot express batching (real
disbursement rails charge per transfer), cannot carry a recovery that spans bookings, and forces the
booking-level dashboard detail and the transfer record to be the same row — so a failed transfer
would corrupt the earnings history. The repository's own shape — a ledger table, a transfer record
and a join — is used instead:

| Table | Role |
|---|---|
| `provider_earnings_lines` (**new**) | The ledger. One immutable-cored row per settled booking. Booking-level dashboard detail, the gross/fee/net math, and the `pending`/`eligible`/`paid` marker |
| `earnings_adjustments` (**new**) | Finance-approved `credit`/`debit` corrections, bound to their `AdminAction` and applied exactly once |
| `payouts` (**altered baseline**) | The transfer record and the only status machine. One open batch per provider per currency |
| `payout_items` (**new**) | The settlement join. Kinds `earnings_line`, `adjustment`, `refund_recovery`, each with the exact signed amount it contributes. The partial unique indexes (I-10) are what make double payment structurally impossible |

**Sweep scope.** `runPayoutSweep()`, `runPayoutReconcileSweep()`, the automatic-retry pass and the
revocation retry each accept an optional `{ providerProfileIds }` scope that restricts every candidate
query to those providers. The cron routes pass none — the whole platform, every run. A scope exists for
a targeted operational replay of specific providers, and so that suites sharing one test database drive
only their own rows (an unscoped sweep in one test process would otherwise act on another process's
rows through a rail sandbox that does not know them).

**Pass A — line creation and eligibility.** `/api/v1/cron/payout-sweep`, schedule `*/5 * * * *`,
implemented as a `GET` route with the same inline `Bearer ${CRON_SECRET}` check every existing cron
route uses (`app/api/v1/cron/refund-reconcile-sweep/route.ts`):

1. Select up to 200 bookings with `status = 'settled'` and no `provider_earnings_lines` row, without
   locking.
2. For each, in one transaction: lock booking → payment `FOR UPDATE SKIP LOCKED` (skip if locked or no
   longer `settled`), compute `gross` (skip if zero), resolve and snapshot `platform_fee_bps`, mark
   every `completed` refund on that payment whose `reconciliation_state = 'pending'` as `reconciled`
   (no recovery is needed: the line has no item yet), compute `refundedTotal`/`feeNet`/`lineNet` from
   those, and insert the line in state `pending`. `UNIQUE (booking_id)` turns a concurrent duplicate
   into a caught unique violation and a no-op. A booking that went `settled → refunded` before this
   pass never gets a line — its net would be zero.
3. Select `pending` lines, re-check E-1…E-6 under the lock, and move qualifying lines to `eligible`,
   stamping `eligible_at` from `clock_timestamp()` — the **database** clock, read in a statement
   issued after the lock is held, exactly as specs 018/020/021 established. Never `now()` (frozen at
   transaction start) and never a client clock.

**Pass B — batch accrual.** For each provider with `eligible` lines or applied adjustments not yet on
a payout: `INSERT ... ON CONFLICT DO NOTHING` the open `pending` payout for that
`(provider, currency)`, insert an `earnings_line` item (amount = the line's current `net_amount`) for
each unattached eligible line and an `adjustment` item for each unattached applied adjustment, and
recompute `payouts.payout_amount_minor_units` as the sum of its items **in the same transaction**.

**Pass C — batch close.** A `pending` payout closes to `eligible` when **all** hold:

- `payout_amount_minor_units > 0` and `>= PAYOUT_MINIMUM_MINOR_UNITS` (default `0`, i.e. no minimum
  beyond "strictly positive" — a threshold that withholds a provider's money is not invented here);
- `getPayoutHoldGate()(tx, providerProfileId)` reports `{ held: false }`. The gate is a port with an
  inert default that never holds — the same idiom as spec 021's `DisputeGate` — because payout holds
  for fraud, abuse or safety belong to spec 038, which registers the real gate. This spec invents no
  hold rule;
- the provider's user is not `deleted` (spec 008's `sweepDeletions` also removes the methods, see
  §4.4, so this is a second, independent guard);
- at least `PAYOUT_BATCH_CLOSE_INTERVAL_HOURS` (default 24) have elapsed since the payout's
  `created_at`;
- the provider has exactly one `is_default = true`, non-removed, `verified` payout method in the
  payout's currency whose `destination_token_encrypted` decrypts — snapshotted onto the payout as
  `payout_method_id` at close time, so a later method change cannot redirect an already-closed payout;
- re-verification of E-1…E-5 for every attached line still passes. A line that no longer qualifies
  (a refund arrived) is **detached**, returned to `pending`, and the total recomputed before the close.

A payout with no usable default method stays `pending` indefinitely, is surfaced on the provider
dashboard as "add a payout method to be paid", and is alerted on after `PAYOUT_STALE_PENDING_HOURS`
(default 168). Nothing is ever paid to a destination the provider has not registered.

**Pass D — transfer.** Spec 021's three-phase discipline, unchanged, because a rail call must never
happen inside a transaction:

| Phase | Transaction? | What happens |
|---|---|---|
| 1 — claim | yes | `SELECT ... FOR UPDATE SKIP LOCKED` one `eligible` payout; increment `attempt_count`; transition `eligible → processing` conditionally on `version`; commit. The payout is now claimed by exactly one worker |
| 2 — call | **no** | one `transfer()` with `idempotencyKey = payout:{payoutId}:{attemptCount}` — a key per *attempt*, so a network retry of the same attempt deduplicates at the rail while a deliberate recovery attempt is a genuinely new transfer |
| 3 — record | yes | read the payout's earnings-line ids unlocked, then lock lines → payout in global order; apply the outcome conditionally on the `version` read in phase 1; `paid` → `paid`, stamp `paid_at`, mark each `earnings_line` item's line `paid` with the same instant; definitive `failed` → `failed` with `failure_code`/`failure_reason`; `unknown` → **leave `processing`**, storing any `payoutReference` returned; write the history row; commit; emit notifications after commit |

**Global lock order**, extending spec 022's `bookings → payments → refunds`:
`bookings → payments → refunds → provider_earnings_lines → earnings_adjustments → payouts →
payout_items`, and **ascending `id` within a table** when a pass locks several rows of one table.
A pass that discovers rows of an earlier table through a later one — Pass C and Pass D phase 3 find
lines through a payout's items — first reads the ids **without** locking, then locks in global order,
then re-reads and re-validates under the locks, abandoning the work if anything moved. Every pass
follows this rule, which is what makes the payout sweep, the reconcile sweep, the refund sink and an
approved Finance retry deadlock-free against each other and against spec 022's own refund execution.

### 3.7 Refund reconciliation (AC-2) — one mechanism, never a second refund path

This spec **executes no refund**. It consumes spec 022's durable fact through two entry points that
share one code path:

1. **Push** — `registerPayoutIntegration()` (called from `instrumentation.ts`, like specs 021–023)
   registers a `RefundReconciliationSink` through spec 022's `registerRefundReconciliationSink`. Spec
   022 calls it **after its own transaction commits**, fire-and-forget, and swallows a throw
   (`emitRefundReconciliation`); the sink opens its own transaction. The event carries `refundId`,
   `bookingId`, `paymentId`, `providerProfileId`, `amountMinorUnits`, `currencyCode` and `completedAt`,
   but the sink **uses only `refundId`** and re-reads every figure from the database under lock — the
   event payload is never trusted as financial input.
2. **Pull** — the same `/api/v1/cron/payout-sweep` scans
   `refunds WHERE status = 'completed' AND reconciliation_state = 'pending'` via spec 022's
   `refunds_reconciliation_idx`. **This is the source of truth**; the port is a latency optimisation.
   A missed, throwing or never-registered sink therefore loses nothing.

For each such refund, in one transaction locking `bookings → payments → refunds → line → payouts →
payout_items` in the global order (§3.6), with the refund re-read and skipped unless still
`completed`/`pending`:

| Situation | Effect |
|---|---|
| No earnings line for the booking | Mark the refund `reconciled`. If the booking later gets a line, Pass A computes it from every reconciled completed refund, so nothing is lost. A booking that never settles never gets a line and the provider was never credited |
| The line exists and has **no** earnings item | **Reduce in place.** Mark the refund reconciled, recompute `refunded`/`fee_reversal`/`net` from source. If the line was `eligible`, return it to `pending` for re-evaluation |
| The line's earnings item is in a **`pending`** batch | **Detach.** Delete the earnings item (permitted by I-25 because the batch is still `pending`), recompute the batch total, mark the refund reconciled, recompute the line, and return it to `pending`. The next passes re-attach it at its new net. No recovery item is needed because nothing has been committed |
| The line's earnings item is in a payout that is `eligible`, `processing`, `paid` or `failed` | That amount is **committed**. Mark the refund reconciled, recompute the line (`Δ = oldNet − newNet ≥ 0`), and — if `Δ > 0` — insert exactly one `refund_recovery` item of `−Δ`, with `source_refund_id` and `earnings_line_id`, into the provider's open `pending` batch for that currency (creating it if needed). If `Δ = 0` (e.g. `feeBps = 10000`) no item is written |
| The refund is already `reconciled` | No-op. The conditional `UPDATE ... WHERE reconciliation_state = 'pending'` writes nothing and the transaction does nothing else |

Each refund enters `refundedTotal` only in the transaction that reconciles it, so `Δ` is exactly that
refund's effect on the line; `UNIQUE (source_refund_id) WHERE kind = 'refund_recovery'` makes a
second recovery for the same refund impossible; and the reconciled flag, the line update and the
recovery item commit together or not at all. The invariant this preserves, asserted by tests
(I-24): **for every attached line, `net_amount` = its earnings item + Σ its recovery items.**

**Already-paid money is never clawed back from the rail.** A recovery is a negative item in the
provider's next batch. If the batch total is not positive, it does not close;
the negative balance is shown honestly to the provider as an amount to be recovered and to Finance as
a recoverable, and is alerted on after `PAYOUT_NEGATIVE_BALANCE_ALERT_DAYS` (default 30). **No debit
is ever initiated against a provider's bank account: this spec has no such primitive, deliberately.**

Spec 022's `refunds_completed_immutable_trg` permits exactly `reconciliation_state`, `reconciled_at`,
`updated_at` and `version` on a `completed` refund — precisely the columns written here, and nothing
else.

### 3.8 Failed payouts and rail ambiguity (AC-5, AC-7)

| Rail result | Payout status | Items | Next |
|---|---|---|---|
| `paid` | `paid`, `paid_at` stamped | lines marked `paid` | notification `payout_paid`; the amount leaves the payable balance |
| `failed` (definitive code) | `failed`; `failure_code`/`failure_reason` stored | stay attached | notifications `payout_failed` to the provider **and** to Finance; the amount returns to the payable balance; recovery per below |
| timeout / transport error / `unknown` | stays `processing` | frozen | resolved **only** by a rail read in the reconcile sweep (`getPayoutStatus` or `getPayoutStatusByIdempotencyKey`); never auto-failed, never auto-retried, never a second `transfer()` for that attempt |

**Recovery from `failed`** is the single `failed → eligible` transition, and is never automatic while
the cause persists. It fires when **either**:

- a Finance Admin retry is **approved and executed** through `POST /api/v1/admin/payouts/{id}/retry`
  — permission `(payouts, retry)` at risk tier **`high`**. Master spec §70 names "Payout intervention"
  as potentially sensitive, and an approval-gated tier is what spec 022 chose for the analogous refund
  override. The route follows spec 022's implemented two-shape idiom (`app/api/v1/admin/refunds`):
  without `adminActionId` it calls `authorizeAndInitiate()` with `targetType: 'payout'` and
  `targetId` = the payout id, and answers `202` with no state change; with `adminActionId` it calls
  `executeApprovedAction()` (`422 APPROVAL_REQUIRED` while `Pending`, `409 APPROVAL_NOT_ELIGIBLE` if
  rejected or already executed), checks the action's target is this payout, re-verifies the payout
  is still `failed` under lock, and only then transitions it. The retry needs no amount — the approved
  target fully determines what is retried; **or**
- the sweep retries automatically (`actor_role = 'system'`), and only in two closed cases: the stored
  `failure_code` is `rail_temporarily_unavailable` or `transfer_not_received` (the rail
  authoritatively holds no transfer, so a new attempt cannot duplicate one) and at least
  `PAYOUT_RETRY_BACKOFF_MINUTES` (default 30) have passed since the failure; **or** the code is
  `destination_invalid` or `destination_unavailable` and the provider has set a different usable
  default method since the failure. `transfer_rejected` and `unknown_failure` are never retried
  automatically.

Before `failed → eligible`, the payout's `payout_method_id` is **re-snapshotted** to the provider's
current usable default method, under the same conditions as Pass C; if none exists the payout stays
`failed`. Either way a retry is a **new attempt**: `attempt_count` increments in phase 1, the rail
idempotency key therefore changes, and `payouts_status_history` gains two rows (`failed → eligible`,
then `eligible → processing`) carrying the actor and role. A non-retryable failure code stays `failed`
until Finance acts. `PAYOUT_MAX_AUTOMATIC_ATTEMPTS` (default 3) bounds automatic retries; beyond it
only a Finance Admin may retry, so a persistently failing destination cannot loop.

Retrying on the **same** payout row (rather than spec 022's "retry is a new row") is deliberate and
justified by a real difference: a refund targets an opaque customer instrument whose state may be
ambiguous, whereas a payout targets a stable registered destination whose rail status is
authoritatively readable. Keeping the row preserves the `payout_items` mapping — and with it
`UNIQUE (earnings_line_id)`, the structural guarantee behind AC-8. Every attempt remains individually
auditable through `attempt_count` and the append-only history rows.

**Ambiguity resolution.** `/api/v1/cron/payout-reconcile-sweep`, schedule `* * * * *`, selects
`processing` payouts and resolves each with a **read**, which can never move money. The outcome is
recorded through the same phase-3 routine the live path uses — under the payout's `FOR UPDATE` lock and
conditional on the payout still being `processing` at the same `attempt_count` — so overlapping sweeps,
or a sweep overlapping a live worker, apply it exactly once:

- with a stored `payout_reference`: `getPayoutStatus(payout_reference)`;
- with a `null` reference — the process died between phase 1 and phase 2, or the rail returned no
  handle: `getPayoutStatusByIdempotencyKey('payout:{id}:{attempt_count}')`, consulted **only once the
  attempt has been `processing` for at least `PAYOUT_ATTEMPT_GRACE_MINUTES`** (default 15). A live
  worker may still be inside its rail call before that; a key lookup then could report
  `transfer_not_received` for a transfer that is about to happen. Both the grace period and the
  escalation threshold are measured from the claim instant, `payouts.updated_at`, which phase 1 sets
  and which neither recording a reference nor escalating changes. This is a **mandatory**
  method of the `PayoutProvider` contract (§3.2), because a rail that cannot be queried by the key it
  deduplicates on could strand a claimed payout forever. An adapter maps "the rail never received this
  key" to `failed` with code `transfer_not_received` **only** when the rail's key lookup is
  authoritative; otherwise it returns `unknown`.

A result of `unknown` leaves the payout `processing`; after `PAYOUT_AMBIGUITY_ESCALATION_MINUTES`
(default 60, mirroring spec 022's threshold) it is **escalated to Finance**, stamping `escalated_at`,
and the sweep keeps polling. It is never auto-failed, never auto-retried, and this spec offers **no
manual "mark paid" or "mark failed" action**: marking it failed could let a second transfer be issued
for money that already moved, and marking it paid would report a transfer the rail never confirmed
(master spec §132.7). The rail stays the only authority. The sweep is idempotent — the next minute's
run is the retry.

**A timeout can therefore never produce a duplicate payout**: the transition into `processing` commits
*before* the call, the `version`-conditional record in phase 3 rejects a stale writer, only
`processing → paid|failed` are seeded exits, and resolution is a read.

### 3.9 Payout-method security (AC-4, AC-10, AC-11)

**The platform stores no payout credential.** There is no account-number, IBAN, wallet-number, PIN or
CNIC column in this spec, and no parameter in `payout-types.ts` that could carry one. Details are
collected by the rail's own hosted/embedded onboarding UI — exactly as spec 021 keeps card data off
every Apuriva route — which returns a single-use `setupToken`. The server exchanges it via
`registerDestination(setupToken)` and stores **only what the rail returns**:

| Stored | Not stored |
|---|---|
| `type` (`bank` \| `mobile_wallet`) — rail-supplied | any account/IBAN/wallet number |
| `masked_detail` — **rail-supplied**, e.g. `****1234` | any full detail, even encrypted |
| `institution_label` — rail-supplied | free text from the client |
| `destination_token_encrypted` — AES-256-GCM at rest via `deriveKey('payout-destination-token-encryption')`, the exact `lib/auth/totp-secret-crypto.ts` idiom | the token in plaintext |
| `payout_currency_code`, `verification_state`, `provider_name` | anything the client asserted about itself |

`masked_detail` and `institution_label` are **never** taken from the request body. A client that
supplies them is ignored, so a client cannot label its own destination "HBL ****9999" and have that
rendered anywhere. `payout_methods_masked_detail_ck` additionally rejects at the database any mask
containing more than four digits (I-15), so a full account number is not even representable.

**Step-up rules (AC-4).** Spec 005's mechanism is used **as shipped** — this spec neither forks nor
weakens it. A valid step-up is a token issued by `POST /api/v1/auth/step-up` for the **exact** action
string below, bound to the current session, **single-use**, and **no more than 5 minutes old**
(`STEP_UP_VALIDITY_MS`). Missing, expired, consumed, wrong-session and wrong-action all collapse to
the same `403 STEP_UP_REQUIRED`, leaking nothing about which.

| Mutation | Step-up action | Required |
|---|---|---|
| `POST /providers/me/payout-methods` | `manage_payout_method` | yes |
| `PATCH /providers/me/payout-methods/{id}` (set default) | `manage_payout_method` | yes |
| `DELETE /providers/me/payout-methods/{id}` | `manage_payout_method` | yes |
| `GET /providers/me/payout-methods` | — | no. A masked list is not a credential |
| Any earnings read, payout read or statement export | — | no |

Because tokens are single-use, each mutation needs its own; a client performing two mutations obtains
two tokens. The UI requests the token immediately before submission so it cannot expire mid-form
(§5.2).

Two properties of spec 005's shipped mechanism are inherited, not fixed here, and are recorded in §8
#6 rather than silently assumed: `POST /auth/step-up` issues a token to any live session without
re-checking a credential, and tokens live in a per-process in-memory `Map` (`lib/auth/step-up.ts`), so
a token issued by one server instance is unknown to another. Both already apply to spec 008's data
export, deletion, MFA and logout-all routes. Strengthening issuance or moving the store to shared
storage is spec 005/008's to own; a payout-specific re-auth scheme would be exactly the second
mechanism this repository refuses to create. The consequence for this spec is fail-closed: a token
that cannot be verified is `403 STEP_UP_REQUIRED`, never a bypass.

**Uniqueness and concurrency (AC-11).** `payout_methods_default_uq` is a partial unique index on
`(provider_profile_id, payout_currency_code) WHERE is_default AND removed_at IS NULL`. Setting a new
default clears the old one and sets the new one in **one transaction** with the provider's rows locked
`FOR UPDATE`, so two concurrent "make this default" requests cannot both win — the index rejects the
loser, which is retried once and then reports `409 CONFLICT`. Removal is a **soft delete**
(`removed_at`): financial history must stay intelligible and `payouts.payout_method_id` is `RESTRICT`.
Removal is refused `422 PAYOUT_METHOD_IN_USE` in two cases: the method is snapshotted as
`payout_method_id` on any payout that is `eligible` or `processing` (a closed payout's destination is
fixed and must stay usable), or it is the provider's last non-removed method while any of their payouts
is `eligible` or `processing`. A removed method is never used again, whether or not
the rail has revoked it: the soft delete commits first, and `revokeDestination()` is called **after**
commit. `payout_methods.revoked_at` records success; the payout sweep retries every removed,
unrevoked method, so a rail outage never blocks removal and never leaves a destination silently live
at the rail. The rail is never called inside a transaction.

**Audit.** Every payout-method mutation writes a durable `security_events` row through spec 005's
`recordSecurityEvent()` (`lib/auth/security-event.ts`): `eventType` ∈
`payout_method.created` \| `payout_method.default_changed` \| `payout_method.removed`,
`severity: 'warning'`, and `metadata` = `{ payoutMethodId, type, maskedDetail, correlationId }` —
**never** the setup token or the destination token, encrypted or otherwise. Every admin action on a
payout goes through spec 009's `recordAdminAuditEvent`, which already captures actor, roles, target,
reason and approval chain; master spec §72's "Payout intervention" requirement is therefore satisfied
with no new mechanism.

### 3.10 Earnings adjustments (AC-9)

| Kind | Who may request | Authorization | Sign |
|---|---|---|---|
| `credit` | Finance Admin or Super Admin | spec 009 `authorizeAndInitiate('payouts', 'adjust')` at risk tier **`high`** ⇒ a second, distinct admin must approve | positive |
| `debit` | same | same | negative |

Refund recoveries are **not** adjustments — they are mechanical settlement items (§3.7) with no
discretion and no admin path.

**The approved amount is bound to the approval, structurally.** Spec 009's `admin_actions` row has no
payload column — only `target_type`, `target_id` and `reason` — so an amount supplied again at
execution time could differ from the amount the second admin approved. This spec therefore follows
spec 022's two-shape route idiom but binds the figures differently:

1. **Initiate** (no `adminActionId` in the body): validate the request and generate the adjustment's
   id; call `authorizeAndInitiate()` with `targetType: 'earnings_adjustment'` and `targetId` = that id
   (spec 009 commits the `AdminAction` on its own connection); then insert the `earnings_adjustments`
   row with that id, `kind`, amount, currency, provider, `reason`, `admin_action_id`,
   `created_by_user_id` and `applied_at = NULL`. The two writes are deliberately **not** claimed to be
   atomic, because spec 009's function does not accept a caller's transaction. If the insert fails,
   the orphaned action targets no row, and execution fails closed with `404 ADJUSTMENT_NOT_FOUND` —
   no money effect is possible. Answer `202`. An unapplied row
   counts in **no** figure, DTO total, batch or statement. `high` always yields `pending_approval`;
   any other outcome fails closed with `422 APPROVAL_REQUIRED`, exactly as
   `lib/refunds/override.ts` does, so a misconfigured seed cannot turn four-eyes off.
2. **Approve / reject** on spec 009's existing approvals screen and routes. The approver sees the
   exact row through the action's target.
3. **Execute** (`adminActionId` in the body, **no amount accepted**): `executeApprovedAction()`
   (`422 APPROVAL_REQUIRED` while `Pending`; `409 APPROVAL_NOT_ELIGIBLE` if rejected or already
   executed), then a conditional `UPDATE earnings_adjustments SET applied_at = clock_timestamp()
   WHERE id = target AND applied_at IS NULL`. Answer `201`. The applied figures are, by construction,
   the approved figures.

**A provider can never create, edit, approve or delete an adjustment.** There is no provider-facing
adjustment route at all; the provider surface is read-only on applied adjustments.

Adjustments are **immutable after insert** — `earnings_adjustments_immutable_trg` rejects every
`DELETE` and any `UPDATE` other than the single `applied_at NULL → value` write (plus
`updated_at`/`version`). A rejected adjustment stays unapplied forever as the record of what was
refused. A mistaken applied adjustment is corrected by a **new, opposite adjustment** with its own
reason and its own approval, never by a rewrite. `reason` is mandatory (master spec §68) and is
carried both onto the row and into spec 009's audit record.

Risk tier `high` (rather than `medium`) matches spec 022's resolution of the same question: spec 009's
risk model has **no amount dimension**, master spec §70 mandates no numeric threshold, and inventing
one would mean inventing a mechanism spec 009 does not have. Every discretionary movement of provider
money therefore needs two admins.

### 3.11 Statement export (AC-6)

**Synchronous CSV — not a second export framework, and not an async job.** The repository's only
asynchronous export pipeline (spec 008) persists artifact bytes through `getFileAssetStorage()`, which
**throws until spec 027 registers a real implementation**; spec 027 has not shipped and no
object-storage adapter exists anywhere. Building spec 024 on it would ship a statement export that can
never succeed, and building a parallel storage backend is explicitly forbidden by the module comment
on `lib/privacy/file-asset-storage.ts`. The draft's `202 + exportRequestId` is therefore replaced by a
bounded synchronous response using spec 008's own non-envelope response idiom (`NextResponse` +
content type + correlation-id header, errors still enveloped).

| Aspect | Decision |
|---|---|
| Behaviour | Synchronous. `200` with `text/csv; charset=utf-8`, `content-disposition: attachment`, `cache-control: private, no-store` |
| Range | `from`/`to` required, inclusive, ISO-8601 dates, resolved to instants in the provider's `scheduling_timezone` (the same field spec 016 made authoritative). Range ≤ `STATEMENT_MAX_RANGE_DAYS` (default 366) or `422 STATEMENT_RANGE_INVALID`. The dashboard's `from`/`to` filter uses the same resolution and the same row-selection columns, so both surfaces agree |
| Size bound | ≤ `STATEMENT_MAX_ROWS` (default 5000). Exceeding it is `422 STATEMENT_RANGE_TOO_LARGE` naming the limit in `details.maxRows`, so the provider narrows the range — **never a truncated statement presented as complete** |
| Currency | One currency per statement. A `currency` parameter is required when the provider has ledger rows in more than one, else `422 STATEMENT_CURRENCY_REQUIRED` |
| Columns | `row_type` (`earnings_line`\|`adjustment`\|`refund_recovery`), `booking_id`, `service_id`, `scheduled_at`, `eligible_at`, `gross_amount_minor_units`, `platform_fee_bps`, `fee_amount_minor_units`, `refunded_amount_minor_units`, `fee_reversal_amount_minor_units`, `net_amount_minor_units`, `currency_code`, `adjustment_kind`, `adjustment_reason`, `item_amount_minor_units`, `payout_id`, `payout_status`, `payout_paid_at`, `total_adjustments_amount_minor_units`, `total_pending_amount_minor_units`, `total_upcoming_amount_minor_units`, `total_paid_amount_minor_units` (the four `total_*` columns are populated only on the `TOTAL` row). Free-text cells are RFC 4180-quoted and prefixed with `'` when they begin with `=`, `+`, `-` or `@`, so a reason can never execute as a spreadsheet formula |
| Rows | One per earnings line by `created_at` in range (not `eligible_at`, so a line still `pending` appears, as it does on the dashboard); one per **applied** adjustment by `applied_at`; one per refund recovery item by `created_at`. `refund_id` is deliberately absent — a recovery row names its `booking_id` |
| Totals | A final `TOTAL` row carrying gross, fee (net of reversals), refunds, adjustments, net, pending, upcoming and paid, computed with the dashboard's exact queries restricted to the range and currency — asserted equal by a test, not by inspection |
| Authorization | Session + `provider` mode + own profile. No step-up (it exposes no credential). Rate-limited on the `payment` domain |
| Never included | `destination_token_encrypted`, `payout_reference`, `provider_reference`, `refund_reference`, rail failure messages, and any customer identity beyond the `booking_id` the provider already has |
| Retention | Nothing is stored. There is no artifact, no expiry and no download token to leak; each request regenerates from the ledger |

### 3.12 Endpoints

Repository conventions: `app/api/v1/**/route.ts` wrapped in `withApiRoute`; path parameters read
from the URL with a local helper (`withApiRoute` forwards no route context); single resources via
`apiSuccess`, lists via `apiPaged` + `parsePageParams`/`buildPage`; plural collections; and the
normative guard order
`session → CSRF → active mode / admin permission → step-up → rate limit → Idempotency-Key`.

**One shared guard module**, `app/api/v1/payouts/route-guards.ts` — the exact idiom of
`app/api/v1/refunds/route-guards.ts` and `app/api/v1/payments/route-guards.ts`, a directory holding
only guards, which `scripts/check-openapi-drift.ts` ignores because it contains no `route.ts`:

| Guard | Steps |
|---|---|
| `guardProviderPayoutRead(request)` | `requireSession` → `requireActiveMode(session, 'provider')` → `checkRateLimit('payment', userId)`; no CSRF on a `GET` |
| `guardProviderPayoutMethodMutation(request)` | `requireSession` → `requireCsrf` → provider mode → `requireStepUp(request, session, 'manage_payout_method')` → rate limit |
| `guardAdminPayoutRequest(request, { csrf })` | `requireSession` → `requireCsrf` (mutations) → rate limit; the **permission** check is spec 009's `resolvePermission` inside `lib/payouts/**`, exactly as `guardAdminRefundRequest` leaves it to the domain so a route cannot skip it |
| `payoutIdempotencyKey(request)` | spec 015's `requireIdempotencyKey` |
| `withPayoutProviderGuard(run)` | maps `PayoutProviderUnavailable` to `503 PAYOUT_PROVIDER_UNAVAILABLE` and `PlatformFeeUnconfigured` to `503 PLATFORM_FEE_UNCONFIGURED`, rather than a `500` |

The caller's provider profile is resolved from `provider_profiles.user_id = session.userId` inside
`lib/payouts/**`; every provider query is scoped by that id, so another provider's resource id is
`404` by construction. A session in `provider` mode always has a profile (spec 006); if the row is
somehow absent, the guard answers `403 FORBIDDEN`, never an empty success. The two cron routes are **not** wrapped in
`withApiRoute`: they follow the existing cron shape exactly (`GET`, `export const dynamic =
'force-dynamic'`, inline `Bearer ${CRON_SECRET}` check returning `401`, `NextResponse.json({ status:
'ok', ...counts })`).

| Method | Route | Auth / mode | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/providers/me/earnings` | session, `provider` mode, own profile | `200 ApiResponse<EarningsSummaryDto>` | optional `from`/`to`/`currency`; rate-limit `payment` |
| `GET` | `/api/v1/providers/me/earnings/lines` | session, `provider` mode | `200 PagedResponse<EarningsLineDto>` | `parsePageParams`/`buildPage`; filters `state`, `from`, `to`, `currency`; newest `eligible_at` first, `created_at` tiebreak |
| `GET` | `/api/v1/providers/me/earnings/statement` | session, `provider` mode | `200 text/csv` | §3.11. Not an `ApiResponse` body; errors still enveloped |
| `GET` | `/api/v1/providers/me/payouts` | session, `provider` mode | `200 PagedResponse<PayoutDto>` | filter `status` |
| `GET` | `/api/v1/providers/me/payouts/{id}` | session, `provider` mode, own payout | `200 ApiResponse<PayoutDetailDto>` | includes its items; `404 PAYOUT_NOT_FOUND` for another provider's id |
| `GET` | `/api/v1/providers/me/payout-methods` | session, `provider` mode | `200 ApiResponse<PayoutMethodDto[]>` | masked only; non-removed first |
| `POST` | `/api/v1/providers/me/payout-methods` | session, `provider` mode, **step-up** | `201 ApiResponse<PayoutMethodDto>` | CSRF; `Idempotency-Key`; body carries only `setupToken` |
| `PATCH` | `/api/v1/providers/me/payout-methods/{id}` | session, `provider` mode, **step-up** | `200 ApiResponse<PayoutMethodDto>` | CSRF; body `{ isDefault: true }` — the sole mutable field |
| `DELETE` | `/api/v1/providers/me/payout-methods/{id}` | session, `provider` mode, **step-up** | `200 ApiResponse<PayoutMethodDto>` | CSRF; soft delete; revokes at the rail |
| `GET` | `/api/v1/admin/payouts` | admin holding `payouts/read` | `200 PagedResponse<AdminPayoutDto>` | filters `status`, `providerProfileId`, `from`, `to` (UTC calendar dates on `created_at` — no single provider timezone applies across providers); failed and escalated payouts sort first |
| `GET` | `/api/v1/admin/payouts/{id}` | admin holding `payouts/read` | `200 ApiResponse<AdminPayoutDetailDto>` | |
| `POST` | `/api/v1/admin/payouts/{id}/retry` | admin holding `payouts/retry` (tier `high`) | initiate: `202 ApiResponse<PayoutRetryPendingDto>`; execute (`adminActionId` in body): `200 ApiResponse<AdminPayoutDto>` | CSRF; `Idempotency-Key`; `reason` required on initiate; §3.8 |
| `POST` | `/api/v1/admin/earnings-adjustments` | admin holding `payouts/adjust` (tier `high`) | initiate: `202 ApiResponse<AdjustmentPendingDto>` (`200` on idempotent replay); execute (`adminActionId` in body, no amount): `201 ApiResponse<EarningsAdjustmentDto>` | CSRF; `Idempotency-Key`; `reason` required on initiate; §3.10 |
| `GET` | `/api/v1/admin/earnings-adjustments` | admin holding `payouts/read` | `200 PagedResponse<EarningsAdjustmentDto>` | filters `providerProfileId`, `applied` (`true`\|`false`) |
| `GET` | `/api/v1/cron/payout-sweep` | `Bearer ${CRON_SECRET}` | `200` | passes A–D; no session, no CSRF, no rate limit |
| `GET` | `/api/v1/cron/payout-reconcile-sweep` | `Bearer ${CRON_SECRET}` | `200` | §3.8 ambiguity resolution |

**Approval listing and decisions use spec 009's existing routes** — `GET /api/v1/admin/approvals/pending`
and `POST /api/v1/admin/approvals/{actionId}/approve|reject`. This spec adds none of its own, for the
same reason spec 022 removed its draft's approval route.

**Privacy-safe `404`.** An id-bearing read by a provider who does not own the resource, or by an admin
without the permission, returns `404` — never `403` — so ids cannot be probed by observing a different
status. `403 FORBIDDEN` is reserved for the wrong active mode and for an admin lacking a permission on
a non-id-bearing route.

### 3.13 Request and response types

```typescript
// lib/types/payouts.ts
export const PAYOUT_STATUSES = ['pending', 'eligible', 'processing', 'paid', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const EARNINGS_LINE_STATES = ['pending', 'eligible', 'paid'] as const;
export type EarningsLineState = (typeof EARNINGS_LINE_STATES)[number];

export const PAYOUT_METHOD_TYPES = ['bank', 'mobile_wallet'] as const;
export type PayoutMethodType = (typeof PAYOUT_METHOD_TYPES)[number];

export const PAYOUT_METHOD_VERIFICATION_STATES = ['pending', 'verified', 'rejected'] as const;
export type PayoutMethodVerificationState = (typeof PAYOUT_METHOD_VERIFICATION_STATES)[number];

export const EARNINGS_ADJUSTMENT_KINDS = ['credit', 'debit'] as const;
export type EarningsAdjustmentKind = (typeof EARNINGS_ADJUSTMENT_KINDS)[number];

export const PAYOUT_ITEM_KINDS = ['earnings_line', 'adjustment', 'refund_recovery'] as const;
export type PayoutItemKind = (typeof PAYOUT_ITEM_KINDS)[number];

/** The closed set adapters map rail responses onto (§3.2). Never a raw rail payload. */
export const PAYOUT_FAILURE_CODES = [
  'destination_invalid',
  'destination_unavailable',
  'rail_temporarily_unavailable',
  'transfer_rejected',
  'transfer_not_received',
  'unknown_failure',
] as const;
export type PayoutFailureCode = (typeof PAYOUT_FAILURE_CODES)[number];

/** Every figure is a persisted SUM in integer minor units. The client formats; it never computes. */
export interface EarningsSummaryDto {
  currencyCode: string;
  grossAmountMinorUnits: number;
  /** Net of reversals: Σ (line fee − line fee reversal). */
  feeAmountMinorUnits: number;
  refundsAmountMinorUnits: number;
  /** Signed. Negative when recoveries outweigh credits. */
  adjustmentsAmountMinorUnits: number;
  /** gross − fee + adjustments − refunds. */
  netAmountMinorUnits: number;
  pendingAmountMinorUnits: number;
  upcomingAmountMinorUnits: number;
  paidAmountMinorUnits: number;
  /** Equals `upcoming`; may be negative while a recovery is outstanding. */
  balanceAmountMinorUnits: number;
  /** True when no usable default payout method exists, so batches cannot close. */
  payoutMethodRequired: boolean;
  /** True when the PayoutHoldGate holds this provider. The reason is never exposed. */
  payoutOnHold: boolean;
  /** Currencies this provider has ledger rows in, so the UI can offer a switcher. */
  availableCurrencyCodes: string[];
}

export interface EarningsLineDto {
  id: string;
  bookingId: string;
  serviceId: string;
  state: EarningsLineState;
  currencyCode: string;
  grossAmountMinorUnits: number;
  platformFeeBps: number;
  /** The fee on gross, before reversals. Immutable. */
  feeAmountMinorUnits: number;
  refundedAmountMinorUnits: number;
  feeReversalAmountMinorUnits: number;
  netAmountMinorUnits: number;
  scheduledAt: string;
  eligibleAt: string | null;
  paidAt: string | null;
  payoutId: string | null;
  createdAt: string;
  version: number;
}

export interface PayoutDto {
  id: string;
  status: PayoutStatus;
  amountMinorUnits: number;
  currencyCode: string;
  itemCount: number;
  /** Masked method detail only — never a token or any id-bearing credential. */
  payoutMethodMaskedDetail: string | null;
  closedAt: string | null;
  paidAt: string | null;
  failureCode: PayoutFailureCode | null;
  createdAt: string;
  version: number;
}

export interface PayoutItemDto {
  id: string;
  kind: PayoutItemKind;
  /** Set for `earnings_line` and `refund_recovery`. */
  earningsLineId: string | null;
  /** Set for `adjustment` only. */
  adjustmentId: string | null;
  bookingId: string | null;
  /** Signed: negative for `refund_recovery` and for a `debit` adjustment. */
  itemAmountMinorUnits: number;
  currencyCode: string;
}

export interface PayoutDetailDto extends PayoutDto {
  items: PayoutItemDto[];
}

export interface PayoutMethodDto {
  id: string;
  type: PayoutMethodType;
  /** Rail-supplied. The ONLY account detail that ever leaves the server. */
  maskedDetail: string;
  institutionLabel: string;
  payoutCurrencyCode: string;
  verificationState: PayoutMethodVerificationState;
  isDefault: boolean;
  removedAt: string | null;
  createdAt: string;
  version: number;
}

export interface EarningsAdjustmentDto {
  id: string;
  kind: EarningsAdjustmentKind;
  /** Signed: positive credits, negative debits and recoveries. */
  adjustmentAmountMinorUnits: number;
  currencyCode: string;
  reason: string;
  /** Present only on the admin surface. */
  adminActionId?: string;
  /** Null until a second admin's approval has been executed. Providers only ever see applied rows. */
  appliedAt: string | null;
  payoutId: string | null;
  createdAt: string;
}

/** The ONLY field a client sends to create a payout method. */
export interface CreatePayoutMethodRequest {
  /** Single-use token from the payout rail's own hosted onboarding UI. */
  setupToken: string;
}

export interface UpdatePayoutMethodRequest {
  isDefault: true;
}

/** Initiate shape. */
export interface InitiateEarningsAdjustmentRequest {
  providerProfileId: string;
  kind: EarningsAdjustmentKind;
  /** Always POSITIVE here; `debit` is stored negated. Zero and non-integers are rejected. */
  amountMinorUnits: number;
  currencyCode: string;
  reason: string;
}

/** Execute shape. Deliberately carries NO amount — the approved row fixes it (§3.10). */
export interface ExecuteEarningsAdjustmentRequest {
  adminActionId: string;
}

/** `202` body for an adjustment awaiting a second admin. The row exists but is unapplied. */
export interface AdjustmentPendingDto {
  adminActionId: string;
  adjustmentId: string;
  status: 'pending_approval';
  providerProfileId: string;
  kind: EarningsAdjustmentKind;
  amountMinorUnits: number;
  currencyCode: string;
}

export interface InitiatePayoutRetryRequest {
  reason: string;
}

export interface ExecutePayoutRetryRequest {
  adminActionId: string;
}

/** `202` body for a retry awaiting a second admin. The payout is unchanged. */
export interface PayoutRetryPendingDto {
  adminActionId: string;
  payoutId: string;
  status: 'pending_approval';
}

export interface AdminPayoutDto extends PayoutDto {
  providerProfileId: string;
  attemptCount: number;
  payoutMethodId: string | null;
}

export interface AdminPayoutDetailDto extends AdminPayoutDto {
  items: PayoutDetailDto['items'];
  /** Operator-facing detail. Never rendered to a provider. */
  failureReason: string | null;
  escalatedAt: string | null;
}
```

`PayoutDto` and `EarningsLineDto` deliberately carry **no** `payoutReference`, `providerReference`,
`destinationToken`, `idempotencyKey`, `failureReason`, `attemptCount` or counterparty identity.
`AdminPayoutDto` adds `attemptCount`, `failureReason` and `escalatedAt` and **still** carries no rail
reference and no destination token — a rail handle is reconciliation data, not admin data.

### 3.14 Auth / RBAC matrix (AC-13)

| Actor | Own earnings & lines | Own payouts | Own payout methods | Any provider's earnings/payouts | Payout-method mask | Initiate retry | Initiate adjustment | Approve retry/adjustment |
|---|---|---|---|---|---|---|---|---|
| Provider (own, `provider` mode) | read | read | read; create/default/remove **with step-up** | no | own only | no | no | no |
| Provider (own, `customer` mode) | `403 FORBIDDEN` | `403` | `403` | no | no | no | no | no |
| Another provider | `404` | `404` | `404` | no | no | no | no | no |
| Customer | `403` | `403` | `403` | no | no | no | no | no |
| Guest | `401 UNAUTHENTICATED` | `401` | `401` | no | no | no | no | no |
| `support_admin` | no | no | no | **no** — `403`/`404`; granted no `payouts` permission by this spec | no | no | no | no |
| `operations_admin` | no | no | no | no | no | no | no | no |
| `finance_admin` | — | — | — | read (`payouts/read`, tier `low`) | **yes**, mask only | yes (`payouts/retry`, tier `high`) | yes (`payouts/adjust`, tier `high`) | yes, if a **different** admin initiated (spec 009's `decideAction`) |
| `super_admin` | — | — | — | read | yes, mask only | yes | yes | yes, same rule |

Permissions seeded by this spec's migration, for `finance_admin` and `super_admin` **only** —
grounded in master spec §69 ("Finance Admin — Payments, refunds, payouts") and §70 ("Payout
intervention" and "High-value financial adjustments" as sensitive), and matching spec 022's seed
shape: `('payouts','read','low')`, `('payouts','retry','high')`, `('payouts','adjust','high')`. No
other role gains any payout permission here, per §69's least privilege; a later spec needing one adds
it to **spec 009's** model, not to this one. Emergency bypass is not offered:
`authorizeAndInitiate` is never called with `emergencyBypass: true` from this spec.

Spec 009's `resolvePermission` returns a granted permission with `low`/`medium` tiers as
`permitted` immediately. Both money-moving actions are therefore seeded `high`, and both code paths
**fail closed** with `422 APPROVAL_REQUIRED` if they ever receive `permitted` — the same guard
`lib/refunds/override.ts` implements — so a mis-seeded tier cannot quietly remove the second admin.

### 3.15 Idempotency and concurrency (AC-8)

| Surface | Key | Scope |
|---|---|---|
| `POST /providers/me/payout-methods` | `Idempotency-Key`, required | `UNIQUE (provider_profile_id, idempotency_key)` on `payout_methods` |
| `POST /admin/earnings-adjustments` (initiate) | `Idempotency-Key`, required | `UNIQUE (provider_profile_id, idempotency_key)` on `earnings_adjustments`; a same-fingerprint replay returns the existing row's `AdjustmentPendingDto` and creates no second `AdminAction` (the key is checked **before** `authorizeAndInitiate` is called) |
| `POST /admin/earnings-adjustments` (execute) | `Idempotency-Key`, required | `applied_at` is set only `WHERE applied_at IS NULL`, and spec 009 moves the action `Approved → Executed` exactly once; a second execution is spec 009's `409 APPROVAL_NOT_ELIGIBLE` and applies nothing |
| `POST /admin/payouts/{id}/retry` (initiate) | `Idempotency-Key`, required | while a `Pending` or `Approved` retry action already targets this payout, a second initiation is `409 PAYOUT_RETRY_ALREADY_PENDING` and creates no second action |
| `POST /admin/payouts/{id}/retry` (execute) | `Idempotency-Key`, required | the version-conditional `failed → eligible` admits one execution; a second execution is `409 APPROVAL_NOT_ELIGIBLE` |
| Rail transfer | `payout:{payoutId}:{attemptCount}` | per **attempt**, so a network retry of the same attempt deduplicates at the rail while a deliberate recovery is a genuinely new transfer |
| Line creation | none needed | `UNIQUE (booking_id)` on `provider_earnings_lines` |
| Recovery item | none needed | `UNIQUE (source_refund_id) WHERE kind = 'refund_recovery'` |
| Earnings/adjustment item | none needed | `UNIQUE (earnings_line_id) WHERE kind = 'earnings_line'`, `UNIQUE (adjustment_id) WHERE kind = 'adjustment'` |

| Situation | Behaviour |
|---|---|
| Same key, same fingerprint | Replay the stored row, `200`. No second rail call |
| Same key, different fingerprint | `409 IDEMPOTENCY_KEY_CONFLICT` (re-exported from `lib/requests/errors.ts`) |
| Two concurrent sweep invocations | `FOR UPDATE SKIP LOCKED` on every pass; the loser skips the row entirely |
| Two concurrent "set default" | The partial unique index admits one; the loser retries once, then `409 CONFLICT` |
| Sweep transfer overlapping a Finance retry | A retry only ever moves `failed → eligible`; the transfer itself is always claimed by the sweep's phase 1 under `FOR UPDATE SKIP LOCKED` with a version-conditional update, so exactly one worker transfers each attempt. A retry executed while the payout is not `failed` is `422 PAYOUT_NOT_RETRYABLE` (or `409 PAYOUT_ALREADY_PROCESSING` while in flight) |
| Refund sink and payout sweep reconcile the same refund | Both lock in the global order (§3.6); the second finds `reconciliation_state = 'reconciled'` under the lock and does nothing |
| Retry while `processing` | `409 PAYOUT_ALREADY_PROCESSING`. Resolution is the reconcile sweep's read, never a second transfer |
| Retry a `paid` payout | `422 PAYOUT_ALREADY_PAID` |
| Retry a payout that is not `failed` | `422 PAYOUT_NOT_RETRYABLE` |
| Stale `version` on any payout mutation | `409 CONFLICT` (spec 003 AC-6) |

### 3.16 Error codes

None is in spec 004's shared `API_ERROR_CODES` map, so each passes `options.status` explicitly — the
pattern specs 005/016/020/021/022 follow. Codes owned by an earlier spec are **re-exported, never
redefined** (`lib/payouts/errors.ts`).

| HTTP | `code` | When |
|---|---|---|
| `403` | `STEP_UP_REQUIRED` | re-exported from `lib/auth/errors.ts` — a payout-method mutation without a fresh, action-matched, unconsumed token |
| `403` | `FORBIDDEN` | wrong active mode, or an admin lacking `payouts/read`\|`retry`\|`adjust` on a non-id route |
| `404` | `PAYOUT_NOT_FOUND` | no such payout, **or** not the caller's (deliberately indistinguishable) |
| `404` | `PAYOUT_METHOD_NOT_FOUND` | no such method, or not the caller's |
| `404` | `EARNINGS_LINE_NOT_FOUND` | no such line, or not the caller's |
| `422` | `PAYOUT_METHOD_SETUP_INVALID` | the rail rejected the `setupToken`, or it was already consumed |
| `422` | `PAYOUT_METHOD_IN_USE` | removing the last non-removed method while a payout is `eligible`/`processing` |
| `422` | `PAYOUT_METHOD_NOT_VERIFIED` | defaulting a method the rail has not verified |
| `422` | `PAYOUT_METHOD_CURRENCY_MISMATCH` | the method's currency differs from the balance being paid |
| `422` | `PAYOUT_ALREADY_PAID` | retrying a `paid` payout |
| `409` | `PAYOUT_ALREADY_PROCESSING` | retrying while a transfer is in flight or its outcome unknown (AC-7) |
| `422` | `PAYOUT_NOT_RETRYABLE` | retrying a payout that is not `failed` |
| `409` | `PAYOUT_RETRY_ALREADY_PENDING` | a retry action for this payout is already `Pending` or `Approved` |
| `404` | `ADJUSTMENT_NOT_FOUND` | executing an action whose target adjustment row does not exist, or is not a `payouts/adjust` action |
| `422` | `ADJUSTMENT_AMOUNT_INVALID` | zero, non-integer, or negative where the body must be positive |
| `422` | `ADJUSTMENT_CURRENCY_MISMATCH` | adjustment currency not among the provider's ledger currencies |
| `422` | `APPROVAL_REQUIRED` | executing an adjustment or retry while its `AdminAction` is still `Pending`, or a mis-seeded tier returning `permitted`. Re-exported from `lib/admin-rbac/errors.ts` (`approvalRequiredError`, status 422), matching spec 022 |
| `409` | `APPROVAL_NOT_ELIGIBLE` | re-exported from spec 009 |
| `409` | `SELF_APPROVAL_NOT_ALLOWED` | re-exported from spec 009 |
| `409` | `IDEMPOTENCY_KEY_CONFLICT` | re-exported from `lib/requests/errors.ts` |
| `409` | `CONFLICT` | stale `version` (spec 003 AC-6) |
| `422` | `STATEMENT_RANGE_INVALID` | missing, inverted, or longer than `STATEMENT_MAX_RANGE_DAYS` |
| `422` | `STATEMENT_RANGE_TOO_LARGE` | more than `STATEMENT_MAX_ROWS` rows; `details.maxRows` names the limit |
| `422` | `STATEMENT_CURRENCY_REQUIRED` | multi-currency provider with no `currency` parameter |
| `503` | `PAYOUT_PROVIDER_UNAVAILABLE` | `PAYOUT_PROVIDER` unset/unknown, or a sandbox refused under `NODE_ENV=production`. **No payout is transitioned** |
| `503` | `PLATFORM_FEE_UNCONFIGURED` | `PLATFORM_FEE_BPS` unset or out of range on a surface that must compute a fee |

### 3.17 OpenAPI

Every route above except the two cron routes is added to `OPENAPI_ROUTES` in
`lib/api/openapi-registry.ts` in the same change, tagged `payouts`, or
`npm run check:openapi-drift` fails. Cron routes are excluded from the drift check, as the existing
cron routes already are. Paths use the OpenAPI `{id}` form matching the directory name exactly.

### 3.18 Breaking-change check

- [x] New routes; new columns on empty spec 003 baseline tables; three new tables; a **new** port
      (`PayoutProvider`) alongside — never replacing — spec 021's `PaymentProvider`.
- [x] No shipped API contract changes. `app/provider/earnings/page.tsx` replaces a `PlaceholderPage`,
      which is not an API surface.
- [x] Spec 022's `RefundReconciliationSink` gains a real registration via `instrumentation.ts`; its
      log-only default, `emitRefundReconciliation`, and every existing call site are unchanged.
- [x] `app/admin/operations/page.tsx` gains one "Payouts" link beside the existing "Refunds" link.

---

## 4. Data model changes

`payouts`, `payout_methods`, `payouts_status_history` and `payouts_status_transitions` **already
exist** as spec 003 baseline skeletons with their FKs, indexes and — for `payouts` — an attached
`payouts_status_transition_trg`. This spec **alters** them and adds three tables.
`0001_baseline_schema.sql` is immutable (`npm run check:schema-checksum`) and is not touched.

`baseColumns()` already supplies `id`, `created_at`, `updated_at` and `version`, so those are not
listed as additions. Money follows spec 003 AC-1's `<base>_amount_minor_units` +
`<base>_currency_code` convention via `moneyColumns()`/`moneyPairChecks()`. `platform_fee_bps` is a
plain `integer` rate, not money, and its name deliberately avoids the money-lint suffixes.

### 4.1 Entities

| Entity | Change | Columns |
|---|---|---|
| `payouts` | **alter** (baseline: `provider_profile_id`, `status`) | `payout_amount_minor_units integer not null default 0`, `payout_currency_code text not null`, `payout_method_id uuid null fk->payout_methods restrict`, `attempt_count integer not null default 0`, `payout_reference text null`, `provider_name text not null`, `failure_code text null`, `failure_reason text null`, `closed_at timestamptz null`, `paid_at timestamptz null`, `escalated_at timestamptz null` |
| `payout_methods` | **alter** (baseline: `provider_profile_id`) | `type text not null`, `masked_detail text not null`, `institution_label text not null`, `payout_currency_code text not null`, `destination_token_encrypted text not null`, `provider_name text not null`, `verification_state text not null default 'pending'`, `is_default boolean not null default false`, `removed_at timestamptz null`, `revoked_at timestamptz null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `payouts_status_history` | **alter** (baseline: `payout_id`, `from_status`, `to_status`, `actor_user_id`, `occurred_at`) | `actor_role text not null`, `detail text null` |
| `provider_earnings_lines` | **new** | `id`, audit, `version`, `booking_id uuid not null fk->bookings restrict`, `provider_profile_id uuid not null fk->provider_profiles restrict`, `payment_id uuid not null fk->payments restrict`, `service_id uuid not null fk->services restrict`, `state text not null default 'pending'`, `gross_amount_minor_units integer not null`, `gross_currency_code text not null`, `platform_fee_bps integer not null`, `fee_amount_minor_units integer not null`, `fee_currency_code text not null`, `refunded_amount_minor_units integer not null default 0`, `refunded_currency_code text not null`, `fee_reversal_amount_minor_units integer not null default 0`, `fee_reversal_currency_code text not null`, `net_amount_minor_units integer not null`, `net_currency_code text not null`, `eligible_at timestamptz null`, `paid_at timestamptz null` |
| `earnings_adjustments` | **new** | `id`, audit, `version`, `provider_profile_id uuid not null fk->provider_profiles restrict`, `kind text not null`, `adjustment_amount_minor_units integer not null`, `adjustment_currency_code text not null`, `reason text not null`, `admin_action_id uuid not null unique fk->admin_actions restrict`, `created_by_user_id uuid not null fk->users restrict`, `applied_at timestamptz null`, `idempotency_key text not null`, `idempotency_fingerprint text not null` |
| `payout_items` | **new** | `id`, audit, `version`, `payout_id uuid not null fk->payouts restrict`, `kind text not null`, `earnings_line_id uuid null fk->provider_earnings_lines restrict`, `adjustment_id uuid null fk->earnings_adjustments restrict`, `source_refund_id uuid null fk->refunds restrict`, `item_amount_minor_units integer not null`, `item_currency_code text not null` |
| `payouts_status_transitions` | **seed only** | the five pairs in §3.5 |
| `permissions` | **seed only** | `('payouts','read','low')`, `('payouts','retry','high')`, `('payouts','adjust','high')` for `finance_admin` and `super_admin`, using the `INSERT ... SELECT ... FROM (VALUES ...) JOIN roles ... ON CONFLICT DO NOTHING` pattern migration `0013` established |
| `refunds` | **no schema change** | this spec only **writes** `reconciliation_state`/`reconciled_at`, which spec 022's `0018` created and `refunds_completed_immutable_trg` explicitly permits |
| `price_adjustments` | **untouched** | not read for earnings (§3.3) |

**The three new tables must be added to `EXPECTED_TABLES` in `lib/db/schema-coverage.test.ts`**, under
the same "beyond master spec §124's minimum list" allowance specs 009, 016, 017 and 023 already use.
`STATE_MACHINE_ENTITIES` stays at five — this spec adds no sixth status machine.

The Drizzle definitions in `lib/db/schema.ts` for `payouts`, `payoutMethods` and `payoutsStatusHistory`
are extended in place, and the three new tables are added there too; the hand-written triggers
(I-8, I-9, I-14, I-20, I-25) live only in the SQL migration, because Drizzle's DSL has no trigger
builder — the same split `0017`, `0018` and `0019` use.

### 4.2 Constraints and invariants

| # | Constraint | Why |
|---|---|---|
| I-1 | `payouts_status_ck`: `status in ('pending','eligible','processing','paid','failed')` | closes the vocabulary the baseline left open |
| I-2 | `payouts_amount_positive_when_closed_ck`: `status = 'pending' or payout_amount_minor_units > 0`, plus `moneyPairChecks('payouts','payout')` | an open batch may run negative while recoveries outweigh earnings; a closed payout always transfers a strictly positive amount |
| I-3 | `payouts_closed_pairing_ck`: `(status = 'pending') = (closed_at is null)`; `payouts_paid_pairing_ck`: `(status = 'paid') = (paid_at is not null)`; `payouts_failure_pairing_ck`: `(failure_code is null) or status in ('failed','eligible','processing')` — a code survives a recovery as the record of the prior failure, and is cleared on `paid`; `payouts_failure_code_ck`: the closed §3.2 vocabulary; `payouts_method_required_ck`: `status = 'pending' or payout_method_id is not null`; `payouts_attempts_ck`: `attempt_count >= 0` and `status not in ('processing','paid','failed') or attempt_count >= 1` | every state carries exactly its own evidence, and no closed payout lacks a destination |
| I-4 | `provider_earnings_lines_amounts_ck`: `gross_amount_minor_units > 0`, `fee_amount_minor_units >= 0`, `refunded_amount_minor_units >= 0`, `fee_reversal_amount_minor_units >= 0`, `net_amount_minor_units >= 0`, `refunded_amount_minor_units <= gross_amount_minor_units`, `fee_amount_minor_units <= gross_amount_minor_units`, `fee_reversal_amount_minor_units <= fee_amount_minor_units`, `platform_fee_bps between 0 and 10000` | no negative or nonsensical ledger row is representable. `refunded ≤ gross` holds because gross is the same captured sum spec 022 caps refunds against |
| I-5 | `provider_earnings_lines_net_identity_ck`: `net_amount_minor_units = gross_amount_minor_units - refunded_amount_minor_units - fee_amount_minor_units + fee_reversal_amount_minor_units` | **AC-3's identity enforced at the database**, not merely in application code |
| I-6 | `provider_earnings_lines_currency_uniform_ck`: `gross_currency_code = fee_currency_code` and `= refunded_currency_code` and `= fee_reversal_currency_code` and `= net_currency_code`, each matching `^[A-Z]{3}$` | one currency per line; no cross-currency arithmetic is representable |
| I-7 | `provider_earnings_lines_state_ck` in `('pending','eligible','paid')`; `..._eligible_pairing_ck`: `(state = 'pending') = (eligible_at is null)`; `..._paid_pairing_ck`: `(state = 'paid') = (paid_at is not null)` | state and its instants can never disagree |
| I-8 | `provider_earnings_lines_immutable_core_trg`: rejects any `UPDATE` changing `booking_id`, `provider_profile_id`, `payment_id`, `service_id`, `gross_amount_minor_units`, `gross_currency_code`, `platform_fee_bps` or `fee_amount_minor_units`; any `UPDATE` moving `state` backwards except `eligible → pending` for a line with no `earnings_line` item; any `UPDATE` that **decreases** `refunded_amount_minor_units` or **increases** `net_amount_minor_units` (refunds only ever accumulate, so net only ever falls); and every `DELETE` | **AC-14** — a later fee-rate change can never rewrite past earnings, a refund can only reduce a line, and a paid line can never be un-paid |
| I-9 | `payout_items_currency_matches_payout_trg`: an item's `item_currency_code` must equal its payout's `payout_currency_code` | cross-currency netting is impossible, not merely discouraged |
| I-10 | `payout_items_kind_ck` in `('earnings_line','adjustment','refund_recovery')`; `payout_items_shape_ck`: `earnings_line` ⇒ `earnings_line_id not null and adjustment_id is null and source_refund_id is null and item_amount_minor_units >= 0`; `adjustment` ⇒ `adjustment_id not null and earnings_line_id is null and source_refund_id is null`; `refund_recovery` ⇒ `earnings_line_id not null and source_refund_id not null and adjustment_id is null and item_amount_minor_units < 0`; `payout_items_earnings_line_uq` unique on `earnings_line_id where kind = 'earnings_line'`; `payout_items_adjustment_uq` unique on `adjustment_id where kind = 'adjustment'`; `payout_items_source_refund_uq` unique on `source_refund_id where kind = 'refund_recovery'` | **AC-2, AC-8** — a line is paid at most once, an adjustment at most once, and a refund is recovered at most once. Double payment and double recovery are structurally impossible |
| I-11 | `earnings_adjustments_kind_ck` in `('credit','debit')`; `admin_action_id` and `created_by_user_id` are `NOT NULL`; `earnings_adjustments_admin_action_uq` unique on `admin_action_id` | **AC-9** — every adjustment has exactly one approval chain and a named initiator |
| I-12 | `earnings_adjustments_sign_ck`: `kind = 'credit'` ⇒ `> 0`; `kind = 'debit'` ⇒ `< 0`; never `0` | a zero adjustment is meaningless, and the sign always matches the kind |
| I-13 | `payout_items_adjustment_applied_trg`: an `adjustment` item may reference only an adjustment whose `applied_at is not null` | an unapproved adjustment can never reach a batch, whatever the application does |
| I-14 | `earnings_adjustments_immutable_trg`: rejects every `DELETE`, and any `UPDATE` other than setting `applied_at` from `NULL` (plus `updated_at`/`version`) | **AC-9** — the approved figures are the applied figures; corrections are new rows, never rewrites |
| I-15 | `payout_methods_type_ck` in `('bank','mobile_wallet')`; `..._verification_state_ck` in `('pending','verified','rejected')`; `..._currency_format_ck` `^[A-Z]{3}$`; `..._masked_detail_ck`: the mask contains at most four digits | **AC-10** — a "mask" that could hold a full account number is rejected at the database |
| I-16 | `payout_methods_default_uq`: unique partial on `(provider_profile_id, payout_currency_code) where is_default and removed_at is null` | **AC-11** — exactly one default per provider per currency, enforced structurally |
| I-17 | `payout_methods_idempotency_uq` unique on `(provider_profile_id, idempotency_key)`; `earnings_adjustments_idempotency_uq` unique on `(provider_profile_id, idempotency_key)` | per-owner idempotency, never global, matching specs 015/018/020/021/022 |
| I-18 | `payouts_open_batch_uq`: unique partial on `(provider_profile_id, payout_currency_code) where status = 'pending'` | one open accruing batch per provider per currency (§3.5) |
| I-19 | `payouts_status_history_actor_role_ck` in `('admin','system')`; `..._actor_pairing_ck`: `(actor_user_id is null) = (actor_role = 'system')` | specs 020/021/022's attribution rule, applied to payouts. No provider ever causes a payout transition |
| I-20 | `payouts_status_history_append_only_trg` — no `UPDATE`, no `DELETE` | financial audit trail, matching `payments_status_history` |
| I-21 | `provider_earnings_lines_booking_id_uq` unique on `booking_id` | one earnings line per booking, structurally |
| I-22 | **Every FK column gets its own plain btree index**, as spec 003's `lib/db/schema-lint.test.ts` ("every foreign-key column has its own covering btree index", checked by leading column) requires and spec 022 did: `payouts_payout_method_id_idx`; `provider_earnings_lines_provider_profile_id_idx`, `..._payment_id_idx`, `..._service_id_idx` (`booking_id` is led by I-21's unique index); `earnings_adjustments_provider_profile_id_idx`, `..._created_by_user_id_idx` (`admin_action_id` is led by its unique index); `payout_items_payout_id_idx`, `..._earnings_line_id_idx`, `..._adjustment_id_idx`, `..._source_refund_id_idx` — plain indexes, not reliant on the partial uniques. The baseline already indexes `payouts.provider_profile_id`, `payout_methods.provider_profile_id` and both `payouts_status_history` FKs. Access-pattern indexes on top: `provider_earnings_lines_provider_state_idx` on `(provider_profile_id, state)`, `..._provider_created_idx` on `(provider_profile_id, created_at)`, `payouts_provider_status_idx` on `(provider_profile_id, status)`, `payouts_status_updated_idx` on `(status, updated_at)`, `earnings_adjustments_provider_created_idx` on `(provider_profile_id, created_at)`, `payout_methods_provider_removed_idx` on `(provider_profile_id, removed_at)` | schema lint, and the sweeps', dashboard's and statement's actual access patterns |
| I-23 | Every FK added by this spec is `ON DELETE RESTRICT` | financial records are retained regardless of account deletion (§4.4) |
| I-24 | Domain invariant, asserted by tests rather than a CHECK (a cross-row aggregate cannot be a Postgres CHECK without a trigger, the same reasoning as spec 022's I-5): for every line with an `earnings_line` item, `net_amount_minor_units = that item + Σ its refund_recovery items`; and for every provider and currency, `pending + upcoming + paid = net` | AC-3 identity 2 and exactly-once settlement |
| I-25 | `payout_items_frozen_trg`: rejects `INSERT` into, and `UPDATE`/`DELETE` of an item of, a payout whose `status <> 'pending'`; rejects every `UPDATE` of `item_amount_minor_units`, `kind` or target columns even while `pending` (an item is replaced by delete + insert only through the §3.7 detach) | a closed batch pays exactly what it held when it closed |
| I-26 | `payout_methods_revoked_requires_removed_ck`: `revoked_at is null or removed_at is not null` | a destination is only revoked after the platform stopped using it |

### 4.3 Migration

- **Name:** `<next>_add_provider_payouts_earnings.sql`, with a hand-written
  `<next>_add_provider_payouts_earnings_down.sql` — the repository's convention (`0012`–`0019` all
  follow it; drizzle-kit generates no down migration, and the down file carries no `_journal.json`
  entry so `npm run db:migrate` never applies it). **The draft's `AddPayoutTables` name is invalid
  here** — it matches no convention in this repository, and the tables are not created but altered.
- **Numbering — read from the repository at implementation time, never from this line.**
  `drizzle/meta/_journal.json`'s head today is `0019_add_cancellation_policy_no_show` (specs 022 and
  023 have shipped `0018` and `0019`). This migration is `0020` **only if it is the next to be
  implemented**; spec 026's draft reads the same journal and may take `0020` first. The implementation
  must use the then-current head plus one and name the file accordingly. The number is an ordering
  fact, never a dependency: this migration requires only that `0018` (the `refunds` reconciliation
  columns) is already applied, and it asserts that in its precondition guard.
- **Precondition guard:** a `DO $$ ... RAISE EXCEPTION` unless (a) `payouts`, `payout_methods` and
  `payouts_status_history` are empty, and (b) `refunds.reconciliation_state` exists — the same guard
  shape `0016`–`0019` use, which is what makes adding `NOT NULL` columns without defaults safe. Nothing
  in `lib/` or `app/` has ever inserted a payout row.
- **Reversible:** yes, **and only while those tables are empty.** The down migration drops exactly
  what this migration added, deletes only the `payouts_status_transitions` and `permissions` rows it
  inserted, and touches no other table — in particular it **never** resets
  `refunds.reconciliation_state`, because a refund reconciled by this spec stays reconciled as a fact
  about the refund. It carries its own emptiness guard over `payouts`, `payout_items`,
  `provider_earnings_lines` and `earnings_adjustments`; §9 states why it must never be applied once
  real rows exist.
- **Backfill required:** no SQL backfill — every table this migration creates or alters is empty.
  Two **forward** effects occur on the first sweep run and are deliberate: Pass A creates earnings
  lines for bookings that were already `settled` before deploy (money genuinely owed), and the pull
  pass reconciles every `completed` refund spec 022 has left `pending` since `0018` shipped. §9's
  staged enablement keeps both inert until the fee rate is set and verified.
- **Downtime:** none.
- **Must keep passing, unedited:** `lib/db/migrations.integration.test.ts` (asserts
  `payouts_status_transition_trg` stays attached — neither migration direction touches it),
  `lib/db/schema-lint.test.ts` (FK indexes, `RESTRICT`, `timestamptz`, no numeric money, no
  undocumented `jsonb` — this spec adds no `jsonb` column), and `lib/db/conventions.test.ts`.
  `lib/db/schema-coverage.test.ts` is edited only to add the three new table names.
- **Reviewed SQL:** hand-reviewed in PR; `npm run check:schema-baseline` and
  `npm run check:schema-money-lint` must pass.

### 4.4 Retention, privacy and audit

- **No payout credential is stored.** No account-number, IBAN, wallet-number, PIN or CNIC column
  exists in this spec, and `payout-types.ts` has no parameter that could carry one. The only sensitive
  column is `destination_token_encrypted`, an opaque rail handle, AES-256-GCM encrypted at rest via
  `deriveKey('payout-destination-token-encryption')`.
- **Never leaves the server, in any channel (AC-10):** `destination_token_encrypted`, the setup token,
  `payout_reference`, `provider_name` (the rail's identity), `idempotency_key` and
  `idempotency_fingerprint`. `failure_reason` reaches the admin DTO only, never a provider. Not in a DTO, not in a log line, not in an error body, not in the privacy
  export, not in the statement CSV, not in analytics. Asserted by
  `lib/payouts/privacy.integration.test.ts` and by the extended source guard.
- **Structured logs** carry `correlationId`, `payoutId`/`earningsLineId`, `providerProfileId`,
  `status`, `amountMinorUnits` and a stable `failureCode` only — never a rail payload, never a rail
  reference, never a mask, never a token, never a customer identity.
- **Retention (spec 008).** `payouts`, `payout_items`, `provider_earnings_lines`,
  `earnings_adjustments` and `payouts_status_history` are financial records retained regardless of
  account deletion, under spec 008's **existing** rule — `lib/privacy/deletion.ts` already names
  `Payout` among the retained financial entities and every FK here is `RESTRICT`. No new retention
  mechanism, sweep or policy is introduced.
- **Account deletion (spec 008).** This spec joins `sweepDeletions()` in `lib/privacy/deletion.ts` the
  way specs 015/017/018/019 already do — one in-database step inside the existing per-user loop,
  **with no rail call inside it**: set `removed_at` and clear `is_default` on the user's
  non-removed `payout_methods`. The payout sweep's existing revocation retry (§3.9) then calls
  `revokeDestination()` for those rows. The financial record survives; the ability to move money to
  that account does not. `masked_detail` and `institution_label` are retained — a four-digit mask and
  a bank name are the financial record's reference, not identifying on their own, and they are the
  only way Finance can explain a past payout.
- **Money owed to a deleted account is never forfeited by code.** Its lines, adjustments and open
  batch are retained; the batch cannot close (no usable method, and Pass C refuses a `deleted` user,
  AC-15); `PAYOUT_STALE_PENDING_HOURS` surfaces it to Finance. What Finance then does with an
  unclaimable balance is a legal/product process outside this spec (§8, genuine open question).
- **Export boundary (spec 008).** `lib/privacy/export.ts` gains a projection for the exporting user's
  **own** provider profile: per line `{ bookingId, state, grossAmountMinorUnits, platformFeeBps,
  feeAmountMinorUnits, refundedAmountMinorUnits, netAmountMinorUnits, currencyCode, eligibleAt,
  paidAt }`; per payout `{ id, status, amountMinorUnits, currencyCode, paidAt }` with its items
  `{ kind, bookingId, itemAmountMinorUnits }`; per **applied** adjustment `{ kind,
  adjustmentAmountMinorUnits, currencyCode, reason, appliedAt }`; per payout method `{ type,
  maskedDetail, institutionLabel, verificationState, isDefault, createdAt, removedAt }`. Never any
  column in the "never leaves the server" list above, never `admin_action_id` or an unapplied
  adjustment, never a `source_refund_id`, and never another provider's or a customer's data.
  `lib/privacy/export.ts` has no payout projection today; this is an addition, not a change.
- **Admin audit.** Every admin retry and every discretionary adjustment is recorded entirely by spec
  009's `recordAdminAuditEvent` (`action_created`, `action_approved`/`action_rejected`,
  `action_executed`, `action_permitted`), which already captures actor, roles, target, reason and
  approval chain — master spec §72's "Payout intervention" requirement satisfied with no new
  mechanism. Every payout-method mutation additionally writes a spec 005 `security_events` row
  (§3.9).

---

## 5. UI states

**No visual redesign of any screen is performed, and the design system is the source of truth.** Every
surface below is composed from the existing primitives exported by `@/components` — `Card`, `Badge`,
`Button`, `Table`, `Select`, `Skeleton`, `EmptyState`, `ErrorState`, `Alert`, `ConfirmDialog`,
`PriceDisplay`, `Toast`, `Icon` — and from the tokens in `app/styles/apuriva-tokens.css`. **No new
design-system primitive, token or `ui/` file is added or changed.** The draft's `packages/ui`,
`StatBlock` and `apps/web/**` paths do not exist in this repository; there is no `StatBlock` component
in `components/index.ts`, so the summary figures are `Card` + `PriceDisplay` compositions. No brand
mark is added to any page — the nav shell already provides the one intentional placement.

**There is no WebSocket layer in this repository** (specs 018–022 all say so). Any live-updating view
uses the existing polling idiom spec 020 established (`BOOKING_POLL_MS = 10_000` in
`app/bookings/booking-client.ts`), and only while a payout of the viewer's is `processing`.

### 5.1 Provider earnings — `app/provider/earnings` (replaces the current `PlaceholderPage`)

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` per summary figure and per table row. No layout shift when the figures arrive |
| **Empty** | A provider with no settled bookings sees a genuine `EmptyState` explaining that earnings appear once a booking settles — all-zero figures, never a broken or half-rendered layout |
| **No payout method** | A persistent, non-dismissible `Alert` above the figures whenever `payoutMethodRequired` is true: payouts cannot be sent until a payout method is added. Never phrased as an error the provider caused |
| **Pending vs upcoming** | Labelled distinctly and never merged: pending money is not yet payable, upcoming money is. No amount is described as "paid" before its payout reaches `paid` (master spec §132.7) |
| **Processing payout** | Explicitly "Payout in progress" with the exact amount and currency. Polls while any of the viewer's payouts is `processing` and stops when all are terminal. **Never** rendered as paid before the rail confirms it |
| **Failed payout** | States plainly that the payout did not complete, that the money is back in the payable balance, and what the next step is (check or update the payout method) — and, where Finance action is required, that support has been notified. Never a bare rail code, never a dead end, never silently absent from the list |
| **Negative balance** | Shown honestly as an amount to be recovered from future payouts, with each refund recovery item itemised against its booking. Never hidden and never rendered as `0` |
| **Held / closed account** | A batch that cannot close because of a hold or a closed account is shown as "payout on hold — contact support", never as failed and never as zero |
| **Error** | `ErrorState` with a retry affordance. A statement-export failure is retryable and leaves page state intact |
| **Multi-currency** | A `Select` currency switcher appears only when `availableCurrencyCodes.length > 1`; totals are never summed across currencies |

Booking-level detail is a paginated `Table` of `EarningsLineDto` showing date, service, gross, fee,
refund, net, state and payout link, filterable by state and date range. Each row links to the
provider's existing booking detail screen, `app/provider/schedule/bookings/[id]`; no new booking
surface is created.

The provider nav entry already exists (`app/components/nav-items.ts`: `earnings` →
`/provider/earnings`) and is not changed. The **earnings snapshot on `app/provider/dashboard`** is
named by that placeholder as shared with spec 037's dashboard work and is **not built here**: this
spec only makes `GET /providers/me/earnings` available for spec 037 to consume, and leaves
`app/provider/dashboard/page.tsx` untouched.

### 5.2 Provider payout methods — `app/provider/earnings/payout-methods`

| State | Behaviour |
|---|---|
| **List** | Masked detail (`****1234`), institution label, type, verification state and a single "Default" `Badge`. **Full detail is never rendered, at any point** — including immediately after creation, since the server never had it |
| **Add** | The provider completes the rail's own hosted onboarding and submits only the resulting single-use setup code, which is posted as `setupToken`. With the sandbox rail — the only rail in this repository — there is no hosted page, so the screen accepts the setup code directly (`sandbox_setup:<type>:<last four>:<currency>`) and says plainly that bank or wallet details are never entered on this page. The step-up token is requested immediately before submission so the 5-minute validity cannot expire mid-form |
| **Step-up required** | A `403 STEP_UP_REQUIRED` re-prompts for step-up and resubmits once; a second failure surfaces a plain message. No sensitive form state is lost, because the platform never held any |
| **Set default / remove** | `ConfirmDialog` naming the masked detail and the consequence. Removing the last method while a payout is in flight shows the `PAYOUT_METHOD_IN_USE` reason, not a generic failure |

### 5.3 Finance Admin — `app/admin/operations/payouts`

A new page under the existing `app/admin/operations` area, whose `PlaceholderPage` already links to
`/admin/approvals`, `/admin/actions/review` and spec 022's `/admin/operations/refunds`, and gains one
`/admin/operations/payouts` link. It shows payouts by status with filters, surfaces failed and
escalated payouts first, offers a retry request behind a `ConfirmDialog` requiring a reason, and an
adjustment request form requiring kind, amount, currency and reason. Both requests show their
approval state explicitly — pending second-admin approval, approved (with an "Execute" action),
rejected, executed — exactly as spec 022's refund override does. An escalated payout offers **no**
mark-paid or mark-failed control (§3.8). Adjustment **approval and rejection happen on spec 009's existing `app/admin/approvals`
screen** — this spec adds no second approval UI. Masked payout-method detail is the only method
information shown, and only to Finance.

`EarningsSummaryDto` gains `payoutOnHold: boolean` for that state (§3.13); the reason for a hold is
never disclosed to the provider, because it may be a spec 038 fraud signal.

**Route(s):** `app/provider/earnings` (replaces the placeholder),
`app/provider/earnings/payout-methods` (new), `app/admin/operations/payouts` (new),
`app/admin/operations` (one link added).

---

## 6. Test plan

Vitest is the **only** runner (`npm test` → `vitest run`). There is no Playwright; `e2e/*.spec.ts` is a
Vitest pattern already configured in `vitest.config.ts`, driving real route handlers against the
isolated `*_test` database (`vitest.config.ts` rewrites `DATABASE_URL` to `<name>_test` and
`test/db-reset.ts` refuses any other name — the normal development database is never touched). The
draft's `apps/api/**`, `apps/worker/**`, `apps/web-e2e/**` and `packages/types/**` paths **do not
exist** in this repository. Integration tests live beside their domain module in `lib/**`, the shape
`lib/payments/*.integration.test.ts` and `lib/bookings/*.integration.test.ts` established.

**These tests do not exist yet.** This section defines what the implementation prompt must build; no
coverage is claimed until it does. Every test is deterministic: time is injected (the `now` parameter
idiom `lib/payments/protection-window.ts` already uses) or driven by the database clock under an
explicit lock, and the sandbox rail's outcomes are keyed by amount suffix exactly as
`lib/payments/provider/sandbox.ts` does.

| Level | What it covers | Where |
|---|---|---|
| **Unit — financial math** | `feeOn()` half-up rounding at every boundary including exact `.5` cases, `feeBps = 0` and `feeBps = 10000`; `feeNet ≤ feeGross` monotonicity; the net identity for full, partial and repeated partial refunds; proof that N partial refunds equal one refund of the same total (no drift); `Δnet` per refund; rejection of non-integer and negative inputs; `resolvePlatformFeeBps()` refusing unset and out-of-range values | `lib/payouts/earnings-math.test.ts` |
| **Unit — state machine** | the payout transition matrix over **every** ordered status pair, asserting exactly the five seeded pairs are legal; earnings-line state movement including the single permitted `eligible → pending` detach; terminality of `paid` | `lib/payouts/state-machine.test.ts` |
| **Unit — eligibility** | E-1…E-6 individually and in combination; `held` and `disputed` both block; `settled` without `released` blocks and vice versa; an in-flight refund blocks; a `completed` refund with `reconciliation_state = 'pending'` blocks; **the protection-window boundary** — not eligible one millisecond before the window closes, eligible at exactly the closing instant, at the 48-hour default and at configured 1-hour and 720-hour windows | `lib/payouts/eligibility.test.ts` |
| **Adapter** | the sandbox `PayoutProvider` honours idempotency keys; produces `paid`, `failed` (every §3.2 code) and `unknown` deterministically by amount suffix; prefixes every reference `sandbox_payout_`; `getPayoutStatusByIdempotencyKey` resolves an attempt that never reached `transfer`; `registerDestination` returns a rail-supplied mask with at most four digits; `resolvePayoutProvider()` refuses an absent name, an unknown name, and any sandbox under `NODE_ENV=production`, and re-reads configuration on every call | `lib/payments/provider/sandbox-payout.test.ts`, `lib/payments/provider/payout-factory.test.ts` |
| **Source guard** | comments stripped first, exactly as spec 021's guard does: no rail SDK import or `process.env.PAYOUT_*(KEY\|SECRET\|TOKEN\|CREDENTIAL)` read outside `lib/payments/provider/`, in `lib/` or `app/`; the payout adapter files touch no table; no `payouts.status` write outside `lib/payouts/state-machine.ts`; `lib/payouts/**` never calls `provider.refund()`, never writes a `refunds` column other than `reconciliation_state`/`reconciled_at`, never reads `price_adjustments`, contains no cancellation-policy or fee-tier literal, and never writes `payments`, `payment_authorizations` or `bookings`; no destination or setup token in any DTO, log, security-event metadata or export; no rail call inside a transaction. Spec 021's `lib/payments/no-fabricated-success.test.ts` and spec 022's `lib/refunds/no-policy-leak.test.ts` must keep passing **unedited** | `lib/payouts/boundaries.test.ts` |
| **Route guards** | each guard runs its steps in the normative order and short-circuits at the first failure; step-up is checked after CSRF and mode and before rate limiting; a mutation without `Idempotency-Key` is rejected before any domain call; `PayoutProviderUnavailable`/`PlatformFeeUnconfigured` become `503`, never `500` | `app/api/v1/payouts/route-guards.test.ts` |
| **Schema conventions** | the three new tables appear in `EXPECTED_TABLES`; `lib/db/schema-lint.test.ts`, `lib/db/conventions.test.ts` and `lib/db/migrations.integration.test.ts` pass unedited, including a plain index on every new FK column and `payouts_status_transition_trg` still attached | existing `lib/db/*` suites; `lib/db/schema-coverage.test.ts` (three names added) |
| **Integration — lifecycle** | a settled booking produces one line; `pending → eligible`; batch accrual; close to `eligible`; `processing`; `paid`; `earnings_line` items' lines marked `paid`; the whole path asserted through `payouts_status_history` rows with correct actor and role; the database trigger rejects an unseeded transition; a payout cannot close with a non-positive total; items cannot be inserted into, changed in or removed from a non-`pending` payout; `registerPayoutIntegration()` is wired from `instrumentation.ts` | `lib/payouts/lifecycle.integration.test.ts` |
| **Integration — refund reconciliation** | for each §3.7 row: no line → reconciled only; unattached line → reduced in place and returned to `pending`; earnings item in a `pending` batch → detached, batch total recomputed, re-attached later at the new net; earnings item in an `eligible`/`processing`/`paid`/`failed` payout → exactly one `refund_recovery` item of `−Δnet` in the open batch; `Δ = 0` writes no item; two partial refunds on a paid line → two recovery items summing to the total reduction; Pass A reconciles refunds completed before the line existed and writes no recovery; the reconciled flag, line update and item commit atomically; a replayed sink callback and a replayed sweep each write nothing; a throwing or unregistered sink loses nothing because the pull pass picks the refund up; the sink ignores payload figures and re-reads from the database; **I-24 holds after every scenario** | `lib/payouts/reconciliation.integration.test.ts` |
| **Integration — adjustments** | initiation creates a `Pending` `AdminAction` and an **unapplied** row that counts in no figure, batch, statement or provider DTO; execution while `Pending` is `422 APPROVAL_REQUIRED`; self-approval is `409`; a rejected action never applies; execution accepts no amount and applies exactly the approved figures; a second execution is `409 APPROVAL_NOT_ELIGIBLE` and applies nothing; a mis-seeded `low`/`medium` tier fails closed; a non-finance admin is `403`; a provider has no route; an adjustment cannot be updated (other than `applied_at` once) or deleted; an unapplied adjustment cannot be attached to a batch (I-13); an orphaned action with no row fails closed `404` | `lib/payouts/adjustments.integration.test.ts` |
| **Integration — rail failure & ambiguity** | a definitive failure sets `failed`, stores the code, keeps items attached and counts the amount as upcoming; `unknown` leaves the payout `processing` with no second `transfer()` call; the reconcile sweep resolves it through `getPayoutStatus`; a crash after phase 1 (null reference) is resolved through `getPayoutStatusByIdempotencyKey`; escalation after the threshold stamps `escalated_at` and polling continues; no code path marks an escalated payout paid or failed without a rail result; automatic retries fire only for the §3.8 codes and conditions, respect the backoff, and stop at `PAYOUT_MAX_AUTOMATIC_ATTEMPTS`; an approved Finance retry re-snapshots the default method, moves `failed → eligible`, increments `attempt_count` and changes the rail key; a second retry initiation while one is pending is `409` | `lib/payouts/failure.integration.test.ts` |
| **Integration — holds & deletion** | an inert hold gate never holds; a registered gate holding a provider keeps the batch `pending` and nothing is transferred; `sweepDeletions` removes the user's payout methods in-database with no rail call, and the payout sweep later revokes them; a deleted user's batch never closes and no amount is deleted; `payoutOnHold` is exposed without a reason | `lib/payouts/holds-deletion.integration.test.ts` |
| **Concurrency (mandatory)** | two concurrent sweeps produce one line, one payout and one transfer; an approved Finance retry overlapping the sweep issues exactly one transfer; **an earnings line can never have two live earnings items and a refund can never have two recovery items** — the partial unique indexes reject the second; two concurrent "set default" requests leave exactly one default; the refund sink and the pull pass reconciling the same refund concurrently produce one effect; a refund reconciliation racing a batch close completes without deadlock under the global lock order, and either the line was detached before the close or a recovery item was written after it — never neither, never both | `lib/payouts/concurrency.integration.test.ts` |
| **Financial (mandatory)** | master spec §113's list for what this spec owns: **payout pending**, **payout failure**, duplicate-payout prevention, idempotency, fee arithmetic at the rounding boundary, refund-after-payout recovery, zero/negative rejection, the currency invariant, that gross equals spec 022's captured sum and never includes charged `price_adjustments`, and that every stored money column is integer minor units | `lib/payouts/financial.integration.test.ts` |
| **Payout-method security** | every mutation without a step-up token is `403 STEP_UP_REQUIRED`; an expired, consumed, wrong-action or wrong-session token gives the same `403` and leaks no difference; the stored token is never plaintext and round-trips through encrypt/decrypt; **no response, log line, error body, security-event metadata, export or CSV contains a setup or destination token, or a mask with more than four digits**; the database rejects such a mask (I-15); a client-supplied `maskedDetail`/`institutionLabel` is ignored in favour of the rail's; removal soft-deletes first and revokes after commit; a rail revocation failure does not block removal and is retried; a removed method is never used by a close or retry; each mutation writes the documented `security_events` row | `lib/payouts/payout-method-security.integration.test.ts` |
| **RBAC** | the §3.14 matrix row by row: a provider in the wrong mode is `403`; another provider's id is `404`, never `403`; `support_admin`, `operations_admin`, `trust_safety_admin`, `content_admin` and `analytics_admin` are refused every payout surface; `finance_admin` initiates but cannot approve its own retry or adjustment; a different `finance_admin` or a `super_admin` can | `lib/payouts/rbac.integration.test.ts` |
| **API / idempotency / OpenAPI** | session, CSRF, guard order, rate limiting on the `payment` domain, pagination, date filtering, missing/duplicate/conflicting `Idempotency-Key`, stale `version` → `409`, and that every new route is registered in `OPENAPI_ROUTES` tagged `payouts` with the registry matching the route files | `lib/payouts/routes.integration.test.ts` |
| **Statement export** | the CSV has one row per line, per applied adjustment and per recovery item in range, and none for an unapplied adjustment; the `TOTAL` row equals the dashboard summary for the same range and currency **exactly**; ranges resolve in the provider's `scheduling_timezone` at a DST-free and a boundary instant; an inverted, missing or over-long range is `422`; an over-large result is `422` naming the limit rather than truncating; a multi-currency provider without `currency` is `422`; no token, rail reference, refund id or customer identity appears in any cell | `lib/payouts/statement.integration.test.ts` |
| **Privacy / retention** | the export carries the new projections and none of the forbidden columns; every FK is `RESTRICT`; account deletion retains the financial rows, revokes the destination and clears the default; no payout-credential column exists anywhere in the schema | `lib/payouts/privacy.integration.test.ts` |
| **UI** | the dashboard renders all eight figures exactly as served (no client arithmetic); `processing` never renders as paid; a failed payout is visible with its next step; the no-payout-method alert appears exactly when `payoutMethodRequired`; the hold state appears exactly when `payoutOnHold` and shows no reason; a negative balance is shown with its recovery items, not hidden; full payout detail is never rendered; the currency switcher appears only when there is more than one currency; the admin page shows approval state and offers no mark-paid/mark-failed control; only `@/components` primitives and tokens are used | `app/provider/earnings/page.test.tsx`, `app/provider/earnings/payout-methods/page.test.tsx`, `app/admin/operations/payouts/page.test.tsx` |
| **E2E (Vitest)** | a settled booking becomes an eligible earnings line, accrues into a batch, closes and is paid through the real route handlers and the sandbox rail; a spec 022 refund on that settled booking then reconciles into one recovery item that reduces the next payout | `e2e/payout.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/payouts/eligibility.test.ts::released and settled advances the line`; `::held, disputed, unsettled, in-flight refund and unreconciled refund each block`; `::not eligible one millisecond before the window closes, eligible at the closing instant`; `lib/payouts/lifecycle.integration.test.ts::a settled booking produces exactly one eligible line` |
| AC-2 | `lib/payouts/reconciliation.integration.test.ts::an unattached eligible line is reduced in place`; `::an earnings item in a pending batch is detached`; `::a committed line gets exactly one refund_recovery item per refund`; `::the refund is marked reconciled in the same transaction`; `::a replayed reconciliation writes nothing`; `::I-24 holds after every scenario`; `lib/payouts/concurrency.integration.test.ts::concurrent reconciliation of one refund has one effect` |
| AC-3 | `lib/payouts/earnings-math.test.ts::net equals gross minus fee plus adjustments minus refunds`; `::repeated partial refunds do not drift`; `lib/payouts/financial.integration.test.ts::both summary identities hold over a mixed ledger`; `app/provider/earnings/page.test.tsx::the rendered figures are the served figures` |
| AC-4 | `lib/payouts/payout-method-security.integration.test.ts::create, default and remove each require step-up`; `::an expired, consumed, wrong-action or wrong-session token is an indistinguishable 403`; `::a successful mutation writes a security_events row without any token` |
| AC-5 | `lib/payouts/failure.integration.test.ts::a definitive failure sets failed and returns the amount to the balance`; `::the provider and Finance are both notified`; `app/provider/earnings/page.test.tsx::a failed payout stays visible with its next step` |
| AC-6 | `lib/payouts/statement.integration.test.ts::the CSV totals equal the dashboard summary for the same range`; `::booking-level rows cover the selected period only`; `::no payout-method detail beyond the mask appears` |
| AC-7 | `lib/payouts/failure.integration.test.ts::an unknown outcome leaves the payout processing`; `::no second transfer call is issued for an ambiguous attempt`; `::the sweep resolves it through getPayoutStatus`; `::a crash after claim is resolved by idempotency-key lookup`; `::an unresolved payout is escalated and never marked without a rail result` |
| AC-8 | `lib/payouts/concurrency.integration.test.ts::two concurrent sweeps issue exactly one transfer`; `::an earnings line can never have two live earnings items`; `::a refund can never have two recovery items`; `::an approved retry overlapping the sweep issues one transfer` |
| AC-9 | `lib/payouts/adjustments.integration.test.ts::initiation creates a Pending AdminAction and an unapplied row that counts nowhere`; `::execution while Pending is 422 APPROVAL_REQUIRED`; `::self-approval is 409`; `::execution applies exactly the approved figures and accepts no amount`; `::a provider has no adjustment route`; `::an adjustment cannot be updated or deleted` |
| AC-10 | `lib/payouts/payout-method-security.integration.test.ts::no response, log, error, export or CSV contains a destination token`; `::the stored token is never plaintext`; `lib/payouts/boundaries.test.ts::no DTO field exposes a rail handle` |
| AC-11 | `lib/payouts/concurrency.integration.test.ts::two concurrent set-default requests leave exactly one default`; `lib/payouts/payout-method-security.integration.test.ts::the last method cannot be removed while a payout is in flight` |
| AC-12 | `lib/payouts/state-machine.test.ts::exactly the five seeded transitions are legal`; `lib/payouts/lifecycle.integration.test.ts::every transition writes one append-only history row with actor and role`; `::the database trigger rejects an unseeded transition` |
| AC-13 | `lib/payouts/rbac.integration.test.ts::each row of the authorization matrix`; `::another provider's id is 404, not 403`; `::support and operations admins are refused every payout surface` |
| AC-14 | `lib/payouts/lifecycle.integration.test.ts::the immutable core of an earnings line rejects an update`; `::a line's net can only fall`; `lib/payouts/earnings-math.test.ts::a later fee-rate change does not alter an existing line` |
| AC-15 | `lib/payouts/holds-deletion.integration.test.ts::a held provider's batch never closes`; `::a deleted user's batch never closes and nothing is deleted`; `::deletion removes methods without calling the rail` |

**Coverage:** ≥80% on new code. The financial and concurrency suites are mandatory, not optional.

**Not covered, deliberately:** a real payout rail's transfer behaviour, since no rail account,
credentials or vendor sandbox exists (§3.2) — testing an adapter this repository does not have would
test nothing; refund execution and refund policy (specs 022/023 — this spec consumes their facts);
notification delivery (spec 026 — only the port ships); real hold rules (spec 038 — only the port
ships); dispute mechanics (spec 031); tax withholding and invoicing (no spec owns them yet). This spec
adds its three tables to `lib/db/schema-coverage.test.ts`'s `EXPECTED_TABLES`; it does not repair any
pre-existing schema-enumeration failure owned by another spec.

---

## 7. Out of scope

- **Payment authorization, capture, protection window, `price_adjustments`** — spec 021. This spec
  reads its facts and writes none of its rows. Recording the capture of a charged price adjustment
  in `payment_authorizations` is spec 021's to fix (§8 #5).
- **Payout-hold rules for fraud, abuse or safety** — spec 038. This spec ships only the inert
  `PayoutHoldGate` port.
- **Legal handling of balances owed to deleted or unreachable accounts** — no spec owns it; this spec
  only guarantees such money is retained, never forfeited, and surfaced to Finance (§8, open question).
- **Refund creation, execution, amounts, policy and any rail `refund()` call** — specs 022/023. This
  spec consumes `reconciliation_state` and creates no second refund mechanism.
- **Cancellation and no-show policy, fee tiers, eligibility decisions** — spec 023. No policy literal
  appears in `lib/payouts/**`.
- **Paying a provider for a cancelled booking's retained fee** — no spec assigns it; §3.4 records the
  decision and names the adjustment mechanism as the auditable path.
- **Notification delivery, templates, channels and preferences** — spec 026. Only an inert port.
- **Dispute creation or resolution** — spec 031.
- **Admin RBAC mechanics, risk tiers, approval routes and the admin audit log** — spec 009. This spec
  seeds three permission rows and calls the framework.
- **Any amount-based approval threshold** — deliberately not invented; §3.10, matching spec 022.
- **Tax withholding, tax identifiers, invoices, statutory statements, currency conversion,
  multi-currency settlement, instant/on-demand payout, provider-chosen payout schedules and
  provider-negotiated fee rates** — no spec owns these; none is invented here.
- **A real Pakistan payout-rail adapter** — §3.2 ships the seam and a sandbox; adopting a vendor is a
  new file and one map entry.
- **Object storage and asynchronous export artifacts** — spec 027. §3.11 is synchronous precisely so
  this spec does not depend on it.
- **Runtime configuration of the §9 environment knobs** — spec 041.
- **Any change to Home, `ui/`, `app/styles/apuriva-tokens.css`, or the primitive set in
  `components/index.ts`.**

---

## 8. Risks and decisions

Items 1–22 are **DECIDED**. No open question blocks implementation; the non-blocking questions that
genuinely need a product, legal or other-spec owner are listed separately below the table.

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Payout rail/provider for Pakistan and credential availability (the draft's Open #1) | Platform/Finance | **DECIDED** (§3.2): a `PayoutProvider` port inside spec 021's existing credential directory, selected by `PAYOUT_PROVIDER` with no silent fallback, plus one self-describing sandbox adapter that `resolvePayoutProvider()` refuses under `NODE_ENV=production`. No real rail, no fabricated payout, and adopting a vendor changes no call site |
| 2 | Protection-window length before `Pending → Eligible` (the draft's Open #2) | Product/Finance | **DECIDED** (§3.4): **there is no new window.** Spec 021's shipped semantics are used verbatim — `protection_state = 'released'` **and** `bookings.status = 'settled'`, a 48-hour default configurable per payment in `[1, 720]`. No duration is invented and no second window is added |
| 3 | The platform fee rate has no source in the repository or the master spec | Product/Finance | **DECIDED** (§3.3): the **mechanism** is specified and the **rate is configuration**, not a guess. `PLATFORM_FEE_BPS` must be an integer in `[0, 10000]`; an unset or invalid value throws and **no earnings line is created**, exactly as spec 021 refuses an unconfigured payment provider. The rate is snapshotted per line and immutable (AC-14), so setting or changing it never rewrites history |
| 4 | Who receives a retained cancellation fee on a booking that never settles | Product | **DECIDED** (§3.4): **no provider earnings line is created.** No spec assigns the retained fee to the provider, and inventing a revenue share here would be a product decision this spec has no authority to make. Compensating a provider for a cancelled booking is possible today, auditably, through a two-admin Finance adjustment |
| 5 | A charged `price_adjustment` leaves no capture evidence | Platform | **DECIDED** (§3.3), verified in `lib/payments/price-adjustment.ts`: the charge is a separate `authorize()` that accepts `authorized` as success and writes no `payment_authorizations` row. **Gross is the captured sum only** — the exact query spec 022's `lib/refunds/amounts.ts` uses — so this spec never pays money the platform cannot prove it took, and refunds can never exceed gross. The capture-evidence gap is **reported as a spec 021 compatibility issue, not patched here**; once spec 021 records adjustment captures there, they enter gross with no change to this spec. Meanwhile a Finance `credit` adjustment is the auditable path |
| 6 | Spec 005's step-up issues a token without re-checking a credential, and stores tokens in a per-process in-memory `Map` | Platform/Security | **DECIDED**: consumed **exactly as shipped** — action-bound, session-bound, single-use, five minutes — neither forked nor weakened. Cross-instance token loss fails **closed** (`403`), never open. Strengthening issuance or sharing the store is spec 005/008's to own and already affects spec 008's sensitive routes identically |
| 7 | An amount threshold for second-admin approval of adjustments | Platform/Finance | **DECIDED** (§3.10): spec 009's risk tier is per `(role, resource, action)` with **no amount dimension**, and master spec §70 mandates no numeric threshold. `payouts/adjust` is seeded `high`, so **every** discretionary adjustment needs two admins. No number is invented |
| 8 | A rail timeout, or a crash between claiming a payout and calling the rail, could pay twice or strand money | Platform | **DECIDED** (AC-7, §3.8): `unknown` is never collapsed into `failed`; the transition into `processing` commits before the call; resolution is always a **read** — by reference, or by the attempt's idempotency key through the mandatory `getPayoutStatusByIdempotencyKey`; unresolved payouts escalate to Finance; **no manual mark-paid or mark-failed action exists** |
| 9 | Concurrent sweeps, or a retry racing a sweep, could pay a line twice | Platform | **DECIDED** (AC-8, I-10, I-25): partial unique indexes allow one live earnings item per line, one item per adjustment and one recovery per refund; items freeze when a batch closes; backed by `FOR UPDATE SKIP LOCKED`, version-conditional transitions and a per-attempt rail key |
| 10 | A refund reconciled after money was committed | Platform/Finance | **DECIDED** (AC-2, §3.7): detach if the line's batch is still `pending`; otherwise exactly one `refund_recovery` **payout item** of `−Δnet` per refund. **No debit is ever initiated against a provider's bank account** — this spec deliberately has no such primitive — and a negative balance is shown honestly and alerted on |
| 11 | Spec 027 has not shipped, so no object storage exists for an async statement artifact | Platform | **DECIDED** (§3.11): the statement is **synchronous CSV**, bounded by range and row count, using spec 008's existing non-envelope response idiom. Building on `getFileAssetStorage()` would ship an export that always throws; building a parallel storage backend is explicitly forbidden by that module |
| 12 | Multi-currency providers | Product | **DECIDED** (§3.3, I-6, I-9): one currency per line, per balance, per payout and per statement, enforced at the database. A cross-currency payout is impossible rather than silently wrong. Currency conversion is named out of scope, not invented |
| 13 | Specs 022 and 023 are now implemented — does this spec match their code, not just their documents? | Platform | **DECIDED**, re-verified against the code: `refunds.reconciliation_state`/`reconciled_at`/`refunds_reconciliation_idx` exist (`0018`); `registerRefundReconciliationSink` exists with a log-only default and is emitted after commit with a swallowed throw; `refunds_completed_immutable_trg` permits exactly this spec's write; refunds are admitted on `settled` bookings; `lib/cancellation/**` defines no provider money rule. This spec adds no requirement on either and edits neither |
| 14 | `payouts.status` had no `CHECK` and an empty transition table in the baseline | Platform | **DECIDED** (§4): add `payouts_status_ck` and seed `payouts_status_transitions`. The trigger is **already attached** by the baseline; no new mechanism is written |
| 15 | Retrying on the same payout row differs from spec 022's "retry is a new row" | Platform | **DECIDED** (§3.8): justified by a real difference — a payout targets a stable registered destination whose rail status is authoritatively readable, and keeping the row preserves the frozen `payout_items` and with them the unique-item guarantee behind AC-8. Every attempt stays individually auditable through `attempt_count` and append-only history rows |
| 16 | The previous draft recorded recoveries as `earnings_adjustments` **and** reduced the line, so a post-payout refund would have been deducted twice from net | Platform | **DECIDED** (§3.1, §3.3, §3.7): recoveries are settlement items on `payout_items`, not earnings adjustments. The line alone carries the refund in earnings; the recovery item alone carries it in settlement. Identity 2 (`pending + upcoming + paid = net`) and I-24 are tested so a double count cannot return |
| 17 | Spec 009's `admin_actions` has no payload, so an amount re-supplied at execution could differ from what was approved | Platform/Security | **DECIDED** (§3.10): the adjustment row is written at initiation with immutable figures, targeted by the action, and execution accepts **no amount** — only `applied_at` is set. The applied figures are the approved figures by construction. (Spec 022's implemented override route accepts the amount again at execution; that is reported to the user as a spec 022 concern, not edited here) |
| 18 | Retrying a payout is a "payout intervention" (master spec §70) | Platform/Finance | **DECIDED** (§3.8, §3.14): `payouts/retry` is seeded `high`, like spec 022's override. Only two closed, rail-authoritative cases retry automatically; everything else needs two admins |
| 19 | Deadlocks between the payout sweep, the reconcile sweep, the refund sink, admin execution and spec 022's own refund execution | Platform | **DECIDED** (§3.6): one global lock order extending spec 022's, ascending `id` within a table, read-unlocked-then-lock-and-revalidate for reverse discovery |
| 20 | Account deletion calling an external rail inside spec 008's deletion sweep | Platform/Privacy | **DECIDED** (§4.4): the deletion join is database-only (remove and un-default methods); rail revocation happens later in the payout sweep. Money owed is retained, never forfeited |
| 21 | Payout holds for suspended, banned or suspected-fraud providers | Platform/T&S | **DECIDED** (§3.6): an inert `PayoutHoldGate` port consulted at batch close, registered for real by spec 038. No hold rule is invented; `provider_profiles.lifecycle_status` is not reinterpreted by this spec |
| 22 | Specs 022/023 shipped while 026 is being drafted, so migration `0020` may be taken | Platform | **DECIDED** (§4.3): the number is read from `_journal.json` at implementation time (head + 1), exactly as spec 026's draft does; the migration's guard asserts `0018`'s columns exist |

**Genuine open questions — none blocks implementation.** Each has a safe shipped default that moves
no money incorrectly and loses nothing:

| # | Question | Owner | Shipped default until answered |
|---|---|---|---|
| Q-1 | The commercial platform commission rate | Product/Finance | `PLATFORM_FEE_BPS` must be set deliberately; unset ⇒ no earnings lines are created (§3.3) |
| Q-2 | What happens, legally, to a balance owed to a deleted or permanently unreachable account | Legal/Finance | retained indefinitely, never forfeited, surfaced to Finance by alert (§4.4) |
| Q-3 | Payout cadence and any minimum payout | Finance | batches close every 24 h with no minimum beyond a positive total; both are environment knobs (§9) |
| Q-4 | Which Pakistan bank/wallet rail to adopt | Platform/Finance | sandbox only; production refuses to run without a real adapter (§3.2) |
| Q-5 | Spec 021 should record charged price-adjustment captures in `payment_authorizations` | Spec 021 owner | adjustment money is excluded from gross; Finance credits are the interim path (§3.3) |

---

## 9. Rollout

- **Feature flag:** none. Payouts are core. The rail stays swappable through `PAYOUT_PROVIDER`; no
  feature-flag system is introduced (spec 041 owns that).
- **Environment.** Added to `.env` and `.env.example`, kept in parity by `npm run check:env`:

| Variable | Default | Purpose |
|---|---|---|
| `PAYOUT_PROVIDER` | `sandbox` in `.env.example` only | Rail adapter selection. No silent fallback; a sandbox is refused under `NODE_ENV=production` |
| `PLATFORM_FEE_BPS` | **none in code — must be set**; `.env.example` documents `0` | Platform commission in basis points, integer `[0, 10000]`. Unset ⇒ no earnings line is created (§3.3). The example's `0` is a neutral placeholder, not a commercial decision (Q-1) |
| `PAYOUT_MINIMUM_MINOR_UNITS` | `0` | Minimum balance before a batch closes. `0` means no minimum — a threshold that withholds a provider's money is not invented |
| `PAYOUT_BATCH_CLOSE_INTERVAL_HOURS` | `24` | How long an open batch accrues before closing |
| `PAYOUT_AMBIGUITY_ESCALATION_MINUTES` | `60` | Mirrors spec 022's threshold for an unresolved in-flight outcome |
| `PAYOUT_MAX_AUTOMATIC_ATTEMPTS` | `3` | Bounds automatic retries; beyond it only an approved Finance retry |
| `PAYOUT_RETRY_BACKOFF_MINUTES` | `30` | Minimum wait before an automatic retry of `rail_temporarily_unavailable` / `transfer_not_received` |
| `PAYOUT_ATTEMPT_GRACE_MINUTES` | `15` | How long an attempt must be `processing` before its outcome may be resolved by idempotency-key lookup (§3.8) |
| `PAYOUT_STALE_PENDING_HOURS` | `168` | Alerts on a batch that cannot close for want of a payout method |
| `PAYOUT_NEGATIVE_BALANCE_ALERT_DAYS` | `30` | Alerts on an outstanding recovery |
| `STATEMENT_MAX_RANGE_DAYS` | `366` | Statement range bound |
| `STATEMENT_MAX_ROWS` | `5000` | Statement size bound; exceeding it is an error, never a truncation |

- **Migration order:** the migration (numbered per §4.3) ships with the code; the routes depend on its
  columns, so migration and deploy are one unit. It requires `0018` (spec 022), which is already on the
  main line of history.
- **Wiring:** `instrumentation.ts` gains one `registerPayoutIntegration()` call after spec 023's, which
  registers the refund reconciliation sink. There is no worker process and none is added.
- **Cron:** two entries added to `vercel.json` using the existing Vercel Cron mechanism and bearer
  `CRON_SECRET` — `/api/v1/cron/payout-sweep` at `*/5 * * * *` and
  `/api/v1/cron/payout-reconcile-sweep` at `* * * * *`, matching `/cron/refund-reconcile-sweep`'s
  cadence for ambiguity resolution. Each invocation processes a bounded batch (`LIMIT 200` per pass)
  so it stays within a serverless invocation; the next run is the continuation. No new scheduler.
- **Staged enablement without a flag.** The rollout is ordered so nothing can pay early: deploy with
  `PLATFORM_FEE_BPS` **unset**, which creates no earnings lines; verify the schema and that both
  sweeps are inert; set `PLATFORM_FEE_BPS`, which begins creating lines in `pending` while
  `PAYOUT_BATCH_CLOSE_INTERVAL_HOURS` holds the first batch open; verify the first batches and their
  arithmetic against the ledger before a real rail adapter is ever configured. Under a sandbox rail no
  money moves at all, and with no configured rail every close simply waits.

### Rollback and recovery safety

The draft's "revert deploy; payout state is provider-authoritative where applicable" is **unsafe
wording for a financial system and is replaced**. A payout the rail has executed cannot be reversed by
any code change, and once real payout rows exist the schema must not be rolled back.

1. **Roll the code back, not the money.** Reverting the deploy stops new payouts being created, closed
   and transferred. It does not and must not attempt to undo executed transfers. There is no code path
   in this spec that can pull money back from a provider's account, by design.
2. **Never apply this spec's down migration once any payout, earnings line or adjustment row exists.** The
   down migration is gated on empty tables and is safe only before the first payout ships. After that
   it would destroy financial records spec 008 requires be retained; the correct response to a defect
   is a **forward fix**.
3. **The rail stays authoritative.** Any payout left `processing` across a rollback is resolved by
   `getPayoutStatus()` when the reconcile sweep next runs, on whatever code version is deployed.
   `processing` is never reinterpreted as `failed` or `paid`, and no duplicate transfer is possible
   because recovery is a read.
4. **The fastest safe mitigation is configuration, not migration.** Unsetting `PLATFORM_FEE_BPS` halts
   line creation and unsetting `PAYOUT_PROVIDER` halts every transfer (`503`), both immediately and
   both without touching a row. Removing the two cron entries from `vercel.json` stops all background
   progression. Each is reversible; a down migration is not.
5. **Reconciliation is replayable.** `refunds.reconciliation_state = 'pending'` is durable, so a
   rollback across the 022/024 boundary loses no deduction; it is picked up on the next pass.
6. **A suspected over- or under-payment is corrected by a new, approved adjustment** — never by editing
   a paid payout, its items, an earnings line's core or an applied adjustment, all of which are
   immutable by trigger.
7. **Reconciliation already recorded stays recorded.** A rollback never resets
   `refunds.reconciliation_state`; if the code that consumed a refund is rolled back, the line and
   recovery rows that carry its effect remain, so the refund is neither lost nor applied twice when
   the fix redeploys.

### Observability (master spec §117)

Structured logs — `earnings.line_created`, `earnings.line_eligible`, `earnings.fee_unconfigured`,
`payout.batch_opened`, `payout.batch_closed`, `payout.batch_held`, `payout.processing`, `payout.paid`,
`payout.failed`, `payout.outcome_unknown`, `payout.escalated`, `payout.retry_requested`,
`payout.retried`, `payout.recovery_created`, `payout.line_detached`, `earnings.refund_reconciled`,
`payout_method.revocation_failed` — each carrying `correlationId`, `payoutId`/`earningsLineId`,
`providerProfileId`, `status` and `amountMinorUnits`. **Never** a rail payload, a rail reference, a
destination token, a payout-method mask, or a customer identity.

Alert on: payout failure rate; any payout `processing` beyond `PAYOUT_AMBIGUITY_ESCALATION_MINUTES`;
any payout `pending` beyond `PAYOUT_STALE_PENDING_HOURS`; any refund `reconciliation_state = 'pending'`
beyond spec 022's reconciliation SLA; any negative provider balance outstanding beyond
`PAYOUT_NEGATIVE_BALANCE_ALERT_DAYS`; any `earnings.fee_unconfigured` event at all; and adjustment
frequency and total adjusted value, with unusual spikes routed to Finance and Trust & Safety (master
spec §68). Time-to-eligible and time-to-paid are tracked as distributions, not averages, so a stuck
tail is visible.
