# Spec: Frontend Platform Quality (PWA / Performance / SEO)

**File:** `docs/specs/2026-08-28-044-frontend-platform-quality-pwa-performance-seo.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §103–§105, §108–§109, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §12, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Every screen spec has its own §5 loading/empty/error/success states, but no
platform-wide PWA/offline behavior, performance budget, or SEO strategy has been established.
Master spec §103 requires responsive adaptive layouts and defined offline behavior (cache safe
shell, show offline status, queue only explicitly safe actions, never claim success without
server confirmation). §104–§105 require consistent loading/error UX. §108 requires measurable
performance budgets. §109 requires public pages to be SEO-friendly while never indexing private
data.

**Who is affected:** Every user, especially on slow/unreliable mobile networks (a primary
Pakistan-market consideration per master spec §1); search engines indexing public pages;
marketing/growth relying on organic discovery.

**Why it matters now:** Sequenced as cross-cutting hardening because performance/PWA/SEO
guarantees are only meaningful once the real screens (010–041) exist to measure and optimize.

**Success looks like:** The app installs as a PWA, works predictably offline within defined
limits, meets performance budgets on slow networks, and public pages (categories, services,
provider profiles) are properly indexed while private data (bookings, payments, messages,
admin) is never indexed.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** the app **When** installed as a PWA **Then** it launches with a cached app shell and static assets available offline |
| AC-2 | **Given** the device goes offline **When** the user interacts **Then** the UI clearly shows offline status, allows previously-loaded safe content, and never claims a booking/payment/message succeeded without server confirmation (ties to spec 020/021/025's existing rules, verified here at the platform level) |
| AC-3 | **Given** a safe, explicitly supported offline action (e.g. drafting a request) **When** queued **Then** it retries automatically once connectivity returns, without duplicating on retry (ties to idempotency patterns from specs 015/020) |
| AC-4 | **Given** the app's performance budget **When** measured on a representative slow-network profile **Then** Core Web Vitals and initial-load targets are met |
| AC-5 | **Given** a public page (category, service, provider profile marked public) **When** crawled **Then** it has correct titles, descriptions, structured data, canonical URLs, and Open Graph tags |
| AC-6 | **Given** a private page (bookings, payments, messages, admin, any authenticated-only route) **When** crawled **Then** it is excluded via robots rules / noindex, never appearing in search results |
| AC-7 | **Given** a content-heavy screen **When** loading **Then** it uses skeleton loaders (per spec 002's primitives) consistently, and images/bundles are lazy-loaded/optimized |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/sitemap.xml` | none | `200` | public pages only |
| `GET` | `/robots.txt` | none | `200` | disallows private routes |

No other new domain endpoints — this spec is primarily a frontend/infrastructure concern
layered over existing routes from specs 010–041.

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

None new. SEO metadata (title/description) may be sourced from existing `Category`/`Service`/
`ProviderProfile` fields (specs 010, 011, 006) rather than a new entity.

### Retention and privacy

Offline-cached content follows the same visibility rules as online content — nothing private is
cached in a way that would be accessible without authentication (e.g. a shared/public device's
cache should not leak private data).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | consistent skeleton pattern platform-wide (spec 002's primitive, applied everywhere, audited here) |
| **Offline** | a distinct, clearly-labeled offline banner/state, differentiated from a generic error |
| **Error** | consistent with master spec §105's plain-language/actionable/honest/context-specific pattern across the whole app, not just individually per spec |
| **Success** | no false-positive success states offline (AC-2's core guarantee, audited across all prior specs' write actions) |

**Route(s):** applies globally; SEO specifically governs `apps/web/app/explore/*`,
`apps/web/app/providers/[id]` (where public)
**Shared components used/added:** `packages/ui` `OfflineBanner` (new), service worker
configuration in `apps/web`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | offline-queue safe-action allowlist, SEO metadata generation | `apps/web/**/*.test.ts` |
| **Integration** | robots/sitemap correctness (public pages included, private excluded) | `apps/web/seo.integration.test.ts` |
| **Performance** | Core Web Vitals budget check on representative pages under throttled network | CI Lighthouse/WebPageTest run |
| **E2E** | offline mode: app shell loads, offline banner shows, queued safe action completes on reconnect without duplication | `apps/web-e2e/pwa-offline.spec.ts` |
| **PWA** | install prompt/manifest correctness | `apps/web-e2e/pwa-install.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/web-e2e/pwa-install.spec.ts` |
| AC-2 | `apps/web-e2e/pwa-offline.spec.ts::never claims success without server confirmation` |
| AC-3 | `apps/web-e2e/pwa-offline.spec.ts::queued action retries without duplication` |
| AC-4 | CI performance budget job (fails build on regression beyond threshold) |
| AC-6 | `apps/web/seo.integration.test.ts::private routes excluded from sitemap/robots` |

**Coverage:** ≥80% on new code; performance budgets are enforced as hard CI thresholds, not just
tested.

**Not covered, deliberately:** Native app store optimization (native mobile apps are Phase 2,
master spec §122).

---

## 7. Out of scope

- Native Android/iOS app store presence (Phase 2).
- Advanced offline-first architecture (e.g. full local-first sync) — MVP offline support is
  read-mostly/safe-action-queue only, per master spec §103's explicit scope.

---

## 8. Risks and open questions

| # | risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact performance budget thresholds (LCP/FID/CLS targets, initial bundle size cap) | — | Open — must be defined before AC-4 is enforceable |
| 2 | Which provider-profile fields are public vs. require authentication to view in full (affects SEO indexability boundary) | Product | Open |

---

## 9. Rollout

- **Feature flag:** none — foundational quality bar, not optional.
- **Migration order:** N/A.
- **Rollback:** revert deploy; service worker versioning must handle cache invalidation safely
  on rollback (old cached shell must not serve stale, broken assets against a rolled-back API).
- **Observability:** real-user Core Web Vitals monitoring, offline-usage rate, and SEO
  crawl-error rate tracked (master spec §108, §117).
