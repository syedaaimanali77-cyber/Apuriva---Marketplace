# Spec: Database & Core Data Model

**File:** `docs/specs/2026-08-28-003-database-core-data-model.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §4.3, §6, §7, §124, §125, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §5, §14, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No database or schema exists. Every domain spec (accounts, catalog, requests,
offers, bookings, payments, etc.) needs a shared set of conventions — how money is stored, how
time is stored, how state machines are validated, how JSON is scoped vs. relational columns —
decided once, consistently, before any table is created. Deciding these per-feature would risk
exactly what master spec §132 forbids: floating-point money, client-trusted timers, and
inconsistent state-transition enforcement.

**Who is affected:** Every backend spec from 005 onward; finance/reconciliation (money
handling); anyone debugging a booking/offer/payment state later.

**Why it matters now:** It is Milestone 1 foundation work (master spec §131) — the base every
other entity is built on.

**Success looks like:** A PostgreSQL schema/migration baseline — Drizzle ORM, built on spec 001's
existing `lib/db/` connection/migration foundation, no separate `packages/database` or other
monorepo package — exists with the money, time, and state-machine conventions encoded as
reusable column types/helpers, plus the full entity list from master spec §124 stubbed as
baseline tables with correct types, ready for later specs to add columns/logic to incrementally
rather than inventing the base pattern each time.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any monetary value in the schema **When** inspected **Then** it is stored as its own semantically-named `integer` (minor units) column paired with its own `currency_code text` column — never `numeric`, `float`, or `double` — and a DB constraint enforces that the pair is either both null or both set |
| AC-2 | **Given** any timestamp column **When** inspected **Then** actual instants are `timestamptz` stored in UTC; any record needing a scheduled/appointment local time also stores the original IANA timezone identifier (e.g. `Asia/Karachi`) in a separate column |
| AC-3 | **Given** an entity with an explicit state machine (Request, Offer, Booking, Payment, Payout) **When** an update attempts a transition **Then** PostgreSQL is the final enforcement layer — a DB function/trigger checks the attempted `(old_status, new_status)` pair against that entity's transition table and rejects the write if it isn't listed, independent of and in addition to any application/Drizzle-layer validation (which exists only to surface a friendlier error before the write is attempted); the concrete valid states/transitions for each entity are owned by that entity's later spec, not by this one |
| AC-4 | **Given** the entity list in master spec §124, plus the five status-history tables (request, offer, booking, payment, payout) and their companion status-transition tables **When** compared against the schema **Then** every entity exists as a baseline table (minimal/empty of feature columns pending its owning spec) with correct primary keys, foreign keys indexed and defaulting to `RESTRICT`/`NO ACTION` (an owning spec may explicitly choose `CASCADE`/`SET NULL` for a specific relationship), and indexes for its declared relationships |
| AC-5 | **Given** a service-specific variable attribute (e.g. AC repair details) **When** modeled **Then** it lives in a scoped `jsonb` column on the owning row; core, queryable, or relationship data is never folded into `jsonb` for convenience |
| AC-6 | **Given** two concurrent updates to the same row **When** both attempt to write **Then** each update is issued as `UPDATE ... SET version = version + 1, ... WHERE id = $1 AND version = $2`; the update that lands first succeeds and increments `version`; the second finds zero matching rows and the application surfaces that as an explicit concurrency-conflict error, never a silent lost update |

---

## 3. API contract

Not applicable directly — this spec is the data layer beneath the API. Every later spec's §4
"Data model changes" section is additive to the baseline this spec establishes.

---

## 4. Data model changes

### Entities

All entities listed in master spec §124 are created as baseline tables in this spec (columns
limited to identity, timestamps, `version`, and foreign keys where the relationship is
structural; feature-specific columns are added by the owning spec), plus the five dedicated
status-history tables and their companion status-transition tables (§8 risk #2 resolution,
below) for each of the five state-machine entities:

```
User, CustomerProfile, ProviderProfile, AdminProfile, Role, Permission,
Category, Subcategory, Service, ServiceField, ServiceRequirement, ServiceFAQ, ServicePackage,
ProviderService, ProviderAvailability, ProviderAvailabilityOverride, ProviderServiceArea,
Request, RequestFieldValue, RequestAttachment, RequestProviderMatch,
  RequestStatusHistory, RequestStatusTransition,
Offer, OfferRevision, OfferMessage,
  OfferStatusHistory, OfferStatusTransition,
Booking, BookingMilestone,
  BookingStatusHistory, BookingStatusTransition,
Payment, PaymentAttempt, PaymentAuthorization, Refund, RefundLine, Payout, PayoutMethod,
  PaymentStatusHistory, PaymentStatusTransition, PayoutStatusHistory, PayoutStatusTransition,
