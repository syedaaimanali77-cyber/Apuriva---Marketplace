# APURIVA — System Architecture Document

**Project:** Apuriva — AI-assisted local-services marketplace
**Primary market:** Pakistan (internationally extensible)
**Source of truth:** Apuriva Master Product & Engineering Specification
**Purpose of this document:** Translate the product specification into a concrete technical architecture — system topology, module boundaries, data flow, and infrastructure decisions.

---

## 1. Architectural Style

**Modular monolith**, not microservices.

- One deployable backend application with clearly separated internal modules (bounded contexts).
- Each module owns its own data access and business logic, but they share one runtime, one deployment pipeline, and one database (with logical/schema-level separation).
- Modules communicate in-process (function/service calls), not over the network — avoiding premature distributed-systems complexity.
- Designed so that any module *could* be extracted into its own service later if scale demands it, but the MVP does not pay that cost upfront.

**Why:** the spec explicitly prohibits starting with microservices and over-engineering the MVP, while still requiring a system that is "modular and ready for future mobile apps and international expansion."

---

## 2. High-Level System Diagram (conceptual)

```
                         ┌─────────────────────────────┐
                         │        Client Layer          │
                         │  Next.js Web App (PWA)       │
                         │  (future: iOS / Android)     │
                         └───────────────┬──────────────┘
                                         │ HTTPS / WebSocket
                         ┌───────────────▼──────────────┐
                         │        API Gateway Layer      │
                         │  /api/v1/*  (versioned REST)  │
                         │  Auth middleware, rate limits │
                         └───────────────┬──────────────┘
                                         │
      ┌──────────────────────────────────┼──────────────────────────────────┐
      │                         Backend Modular Monolith                     │
      │                                                                      │
      │  Auth │ Users │ Customers │ Providers │ Categories │ Services        │
      │  Requests │ Offers │ Matching │ Bookings │ Payments │ Payouts        │
      │  Messaging │ Notifications │ Reviews │ Disputes │ Safety │ Support   │
      │  AI │ MCP │ Admin │ Analytics │ Audit │ Files │ Location             │
      │                                                                      │
      └───────┬───────────────┬───────────────┬───────────────┬────────────┘
              │               │               │               │
      ┌───────▼─────┐ ┌───────▼──────┐ ┌──────▼──────┐ ┌──────▼───────┐
      │ Relational   │ │ Object       │ │ Background   │ │ AI Provider   │
      │ Database     │ │ Storage/CDN  │ │ Job Queue    │ │ (abstracted)  │
      │ (+ JSON cols)│ │ (files/media)│ │ (workers)    │ │               │
      └──────────────┘ └──────────────┘ └──────────────┘ └───────────────┘
                                                                   │
                                                          ┌────────▼────────┐
                                                          │  MCP Tool Layer  │
                                                          │ Read + Action    │
                                                          │ tools, per-risk  │
                                                          └──────────────────┘
```

---

## 3. Monorepo Layout

```
apuriva/
├── apps/
│   ├── web/        # Next.js frontend (React, TypeScript, PWA)
│   ├── api/         # Backend modular monolith (REST + WebSocket)
│   └── worker/       # Background job/queue processor
├── packages/
│   ├── ui/           # Shared design system / accessible primitives
│   ├── types/         # Shared TypeScript types/contracts
│   ├── config/         # Shared config, env schema, design tokens
│   ├── validation/      # Shared schema validation (requests, forms)
│   ├── auth/             # Shared auth utilities (JWT/session helpers)
│   ├── ai/                 # AI provider abstraction layer
│   ├── mcp/                  # MCP tool definitions and client
│   ├── database/               # ORM schema, migrations, query layer
│   ├── location/                 # Location/maps provider abstraction
│   └── payments/                   # Payment provider abstraction
└── future:
    └── apps/mobile/                  # Native mobile clients (Phase 2), reuse api/
```

Each `app` is independently deployable; `packages` are shared, versioned internally, and never contain business rules that bypass module boundaries.

