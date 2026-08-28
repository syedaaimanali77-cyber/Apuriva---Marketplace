# Apuriva Spec Index

Full build order and dependency rationale: [docs/workflow.md](../workflow.md)
Template all specs below follow: [docs/TEMPLATE-SPEC.md](../TEMPLATE-SPEC.md)

All specs are `Draft` until implemented and reviewed per the template's status lifecycle
(Draft → Approved → Implemented → Superseded).

| # | Spec | Milestone | Status | Scope |
|---|---|---|---|---|
| 001 | [Monorepo & Environment Foundation](2026-08-28-001-monorepo-environment-foundation.md) | 1 — Foundation | Draft | Monorepo layout, env/secrets separation, `.env.example` |
| 002 | [Design System & UI Primitives](2026-08-28-002-design-system-ui-primitives.md) | 1 — Foundation | Draft | Design tokens, branding centralization, accessible primitives |
| 003 | [Database & Core Data Model](2026-08-28-003-database-core-data-model.md) | 1 — Foundation | Draft | Core entity groups, money/time handling, state-machine conventions |
| 004 | [API Foundation & Response Standards](2026-08-28-004-api-foundation-response-standards.md) | 1 — Foundation | Draft | API versioning, response/error conventions, rate limiting |
| 005 | [Authentication](2026-08-28-005-authentication.md) | 2 — Accounts | Draft | Phone+OTP, email/password, Google/Apple, sessions, MFA |
| 006 | [User Identity & Role Switching](2026-08-28-006-user-identity-role-switching.md) | 2 — Accounts | Draft | User/CustomerProfile/ProviderProfile model, mode switch |
| 007 | [Onboarding & Guest Experience](2026-08-28-007-onboarding-guest-experience.md) | 2 — Accounts | Draft | First-run intro, guest browsing, location-permission UX |
| 008 | [Security Sessions & Privacy Center](2026-08-28-008-security-sessions-privacy-center.md) | 2 — Accounts | Draft | Sessions, 2FA, privacy center, deletion, data export |
| 009 | [Admin RBAC & Roles](2026-08-28-009-admin-rbac-roles.md) | 2 — Accounts | Draft | Admin roles, permission scopes, four-eyes approval |
| 010 | [Service Catalog & Taxonomy](2026-08-28-010-service-catalog-taxonomy.md) | 3 — Marketplace | Draft | Category/subcategory/service taxonomy, admin catalog control |
| 011 | [Category & Service Pages + Requirements](2026-08-28-011-category-service-pages-requirements.md) | 3 — Marketplace | Draft | Category/service detail pages, structured fields, FAQs, pricing display |
| 012 | [Location & Address Services](2026-08-28-012-location-address-services.md) | 3 — Marketplace | Draft | Location abstraction, geocoding, service areas, privacy-aware visibility |
| 013 | [Search & Discovery](2026-08-28-013-search-discovery.md) | 3 — Marketplace | Draft | Keyword/NL/voice search, autocomplete, results loading, empty states |
| 014 | [Home, Personalization & Navigation](2026-08-28-014-home-personalization-navigation.md) | 3 — Marketplace | Draft | Home personalization, customer/provider/admin navigation IA |
| 015 | [Request Creation & Lifecycle](2026-08-28-015-request-creation-lifecycle.md) | 4 — Requests & Matching | Draft | Request creation, budget, media, status, cancellation |
| 016 | [Provider Matching, Ranking & Distribution](2026-08-28-016-provider-matching-ranking-distribution.md) | 4 — Requests & Matching | Draft | Eligibility rules, weighted ranking, fair exposure, request distribution |
| 017 | [Offer System & 2-Minute Timer](2026-08-28-017-offer-system-timer.md) | 5 — Offers & Booking | Draft | Offer lifecycle, server-authoritative expiry |
| 018 | [Offer Negotiation & Comparison](2026-08-28-018-offer-negotiation-comparison.md) | 5 — Offers & Booking | Draft | Pre-booking chat, negotiation, offer/provider comparison |
| 019 | [Provider Availability & Service Areas](2026-08-28-019-provider-availability-service-areas.md) | 5 — Offers & Booking | Draft | Weekly schedule, overrides, blocked periods, availability visibility |
| 020 | [Booking Creation & State Machine](2026-08-28-020-booking-creation-state-machine.md) | 5 — Offers & Booking | Draft | Server-authoritative booking, revalidation, race-condition prevention |
| 021 | [Payment Processing & Protection](2026-08-28-021-payment-processing-protection.md) | 6 — Payments | Draft | Payment timing models, authorization/capture, protection window |
| 022 | [Refunds](2026-08-28-022-refunds.md) | 6 — Payments | Draft | Full/partial refunds, policy-driven vs admin override |
| 023 | [Cancellation Policy & No-show](2026-08-28-023-cancellation-policy-no-show.md) | 6 — Payments | Draft | Cancellation fee policy, no-show reporting/resolution |
| 024 | [Provider Payouts & Earnings](2026-08-28-024-provider-payouts-earnings.md) | 6 — Payments | Draft | Payout lifecycle, earnings dashboard, payout methods |
| 025 | [Messaging & Conversations](2026-08-28-025-messaging-conversations.md) | 7 — Communication | Draft | Request/booking-scoped messaging, privacy, retention |
| 026 | [Notifications](2026-08-28-026-notifications.md) | 7 — Communication | Draft | Push/SMS/email, categories, preferences, marketing consent |
| 027 | [File Uploads & Media Storage](2026-08-28-027-file-uploads-media-storage.md) | 7 — Communication | Draft | Upload handling, object storage/CDN, private storage, signed URLs |
| 028 | [Service Execution Lifecycle](2026-08-28-028-service-execution-lifecycle.md) | 8 — Completion & Trust | Draft | Arrival, start, progress milestones, completion evidence |
| 029 | [Reviews & Ratings](2026-08-28-029-reviews-ratings.md) | 8 — Completion & Trust | Draft | Review eligibility, moderation, provider response |
| 030 | [Blocking, Reporting & Safety Incidents](2026-08-28-030-blocking-reporting-safety-incidents.md) | 8 — Completion & Trust | Draft | Block/report, safety report workflow, urgent jobs |
| 031 | [Disputes & Resolution](2026-08-28-031-disputes-resolution.md) | 8 — Completion & Trust | Draft | Dispute lifecycle, evidence, resolution, appeals |
| 032 | [Customer & Provider Support](2026-08-28-032-customer-provider-support.md) | 8 — Completion & Trust | Draft | Support tickets, admin support workspace |
| 033 | [AI Assistant Architecture](2026-08-28-033-ai-assistant-architecture.md) | 9 — AI | Draft | AI provider abstraction, task routing, cost controls |
| 034 | [AI Conversation, Memory & Autonomy](2026-08-28-034-ai-conversation-memory-autonomy.md) | 9 — AI | Draft | Conversation history, memory, activity history, undo, autonomy tiers |
| 035 | [MCP Tool Architecture & Authorization](2026-08-28-035-mcp-tool-architecture-authorization.md) | 10 — MCP | Draft | Tool registry, 8-step authorization pipeline, confirmation, prompt-injection defense |
| 036 | [MCP Tool Catalog, Idempotency & Errors](2026-08-28-036-mcp-tool-catalog-idempotency-errors.md) | 10 — MCP | Draft | Read/action tool catalog, idempotency keys, structured error translation |
| 037 | [Admin Dashboard & Operations](2026-08-28-037-admin-dashboard-operations.md) | 11 — Admin | Draft | Admin overview/operations workspace, marketplace configuration |
| 038 | [Admin Moderation & Fraud/Abuse](2026-08-28-038-admin-moderation-fraud-abuse.md) | 11 — Admin | Draft | Moderation actions, fraud/abuse signals, appeals |
| 039 | [Audit Logging](2026-08-28-039-audit-logging.md) | 11 — Admin | Draft | Audit log schema, coverage, separation from app logs |
| 040 | [Analytics & Reporting](2026-08-28-040-analytics-reporting.md) | 11 — Admin | Draft | Analytics event model, admin reporting surfaces |
| 041 | [Feature Flags & Platform Configuration](2026-08-28-041-feature-flags-platform-configuration.md) | 11 — Admin | Draft | Feature flags, business vs. developer-controlled config |
| 042 | [Internationalization & Localization](2026-08-28-042-internationalization-localization.md) | Cross-cutting | Draft | English/Urdu/Roman Urdu, RTL, no hard-coded locale assumptions |
| 043 | [Accessibility Standards](2026-08-28-043-accessibility-standards.md) | Cross-cutting | Draft | Accessibility requirements and CI testing |
| 044 | [Frontend Platform Quality (PWA / Performance / SEO)](2026-08-28-044-frontend-platform-quality-pwa-performance-seo.md) | Cross-cutting | Draft | PWA/offline, loading/error states, performance budgets, SEO |
| 045 | [Demo Mode & Seed Data](2026-08-28-045-demo-mode-seed-data.md) | Cross-cutting | Draft | Seed data, demo accounts, demo payments |
| 046 | [Engineering Operations (CI/CD / Observability)](2026-08-28-046-engineering-operations-cicd-observability.md) | Cross-cutting | Draft | CI/CD pipeline, testing strategy, observability, backup/DR |
