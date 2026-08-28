# Spec: Database & Core Data Model

**File:** `docs/specs/2026-08-28-003-database-core-data-model.md`
**Status:** Draft
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

**Success looks like:** A PostgreSQL schema/migration baseline exists with the money, time, and
state-machine conventions encoded as reusable column types/helpers, plus the full entity list
from master spec §124 stubbed as empty tables with correct types, ready for later specs to add
columns/logic to incrementally rather than inventing the base pattern each time.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any monetary column in the schema **When** inspected **Then** it is stored as `integer` (minor units) plus a separate `currency_code text` column — never `numeric`, `float`, or `double` |
| AC-2 | **Given** any timestamp column **When** inspected **Then** it is `timestamptz` stored in UTC; any record needing a local-time-of-appointment also stores the original timezone identifier separately |
| AC-3 | **Given** an entity with an explicit state machine (Request, Offer, Booking, Payment, Payout) **When** an application-layer update attempts an invalid transition **Then** the database/ORM layer rejects it, not just the frontend |
| AC-4 | **Given** the entity list in master spec §124 **When** compared against the schema **Then** every entity exists as a table (may be minimal/empty of feature columns pending its owning spec) with correct primary keys, foreign keys, and indexes for its declared relationships |
| AC-5 | **Given** a service-specific variable attribute (e.g. AC repair details) **When** modeled **Then** it lives in a scoped `jsonb` column on the owning row, not as a top-level relational column, and not as the entire row's representation |
| AC-6 | **Given** two concurrent updates to the same row **When** both attempt to write **Then** optimistic concurrency (a `version`/`row_version` column) prevents a silent lost update |

---

## 3. API contract

Not applicable directly — this spec is the data layer beneath the API. Every later spec's §4
"Data model changes" section is additive to the baseline this spec establishes.

---

## 4. Data model changes

### Entities

All entities listed in master spec §124 are created as baseline tables in this spec (columns
limited to identity, timestamps, `version`, and foreign keys where the relationship is
structural; feature-specific columns are added by the owning spec):

```
User, CustomerProfile, ProviderProfile, AdminProfile, Role, Permission,
Category, Subcategory, Service, ServiceField, ServiceRequirement, ServiceFAQ, ServicePackage,
ProviderService, ProviderAvailability, ProviderAvailabilityOverride, ProviderServiceArea,
Request, RequestFieldValue, RequestAttachment, RequestProviderMatch,
Offer, OfferRevision, OfferMessage,
Booking, BookingStatusHistory, BookingMilestone,
Payment, PaymentAttempt, PaymentAuthorization, Refund, RefundLine, Payout, PayoutMethod,
Conversation, ConversationParticipant, Message, MessageAttachment,
Review, ReviewResponse, ReviewReport,
Dispute, DisputeEvidence, DisputeMessage, DisputeResolution, DisputeAppeal,
SafetyReport, SupportTicket, SupportMessage, SupportNote,
Notification, NotificationPreference,
AIConversation, AIMessage, AIMemory, AIAction, AIToolCall,
AuditLog, FeatureFlag, Policy, PolicyVersion, PolicyAcceptance,
Session, SecurityEvent, FileAsset, Location, Address, AnalyticsEvent
```

Baseline convention for every table: `id uuid primary key default gen_random_uuid()`,
`created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`,
`version integer not null default 1`. Money-bearing tables additionally carry
`amount_minor_units integer` + `currency_code text` pairs per field (never a single float
column). State-machine tables (`Request`, `Offer`, `Booking`, `Payment`, `Payout`) carry a
`status` enum column plus a `*_status_history` table recording every transition with actor and
timestamp.

### Migration

- **Name:** `0001_baseline_schema`
- **Reversible:** yes — a full `down` migration drops all baseline tables (safe pre-launch only)
- **Backfill required:** no (no existing data)
- **Downtime:** none (fresh database)
- **Reviewed SQL:** to be generated by the ORM's migration tool and reviewed in the implementing
  PR

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
| **Unit** | money-type helper (format/parse minor units), state-machine transition validator | `packages/database/**/*.test.ts` |
| **Integration** | migration applies cleanly to a fresh database; foreign keys/indexes exist as declared | `packages/database/migrations.integration.test.ts` |
| **Architecture** | a lint rule rejecting any `numeric`/`float`/`double` column type on a money-suffixed field | CI schema-lint script |
| **E2E** | N/A | — |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `packages/database/schema-lint.test.ts::no float money columns` |
| AC-2 | `packages/database/schema-lint.test.ts::timestamps are timestamptz` |
| AC-3 | `packages/database/state-machine.test.ts::rejects invalid transition` |
| AC-4 | `packages/database/schema-coverage.test.ts::all §124 entities present` |
| AC-6 | `packages/database/concurrency.test.ts::rejects stale version write` |

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

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | ORM choice (Prisma, Drizzle, Kysely, TypeORM) affects how state-machine validation and migrations are authored | — | Open — recommend Drizzle or Prisma for TypeScript-first schema + migration tooling |
| 2 | Whether state-machine validation lives purely in the ORM layer or also as Postgres check constraints/triggers for defense-in-depth | — | Open — recommend both: ORM-layer validation for good error messages, DB constraints as a last-resort guard |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** this migration ships first, before any application code depends on it.
- **Rollback:** drop and recreate from `0001_baseline_schema` down migration (pre-launch only).
- **Observability:** migration runner logs applied migration versions; a `/api/v1/health` DB
  check (from spec 001) confirms connectivity against this schema.