---

## 4. Backend Module Boundaries

The backend is organized as internal modules inside `apps/api`. Each module is responsible for its own:
- Data models (within the shared relational DB)
- Business/domain logic
- Internal service interface exposed to other modules
- Its own tests

| Module | Responsibility |
|---|---|
| **Auth** | Phone+OTP, email/password, OAuth (Google/Apple), sessions, MFA |
| **Users** | Core identity record shared across customer/provider/admin profiles |
| **Customer Profiles** | Customer-specific data, saved providers, preferences |
| **Provider Profiles** | Provider-specific data, verification status, portfolio |
| **Categories / Services** | Catalog taxonomy, service fields, packages, FAQs |
| **Requests** | Request lifecycle, service-specific field values, attachments |
| **Offers** | Offer creation, revisions, expiration (2-minute timer), negotiation |
| **Matching** | Eligibility rules + weighted ranking engine |
| **Bookings** | Server-authoritative booking state machine, scheduling |
| **Payments** | Payment provider abstraction, authorization/capture, protection windows |
| **Payouts** | Provider earnings ledger, payout lifecycle, payout methods |
| **Messaging** | Conversations tied to requests/bookings, privacy enforcement |
| **Notifications** | Push/SMS/email dispatch, preference management |
| **Reviews** | Verified review eligibility, moderation signals |
| **Disputes** | Dispute lifecycle, evidence, resolution, appeals |
| **Safety** | Safety incident reports, escalation, restrictions |
| **Support** | Support tickets, admin support workspace |
| **AI** | AI provider abstraction, conversation, memory, cost controls |
| **MCP** | Tool registry, authorization pipeline, idempotency, audit hooks |
| **Admin** | RBAC, configuration, moderation actions |
| **Analytics** | Event ingestion, reporting aggregates |
| **Audit** | Immutable audit log, distinct from application logs |
| **Files** | Upload handling, storage routing, signed URLs |
| **Location** | Maps/geocoding provider abstraction, service-area logic |

**Cross-module rule:** modules call each other through explicit internal interfaces, never by reaching directly into another module's database tables.

---

## 5. Data Layer

### 5.1 Database
- **Relational database** (e.g., PostgreSQL-class) with JSON/JSONB columns for variable, service-specific data (e.g., AC repair details, photographer packages).
- Core entities remain strongly typed and relational; JSON is scoped to genuinely variable attributes, not the whole domain model.
- Full state machines (Request, Offer, Booking, Payment, Payout) are enforced with server-side validated transitions — never inferred purely from client state.

### 5.2 Core Entity Groups (see spec §124 for full list)
- **Identity:** User, CustomerProfile, ProviderProfile, AdminProfile, Role, Permission
- **Catalog:** Category, Subcategory, Service, ServiceField, ServiceRequirement, ServiceFAQ, ServicePackage, ProviderService
- **Availability:** ProviderAvailability, ProviderAvailabilityOverride, ProviderServiceArea
- **Transaction flow:** Request, RequestFieldValue, RequestAttachment, RequestProviderMatch, Offer, OfferRevision, OfferMessage, Booking, BookingStatusHistory, BookingMilestone
- **Money:** Payment, PaymentAttempt, PaymentAuthorization, Refund, RefundLine, Payout, PayoutMethod
- **Communication:** Conversation, ConversationParticipant, Message, MessageAttachment
- **Trust:** Review, ReviewResponse, ReviewReport, Dispute, DisputeEvidence, DisputeMessage, DisputeResolution, DisputeAppeal, SafetyReport
- **Support/Ops:** SupportTicket, SupportMessage, SupportNote, Notification, NotificationPreference
- **AI:** AIConversation, AIMessage, AIMemory, AIAction, AIToolCall
- **Platform:** AuditLog, FeatureFlag, Policy, PolicyVersion, PolicyAcceptance, Session, SecurityEvent, FileAsset, Location, Address, AnalyticsEvent

