# Spec: Demo Mode & Seed Data

**File:** `docs/specs/2026-08-28-045-demo-mode-seed-data.md`
**Status:** Draft — implemented; focused suites re-verified locally 2026-10-27 (§10); **no clean full-suite pass established**; **not ready for a hosted demo**: DEP-1 is unresolved, so on any hosted server (`NODE_ENV=production`) provisioning refuses with the sandbox adapters' own refusal.
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §110–§113, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §16, [docs/workflow.md](../workflow.md); specs 005 (sessions, mandatory admin MFA), 009 (admin roles), 010 (catalog seed), 021/024 (payment and payout adapters), 026 (notification channels), 033 (AI adapter), 039 (audit), 040 (analytics), 041 (feature flags, `APP_ENV`). See §8.

---

## 1. Problem statement

**Today (verified against the repository):**

- No demo mode, demo account, seed script or `users.is_demo` column exists.
- **Already seeded in every environment:** the 8 master-§14 categories and their services, by
  migration `drizzle/0006_lean_shaman.sql` (spec 010). Packages exist (`service_packages`). Portfolio
  exists only as spec 027's `portfolio` file context (`lib/files/contexts/policies.ts`); there is no
  portfolio feature.
- **Existing controls this spec must not weaken:**
  - Admin MFA is mandatory (spec 005 AC-5), enforced in the single login choke point
    `completeLogin()` (`lib/auth/login-flow.ts`), which gives an admin a partial session until
    `/auth/mfa/verify` succeeds.
  - Every adapter factory (payments `lib/payments/provider/index.ts`, payouts
    `payout-factory.ts`, notifications `lib/notifications/channels/index.ts`, AI
    `lib/ai/provider/index.ts`) refuses a sandbox adapter when **`NODE_ENV === 'production'`**.
  - `audit_logs` rejects `UPDATE`/`DELETE`/`TRUNCATE` (spec 039 AC-2).
  - All 56 foreign keys to `users.id` are non-cascading (`RESTRICT`/default).
- **Consequences:**
  1. A one-click Admin login would bypass mandatory MFA. It is **not** built (D-2).
  2. Deleting a demo user's data in place is not viable: audit rows can never be removed and
     non-cascading FKs span every domain. Reset therefore provisions, never deletes (D-3).
  3. Every hosted deployment (Vercel, `next start`, the Docker image) runs with
     `NODE_ENV=production`, so today **no hosted environment, including staging and a demo
     deployment, can use the sandbox adapters**.
     - A hosted demo's payment and notification behaviour therefore **depends on changes in the
       owning specs 021/024/026/033**. Whether and how to allow sandboxes in a hosted non-production
       deployment is **their** decision, to be approved separately (§8 DEP-1).
     - **045 does not change, bypass or weaken the existing `NODE_ENV=production` sandbox refusal,**
       and adds no payment or notification branch of its own.
  4. No real payment vendor exists. The in-repo sandbox is the master §133.7 fallback, and master
     §112 requires the vendor sandbox only "where available".

Master §110 requires realistic, clearly-identifiable seed data separated from production data. §111
requires one-click demo accounts, a reset capability and a clear Demo Mode label, with no real money.
§112 requires demo payments to use the payment provider's sandbox/test environment where available,
with simulated success/failure/pending/cancellation.

**Who is affected:** Anyone evaluating the product (stakeholders, sales, QA); every prior spec's
manual/E2E testing, which needs realistic data to exercise against.

**Why it matters now:** Sequenced near the end since it seeds data across every entity from
specs 003–041 — it can only be complete once those entities are finalized.

**Success looks like:**

- A dedicated, non-production **demo environment** with its own database.
- A visitor clicks "Try as Customer" or "Try as Provider" and gets a private, freshly seeded demo
  world, clearly labelled.
- Payments run through the payment port's sandbox adapter, never through a fabricated branch, and no
  real money or real message can move.
- Admin capabilities are demonstrated only through operator-provisioned admin accounts that keep
  mandatory MFA.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a demo environment (§3.1) **When** a visitor clicks "Try as Customer" or "Try as Provider" **Then** `POST /api/v1/demo/login` provisions a fresh demo set for that visitor (§3.3) and signs them in as its persona user through `completeLogin()`, with no signup. `persona: 'admin'` is refused `400 VALIDATION_ERROR` (spec 004 AC-3). No endpoint creates an admin session without MFA. |
