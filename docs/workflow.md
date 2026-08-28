# Apuriva — User Flow & Feature Implementation Order

**Source of truth:** [Apuriva Master Specification](../Apuriva_Master_Specification%20-%20Copy.md),
[Apuriva Architecture](../Apuriva_Architecture%20-%20Copy.md)
**Purpose:** Turn the product spec's prose into an ordered, buildable feature list — sequenced by
actual user journey and technical dependency, not by document section order. Every spec in
[docs/specs/](specs/) is numbered against the order defined here.

> How to use this file: pick the next unbuilt counter from the table below, open its spec in
> [docs/specs/](specs/README.md), implement it per
> [docs/TEMPLATE-SPEC.md](TEMPLATE-SPEC.md)'s acceptance criteria, then move to the next counter.
> Do not skip ahead — later specs assume earlier ones exist (see Dependencies, below).

---

## 1. The canonical user journeys

These are the four end-to-end journeys the MVP must support (master spec §128). Every feature
domain below exists to make one or more steps of these journeys real.

### Customer journey

```
Guest
 → Search (keyword / natural language / voice)
 → Service page
 → Request creation (service-specific fields, budget, location, media)
 → Provider matching → request distributed to eligible providers
 → Offers received (2-minute server-authoritative response window per offer)
 → Compare offers (price, rating, distance, badges)
 → Select provider → payment authorization
 → Booking confirmed
 → Chat with provider
 → Provider arrives → service in progress
 → Service completed (evidence if required)
 → Payment protection window → settled
 → Review
```

### Provider journey

```
Signup → Provider profile → Verification
 → Define services, packages, pricing
 → Set availability (recurring schedule + overrides) and service areas
 → Receive incoming request (from matching/distribution pool)
 → Accept / Send offer / Decline
 → Negotiate (pre-booking chat, revised offers)
 → Booking confirmed
 → Arrive → Start service → Mark complete (evidence if required)
 → Earnings ledger updates (pending → eligible → paid)
 → Payout
 → Respond to review
```

### Admin journey

```
Login (mandatory MFA)
 → Dashboard (marketplace health, alerts)
 → User / provider management (verification, moderation)
 → Marketplace configuration (categories, services, matching weights, policies)
 → Operations: requests, bookings, disputes, support, safety queue
 → Audit log review
 → Analytics
```

### AI / MCP journey

```
Natural language input (chat or voice)
 → Intent extraction (AI)
 → Real search / real provider data (never AI-invented results)
 → Explainable recommendation
 → Risk-tiered confirmation (low: automatic, medium: conversational, high: structured UI)
 → MCP tool call
 → Backend authorization (independent of what the AI "decided")
 → Real result
 → AI reports truthfully (never claims success without confirmed backend success)
```

---

## 2. Dependency notes (why the order isn't purely sequential-by-milestone)

- **Booking (020)** depends on both **Offers (017–018)** and **Availability (019)** being in
  place — a booking is the confirmed output of an accepted offer against a validated slot.
- **Payment processing (021)** must exist before **Booking (020)** can go fully live end-to-end
  for offer-based/paid services, but the booking state machine and payment authorization are
  specified separately because payment timing is itself service-model-dependent (master spec
  §46) and reused by cancellation (023) and refunds (022).
- **Messaging (025)** is needed in a limited form before booking (pre-booking chat, master spec
  §33) and in full form after (post-booking chat) — the spec covers both, but pre-booking chat
  is what request/offer flows (015–018) actually depend on.
- **MCP tools (035–036)** wrap the modules that already exist — each MCP action tool is only
  buildable once its underlying module (requests, offers, bookings, payments, etc.) has a real
  authorization boundary to call into. MCP is deliberately sequenced after the modules it
  orchestrates, not before.
- **Admin RBAC (009)** is built early (Milestone 2) because every subsequent admin-configurable
  rule (matching weights, cancellation policy, feature flags) needs a permission model to sit
  behind — but the admin *workspaces* themselves (037–041) are built late, once there is
  marketplace activity for admins to operate on.
