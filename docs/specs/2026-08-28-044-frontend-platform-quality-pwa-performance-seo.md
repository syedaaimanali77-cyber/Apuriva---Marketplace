# Spec: Frontend Platform Quality (PWA / Performance / SEO)

**File:** `docs/specs/2026-08-28-044-frontend-platform-quality-pwa-performance-seo.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §103–§105, §108–§109, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §12, [docs/workflow.md](../workflow.md); specs 002 (primitives, tokens, branding), 004 (API envelope), 010/011 (public catalog pages), 015/020 (idempotency), 042 (locale resolution, dynamic rendering), 046 (CI, browser runner). See §8.

---

## 1. Problem statement

**Today (verified against the repository):**

- **Present:**
  - Consistent `NETWORK_ERROR` handling when `fetch` rejects, in `app/requests/api-client.ts`,
    `app/_components/ask-apuriva-client.ts`, `app/account/_components/useAccountUser.ts` and
    `app/account/notifications/page.tsx`, with en/ur text (`lib/i18n/dictionaries/*`);
  - `Skeleton` and `app/loading.tsx`;
  - the shared `Idempotency-Key` mechanism (`lib/api/idempotency.ts`);
  - static root `metadata` (title and description from `lib/config/branding.ts`) in `app/layout.tsx`.
- **Missing:**
  - a web app manifest, service worker, app icons, `robots.txt`, `sitemap.xml`, per-page metadata,
    canonical URLs, Open Graph and structured data;
  - an offline indicator;
  - any performance budget or measurement.
- **Constraints the draft did not account for:**
  - Every public page (`app/page.tsx`, `app/explore/**`, `app/search/page.tsx`) is a `'use client'`
    component, so none can export `metadata`/`generateMetadata`.
  - Public URLs are keyed by **UUID**, not slug: `/explore/{categoryId}/{serviceId}`.
  - Spec 042 D-3 makes every route dynamic, because the root layout reads cookies and headers for
    `lang`/`dir`.
  - There is **no public provider-profile route or API**. `app/providers/[id]` does not exist; only
    sub-resources such as `/api/v1/providers/{id}/reviews` do.
  - The draft's AC-3 example, "drafting a request", does not exist as an action. A request's `draft`
    status lives only inside the creation transaction and is never customer-visible (spec 015 §4,
    `lib/types/requests.ts`).
  - The only brand artwork is the full wordmark `ui/assets/apuriva-logo-full.jpeg`. There is no square
    app icon.

Master §103 requires offline behaviour that caches the safe shell, shows offline status, queues only
explicitly supported safe actions, and never claims success without server confirmation. §104–§105
require consistent loading and error UX, §108 measurable performance budgets, and §109 SEO for public
pages while never indexing private data.

**Who is affected:** Every user, especially on slow/unreliable mobile networks (a primary
Pakistan-market consideration per master spec §1); search engines indexing public pages;
marketing/growth relying on organic discovery.

**Why it matters now:** Sequenced as cross-cutting hardening because performance/PWA/SEO
guarantees are only meaningful once the real screens (010–041) exist to measure and optimize.

**Success looks like:**

- The app is installable.
- Offline, it is honest: it shows its status, does not send or queue writes, and serves an offline
  page instead of a browser error.
- The public catalog pages meet measured budgets on a slow-network profile and are fully described
  to crawlers.
- Every other route is `noindex`.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a supporting browser **When** the site is loaded **Then** it is installable: `app/manifest.ts` is served with name, short name, start URL `/`, `display: standalone`, theme/background colours and 192/512px (plus maskable) icons, and `public/sw.js` is registered. **When** the installed app is launched offline **Then** the cached offline page renders with its static assets, instead of a browser error |
| AC-2 | **Given** the device is offline (`navigator.onLine === false`, or a request rejected as `NETWORK_ERROR`) **When** the user interacts **Then** the `OfflineBanner` is shown (distinct from a generic error); content already rendered in the open tab stays visible; a navigation shows the offline page; and no booking, payment, message or request is ever shown as succeeded without a `2xx` server response |
| AC-3 | **Given** MVP scope **When** the device is offline **Then** no write is queued or replayed: the four critical write controls (§3.5) are disabled with the offline notice, and any other write fails with the existing `NETWORK_ERROR` message. **When** connectivity returns **Then** the banner clears and the route's server-rendered data is refreshed automatically (`router.refresh()`), while client-fetched views offer their existing retry. |
| AC-4 | **Given** the budget routes (§3.7) under the defined slow-network lab profile, median of 3 runs **When** measured **Then** each route meets the Core Web Vitals "Good" thresholds, **LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1**, and the JavaScript budget, **≤ 200 KB (204,800 bytes) of compressed JavaScript transferred during initial load**. A breach of any of the four fails the CI job. |
| AC-5 | **Given** an indexable page (§3.8: `/`, `/explore`, `/explore/{categoryId}`, `/explore/{categoryId}/{serviceId}` for published entities) **When** crawled **Then** its HTML contains a specific title and description, a canonical URL built from `SITE_URL`, Open Graph and Twitter tags, and JSON-LD (`BreadcrumbList`; plus `Service` on service pages) |
| AC-6 | **Given** any route outside the §3.8 indexable set **When** crawled **Then** its HTML carries `<meta name="robots" content="noindex, nofollow">` (`noindex, follow` for `/search`), and `sitemap.xml` lists exactly the indexable set and nothing else |
| AC-7 | **Given** a content-heavy screen **When** loading **Then** it uses the `Skeleton` primitive (spec 002), and images use `next/image` with explicit dimensions, audited per §3.10 |

---

## 3. Architecture and API contract

**No `/api/v1` endpoint is added and no OpenAPI entry changes.** `sitemap.xml`, `robots.txt` and
`manifest.webmanifest` are **Next.js metadata routes** produced by file conventions (`app/sitemap.ts`,
`app/robots.ts`, `app/manifest.ts`, per `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/`).
They are not API routes, carry no spec 004 envelope, and are outside the OpenAPI drift check.

### 3.1 Repository reality and new files

| What | Path |
|---|---|
| Manifest, robots, sitemap | `app/manifest.ts`, `app/robots.ts`, `app/sitemap.ts` |
| Service worker (hand-written, static) | `public/sw.js` and its caching rules `public/sw-rules.js` |
| Offline page (the only document the service worker caches) | `app/offline/page.tsx` (server component) |
| App icons (design-supplied, §8 DEP-2) | `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/icon-maskable-512.png` |
| Registration and network status | `app/_components/ServiceWorkerRegistrar.tsx`, `app/_components/useNetworkStatus.ts`, `app/_components/OfflineBanner.tsx` |
| SEO helpers | `lib/seo/site-url.ts` (`SITE_URL`), `lib/seo/route-policy.ts` (index/noindex classification), `lib/seo/public-routes.ts` (published catalog reads for the sitemap), `lib/seo/json-ld.ts` |
| Per-segment metadata (server layouts; the client pages are untouched) | `app/explore/layout.tsx`, `app/explore/[category]/layout.tsx`, `app/explore/[category]/[service]/layout.tsx`, plus a `noindex` `layout.tsx` for each private segment (§3.8) |
| Lighthouse CI config | `lighthouserc.json` |

- **New dependency:** `@lhci/cli` (devDependency) for AC-4. Nothing else. The service worker is
  hand-written; there is no PWA library.
- **Browser tests:** they use spec 046's Playwright architecture (`browser/**/*.browser.ts`, excluded
  from Vitest). Nothing browser-based goes in `e2e/`, which is Vitest's route-level suite.

### 3.2 Service worker: `public/sw.js` (decision D-1)

- **Scope `/`.** It is registered by `ServiceWorkerRegistrar` only in production builds
  (`process.env.NODE_ENV === 'production'`). It never runs in `next dev`.
- **Caches, and nothing else:**
  - `apuriva-static-v<CACHE_VERSION>`: cache-first for `GET /_next/static/**`. These files are
    content-hashed and immutable (scripts, CSS, fonts).
  - `apuriva-images-v<CACHE_VERSION>`: stale-while-revalidate for `GET /images/**` (the public
    marketing images).
  - `apuriva-offline-v<CACHE_VERSION>`: `/offline`, fetched **at install with
    `credentials: 'omit'`**, so it is rendered as an anonymous guest and can hold no session-specific
    content, plus the `/icons/*` files. The `/_next/static/**` files that page's HTML references are
    added to the static cache at the same time, so a first offline launch renders it with its assets
    (AC-1); a missing icon (DEP-2) never fails installation.
- **Never cached:**
  - navigation or HTML responses other than that one guest-rendered `/offline`;
  - anything under `/api/`;
  - `sitemap.xml`, `robots.txt`, the manifest;
  - any response to a request that carried credentials, other than the path-scoped static and image
    rules above.
- **Non-`GET` requests are never intercepted.** The worker does not call `respondWith` for them, so
  writes go straight to the network with their normal cookies, CSRF header and `Idempotency-Key`.
- **Navigations** are network-only. If the network fails, the worker responds with the cached
  `/offline` page.
- **Versioning:** `CACHE_VERSION` is an integer constant in `sw.js`, bumped whenever caching logic
  changes. On `activate`, every `apuriva-*` cache whose name is not current is deleted. Because
  static assets are content-hashed and HTML is never cached, a new deploy never serves an old page
  against new assets, or the reverse.
- **Updates:** `ServiceWorkerRegistrar` registers with `updateViaCache: 'none'`, so the browser
  re-fetches `sw.js` **and** its imported `sw-rules.js` bypassing the HTTP cache. Every deploy's worker
  is therefore picked up without a `next.config.ts` header change.
- **Rollback:** reverting a deploy serves the previous `sw.js`. It is byte-different, so it installs,
  and its `activate` deletes the other versions' caches. Since HTML is never cached, a rolled-back API
  is never paired with a cached newer page.
- **Emergency kill:** replace `public/sw.js` with a worker that deletes every `apuriva-*` cache and
  calls `self.registration.unregister()`. This procedure is documented in the file header.
- **Private data:** nothing authenticated is ever stored. Logging out or sharing a device leaves
  nothing private in Cache Storage (§4).

### 3.3 Offline detection and banner (AC-2)

- `useNetworkStatus()` returns `online: boolean` from `navigator.onLine` and the `online`/`offline`
  events.
- `OfflineBanner` renders the design system's `Alert` (`tone="warning"`, `role="status"`) with the
  existing `errors.NETWORK_ERROR` dictionary text, via spec 042's `useLocale().t`. It is placed once,
  in `app/layout.tsx` (X-1). It is not a `ui/` primitive and adds no token.
- `navigator.onLine` can report `true` without internet access. The existing `NETWORK_ERROR` path
  (rejected `fetch`) remains the authoritative per-request signal, and the banner does not replace it.

### 3.4 No queued writes in MVP (AC-3, decision D-2)

- The **supported offline write set is empty.** No IndexedDB queue, no Background Sync and no replay.
  Master §103 "queue only explicitly supported safe actions" is met with an empty supported set.
- Consequently there is no replay, so no CSRF-token refresh, no stale-session replay and no duplicate
  risk. The existing per-attempt `Idempotency-Key` behaviour (specs 015/020/021) is unchanged.
- A future queued action requires a spec that names it and defines its replay: the same
  `Idempotency-Key`, a fresh CSRF token, and a session check before replay.
- **Reconnect:** on the `online` event, `OfflineBanner` calls `router.refresh()` once, which re-runs
  the server components of the current route. Client-fetched views keep their existing
  `ErrorState`/retry behaviour; they are not rewritten.

### 3.5 Critical write controls disabled while offline (AC-3)

`useNetworkStatus()` disables the submit control, with the offline notice as its description, on
exactly these four master-§103 writes:

| Write | File |
|---|---|
| Request submission | `app/requests/new/[serviceId]/page.tsx` |
| Offer acceptance / booking confirmation | `app/bookings/_components/ConfirmBookingPanel.tsx` |
| Payment | `app/bookings/[id]/payment/page.tsx` |
| Message send | `app/_components/RequestMessageThread.tsx`, `app/bookings/_components/BookingConversation.tsx` |

Every other write keeps its current behaviour: a rejected `fetch` gives `NETWORK_ERROR`, and nothing
is shown as succeeded. The AC-2 audit (§6) verifies that no write surface in the §3.10 audit list
renders success on a non-`2xx` result.

### 3.6 Manifest and icons (AC-1)

- `app/manifest.ts`:
  - `name` and `short_name` come from `branding.appName` (`lib/config/branding.ts`), `description`
    from `branding.tagline`;
  - `start_url: '/'`, `display: 'standalone'`;
  - `theme_color` and `background_color` are read from the design-system token values in
    `ui/_ds_manifest.json` (`--teal-600`, `--surface-page`) at build time, never hand-written hex;
  - `icons` are the three `public/icons/*` files.
- **The icons are design-supplied artwork (DEP-2).** 044 does not generate or crop a logo.

### 3.7 Performance budgets (AC-4, decision D-3)

- **Tools:** Lighthouse CI (`@lhci/cli`) for LCP, CLS and JS, plus a Playwright test for INP. Both run
  in a spec 046 CI job, against
  `next build && next start` on the browser test database.
- **Settings:** `lighthouserc.json` uses the default mobile emulation and `throttlingMethod: simulate`
  (Lighthouse's Slow 4G profile, 150 ms RTT and about 1.6 Mbps, with 4× CPU slowdown).
  `numberOfRuns: 3`; assertions use the median run.
- **Budget routes**, with concrete IDs resolved from the browser database (the categories and
  services seeded by migration 0006):
  - `/`
  - `/explore`
  - `/explore/{categoryId}`
  - `/explore/{categoryId}/{serviceId}`
  - `/search?q=cleaning`
  - `/login`

| Metric | Threshold (CWV "Good" / JS cap) | Measured by | Level |
|---|---|---|---|
| **LCP** (Largest Contentful Paint) | **≤ 2.5 s** (2500 ms) | Lighthouse `largest-contentful-paint` | error |
| **INP** (Interaction to Next Paint) | **≤ 200 ms** | `browser/perf/inp.browser.ts` (see below) | error |
| **CLS** (Cumulative Layout Shift) | **≤ 0.1** | Lighthouse `cumulative-layout-shift` | error |
| **JavaScript transferred** | **≤ 200 KB = 204,800 bytes**: the sum of compressed (on-the-wire) bytes of every script requested during the initial page load, per route, first-party and third-party | Lighthouse `resource-summary:script:size` | error |

- **How INP is measured.** INP needs real interactions, which a Lighthouse navigation run does not
  perform. `browser/perf/inp.browser.ts` runs on spec 046's Playwright runner, in Chromium:
  - applies 4× CPU throttling (CDP `Emulation.setCPUThrottlingRate`) and Slow 4G network emulation;
  - performs a fixed scripted interaction set per route: `/`, click a category tile; `/explore`,
    click a category; `/explore/{categoryId}`, click a service; `/explore/{categoryId}/{serviceId}`,
    press the primary call to action; `/search?q=cleaning`, type five characters into the search
    input; `/login`, type into the email input and press Tab;
  - records the browser's native Event Timing entries (`PerformanceObserver` type `event`,
    `durationThreshold: 16`).
  - With fewer than 50 interactions, INP is the longest interaction's duration. The median of 3
    runs must be ≤ 200 ms.
  - No new dependency.
- TBT is still reported by Lighthouse as a diagnostic, but it is **not** a gate; INP is.

- **CI behaviour:** any `error` assertion (Lighthouse) or an INP median above 200 ms (Playwright) fails
  the `perf` job, which is a required check.
- **No baseline or exception mechanism:** a route that cannot meet a budget is a defect in the route.
  The first run during implementation shows whether the current pages meet it; any breach found then
  is fixed or brought back to this spec for a decision, never silently loosened.
- **Spec 042 D-3:** every route is dynamic, so the budgets measure server-rendered dynamic
  responses. That is the product's real behaviour, and nothing here relaxes it.
- **First measurement (implementation, 2026-09-29; Linux, Node 22, production build) — AC-4 is open.**
  The gate is committed exactly as specified and currently FAILS; per the decision taken with the product
  owner, the breaches are follow-up work for the owning specs, not a loosened budget.
  - **JavaScript (host-independent), every route over:** 222,141–226,563 bytes against 204,800. The same
    routes on the tree without spec 044 transfer 222,075–227,509 bytes — the overage predates 044, whose
    additions net about −1 KB. The initial JS is React DOM (~73 KB), the Next runtime (~44 KB), the full
    English dictionary sent to every page (~23 KB, spec 042's client fallback) and the shared app chrome.
  - **CLS:** 0–0.028 on five routes; `/search?q=cleaning` is **0.144** — the results/empty-state block
    shifts as it renders (spec 013's page).
  - **LCP and INP breach on every route** (LCP 7.0–12.3 s; INP medians 320 ms–2.2 s, `/search` typing the
    worst), but the measuring host was flagged by Lighthouse as slower than it assumes (`benchmarkIndex`
    64–272), which inflates both under the 4× CPU throttle. Their authoritative values come from the CI
    `perf` job on a GitHub-hosted runner.

### 3.8 Index policy (AC-5, AC-6, decision D-4)

`lib/seo/route-policy.ts` classifies **every** top-level `app/` segment that contains a `page.tsx`:

| Class | Routes | Robots meta | In sitemap |
|---|---|---|---|
| index | `/`, `/explore`, `/explore/{categoryId}`, `/explore/{categoryId}/{serviceId}` (published only) | default (indexable) | yes |
| noindex-follow | `/search` | `noindex, follow` | no |
| noindex | `/account/**`, `/admin/**`, `/provider/**`, `/bookings/**`, `/requests/**`, `/support/**`, `/login`, `/register`, `/offline` | `noindex, nofollow` | no |

- **Mechanism:** each private segment gets a server `layout.tsx` that only exports
  `metadata = { robots: { index: false, follow: false } }` and returns its children. There are new
  layouts for `app/account`, `app/admin`, `app/provider`, `app/bookings`, `app/requests`,
  `app/support`, `app/search` and `app/(auth)`; `app/offline/page.tsx` sets it itself. Their pages are
  not modified.
- **Deny-by-construction:** `lib/seo/route-policy.test.ts` fails if any top-level `app/` segment with a
  `page.tsx` is unclassified, or if a `noindex` segment lacks its layout. A new route cannot silently
  become indexable.
- **`robots.txt`** (`app/robots.ts`): `Allow: /`, `Disallow: /api/`, and `Sitemap: <SITE_URL>/sitemap.xml`.
  Private pages are **not** disallowed there, because a crawler that cannot fetch a page cannot see its
  `noindex`. They are also auth-gated and render no private data to an anonymous crawler.
- **Provider profiles are removed from scope.** No public provider-profile route or API exists, and no
  spec owns one (§7). Master §109 "public provider profiles where appropriate" is deferred to whichever
  spec builds that page.

### 3.9 Metadata, canonical URLs and locale (AC-5; decision D-5)

- **`SITE_URL`:** a new server-only env var, the absolute origin (for example
  `https://apuriva.example`). It is documented in `.env.example` (X-3) and validated by
  `lib/seo/site-url.ts`: it must be an absolute `https:` URL in production (or `http:` locally),
  otherwise it is a configuration error. The root layout sets `metadataBase` from it (X-1).
- **Per-segment `generateMetadata`** (the server layouts in §3.1):
  - reads spec 010's published-only `getCategoryPublic(id)` / `getServicePublic(id)` (reused, not
    modified) — the reads `getCategoryPage`/`getServicePage` are built on. The service record is needed
    for its `categoryId` (the canonical below), which `ServicePageDto` does not carry;
  - an unpublished or unknown entity (or a service whose category is not published, or a malformed id)
    gives `noindex` and no canonical, while the client page keeps rendering its own not-found state;
  - the reads are de-duplicated within the request with React `cache()` (the layout and its
    `generateMetadata` both ask).
- **Title and description:**
  - catalog pages use the entity's authored name, with `branding.appName` as the title suffix (spec 042
    D-1 does not translate catalog content). **The catalog has no authored description** (neither
    `categories` nor `services` has a description column), so the description is a name-based template,
    `seo.categoryDescription` / `seo.serviceDescription` ("Find {name} services and request offers from
    providers on APURIVA." / "Request {name} on APURIVA and compare offers from providers."), which the
    `Service` JSON-LD `description` also uses. Resolved with the product owner during implementation;
    authored descriptions would need a spec 010 schema change;
  - `/explore` uses `translate(locale, key)` with the locale from spec 042's `getRequestLocale()`. The new
    `seo.*` keys are added to `lib/i18n/dictionaries/en.ts` only (X-2); `ur` falls back to English per
    spec 042 AC-6;
  - `/` keeps the root layout's static `metadata`: title `branding.appName` and description
    `branding.tagline`, which spec 002's `lib/config/branding.test.ts` pins exactly (AC-1 there). Next
    does not allow `metadata` and `generateMetadata` in the same layout, so `/` has no separately
    translated title; its canonical and Open Graph URL are `/`, resolved against `metadataBase`
    (= `SITE_URL`, read lazily so importing the layout never needs it).
- **Inheritance:** metadata is inherited, so every `noindex` layout (and `/offline`) sets
  `lib/seo/route-policy.ts`'s `noindexMetadata()`: `robots`, **no canonical and no Open Graph/Twitter
  URL** (`null` resets the inherited `/` values), and the plain `branding.appName` title those screens have
  always had.
- **Canonical URLs:**
  - built only from `SITE_URL` plus the path; never from the request host;
  - a service's canonical is `/explore/{service.categoryId}/{service.id}`, taken from the service
    record, so the same service reached under a wrong category segment consolidates onto one URL;
  - no query string on any canonical.
- **Locale:** spec 042 serves `en` and `ur` from the **same URL**, with no `/ur/…` prefix (042 §7).
  Therefore:
  - one canonical per page;
  - **no `hreflang` alternates**, because no alternate URLs exist;
  - `<html lang>`/`dir` stay exactly as spec 042 renders them, and 044 does not touch them;
  - crawlers send no cookie, so they receive `en` (and `urdu-locale` is off everywhere);
  - locale-prefixed SEO is out of scope until a spec introduces locale URLs.
- **Open Graph and Twitter tags:**
  - `og:title`, `og:description`, `og:url` (the canonical), `og:type: website`, `og:site_name`
    (`branding.appName`), `twitter:card: summary_large_image`;
  - `og:image` is `imageForCategoryName(category.name)` from `app/category-images.ts` for category and
    service pages (absolute via `SITE_URL`), and is omitted elsewhere;
  - no generated OG images.
- **JSON-LD** (`lib/seo/json-ld.ts`, rendered as `<script type="application/ld+json">` from the server
  layouts):
  - `BreadcrumbList` on category and service pages (Explore → category → service);
  - `Service` on service pages (`name`, `description`, `serviceType` = category name,
    `provider` = `Organization` `branding.appName`).
  - No `AggregateRating` or `Offer`: there is no public per-service rating, and prices vary by
    provider.
- **Sitemap** (`app/sitemap.ts`):
  - `/`, `/explore`, every published category, and every published service whose category is
    published;
  - `lib/seo/public-routes.ts` makes one read-only query over spec 010's `categories`/`services` with
    `status = 'published'`, and writes nothing;
  - `lastModified` is each row's `updated_at`;
  - dynamic, like every route (spec 042 D-3).

### 3.10 Loading and image audit (AC-7)

- The audit covers every `page.tsx` under `app/` except `app/admin/**`. Admin screens are
  information-dense internal tools; they keep `Skeleton` where they already use it, but are not
  audited here.
- For each list- or content-heavy page, the audit checks two things:
  - its loading state uses `Skeleton` (not a bare spinner or blank);
  - its images use `next/image` with `width`/`height` or `fill` plus `sizes` (CLS).
- **Findings are fixed in the owning route's file** under X-4, which lists the files the audit finds;
  the list is recorded in the implementing PR.
- **Audit result (implementation):** every content-loading page outside `app/admin/**` already renders
  `Skeleton` while loading (the auth and support pages load no content — their only pending state is
  the submit button's), and every `next/image` use (`app/page.tsx`, `app/explore/page.tsx`,
  `app/explore/[category]/page.tsx`, `app/components/AppHeader.tsx`) is `fill` plus `sizes` inside a
  sized container. No X-4 change was needed. One finding is outside X-4's owners and is reported, not
  fixed: `app/_components/MediaPreview.tsx` (spec 027) renders uploaded images with a plain `<img>`
  (a short-lived signed URL next/image cannot optimize) at `height: auto` with no reserved space, so it
  can shift layout while loading; `FileAssetDto` carries no dimensions to reserve it from.

---

## 4. Data model changes

None new. No migration. SEO content is read from the existing `categories`/`services` rows (specs
010/011) through existing and read-only functions.

### Retention and privacy

- Offline-cached content follows the same visibility rules as online content. By construction the
  service worker stores only content-hashed static assets, public marketing images, the icons and a
  guest-rendered `/offline` page (§3.2), so a shared or public device's cache cannot leak private data.
- Nothing is written to IndexedDB or `localStorage` by this spec.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | consistent `Skeleton` pattern on content-heavy screens (spec 002's primitive), audited per §3.10 |
| **Offline** | `OfflineBanner` (`Alert`, `role="status"`, the `errors.NETWORK_ERROR` text) — distinct from a generic error; the four critical write controls are disabled with the same notice; a navigation shows `/offline` |
| **Error** | consistent with master §105's plain-language/actionable/honest/context-specific pattern, through the existing `ErrorState` and spec 042's `translateApiError` — unchanged by this spec |
| **Success** | no false-positive success states offline (AC-2's core guarantee): success renders only after a `2xx` server response |

- **Route(s):** applies globally. SEO governs `app/page.tsx` (via the root layout), `app/explore/**`
  (via its new server layouts) and `app/sitemap.ts`/`app/robots.ts`. There is no provider-profile
  route.
- **Offline page:** `app/offline/page.tsx` is a server component, rendered with the design system
  (`EmptyState` with the offline copy) and the shared chrome. No new primitive and no new token.
- **Shared components used/added:**
  - used: `Alert`, `EmptyState`, `Skeleton` from `@/components`;
  - added: `app/_components/OfflineBanner.tsx`, `ServiceWorkerRegistrar.tsx`, `useNetworkStatus.ts`.
    These are app-level components, not design-system primitives.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | the route policy is complete: every top-level segment classified, each `noindex` segment has its layout | `lib/seo/route-policy.test.ts` |
| **Unit** | `SITE_URL` validation; canonical building (the service's own `categoryId`, no query); JSON-LD shapes | `lib/seo/site-url.test.ts`, `lib/seo/json-ld.test.ts` |
| **Integration** | the sitemap lists exactly the published categories and services (a draft or retired one is excluded; a service under an unpublished category is excluded); `robots.txt` content; `generateMetadata` for published, unpublished and unknown entities | `lib/seo/seo.integration.test.ts` (`*_test` database) |
| **Component** | `OfflineBanner` shows and hides on the offline and online events and calls `router.refresh()` once on reconnect; the four critical controls are disabled offline | `app/_components/OfflineBanner.test.tsx`, plus one test per §3.5 file named `*.offline.test.tsx` (new files; the existing tests are not edited) |
| **Unit** | the worker's caching rules as pure functions: which requests are cached (static, images, offline) and which never are (navigations, `/api/*`, non-`GET`) | `lib/pwa/sw-rules.test.ts`. The rules live in the classic script `public/sw-rules.js` (it assigns `self.apurivaSwRules`), which `sw.js` loads with `importScripts('/sw-rules.js')` and which the test evaluates with `node:vm` in a sandbox `self`. The test exercises the exact shipped file. |
| **Browser (PWA)** | the manifest is served and valid; the worker registers; an offline navigation serves `/offline`; `Cache Storage` holds no `/api/` or HTML entry other than `/offline` after browsing signed in | `browser/pwa/install.browser.ts`, `browser/pwa/offline.browser.ts` (spec 046 runner) |
| **Browser (offline honesty)** | with the network offline, the payment, booking-confirm, request-submit and message-send controls are disabled; forcing a write through any §3.10 write surface shows an error, never success; reconnecting refreshes | `browser/pwa/offline.browser.ts` |
| **Performance** | the §3.7 budgets: LCP, CLS and JS via Lighthouse CI; INP via Event Timing | CI `perf` job (`lighthouserc.json`, `browser/perf/inp.browser.ts`) |
| **Audit** | the §3.10 Skeleton and `next/image` audit | checklist in the implementing PR |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `browser/pwa/install.browser.ts`; `browser/pwa/offline.browser.ts::installed app offline shows /offline` |
| AC-2 | `browser/pwa/offline.browser.ts::never claims success without server confirmation`; `OfflineBanner.test.tsx` |
| AC-3 | `browser/pwa/offline.browser.ts::no write is queued or replayed`; the `*.offline.test.tsx` component tests; `lib/pwa/sw-rules.test.ts::non-GET never intercepted` |
| AC-4 | CI `perf` job: `lighthouserc.json` (LCP ≤ 2.5 s, CLS ≤ 0.1, JS ≤ 204,800 bytes) and `browser/perf/inp.browser.ts` (INP ≤ 200 ms); fails on any breach |
| AC-5 | `lib/seo/seo.integration.test.ts::metadata, canonical, OG, JSON-LD`; `lib/seo/json-ld.test.ts` |
| AC-6 | `lib/seo/route-policy.test.ts`; `lib/seo/seo.integration.test.ts::sitemap contains only indexable routes` |
| AC-7 | the §3.10 audit checklist in the implementing PR |

**Coverage:** ≥80% statements on `lib/seo/**` and on `public/sw-rules.js`. The performance
budgets are hard CI thresholds.

**Other specs' tests must stay green and unedited:** the existing tests of the pages touched under
X-4/X-5, `app/layout.test.tsx` and `app/layout.locale.test.tsx`.

**Not covered, deliberately:**

- Native app store optimization (native mobile apps are Phase 2, master §122).
- Real-user Core Web Vitals monitoring. Spec 046 selects platform logs with no monitoring vendor, so
  §9's field monitoring is deferred; lab budgets are the MVP gate.

---

## 7. Out of scope

- Native Android/iOS app store presence (Phase 2).
- Advanced offline-first architecture (e.g. full local-first sync).
- **Any queued or replayed offline write** (D-2). Adding one needs a spec naming the action and its
  replay rules.
- **Public provider-profile pages and their SEO.** No route or owner exists today.
- Locale-prefixed URLs, `hreflang`, and translated catalog content (specs 042 §7 and a future
  content-translation spec).
- Generated Open Graph images and app-icon artwork (design, DEP-2).
- Push notifications through the service worker (spec 026 owns channels; its push adapter is a
  sandbox).
- The CI pipeline and the Playwright runner themselves (spec 046).

---

## 8. Dependencies, decisions, risks

### Dependencies

| # | Dependency | Owner | Needed for |
|---|---|---|---|
| DEP-1 | Playwright runner, `browser/` directory, browser test database, and CI jobs (`browser`, `perf`) | spec 046 | AC-1/2/3 browser tests, AC-4 |
| DEP-2 | Square app-icon artwork: 192px, 512px and maskable 512px PNGs, delivered to `public/icons/` | design (brand owner) | AC-1 |
| DEP-3 | The in-flight `package.json`/`package-lock.json` changes (spec 033 OpenAI work) are landed first, so adding `@lhci/cli` is not a mixed-file change | — | implementation start |

### Authorized cross-spec changes (X-list)

| # | Owning spec | File(s) | Change |
|---|---|---|---|
| X-1 | 002/042 | `app/layout.tsx` | Add `metadataBase` from `SITE_URL` and the default Open Graph `siteName`; render `<ServiceWorkerRegistrar />` and `<OfflineBanner />` inside `LocaleProvider`. Nothing else: `lang`/`dir`/`LocaleProvider` are untouched. |
| X-2 | 042 | `lib/i18n/dictionaries/en.ts` | Add the `seo.*` keys (home and explore title/description) and `offline.*` keys (offline page heading and body). `ur.ts` is not required (`DeepPartial` fallback, 042 AC-6). |
| X-3 | 001 | `.env.example` | Document `SITE_URL`. |
| X-4 | 011/013/014/015/020/021/025 | the files the §3.10 audit finds, recorded in the PR | `Skeleton` and `next/image` fixes only |
| X-5 | 015/020/021/025 | the five files of §3.5 | Disable the submit control while offline via `useNetworkStatus()`, with the offline notice. No other change. |

### Decisions

| # | Decision |
|---|---|
| D-1 | A hand-written `public/sw.js` with no library. It caches only hashed static assets, public images, icons and a guest-rendered `/offline`. It never caches HTML otherwise, never `/api/*`, and never intercepts non-`GET` requests. Caches are versioned by `CACHE_VERSION`, and old versions are purged on activate. |
| D-2 | No queued writes in MVP. The four critical write controls are disabled offline, other writes fail honestly with `NETWORK_ERROR`, and reconnect triggers one `router.refresh()`. |
| D-3 | Budgets are the CWV "Good" thresholds, LCP ≤ 2.5 s, INP ≤ 200 ms and CLS ≤ 0.1, plus a JavaScript cap of 200 KB (204,800 bytes) compressed transfer on initial load. They are measured on six routes under Slow 4G with 4× CPU, median of 3: LCP, CLS and JS via Lighthouse CI, and INP via Playwright Event Timing. Blocking. |
| D-4 | Indexable = home, explore, and published category and service pages. Everything else is `noindex` via per-segment server layouts, with a completeness test. `robots.txt` only disallows `/api/`. |
| D-5 | One canonical per page from `SITE_URL`; no `hreflang` (spec 042 has no locale URLs); catalog metadata as authored; static metadata through spec 042's `translate()`. |
| D-6 | Provider-profile SEO is removed; there is no route or owner. |
| D-7 | The draft's "drafting a request" example is removed, because no such action exists (spec 015 §4). |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | The current dynamic pages may breach the budgets on first measurement | This is a real defect to fix in the owning route (§3.7); the budget is not loosened without a spec decision |
| R-2 | Lab CI hardware variance makes the perf job noisy; lab INP from scripted interactions is not identical to field INP | Throttling plus the median of 3 runs; field INP monitoring is deferred (§6) |
| R-3 | `navigator.onLine` false positives | `NETWORK_ERROR` stays authoritative; the banner is advisory |
| R-4 | A worker bug serving stale content | HTML is never cached, versioned caches, and the documented kill-switch worker |
| R-5 | Client-only public pages render their main content after hydration, which crawlers may index less well | Server layouts supply all metadata and JSON-LD in the initial HTML; converting the pages to server components is out of scope |

---

## 9. Rollout

- **Feature flag:** none — foundational quality bar, not optional.
- **Migration order:** N/A.
- **Environment:** set `SITE_URL` in every deployed environment (staging uses its own origin, so its
  canonicals never point at production).
- **Rollback:** revert the deploy. The previous or no-op `sw.js` purges the versioned caches (§3.2);
  the emergency kill-switch worker is documented in `sw.js`.
- **Observability:**
  - the CI `perf` job's history (master §108);
  - structured lines `pwa.sw_registered` and `pwa.sw_registration_failed` (client-side `console`,
    development diagnostics only);
  - the crawl-error rate from the search engine's webmaster console, reviewed manually;
  - field Core Web Vitals monitoring is deferred (§6).