| AC-2 | **Given** a provisioned demo set **When** inspected **Then** it references the 8 categories and services seeded by migration 0006 (not re-created), and contains demo providers with packages and portfolio placeholders, reviews, requests, offers (including expired ones), bookings in every spec 020 status, notifications, and providers in each availability state (`available`, `busy`, `unavailable`) |
| AC-3 | **Given** a demo environment **When** any page renders, for guests and signed-in users alike **Then** the `DemoModeBanner` is visible, and every seeded person's display name carries the "(Demo)" suffix |
| AC-4 | **Given** a demo payment **When** processed **Then** it goes through spec 021's unchanged payment port and adapter selection (`PAYMENT_PROVIDER=sandbox`), and its outcome (success, failure/decline, requires-action/pending, cancellation/void) comes from the adapter's documented deterministic test amounts. No demo-specific branch exists in any payment, payout or notification code path. |
| AC-5 | **Given** a signed-in demo user **When** they request a reset **Then** a new demo set is provisioned, their session is revoked and replaced by one for the new set's persona, and **no existing row is updated or deleted**, so no other visitor's set and no non-demo data can be affected |
| AC-6 | **Given** demo mode **When** any action is taken **Then** no real money moves and no real SMS, email or push is sent: the environment runs only sandbox adapters (§3.1), and every seeded contact address is undeliverable by construction (§3.4) |
| AC-7 | **Given** `APP_ENV=production`, or the `demo-mode` flag off, or a database whose name does not end in `_demo` **When** any `/api/v1/demo/*` route is called **Then** it refuses (§3.6) without reading or writing domain data, and the demo entry page shows that demo is unavailable |

---

## 3. Architecture and API contract

### 3.1 The demo environment (decision D-1)

Demo mode exists **only** in a dedicated deployment that meets all of the following. Every
`/api/v1/demo/*` handler and the seed script check the first three **server-side**, on every call:

1. **`APP_ENV` is not `production`**, read through spec 041's `currentFlagEnvironment()`. The demo
   deployment sets `APP_ENV=staging`.
2. **The `demo-mode` flag is on** (`isFeatureEnabled('demo-mode')`, §3.7). A demo deployment sets its
   override `DEMO_MODE_ENABLED=true`.
3. **The database name** in `DATABASE_URL` **ends in `_demo`**. This is the same structural guard idiom
   as the repository's `_test` rule (`test/db-reset.ts`). A real staging or production database
   cannot match it by accident.
4. **Sandbox adapters:** `PAYMENT_PROVIDER=sandbox`, `PAYOUT_PROVIDER=sandbox`,
   `NOTIFICATION_CHANNEL_PROVIDER=sandbox`, `AI_PROVIDER=sandbox`. **Unresolved:** under the existing
   guard these refuse on every hosted server (`NODE_ENV=production`). This stays unresolved until
   specs 021/024/026/033 are separately changed and approved (DEP-1); until then, a hosted demo's
   payment and notification calls fail with those adapters' documented refusals. They never fall
   back to anything else.

**Production behaviour:** with `APP_ENV=production` every `/demo/*` route answers
`403 DEMO_NOT_AVAILABLE_IN_PRODUCTION` regardless of the flag, and the `/demo` page renders the
unavailable state. Production payments are untouched: the production adapter selection, spec 021
AC-10, is not modified by this spec.

**Data isolation is by database.** A demo environment's database holds no production data, and
production's holds no demo data. The `users.is_demo` column is a second, row-level marker used by the
reset and reseed guards (§3.5), not the primary boundary.

### 3.2 Endpoints

| # | Method and route | Auth | Success |
|---|---|---|---|
| D1 | `POST /api/v1/demo/login` | none (guest) | `200 ApiResponse<SessionDto>` plus the session and CSRF cookies, exactly as a normal login sets them |
| D2 | `POST /api/v1/demo/reset` | session + CSRF; the session user must have `is_demo = true` | `200 ApiResponse<SessionDto>` plus replacement cookies |

**Shared conventions:** `withApiRoute`, the `auth` rate-limit bucket (10/min) keyed by
`hashRequestIp()`, `apiSuccess`, and entries in `lib/api/openapi-registry.ts` (D1, D2).

**D1 steps:**

1. Run the §3.6 checks.
2. Validate the body `{ persona }`: anything other than `'customer'` or `'provider'`
   → `400 VALIDATION_ERROR` (field `persona`; spec 004 AC-3 owns this status).
3. Provision a demo set (§3.3) in one transaction.
4. Call `completeLogin(personaUserId, 'demo', { ipHash })` (X-1), then set the cookies the same way the
   existing login routes do.
5. Log `demo.set_provisioned` (persona, set id; no IP).

**D2 steps:**

1. Run the §3.6 checks.
2. `requireSession` plus CSRF.
3. A user who is not a demo user → `403 FORBIDDEN`.
4. Provision a new set for the **same persona** as the caller's set.
5. `revokeSession(currentSessionId, 'demo_reset')`, then `completeLogin` for the new persona user.
6. Log `demo.reset`.

**Error handling:** a failure at any step before the commit leaves nothing written, and the caller's
existing session stays valid. That is the "never partially reset" guarantee (§5).

**Types (`lib/types/demo.ts`):**

```typescript
export type DemoPersona = 'customer' | 'provider';
export interface DemoLoginRequest {
  persona: DemoPersona;
}
// D1 and D2 return the existing SessionDto (lib/types/auth.ts); no new response type.
```

### 3.3 Per-visitor demo sets (decision D-3; resolves draft §8 #1)

**Account model.** Every D1 call provisions a new **demo set**: a closed group of synthetic users and
their data, created in one transaction and identified by a `demo_set_id`. There is no shared demo
account and no demo password; a visitor's only credential is the session D1 issues.