- **Audit logging (039)** is specified once, late, but its hooks are consumed by nearly every
  earlier spec (offer changes, price changes, moderation, payouts) — each earlier spec's
  acceptance criteria should note "this action is audited," even though the audit log's own
  schema/spec lands at 039.
- **Cross-cutting hardening (042–046)** — i18n, accessibility, PWA/performance, demo mode,
  CI/CD/observability — apply to every feature built before them. They are specified last but
  their *rules* (e.g. accessibility-first, no floating-point money) apply from spec 001 onward;
  see each individual spec's "UI states" and "Data model" sections, which already bake these
  rules in rather than deferring them.

---

## 3. Feature implementation order

Each row is one file in [docs/specs/](specs/), named
`2026-08-28-<counter>-<slug>.md`. "Module" references the backend module boundaries defined in
architecture doc §4.

### Milestone 1 — Foundation

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 001 | Monorepo & Environment Foundation | Monorepo layout, env/secrets separation, `.env.example` | — (platform) | §4.4, §118 |
| 002 | Design System & UI Primitives | Design tokens, branding centralization, accessible primitives | — (platform) | §3, §106 |
| 003 | Database & Core Data Model | Core entity groups, money/time handling, state-machine conventions | — (platform) | §6, §7, §124, §125 |
| 004 | API Foundation & Response Standards | API versioning, response/error conventions, rate limiting | — (platform) | §98–§101 |

### Milestone 2 — Accounts

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 005 | Authentication | Phone+OTP, email/password, Google/Apple, sessions, MFA | Auth | §9, §78 |
| 006 | User Identity & Role Switching | User/CustomerProfile/ProviderProfile model, mode switch | Users | §9.2–9.3 |
| 007 | Onboarding & Guest Experience | First-run intro, guest browsing, location-permission UX | — (frontend) | §10–§12 |
| 008 | Security Sessions & Privacy Center | Sessions, 2FA, privacy center, deletion, data export | Auth | §74–§77 |
| 009 | Admin RBAC & Roles | Admin roles, permission scopes, four-eyes approval | Admin | §69–§70 |

### Milestone 3 — Marketplace

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 010 | Service Catalog & Taxonomy | Category/subcategory/service taxonomy, admin catalog control | Categories/Services | §14, §18 |
| 011 | Category & Service Pages + Requirements | Category & service detail pages, structured fields, FAQs, pricing display | Categories/Services | §15–§17, §26 |
| 012 | Location & Address Services | Location abstraction, geocoding, service areas, privacy-aware visibility | Location | §8 |
| 013 | Search & Discovery | Keyword/NL/voice search, autocomplete, results loading, empty states | — (search infra) | §19–§22, §97 |
| 014 | Home, Personalization & Navigation | Home personalization, customer/provider/admin navigation IA | — (frontend) | §13, §59–§61, §123 |

### Milestone 4 — Requests & Matching

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 015 | Request Creation & Lifecycle | Request creation, budget, media, status, cancellation | Requests | §27–§28, §37–§38 |
| 016 | Provider Matching, Ranking & Distribution | Eligibility rules, weighted ranking, fair exposure, request distribution | Matching | §23–§25, §29–§30 |

### Milestone 5 — Offers & Booking

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 017 | Offer System & 2-Minute Timer | Offer lifecycle, server-authoritative expiry | Offers | §31–§32 |
| 018 | Offer Negotiation & Comparison | Pre-booking chat, negotiation, offer/provider comparison | Offers | §33–§36 |
| 019 | Provider Availability & Service Areas | Weekly schedule, overrides, blocked periods, availability visibility | Provider Profiles | §40–§42 |
| 020 | Booking Creation & State Machine | Server-authoritative booking, revalidation, race-condition prevention, arrival/progress | Bookings | §39, §43–§45, §125 |