### 5.3 Money Handling
- Stored as `integer minor_units + currency_code` (e.g., `250000 + PKR`).
- No floating-point arithmetic anywhere in financial calculations.
- Formatting/display happens only at the presentation layer.

### 5.4 Time Handling
- All authoritative timestamps stored in UTC.
- Timezone context preserved per-record (e.g., appointment local timezone).
- Critical deadlines (offer expiry, cancellation windows) are computed and enforced server-side — never trusting device clocks or browser timers.

---

## 6. API Layer

- **Versioned REST API** rooted at `/api/v1/`.
- Domains mirror backend modules: `/auth`, `/users`, `/customers`, `/providers`, `/categories`, `/services`, `/search`, `/requests`, `/offers`, `/bookings`, `/payments`, `/refunds`, `/payouts`, `/messages`, `/reviews`, `/disputes`, `/safety`, `/support`, `/notifications`, `/ai`, `/admin`.
- Documented with **OpenAPI**, including auth requirements, examples, and machine-readable error codes alongside human-readable messages.
- Consistent response conventions for success, validation errors, auth/permission errors, not-found, conflict/state errors, rate limits, pagination, and correlation IDs.
- The same API layer serves the web PWA today and future native mobile apps — no separate mobile-only backend.

### 6.1 Real-Time Layer
- **HTTP** for standard CRUD.
- **WebSockets** for live offers, booking status changes, chat, and timers.
- **Push notifications** for background/mobile alerts.
- The server is always the source of truth; clients reconnect, retry, and refresh authoritative state rather than trusting local state during disconnects.

### 6.2 Rate Limiting
- Per-domain limits (auth, search, messaging, AI, MCP, payment, security), using user- and device/IP-level signals, burst handling, HTTP 429s, and admin-configurable thresholds.

---

## 7. AI & MCP Architecture

### 7.1 AI Provider Abstraction
- One primary AI provider/model for the MVP, accessed only through an internal AI service abstraction (`packages/ai`).
- No business logic depends directly on a specific model/vendor — model swaps happen through configuration.
- Future task-based routing (by cost/latency/quality/complexity) is structurally possible but not built prematurely.

### 7.2 AI Memory vs. Conversation History
- **Conversation history:** verbatim record of what was said.
- **AI memory:** a small, permitted, user-visible/deletable set of durable preferences — never an automatic copy of all conversations.

### 7.3 MCP Tool Layer (`packages/mcp`)
- Small, single-purpose, domain-specific tools — never one catch-all "do everything" tool.
- **Read tools** (e.g., `search_services`, `get_provider_availability`, `get_booking`) — low risk, generally automatic.
- **Action tools** (e.g., `create_booking`, `authorize_payment`, `cancel_booking`) — risk-tiered, may require conversational or structured confirmation.
- Every tool call passes through a fixed authorization pipeline:
  1. Authenticated identity
  2. Current role/mode
  3. Resource ownership
  4. Booking/request context
  5. Tool risk level
  6. Required confirmation
  7. Permission scope
  8. Audit requirement
- **AI is never the security boundary** — the backend independently re-verifies ownership and state for every action tool, regardless of what the AI "decided."
- State-changing tools use **idempotency keys**; retries return the original result rather than duplicating bookings/payments/offers.
- Admin-only MCP tools are registered separately and are never exposed to customer/provider AI contexts.

### 7.4 AI Autonomy Tiers

| Tier | Examples | Behavior |
|---|---|---|
| Low risk | Search, filter, summarize, translate, read | Automatic |
| Medium risk | Send message, modify preferences, draft request | Conversational/contextual confirmation |
| High risk | Booking, payment, cancellation, payout, security changes | Explicit confirmation + secure UI |
| Restricted | Safety enforcement, bans, financial investigations | Human/admin only |

### 7.5 Prompt Injection Defense
- All external content (user messages, provider descriptions, reviews, uploaded files, search/tool results) is treated as untrusted data, never as instructions.
- System/developer instructions are structurally separated from retrieved content.
- MCP tools independently enforce authorization regardless of what the AI requests.