- **A customer set** contains:
  - the persona customer;
  - four demo providers: one `available`, one `busy`, one `unavailable`, and one extra `available`
    with a rich profile;
  - two demo customers who wrote the providers' existing reviews.
- **A provider set** contains:
  - the persona provider (`available`);
  - three demo customers whose requests and bookings involve the persona;
  - one `busy` and one `unavailable` demo provider for comparison.
- **Contents of either set (AC-2):**
  - requests in every customer-visible status;
  - offers, including expired ones;
  - bookings in every spec 020 status;
  - sandbox payments for the bookings whose status implies one;
  - reviews;
  - notifications;
  - packages, and portfolio placeholder assets (spec 027 `portfolio` context, backed by a bundled
    placeholder image through the configured `FILE_STORAGE_PROVIDER`).
- **Catalog:** the set's services and categories are the ones migration 0006 seeded (spec 010). The
  seed **reads** them and never inserts or edits catalog rows (D-5).

**How rows are produced.** The seed writes through the owning modules' existing write functions
wherever one exists, so every row passes the same validation, state-machine triggers and
idempotency rules as production code. A state that needs elapsed time (an expired offer, a booking
whose protection window has passed) is reached by walking only transitions the spec 003 transition
triggers accept, with back-dated timestamps, inside the same transaction. No state is written that
the real state machine could not have produced.

**Isolation and concurrency:**

- Seeded relationships (offers, bookings, messages, reviews, notifications) only ever link users of
  the **same** set.
- Live actions a visitor takes afterwards go through the normal code. Matching (spec 017) may
  therefore route a visitor's new request to eligible providers from **other** demo sets. This is
  accepted: every account in a demo database is synthetic (§3.1), and master §110's separation is
  between demo and **production** data, which the database boundary guarantees. True multi-tenant
  sandboxing stays out of scope (§7).
- Concurrent D1 calls create independent sets and share no row except the read-only catalog.

**Reset (AC-5)** is provisioning plus a session switch; no row is updated or deleted.

**Growth.** Old sets remain until an operator runs the **environment reseed** (§3.5). Recommended
cadence: nightly, and on each demo deploy.

### 3.4 Synthetic identity and AC-6

- **Display names** are clearly synthetic and carry the "(Demo)" suffix, for example
  "Ayesha (Demo)".
- **Emails** are `demo+<uuid>@example.invalid`. `.invalid` is reserved by RFC 2606 and can never be
  delivered.
- **Phone numbers** are drawn only from the North American fictional range `+1 555 0100`–`0199`.
- **No real personal data**, ever.
- Even if a real adapter were ever configured, these addresses cannot reach a real recipient. The
  environment's sandbox adapters (§3.1) send nothing in the first place. **No `is_demo` branch exists
  in notification, payment or payout code.**

### 3.5 Reset guarantees and the environment reseed

