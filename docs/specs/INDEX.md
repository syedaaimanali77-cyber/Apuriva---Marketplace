# Apuriva Spec Index

Status and dependency/order notes below are taken directly from each spec file's own **Status**
field and body text (acceptance criteria, "Why it matters now," data model, and risk sections).
The dependency/order column is populated only where a spec explicitly states a build-order or
data/entity relationship to another spec — it is not a full cross-reference list; most specs
mention several other specs in passing (audit logging, exports, analytics, etc.) without that
being a build-order dependency.

| # | Spec | Status | Dependency / order notes |
|---|---|---|---|
| 001 | [Application & Environment Foundation](2026-08-28-001-application-environment-foundation.md) | Approved | Prerequisite for every subsequent spec (spec's own "Why it matters now": "a prerequisite for everything else"). |
| 002 | [Design System & UI Primitives](2026-08-28-002-design-system-ui-primitives.md) | Draft | — |
| 003 | [Database & Core Data Model](2026-08-28-003-database-core-data-model.md) | Draft | Stubs entities later fully implemented elsewhere: `FileAsset` (specs 008/027), `AuditLog` (spec 039), `AnalyticsEvent` (spec 040), `FeatureFlag` (spec 041). |
| 004 | [API Foundation & Response Standards](2026-08-28-004-api-foundation-response-standards.md) | Draft | — |
| 005 | [Authentication](2026-08-28-005-authentication.md) | Draft | — |
| 006 | [User Identity & Role Switching](2026-08-28-006-user-identity-role-switching.md) | Draft | — |
| 007 | [Onboarding & Guest Experience](2026-08-28-007-onboarding-guest-experience.md) | Draft | — |
| 008 | [Security Sessions & Privacy Center](2026-08-28-008-security-sessions-privacy-center.md) | Draft | Reuses `FileAsset`; its export-file delivery mechanism depends on spec 027 (File Uploads & Media Storage). |
| 009 | [Admin RBAC & Roles](2026-08-28-009-admin-rbac-roles.md) | Draft | — |
| 010 | [Service Catalog & Taxonomy](2026-08-28-010-service-catalog-taxonomy.md) | Draft | `ServiceField`, `ServiceRequirement`, `ServiceFAQ`, `ServicePackage` are owned by specs 011/012, not duplicated here (spec's own note). |
| 011 | [Category & Service Pages + Requirements](2026-08-28-011-category-service-pages-requirements.md) | Draft | Open question: AI-suggested FAQs depend on spec 034's AI architecture existing first — noted in-spec as a sequencing dependency. |
| 012 | [Location & Address Services](2026-08-28-012-location-address-services.md) | Draft | AC-5 feeds spec 017 (matching eligibility). |
| 013 | [Search & Discovery](2026-08-28-013-search-discovery.md) | Draft | Open question: `/search/interpret`'s NL interpretation depends on spec 033's AI abstraction existing — noted in-spec as a sequencing dependency. |
| 014 | [Home, Personalization & Navigation](2026-08-28-014-home-personalization-navigation.md) | Draft | Reads relationships populated once specs 017/019 (saved providers) and spec 020 (active-booking priority) exist. |
| 015 | [Request Creation & Lifecycle](2026-08-28-015-request-creation-lifecycle.md) | Draft | — |
| 016 | [Provider Availability & Service Areas](2026-08-28-016-provider-availability-service-areas.md) | Draft | AC-3 feeds spec 017 AC-1 (matching eligibility). |
| 017 | [Provider Matching, Ranking & Distribution](2026-08-28-017-provider-matching-ranking-distribution.md) | Draft | Consumes requests from spec 015 and eligibility data from spec 016; feeds offers (spec 018). |
| 018 | [Offer System & 2-Minute Timer](2026-08-28-018-offer-system-timer.md) | Draft | Expiry correctness depends on the background-job mechanism established in spec 046. |
| 019 | [Offer Negotiation & Comparison](2026-08-28-019-offer-negotiation-comparison.md) | Draft | Reuses `OfferMessage`/`OfferRevision` stubbed in spec 018; feeds spec 038's fraud/abuse signals. |
| 020 | [Booking Creation & State Machine](2026-08-28-020-booking-creation-state-machine.md) | Draft | Built on an accepted offer (specs 018/019) and validated availability (spec 016) — spec's own "Why it matters now." |
| 021 | [Payment Processing & Protection](2026-08-28-021-payment-processing-protection.md) | Draft | AC-5 feeds spec 024 (payouts). |
| 022 | [Refunds](2026-08-28-022-refunds.md) | Draft | — |
| 023 | [Cancellation Policy & No-show](2026-08-28-023-cancellation-policy-no-show.md) | Draft | AC-6 feeds spec 017's ranking factor. |
| 024 | [Provider Payouts & Earnings](2026-08-28-024-provider-payouts-earnings.md) | Draft | — |
| 025 | [Messaging & Conversations](2026-08-28-025-messaging-conversations.md) | Draft | AC-6 depends on the blocked-user mechanism defined in spec 030; shared `Chat` component extends spec 019's request-scoped chat. |
| 026 | [Notifications](2026-08-28-026-notifications.md) | Draft | — |
| 027 | [File Uploads & Media Storage](2026-08-28-027-file-uploads-media-storage.md) | Draft | — |
| 028 | [Service Execution Lifecycle](2026-08-28-028-service-execution-lifecycle.md) | Draft | Reuses `BookingMilestone` stubbed in spec 020. |
| 029 | [Reviews & Ratings](2026-08-28-029-reviews-ratings.md) | Draft | Depends on completed bookings existing (spec 028); feeds ranking (spec 017) — spec's own "Why it matters now." |
| 030 | [Blocking, Reporting & Safety Incidents](2026-08-28-030-blocking-reporting-safety-incidents.md) | Draft | — |
| 031 | [Disputes & Resolution](2026-08-28-031-disputes-resolution.md) | Draft | — |
| 032 | [Customer & Provider Support](2026-08-28-032-customer-provider-support.md) | Draft | — |
| 033 | [AI Assistant Architecture](2026-08-28-033-ai-assistant-architecture.md) | Draft | — |
| 034 | [AI Conversation, Memory & Autonomy](2026-08-28-034-ai-conversation-memory-autonomy.md) | Draft | — |
| 035 | [MCP Tool Architecture & Authorization](2026-08-28-035-mcp-tool-architecture-authorization.md) | Draft | — |
| 036 | [MCP Tool Catalog, Idempotency & Errors](2026-08-28-036-mcp-tool-catalog-idempotency-errors.md) | Draft | `AIToolCall` extends the entity stubbed in spec 033. |
| 037 | [Admin Dashboard & Operations](2026-08-28-037-admin-dashboard-operations.md) | Draft | — |
| 038 | [Admin Moderation & Fraud/Abuse](2026-08-28-038-admin-moderation-fraud-abuse.md) | Draft | — |
| 039 | [Audit Logging](2026-08-28-039-audit-logging.md) | Draft | `AuditLog` fully implements the entity stubbed in spec 003. |
| 040 | [Analytics & Reporting](2026-08-28-040-analytics-reporting.md) | Draft | `AnalyticsEvent` fully implements the entity stubbed in spec 003. |
| 041 | [Feature Flags & Platform Configuration](2026-08-28-041-feature-flags-platform-configuration.md) | Draft | `FeatureFlag` fully implements the entity stubbed in spec 003. |
| 042 | [Internationalization & Localization](2026-08-28-042-internationalization-localization.md) | Draft | RTL-aware layout primitives extend spec 002's design system. |
| 043 | [Accessibility Standards](2026-08-28-043-accessibility-standards.md) | Draft | AC-4 extends spec 002's token-level contrast check to actual usage; AC-6 depends on spec 042 (Urdu/RTL locale). |
| 044 | [Frontend Platform Quality (PWA / Performance / SEO)](2026-08-28-044-frontend-platform-quality-pwa-performance-seo.md) | Draft | AC-7 uses spec 002's loading-skeleton primitives. |
| 045 | [Demo Mode & Seed Data](2026-08-28-045-demo-mode-seed-data.md) | Draft | — |
| 046 | [Engineering Operations (CI/CD / Observability)](2026-08-28-046-engineering-operations-cicd-observability.md) | Draft | Makes spec 001's already-stubbed health endpoint fully accurate; its background-job mechanics implement spec 001 §8's Vercel Cron decision. |