---

## 8. Payments Architecture

- Payment timing is service-aware: scheduled/fixed services authorize/charge at booking; offer-based services charge on offer acceptance; deposit services split payment; final adjustments require explicit customer approval before any additional charge.
- Built on a **payment provider abstraction** (`packages/payments`) using the provider's native authorization/hold/capture/payout primitives — Apuriva does not claim to be an escrow service unless legally and technically justified.
- **Payment protection window:** funds are tracked through authorization → capture states; provider payout is not finalized until the appropriate completion/protection state is reached; disputes can affect payout release.
- Idempotency keys are used on all state-changing payment operations, leveraging the payment provider's own idempotency support where available.
- Demo/sandbox mode uses the payment provider's official sandbox — never simulated success inside application code, and never real money.

---

## 9. Security & Authorization Model

### 9.1 Core Principle
**Server is authoritative — always.** The system never trusts browser timers, frontend-only permission checks, client-reported payment status, AI claims of success, or client-side ownership checks.

### 9.2 RBAC (Admin)
| Role | Scope |
|---|---|
| Super Admin | Full platform control |
| Operations Admin | Requests, bookings, providers |
| Support Admin | Support tickets, user support |
| Finance Admin | Payments, refunds, payouts |
| Trust & Safety Admin | Reports, disputes, safety |
| Content/Marketplace Admin | Services, categories, FAQs |
| Analytics Admin | Reporting/analytics |

Least-privilege by default; sensitive actions require reason + audit record, with second-admin ("four-eyes") approval for high-risk/critical actions (large refunds, payout intervention, permanent bans, permission changes).

### 9.3 Authentication
- Phone+OTP (primary), email+password, Google, Apple.
- MFA: optional for customers, strongly encouraged/required for sensitive provider actions, **mandatory for admins**.
- Step-up (re-)authentication required for sensitive account/security changes.

### 9.4 Audit Logging
- All sensitive/admin actions are recorded with actor, role, action, target, timestamp, before/after values, reason, approval, and correlation ID.
- Audit logs are a **separate system** from ordinary application logs.

### 9.5 Privacy
- No public exposure of personal phone numbers/emails; only approximate location before booking, exact operational address after.
- Data export and account deletion flows follow structured, auditable pipelines that retain legally required financial/audit records even after "deletion."
- MCP tools inherit backend authorization — they never get a separate, looser permission model.

---

## 10. Background Processing

- A dedicated **worker** app (`apps/worker`) consumes a background job queue for:
  - Offer expiration (2-minute timer enforcement)
  - Notifications dispatch
  - Media processing
  - AI summaries
  - Analytics processing
  - Scheduled reminders
  - Cleanup tasks
- Workers use retries with backoff, idempotent execution, dead-letter handling, and monitoring.
- Critical timers (offer expiry, cancellation deadlines) are always re-derived from server/database state, never from an in-memory or client timer.

---

## 11. File & Media Architecture

- **Object storage** for all uploaded files (images, video, documents).
- **Public media** served via CDN with optimized delivery.
- **Private/sensitive media** (verification docs, dispute evidence) stored in a private bucket with signed, time-limited URLs and strict access control.
- No large binary blobs stored directly in the relational database.

---

## 12. Frontend Architecture

- **Next.js + React + TypeScript**, built as a responsive **PWA**.
- Custom accessible design system (`packages/ui`) built on reliable accessible primitives — accessibility (semantic HTML, keyboard nav, screen readers, contrast, RTL/Urdu support) is a first-class requirement, not a later pass.
- Content-driven responsive breakpoints (mobile → wide desktop), not device-specific targeting.
- Offline behavior: cache safe static shell, show offline status, queue only explicitly safe actions, and never claim booking/payment/message success without confirmed server response.
- Same API layer will serve a future native mobile app (`apps/mobile`), so no web-only business logic leaks into the frontend.

---

## 13. Search Infrastructure