### Milestone 6 — Payments

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 021 | Payment Processing & Protection | Payment timing models, authorization/capture, protection window | Payments | §46–§47 |
| 022 | Refunds | Full/partial refunds, policy-driven vs admin override | Payments | §49 |
| 023 | Cancellation Policy & No-show | Cancellation fee policy, no-show reporting/resolution | Bookings | §50–§51 |
| 024 | Provider Payouts & Earnings | Payout lifecycle, earnings dashboard, payout methods | Payouts | §48 |

### Milestone 7 — Communication

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 025 | Messaging & Conversations | Request/booking-scoped messaging, privacy, retention | Messaging | §54–§55 |
| 026 | Notifications | Push/SMS/email, categories, preferences, marketing consent | Notifications | §57–§58 |
| 027 | File Uploads & Media Storage | Upload handling, object storage/CDN, private storage, signed URLs | Files | §56, §102 |

### Milestone 8 — Completion & Trust

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 028 | Service Execution Lifecycle | Arrival, start, progress milestones, completion evidence | Bookings | §43–§45 |
| 029 | Reviews & Ratings | Review eligibility, moderation, provider response | Reviews | §52 |
| 030 | Blocking, Reporting & Safety Incidents | Block/report, safety report workflow, urgent jobs | Safety | §53, §64–§65 |
| 031 | Disputes & Resolution | Dispute lifecycle, evidence, resolution, appeals | Disputes | (entities §124: Dispute*) |
| 032 | Customer & Provider Support | Support tickets, admin support workspace | Support | §62–§63 |

### Milestone 9 — AI

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 033 | AI Assistant Architecture | AI provider abstraction, task routing, cost controls | AI | §80, §94 |
| 034 | AI Conversation, Memory & Autonomy | Conversation history, memory, activity history, undo, autonomy tiers, notification transparency | AI | §81–§87 |

### Milestone 10 — MCP

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 035 | MCP Tool Architecture & Authorization | Tool registry, 8-step authorization pipeline, confirmation, prompt-injection defense | MCP | §88–§90, §93 |
| 036 | MCP Tool Catalog, Idempotency & Errors | Read/action tool catalog, idempotency keys, structured error translation | MCP | §91–§92, §127 |

### Milestone 11 — Admin

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 037 | Admin Dashboard & Operations | Admin overview/operations workspace, marketplace configuration | Admin | §61, §71 |
| 038 | Admin Moderation & Fraud/Abuse | Moderation actions, fraud/abuse signals, appeals | Admin | §68, §79 |
| 039 | Audit Logging | Audit log schema, coverage, separation from app logs | Audit | §72 |
| 040 | Analytics & Reporting | Analytics event model, admin reporting surfaces | Analytics | §123 (Analytics nav) |
| 041 | Feature Flags & Platform Configuration | Feature flags, business vs. developer-controlled config | Admin | §71, §119 |

### Cross-cutting / Hardening

| # | Feature | Scope | Module(s) | Master spec §§ |
|---|---|---|---|---|
| 042 | Internationalization & Localization | English/Urdu/Roman Urdu, RTL, no hard-coded locale assumptions | — (platform) | §5, §120 |
| 043 | Accessibility Standards | Accessibility requirements and CI testing | — (platform) | §106 |
| 044 | Frontend Platform Quality (PWA / Performance / SEO) | PWA/offline, loading/error states, performance budgets, SEO | — (frontend) | §103–§105, §108–§109 |
| 045 | Demo Mode & Seed Data | Seed data, demo accounts, demo payments | — (platform) | §110–§113 |
| 046 | Engineering Operations (CI/CD / Observability) | CI/CD pipeline, testing strategy, observability, backup/DR | — (platform) | §114–§117 |

---

## 4. Non-negotiable rules that apply across every spec

Every spec above must respect the rules in master spec §132 / architecture §19 regardless of its
counter — most importantly: the server/database is always authoritative (never the frontend or
the AI), no floating-point money, no duplicate bookings/payments on retries, no claiming success
without confirmed backend/provider confirmation, and no silent price or ranking changes. These
are not re-litigated per spec; each spec's acceptance criteria should encode the subset that
applies to it.

See [docs/specs/README.md](specs/README.md) for the live status of each spec.