Conversation, ConversationParticipant, Message, MessageAttachment,
Review, ReviewResponse, ReviewReport,
Dispute, DisputeEvidence, DisputeMessage, DisputeResolution, DisputeAppeal,
SafetyReport, SupportTicket, SupportMessage, SupportNote,
Notification, NotificationPreference,
AIConversation, AIMessage, AIMemory, AIAction, AIToolCall,
AuditLog, FeatureFlag, Policy, PolicyVersion, PolicyAcceptance,
Session, SecurityEvent, FileAsset, Location, Address, AnalyticsEvent
```

**Baseline conventions** (apply to every table unless noted):

- Identity/audit columns: `id uuid primary key default gen_random_uuid()`,
  `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.
- **Optimistic concurrency:** `version integer not null default 1`. Every update statement is
  `UPDATE <table> SET version = version + 1, ... WHERE id = $1 AND version = $2`; an update that
  matches zero rows means another writer already moved the version forward, and the application
  surfaces that as an explicit concurrency-conflict error rather than retrying silently.
- **Money:** every distinct monetary value gets its own semantically-named pair — e.g.
  `deposit_amount_minor_units integer` + `deposit_currency_code text`, never a single reused
  `amount`/`currency` pair on a row that represents more than one monetary value, and never
  `numeric`/`float`/`double`. Each pair carries a `CHECK` constraint that both columns are null
  together or set together, plus a `CHECK` that `currency_code` is a 3-character uppercase ISO
  4217-shaped code.
- **Time:** actual instants use `timestamptz` (UTC). A record that also needs a scheduled/
  appointment local time stores the original IANA timezone identifier alongside it — e.g.
  `scheduled_at timestamptz` + `scheduled_at_timezone text` (`'Asia/Karachi'`) — so the local
  wall-clock time can be reconstructed later regardless of server timezone.
- **State machines:** `Request`, `Offer`, `Booking`, `Payment`, and `Payout` each carry a
  `status text` column. PostgreSQL is the final enforcement layer for transitions: a
  `BEFORE UPDATE` trigger calls a function that checks the attempted `(OLD.status, NEW.status)`
  pair against that entity's `*StatusTransition` table (columns: `from_status text`,
  `to_status text`, unique on the pair) and raises an exception if the pair isn't listed there.
  The matching `*StatusHistory` table records every transition that does succeed, with the
  actor and a `timestamptz`. This spec creates the `status` column, the empty transition-table
  shape, and the trigger mechanism as baseline structure only — it does **not** decide or
  populate any entity's actual valid states or transition pairs; that belongs entirely to each
  entity's owning spec (e.g. Offer's real states ship with
  `docs/specs/2026-08-28-018-offer-system-timer.md`). Application/Drizzle-layer validation may
  additionally pre-check a transition before issuing the `UPDATE`, purely to return a friendlier
  error message — it is never the only enforcement, and the DB trigger still applies regardless.
- **JSONB:** reserved for genuinely variable, service-specific attributes scoped to a single
  `jsonb` column on the owning row (e.g. AC-repair-specific request fields). Core, queryable, or
  relationship data always stays in relational columns/tables, never inside `jsonb` for
  convenience.
- **Foreign keys:** every FK defaults to `ON DELETE RESTRICT` (or `NO ACTION`, functionally
  equivalent without an explicit `ON DELETE` clause). An owning spec may explicitly choose
  `CASCADE` or `SET NULL` for a specific relationship, documented in that spec's own §4 — this
  spec does not default to either.
- **Indexes:** every foreign-key column gets a `btree` index (primary keys are indexed
  automatically by the `PRIMARY KEY` constraint). No other unique constraint or index is added
  at baseline unless a later spec explicitly requires it for its own querying/uniqueness needs.
- **Soft delete:** there is no universal `deleted_at` column. Whether an entity supports soft
  delete, and how, is decided per-entity by that entity's owning spec — this spec does not add
  one by default anywhere.

### Migration

- **Name:** `0001_baseline_schema`
- **Workflow:** schema is authored first in `lib/db/schema.ts` (Drizzle ORM, the existing spec
  001 database module); `npm run db:generate` (`drizzle-kit generate`) then produces the SQL
  migration file under `drizzle/`, which is reviewed in the implementing PR before merge —
  schema-then-migration, never a hand-written migration authored ahead of the schema.
- **Immutability:** once `0001_baseline_schema` is merged, its generated SQL is never edited
  again — not even to fix a baseline mistake found later. Every subsequent schema change,
  baseline or feature-specific, ships as its own new sequentially-numbered migration
  (`0002_*`, `0003_*`, …) applied via `npm run db:migrate` (`lib/db/migrate.ts`).