**D2 cannot mutate or delete existing data.** It only inserts a new set and revokes the caller's own
session row (spec 005's normal revocation). Each relationship in the draft's list:

| Data | Why D2 cannot affect another set or non-demo data |
|---|---|
| bookings, offers, requests, messages, reviews, payments, notifications | never updated or deleted by D2; new rows are inserted only for the new set's users |
| audit rows (spec 039) | immutable anyway, and never written by the seed except through normal module paths |
| analytics (spec 040) | isolated by the demo database (§3.8) |

**`scripts/demo-reseed.ts`** is an operator-only tool, never an HTTP route. Its guards:

- it refuses unless the §3.1 conditions 1–3 hold;
- it refuses unless `SELECT count(*) FROM users WHERE is_demo = false` is 0.
  **Consequence:** in a demo environment, the real registration and login (spec 005, unchanged) still
  work, but any account created that way blocks the reseed until the operator removes it
  deliberately. The script never deletes non-demo rows.

When the guards pass, it drops and recreates **only the `_demo` database**, runs `npm run db:migrate`,
and logs `demo.environment_reseeded`. Migrations re-seed the catalog (0006) and the flags.

### 3.6 Refusals

| HTTP | `code` | When |
|---|---|---|
| `403` | `DEMO_NOT_AVAILABLE_IN_PRODUCTION` | `currentFlagEnvironment() === 'production'` |
| `403` | `DEMO_MODE_DISABLED` | the `demo-mode` flag is off, or the database name does not end in `_demo`. The latter also logs `demo.misconfigured`. |
| `403` | `FORBIDDEN` | D2 by a non-demo user |
| `403` | `CSRF_TOKEN_INVALID` | D2 without a valid CSRF token (spec 005) |
| `401` | `UNAUTHENTICATED` | D2 without a session |
| `400` | `VALIDATION_ERROR` | D1 `persona` missing or not `customer`/`provider` (spec 004 AC-3) |
| `429` | `RATE_LIMITED` | the `auth` bucket is exhausted |

The checks run in the table's order, before any domain read or write.

### 3.7 The `demo-mode` flag: spec 041 §3.3, exactly

One registry entry in `lib/feature-flags/registry.ts`, plus the new migration's seed of its flag row
and three environment rows (§4). No other flag mechanism.

| Field | Value |
|---|---|
| key | `demo-mode` |
| owning spec | 045 |
| classification | **developer** (it gates an unauthenticated, account-creating endpoint: a safety-critical technical control, master §71) |
| client-readable | no. The banner is rendered server-side (§5), and spec 041's CHECK forbids a client-readable developer flag anyway. |
| kill switch | no |
| env override | `DEMO_MODE_ENABLED` |
| defaults | **off** in development, staging and production |
| description | "Enables one-click demo logins and the demo banner. Only effective outside production on a `_demo` database (spec 045)." |

A demo deployment turns it on with `DEMO_MODE_ENABLED=true`. A Super Admin may also toggle the stored
value through spec 041's F2, audited as usual. The §3.1 production and database checks still apply
regardless of the flag.

### 3.8 Analytics and audit (decision D-6)

- **Analytics:** demo activity is **isolated by database**. The demo environment's `analytics_events`
  and reports describe only demo data, and production's never contain it. No tag, no new property and
  no change to spec 040's closed vocabulary.
- **Audit:** the same applies to spec 039's `audit_logs`. The seed writes audit rows only where a
  module it calls already does, and they stay in the demo database.
- **Specs 039 and 040 are not modified.**

### 3.9 Admin demonstrations (decision D-2)

- **No one-click Admin demo and no admin demo persona in D1.** Master §111's "One-click Admin demo"
  is a deliberate deviation, recorded here, because spec 005 AC-5 makes admin MFA mandatory.
- **Operator-provisioned admin accounts:** `scripts/demo-create-admin.ts --email <evaluator> --role <role>`,
  where the evaluator's email is supplied by the operator.
  - It runs only under the §3.1 conditions 1–3.
  - It creates a `users` row (`is_demo = true`), an `admin_profiles` row, and one spec 009 role
    assignment. Any of the seven canonical roles **except `super_admin`** is accepted, so an evaluator
    cannot toggle developer flags, including `demo-mode` itself.
  - The evaluator signs in through the normal login and **enrols and uses MFA exactly as spec 005
    requires**. No MFA secret is generated, shared or skipped by the script.

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `users` (spec 003) | extend | `is_demo boolean NOT NULL DEFAULT false` |
| `users` (spec 003) | extend | `demo_set_id uuid NULL`. It groups one provisioned set; there is no FK and no new table, because a set has no attributes of its own. CHECK `users_demo_set_ck`: `demo_set_id IS NULL OR is_demo`. |

- No per-child demo flag. Every demo row is owned by users of one set, and the database boundary
  (§3.1) is the isolation guarantee.
- **The partial index `users_demo_set_idx`** on `(demo_set_id) WHERE demo_set_id IS NOT NULL` finds a
  set's users.

### Migration

- **Files:** `drizzle/0039_add_demo_mode.sql`, a hand-written `_down.sql`, and journal index 39;
  `lib/db/schema.ts` gains the two columns, the CHECK and the index.
- **Up:**
  1. `ALTER TABLE users ADD COLUMN is_demo boolean NOT NULL DEFAULT false`,
     `ADD COLUMN demo_set_id uuid`, the CHECK and the index.
  2. Insert the `demo-mode` row into `feature_flags` with `ON CONFLICT ("key") DO NOTHING`.
  3. Insert its three `feature_flag_environment_values` rows (`enabled = false`) with
     `ON CONFLICT DO NOTHING`.
- **Down:** delete the three value rows and the flag row, then drop the index, the CHECK and the two
  columns. It is reversible.
- **Backfill:** none (every existing user gets `is_demo = false`). **Downtime:** none; the new column
  is defaulted and the other is nullable. No money column and no jsonb.
- **The seed is not a migration.** Demo sets are created only by D1/D2 at run time. Nothing demo is
  ever inserted by a migration, so no production database ever receives demo rows.

### Retention and privacy

- Demo data contains no real personal information (§3.4).
- **Export and deletion (spec 008):** unchanged. A demo user's data can be exported like any other,
  and it lives only in the demo database.
- **Logs:** `demo.*` lines carry the persona and set id, never an IP.

---

## 5. UI states

**Route(s):**

- `app/(auth)/demo/page.tsx` (URL `/demo`): the entry point, a server component with "Try as Customer" and
  "Try as Provider" buttons. With demo unavailable, it renders the unavailable state.
- The `DemoModeBanner` is rendered from `app/layout.tsx` (X-3) when the server-side
  `isFeatureEnabled('demo-mode')` is true **and** `APP_ENV` is not `production`.
- A "Reset demo" action sits on `/account` for demo users only (X-4).

**Shared components:**

- `app/_components/DemoModeBanner.tsx` (new, app-level), composed from `@/components`'s `Alert`
  (`tone="info"`, `role="status"`) and `Badge`. It has no dismiss control, so it stays visible for the
  whole session.
- `Button` and `ConfirmDialog` for reset. No new primitive and no new token.

| State | Behaviour |
|---|---|
| **Loading** | demo login shows a brief "Setting up your demo..." state; buttons disabled while D1 or D2 is in flight |
| **Empty** | N/A — a demo set is always pre-populated |
| **Error** | `ErrorState` with retry. A D1/D2 failure leaves nothing written (one transaction) and keeps any current session, so the data is never partially reset. `DEMO_NOT_AVAILABLE_IN_PRODUCTION` / `DEMO_MODE_DISABLED` render the unavailable state instead of retry. |
| **Success** | redirect to `/` (customer) or `/provider/dashboard` (provider); the banner is visible on every page (master §111's "clear Demo Mode label") |

All strings go through spec 042's `t()`, with new `demo.*` keys in `lib/i18n/dictionaries/en.ts` (X-5).

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | the §3.6 check order; persona validation; database-name guard (`_demo` suffix); synthetic identity generators (`.invalid` emails, fictional numbers, "(Demo)" names) | `lib/demo/guards.test.ts`, `lib/demo/identity.test.ts` |
| **Integration** | D1 per persona: a set is provisioned, one session is issued via `completeLogin`, no MFA path is touched, `admin` is refused | `app/api/v1/demo/login/route.integration.test.ts` |
| **Integration** | AC-2: a provisioned set spans every required entity and state and references 0006's categories without inserting any catalog row | `lib/demo/seed/coverage.integration.test.ts` |
| **Integration** | AC-5: D2 inserts a new set, revokes the old session, and **changes no existing row**, asserted by table row fingerprints before and after for every table except the inserts and the one revoked session; a second visitor's set is byte-identical after | `app/api/v1/demo/reset/route.integration.test.ts` |
| **Integration** | AC-7: each refusal (production, flag off, wrong database name, non-demo user, CSRF, 401, 429) writes nothing | `app/api/v1/demo/guards.integration.test.ts` |
| **Integration** | AC-4: demo bookings' payments are rows produced by the sandbox adapter (`provider = 'sandbox'`, `sandbox_` references), covering decline, requires-action and void outcomes via its documented amounts | `lib/demo/seed/payments.integration.test.ts` |
| **Boundary** | no `is_demo`/`demo` reference in `lib/payments/**`, `lib/payouts/**`, `lib/notifications/**` or `lib/ai/**`; no demo row inserted by any migration; `demo-mode` is registered exactly per §3.7 | `lib/demo/boundary.test.ts` |
| **Integration** | 0039 up/down, CHECK, index, flag seeded off | `lib/demo/migration.integration.test.ts` |
| **Script** | `demo-reseed` and `demo-create-admin` refuse outside the §3.1 conditions and when a non-demo user exists; `super_admin` refused | `scripts/demo-reseed.test.ts`, `scripts/demo-create-admin.test.ts` |
| **Component** | banner renders with the flag on outside production and not otherwise; the entry page's loading, unavailable and error states | `app/_components/DemoModeBanner.test.tsx`, `app/(auth)/demo/page.test.tsx` |
| **Route-level** | customer persona: demo login → search → request → offers → booking → sandbox payment → review, through the route handlers | `e2e/demo-mode.spec.ts` (Vitest route-level, the repository's `e2e/` convention) |

All integration tests run on the isolated `*_test` database. A test that needs the `_demo` guard to
pass stubs the database-name reader; it never renames or creates a database.

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/demo/login/route.integration.test.ts`, `e2e/demo-mode.spec.ts::one-click login per persona` |
| AC-2 | `lib/demo/seed/coverage.integration.test.ts::spans all required entity states` |
| AC-3 | `app/_components/DemoModeBanner.test.tsx`, `lib/demo/identity.test.ts` |
| AC-4 | `lib/demo/seed/payments.integration.test.ts::sandbox adapter, not fabricated`, `lib/demo/boundary.test.ts` |
| AC-5 | `app/api/v1/demo/reset/route.integration.test.ts::isolated reset, no existing row changed` |
| AC-6 | `lib/demo/identity.test.ts`, `lib/demo/boundary.test.ts` |
| AC-7 | `app/api/v1/demo/guards.integration.test.ts` |

**Coverage:** ≥80% statements, branches, functions and lines on `lib/demo/**`.

**Other specs' tests (must stay green):** specs 005, 009, 010, 020, 021, 026, 039, 040 and 041. The
only edits to other specs' tests are X-6.

**Not covered, deliberately:** Seed-data realism/quality as a subjective judgment — functional
completeness (all required states represented) is the acceptance bar, not editorial polish.

---

## 7. Out of scope

- Sales/marketing-specific demo scripting or guided tours (a product/growth concern, not a
  platform spec).
- **Demo mode in production**, by design (D-1).
- **A one-click Admin demo, or any admin session without MFA** (D-2).
- True multi-tenant sandboxing between demo visitors (§3.3). Isolation from production data is by
  database.
- A real payment vendor's test mode. None exists; spec 021 adds a vendor adapter when one is
  contracted, and 045 needs no change then.
- Changing the adapters' production guard (DEP-1), which belongs to specs 021/024/026/033.
- Tagging demo data in analytics or audit (D-6).

---

## 8. Dependencies, decisions, risks

### Dependencies

| # | Dependency | Owner | Status |
|---|---|---|---|
| DEP-1 | A hosted, non-production way for the payment, payout, notification and AI adapters (`lib/payments/provider/index.ts`, `payout-factory.ts`, `lib/notifications/channels/index.ts`, `lib/ai/provider/index.ts`) to run their sandboxes, which today refuse under the `NODE_ENV=production` every hosted server sets. **The mechanism, and whether to provide it at all, is decided by the owning specs**; one option raised during review is keying the refusal on spec 041's `APP_ENV=production`. | specs 021, 024, 026, 033 | **Unresolved. Required for a hosted demo, and not approved.** It must be approved separately through those specs. 045 does not modify, bypass or weaken the existing refusal, and adds no sandbox or payment branch. |
| DEP-2 | A hosted demo deployment: `APP_ENV=staging`, a `_demo` database, `DEMO_MODE_ENABLED=true`, the sandbox adapters | spec 046 (hosting) | operational |
| DEP-3 | The in-flight working-tree changes (spec 033 OpenAI work in `lib/ai/**`, `package.json`, `.env.example`, `instrumentation.ts`) are landed first, because X-2 edits `.env.example` | — | implementation start |

### Authorized cross-spec changes (X-list)

| # | Owning spec | File(s) | Change |
|---|---|---|---|
| X-1 | 005 | `lib/auth/login-flow.ts` | Add `'demo'` to `LoginMethod`, so the security event records the method. `completeLogin` itself is unchanged, and its admin-MFA rule applies to demo logins exactly as to every other login. |
| X-2 | 001 | `.env.example` | Document `DEMO_MODE_ENABLED` (empty by default), with the §3.1 guard explanation |
| X-3 | 002/042 | `app/layout.tsx` | Render `<DemoModeBanner />` inside `LocaleProvider` when §5's server-side condition holds. Nothing else. |
| X-4 | 014 | `app/account/page.tsx` | A "Reset demo" `Button` plus `ConfirmDialog`, rendered only for `is_demo` users (requires X-7) |
| X-5 | 042 | `lib/i18n/dictionaries/en.ts` | `demo.*` keys (`ur` falls back per spec 042 AC-6) |
| X-6 | 041 (tests) | `lib/feature-flags/registry.test.ts` (the `APPROVED` list gains `demo-mode`, and `demo-mode` is removed from the key list of the D-8 test "registers none of the flags the owning specs removed or never defined"; `matching-fairness-exposure` and `marketing-notifications` stay in it), `app/api/v1/admin/feature-flags/routes.integration.test.ts` (the Super Admin list `toHaveLength(7)` → `8`), `lib/feature-flags/migration.integration.test.ts` (its description text, and the 0036 file-level check's owning-spec exemption gains `045` beside spec 042's — later flags ship in their own migration) | accept the registered eighth flag. `resolve.test.ts` and `environment-isolation.integration.test.ts` need no edit, because `demo-mode` is not client-readable. These are the only spec 041 test edits. |
| X-7 | 006 | `lib/types/users.ts`, `app/api/v1/users/me/route.ts`, `app/api/v1/users/me/active-mode/route.ts` | Add `UserDto.isDemo: boolean` (additive), for the X-4 gate. It is set by both routes that build the DTO, as spec 042 X-4 did for `locale`. |
| X-8 | 004 | `lib/api/openapi-registry.ts` | D1, D2 |
| X-9 | 041 | `lib/feature-flags/registry.ts` | the `demo-mode` entry (§3.7) |

### Decisions

| # | Decision |
|---|---|
| D-1 | Demo runs only in a dedicated non-production deployment: `APP_ENV≠production`, the `demo-mode` flag on, and a `_demo` database, all enforced server-side on every call. In production, `/demo/*` returns `403` and no payment path changes. |
| D-2 | No one-click Admin demo. Admin evaluators get operator-provisioned, non-super-admin accounts that use spec 005's mandatory MFA. This is a documented deviation from master §111. |
| D-3 | Per-visitor demo sets, provisioned fresh. Reset provisions a new set and switches the session; nothing is ever updated or deleted. Environment-wide cleanup is the guarded operator reseed of the `_demo` database. |
| D-4 | Demo payments use spec 021's unchanged port with the sandbox adapter and its deterministic test amounts. There are no demo branches in payment, payout, notification or AI code. Master §112's vendor sandbox applies "where available"; none is available. |
| D-5 | The catalog is reused from migration 0006. The seed never inserts categories or services. |
| D-6 | Analytics and audit are isolated by database; specs 039 and 040 are unchanged. |
| D-7 | `demo-mode` is a developer flag, off everywhere, overridden by `DEMO_MODE_ENABLED`, registered and seeded exactly per spec 041 §3.3. |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | DEP-1 is unresolved, so a hosted demo cannot take sandbox payments or dispatch through the sandbox channels | 045 does not work around it. A hosted demo cannot meet AC-4/AC-6 until the owning specs approve DEP-1. This is 045's open dependency. |
| R-2 | Cross-set interaction through live matching | Accepted (§3.3); all accounts are synthetic |
| R-3 | Demo database growth between reseeds | Nightly and per-deploy reseed |
| R-4 | Someone enables `DEMO_MODE_ENABLED` on a real staging deployment | The `_demo` database-name guard refuses; `demo.misconfigured` is logged |
| R-5 | A real account registered inside the demo environment | It blocks the reseed until an operator deliberately removes it; never deleted automatically |
| R-6 | Provisioning cost per D1 | One transaction per visitor; the `auth` rate-limit bucket bounds abuse |

---

## 9. Rollout

- **Feature flag:** `demo-mode` (§3.7), **off** in every environment by default. A demo deployment
  sets `DEMO_MODE_ENABLED=true`, and production never does. Even if the flag were on, `APP_ENV=production`
  refuses.
- **Migration order:** `0039` ships with the code. It adds the columns and the flag only, and seeds no
  demo data.
- **Precondition:** DEP-1 is approved and implemented by its owning specs before a hosted demo is
  deployed.
- **Rollback:**
  - turn `demo-mode` off: `/demo/*` refuses on the next request, with no deploy;
  - or revert the deploy;
  - `0039_…_down.sql` is optional and drops the columns and the flag;
  - demo data is disposable: run the reseed.
- **Observability:** the structured lines `demo.set_provisioned`, `demo.reset`,
  `demo.environment_reseeded` and `demo.misconfigured` (master §117). Demo usage is counted from these
  lines in the demo environment's logs, never mixed into production metrics (D-6).

---

## 10. Implementation notes and verification (2026-10-15; re-verified 2026-10-27)

**Corrections made while implementing, each settled by an owning spec or the repository, not invented:**

- **`400`, not `422`, for `VALIDATION_ERROR`.** Spec 004 AC-3 owns the error taxonomy and fixes `VALIDATION_ERROR` at `400`; every route follows it. AC-1, §3.2 and §3.6 are corrected to match.
- **Entry page path.** The page lives at `app/(auth)/demo/page.tsx`, so the URL is exactly `/demo`. A new top-level `app/demo` segment would need an entry in spec 044's `lib/seo/route-policy.ts`, which is outside the X-list. The `(auth)` group already carries spec 044's `noindex` layout and the shared auth shell.
- **`UserDto.isDemo` is set by both routes that build the DTO.** `PATCH /users/me/active-mode` (spec 006) returns the DTO that replaces the account page's copy, so without the field "Reset demo" would disappear after a mode switch. X-7 is applied to that route exactly as spec 042 X-4 applied `locale`. Verified by `app/api/v1/demo/user-dto.integration.test.ts` and the mode-switch case in `app/_components/DemoResetAction.test.tsx`.
- **Request statuses.** No owning spec seeds a transition into `expired` or `completed` (specs 018/026/028), so §3.3's rule that no state the real machine cannot produce may be written covers the six reachable statuses: `submitted`, `matching`, `offers_open`, `provider_selected`, `booking_created` and `cancelled`.
- **"Cancellation/void" (AC-4).** The sandbox has no amount-driven void, and no application path calls `voidAuthorization`. Spec 023 only cancels a captured payment. Each set therefore shows cancellation through spec 023's fee ladder and spec 022's sandbox refund:
  - 18 hours before the job: a 25% fee and a partial refund, so the booking stays `cancelled`;
  - 72 hours before: a full refund, so the booking becomes `refunded`.
- **One transaction.** The owning modules' public write functions each open their own transaction. The provisioner uses their transaction-composable primitives:
  - spec 021's `record.ts` and state machine;
  - spec 022's refund state machine;
  - spec 023's `ensurePolicyAcceptance` and `computeCancellationConsequence`;
  - spec 029's `resolveReviewEligibility` and `evaluateReviewSignals`;
  - spec 026's `renderNotification`.

  Everything else is the trigger-checked walk §3.3 prescribes. Payment, refund and attempt rows carry the provisioning instant, because `record.ts` uses `clock_timestamp()`. Booking, offer and request histories are back-dated.
- **No phone numbers.** `users.phone_number` is unique, and the fictional range holds only 100 numbers, so seeded users have none. Nothing outside the range is ever used.
- **Notifications are inbox rows only.** No `notification_deliveries` row is created, so nothing is ever dispatched.
- **`demo-create-admin` credential.** The evaluator needs a credential for the normal login. The script generates a random one-time password, prints it once and stores only its scrypt hash. No MFA secret is touched. Both operator scripts also refuse while any non-demo user exists.
- **Parallel-safe "wrote nothing" checks.** A global before/after row diff fails whenever another test file writes in parallel. Two such false failures appeared in full-suite runs:
  - the catalog check in the coverage suite (fixed in `ee18ded`);
  - AC-5's deletion check in the reset suite: another file deleted its own `cron_job_heartbeats` rows mid-reset.

  Both now judge only what the provisioning itself did. They check the statements it issued (`capturedWrites` in `lib/demo/demo-test-support.ts`), and the reset suite still attributes updates by the provisioning transaction's `xmin`. The reset suite has a deterministic regression test: an outside connection deletes a row during the reset and is not counted, while a delete through the suite's own pool is caught.

**Verification (local, isolated `apuriva_test` database, on a clean checkout of the branch):**

| Check | Result (2026-10-27) |
|---|---|
| Spec 045 suites (19 files, 125 tests): unit, integration, component, scripts, route-level e2e, and the feature-flag suites with the X-6 edits | **pass**, run with one worker |
| `tsc --noEmit` | pass |
| `eslint .` | 0 errors; no warnings in Spec 045 files |
| `check:schema-money-lint`, `check:no-workspace` | pass |
| `check:schema-checksum` | fails on a Windows CRLF checkout only. The committed `0001_baseline_schema.sql` blob matches the recorded hash, and Spec 045 does not touch the file. |
| `check:env` | **fails**: `REVIEW_WINDOW_DAYS` (spec 029, `lib/reviews/limits.ts`) is missing from `.env.example`. Already missing at this spec's base `642b42e`; not a Spec 045 variable. |
| `check:openapi-drift` | **fails**: spec 010's admin subcategory routes use `{id}` in `app/api/v1/**` and `{categoryId}` in the registry. Both demo routes match the registry. |
| Coverage of `lib/demo/**` (statements / branches / functions / lines) | 93.9% / 85.8% / 96.2% / 97.1%, measured 2026-10-15 and not re-measured |

**Full suite.** Two complete runs, each with `vitest run --maxWorkers=2` and the database up. **No clean full-suite pass has been established.**

- **At `f076c8e` (2026-10-27/28):** 591 files and 4,754 tests, with 19 tests failing in 12 files. The run took 2.9 hours under heavy machine load, against about 1 hour for the earlier run. **No Spec 045, demo or e2e test failed**, including the AC-5 reset test.
  - **Listed in `test/known-failures.json` (7 tests):**
    - `lib/db/concurrency.integration.test.ts` (2 tests)
    - `lib/db/migrations.integration.test.ts`
    - `lib/db/schema-coverage.test.ts`
    - `lib/db/schema-lint.test.ts`
    - `app/explore/[category]/[service]/page.test.tsx`
  - **Not listed and not verified (12 tests):**

    | File | Owner | Failing tests | How they failed |
    |---|---|---|---|
    | `app/api/v1/requests/negotiation.integration.test.ts` | spec 019 | 6 | 60-second timeouts, failed sign-ups, a missing `429` |
    | `lib/ai-assistant/activity.integration.test.ts` | spec 034 | 2 | timeout, failed sign-up |
    | `app/api/v1/admin/roles.integration.test.ts` | spec 009 | 1 | |
    | `lib/bookings/evidence.integration.test.ts` | spec 028 | 1 | timeout |
    | `lib/feature-flags/environment-isolation.integration.test.ts` | spec 041 | 1 | |
    | `lib/payments/sweep.integration.test.ts` | spec 021 | 1 | its idempotency check failed 29 other bookings on the second sweep |
    | `lib/reviews/routes.integration.test.ts` | spec 029 | 1 | |

  - **Not attributed to Spec 045 or ruled out.** None of these was rerun alone. Spec 045 does not modify their files. Two are worth noting:
    - The feature-flag suite is in an area Spec 045 edits (X-6, the `demo-mode` flag).
    - The extra bookings the sweep picked up may include demo-seeded `pending` bookings.

    Both passed in the `ee18ded` run.
- **At `ee18ded` (2026-10-23):** 591 files and 4,753 tests, with 13 tests failing in 9 files.
  - The same 7 listed failures.
  - 6 unlisted failures, each of which passed when its file was rerun alone with one worker:
    - the AC-5 reset test (fixed as noted above);
    - `lib/payments/protection-window` (3 tests);
    - `lib/payments/sweep` (2 tests);
    - `lib/reviews/routes` (1 test).

| AC | Status | Evidence |
|---|---|---|
| AC-1 | **Pass (local)** | `app/api/v1/demo/login/route.integration.test.ts`, `e2e/demo-mode.spec.ts` |
| AC-2 | **Pass (local)** | `lib/demo/seed/coverage.integration.test.ts`; request statuses as noted above |
| AC-3 | **Pass** | `app/_components/DemoModeBanner.test.tsx`, `lib/demo/identity.test.ts` |
| AC-4 | **Pass locally; blocked for a hosted demo (DEP-1)** | `lib/demo/seed/payments.integration.test.ts`, `lib/demo/boundary.test.ts` |
| AC-5 | **Pass (local)** | `app/api/v1/demo/reset/route.integration.test.ts`, including the parallel-deletion regression test |
| AC-6 | **Pass locally; blocked for a hosted demo (DEP-1)** | `lib/demo/identity.test.ts`, `lib/demo/boundary.test.ts`, the coverage suite's zero-delivery check |
| AC-7 | **Pass** | `app/api/v1/demo/guards.integration.test.ts`, `lib/demo/guards.test.ts` |

The status stays **Draft**. Spec 045's implementation and local verification are complete, with its focused suites passing. Two things remain open:

- **A clean full-suite pass** is still outstanding.
- **DEP-1 is an external blocker** owned by specs 021, 024, 026 and 033, and not resolved by this spec. Until those specs approve it, AC-4 and AC-6 cannot be met on a hosted deployment.