- **Smart hybrid** approach:
  - Database filtering for authoritative structured fields (service, location, price).
  - Full-text search for keyword queries.
  - Optional semantic/vector search and embeddings for natural-language queries.
  - AI performs **intent interpretation only** — actual results always come from authoritative backend search infrastructure. The AI is structurally prevented from inventing providers or services.

---

## 14. State Machines

Explicit, server-validated state machines govern the core transactional entities:

- **Request:** Draft → Submitted → Matching → Offers Open → Provider Selected → Booking Created → (Cancelled / Expired / Completed)
- **Offer:** Draft → Sent → Viewed → Revised → (Accepted / Declined / Expired / Withdrawn)
- **Booking:** Pending → Confirmed → Provider En Route → Arrived → In Progress → Completed → Protected → Settled, with alternates (Cancelled / Disputed / Refunded / Failed)
- **Payment:** Created → Requires Action → Authorized/Pending → Captured → Failed → (Refunded / Partially Refunded)
- **Payout:** Pending → Eligible → Processing → Paid → Failed

All transitions are validated server-side; no state machine logic lives only in the frontend.

---

## 15. Observability & Reliability

- Structured logs, error tracking, performance monitoring, MCP execution tracing, background job monitoring, health checks, and critical alerting — all correlated via request/correlation IDs.
- Audit logs remain a distinct system from operational logs.
- Standard AI request trace: `User → AI → MCP tool → authorization → backend → result → AI response`.
- Automated backups with point-in-time recovery, encryption, tested recovery procedures, and protection against accidental production deletion.

---

## 16. Environments & Configuration

- Strict separation of **Development / Staging / Production**.
- Secrets managed via environment variables/secret management — never committed (API keys, payment secrets, DB passwords, MCP credentials, AI credentials).
- `.env.example` documents required config without exposing real values.
- **Feature flags** separate business-configurable flags (available to business admins) from security/technical flags (developer-controlled only); all flag changes are audited.

---

## 17. CI/CD Pipeline

```
PR opened
  → Lint
  → Typecheck
  → Unit tests
  → Integration tests
  → MCP tests
  → Security/permission tests
  → E2E tests
  → (all pass) → auto-deploy to Staging
  → (manual approval) → Production
```

- Database migrations are reviewed and treated as safe-by-default operations with a rollback strategy.
- Failed checks block deployment outright.

---

## 18. Internationalization Architecture

- English is the default UI locale; Urdu is a fully supported RTL locale; Roman Urdu is supported as natural input (chat/search), not a formal translated locale.
- No hard-coded assumptions about currency, country, address format, phone format, tax rules, payment rules, timezone, or service-area logic — all routed through configuration/localization layers (`packages/config`, `packages/location`, `packages/payments`).
- This is what allows Pakistan to be the launch market without constraining future country expansion.

---

## 19. Non-Negotiable Architectural Rules

These carry directly from the product specification and constrain every implementation decision:

1. Server/database is always authoritative — never the frontend, never the AI.
2. No floating-point money arithmetic.
3. No duplicate bookings/payments on retries (idempotency required).
4. No claiming success (payment or MCP action) without confirmed backend/provider confirmation.
5. AI can never invent providers/services or bypass permissions.
6. No permanent bans decided solely by AI/ML predictions.
7. No unnecessary exposure of personal contact info or sensitive data.
8. No indexing of private marketplace data (bookings, payments, messages, admin).
9. No silent price changes or silent ranking-rule overrides.
10. No safety enforcement decided solely by AI.
11. No critical state transitions implemented only in the frontend.
12. No Pakistan-specific assumptions hard-coded into core architecture.
13. No premature microservice decomposition.
14. No fake "working" integrations — use real sandbox/test environments for anything requiring external credentials.

---

## 20. Build Order Alignment

This architecture is intended to be built in the milestone order defined in the master specification (Foundation → Accounts → Marketplace → Requests & Matching → Offers & Booking → Payments → Communication → Completion & Trust → AI → MCP → Admin → Hardening), in small vertical slices, each fully tested before moving to the next.