- **Reversible:** yes — `0001_baseline_schema` ships with a full `down` migration dropping all
  baseline tables (safe pre-launch only; not a promise later migrations stay reversible).
- **Backfill required:** no (no existing data).
- **Downtime:** none (fresh database).
- **Reviewed SQL:** generated by `drizzle-kit`, reviewed in the implementing PR — never
  hand-edited.

### Retention and privacy

This spec does not populate personal data; it establishes that `User` and related identity
tables exist. Retention/deletion rules for each entity are specified per-domain in the owning
spec (e.g. account deletion in `docs/specs/2026-08-28-008-security-sessions-privacy-center.md`).

---

## 5. UI states

Not applicable — no user-facing screen.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | money-pair helper (format/parse minor units), Drizzle-layer transition pre-validator (the friendly-error path) | `lib/db/**/*.test.ts` |
| **Integration** | migration applies cleanly to a fresh database; foreign keys/indexes exist as declared; a DB trigger rejects a status update whose `(from, to)` pair isn't in that entity's transition table, independent of the application layer; a stale-`version` update is rejected | `lib/db/migrations.integration.test.ts`, `lib/db/status-transitions.integration.test.ts`, `lib/db/concurrency.integration.test.ts` |
| **Architecture** | a lint rule rejecting any `numeric`/`float`/`double` column type on a money-suffixed field; a CI check that fails if `drizzle/0001_baseline_schema`'s generated SQL differs from its originally-committed checksum (immutability guard) | CI schema-lint script |
| **E2E** | N/A | — |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/db/schema-lint.test.ts::no float money columns, currency pair CHECK constraints present` |
| AC-2 | `lib/db/schema-lint.test.ts::timestamps are timestamptz; scheduled-time columns pair with an IANA timezone column` |
| AC-3 | `lib/db/status-transitions.integration.test.ts::DB trigger rejects a transition absent from the entity's transition table even when the app layer is bypassed` |
| AC-4 | `lib/db/schema-coverage.test.ts::all §124 entities present, including the five status-history and status-transition tables; FKs default to RESTRICT/NO ACTION and are indexed` |
| AC-5 | `lib/db/schema-lint.test.ts::jsonb columns are scoped to variable/service-specific fields, never core/queryable data` |
| AC-6 | `lib/db/concurrency.integration.test.ts::WHERE id=? AND version=? update rejects a stale write as a concurrency conflict, never a silent overwrite` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Feature-specific columns/business rules for each entity — those
are each owning spec's responsibility and are tested there.

---

## 7. Out of scope

- Feature-specific columns and business logic for any single entity (added incrementally by
  specs 005–046).
- Search indexing (full-text/vector) — see `docs/specs/2026-08-28-013-search-discovery.md`.
- Analytics event ingestion pipeline details — see
  `docs/specs/2026-08-28-040-analytics-reporting.md`; only the `AnalyticsEvent` table shape is
  stubbed here.
- The `Payment` ↔ `Payout` relationship (which settled payments compose a given payout) — owned
  by `docs/specs/2026-08-28-024-provider-payouts-earnings.md`. `Payment` and `Payout` are stubbed
  here as independent baseline tables per master spec §124; the FK/join structure connecting them
  is not added at baseline.
- The `FileAsset` ↔ attachment relationships (e.g. `RequestAttachment`, `MessageAttachment`
  referencing a `FileAsset`) — owned by `docs/specs/2026-08-28-027-file-uploads-media-storage.md`.
  `FileAsset` is stubbed here as an independent baseline table per master spec §124; attachment
  tables do not reference it at baseline.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | ORM choice affects how state-machine validation and migrations are authored | — | Decided — Drizzle ORM, using spec 001's existing `lib/db/` connection pool, migration runner, and `drizzle.config.ts` rather than a new module |
| 2 | Whether state-machine validation lives purely in the ORM layer or also as Postgres check constraints/triggers for defense-in-depth | — | Decided — PostgreSQL is the final enforcement layer: an explicit `*StatusTransition` whitelist table per state-machine entity plus a `BEFORE UPDATE` trigger function that rejects any `(old_status, new_status)` pair not listed there; the Drizzle/application layer may additionally pre-validate for a friendlier error, but that layer is never the only guard. This spec builds the mechanism only — each entity's actual states/transitions and business rules are decided and populated by that entity's owning spec |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** this migration ships first, before any application code depends on it.
- **Rollback:** drop and recreate from `0001_baseline_schema` down migration (pre-launch only).
- **Observability:** migration runner logs applied migration versions; a `/api/v1/health` DB
  check (from spec 001) confirms connectivity against this schema.
