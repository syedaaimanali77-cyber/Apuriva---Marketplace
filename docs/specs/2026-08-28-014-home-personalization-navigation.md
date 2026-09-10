# Spec: Home, Personalization & Navigation

**File:** `docs/specs/2026-08-28-014-home-personalization-navigation.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §13, §59–§61, §123, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §12, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No home screen or persona-specific navigation exists. Master spec §13 requires smart
hybrid home personalization (curated content for new users, recent/relevant + saved providers
for returning users, active bookings taking priority), and §59–§61/§123 define distinct
navigation IA for customer, provider, and admin personas.

**Who is affected:** Every logged-in and guest user landing on the app; this is the single most
visited screen.

**Why it matters now:** It ties together catalog (010–011), search (013), and — once they
exist — active requests/bookings, into the primary landing experience; it must exist before
later specs (015+) can assume a coherent app shell with working navigation.

**Success looks like:** A returning user's home reflects their context (active booking front and
center, otherwise recent/relevant services and saved providers); a new user sees curated/popular
content; each persona (customer/provider/admin) has the navigation structure defined in master
spec §123, with AI contextual rather than a mandatory permanent tab.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a new user with no history **When** they view Home **Then** they see curated/popular content, not an empty or generic screen |
| AC-2 | **Given** a returning user with history but no active booking **When** they view Home **Then** they see recent/relevant services and saved providers |
| AC-3 | **Given** a user with an active booking **When** they view Home **Then** the active booking is shown with priority above general recommendations |
| AC-4 | **Given** a user in customer mode **When** viewing primary navigation **Then** it shows exactly Home, Explore, Requests, Bookings, Account (master spec §59) |
| AC-5 | **Given** a user in provider mode **When** viewing primary navigation **Then** it shows exactly Dashboard, Requests, Schedule, Earnings, Account (master spec §60) |
| AC-6 | **Given** an admin **When** viewing primary navigation **Then** it shows exactly Overview, Operations, Users, Marketplace, Analytics, Settings (master spec §61) |
| AC-7 | **Given** any user **When** personalization is shown **Then** they can access controls to adjust/disable it, and where useful the UI explains why a recommendation appeared |
| AC-8 | **Given** any persona **When** browsing **Then** the AI assistant is reachable contextually, not pinned as a permanent required tab |

**Scope note:** AC-1/AC-2/AC-3/AC-7 describe the *customer-mode* home feed — `HomeFeedDto`'s
sections (`curated_popular`/`recent_relevant`/`saved_providers`) and the personalization
opt-out only apply there. Provider mode gets a Dashboard and admin gets Overview (their
*content* is out of scope here, §7); "any user" in AC-7 means any user currently viewing the
customer home feed, not a provider/admin's dashboard.

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/home` | session or guest | `200` `ApiResponse<HomeFeedDto>` | shape varies by auth state and active mode |
| `GET` | `/api/v1/users/me/personalization-settings` | session | `200` `ApiResponse<PersonalizationSettingsDto>` | |
| `PATCH` | `/api/v1/users/me/personalization-settings` | session | `200` | opt out/adjust |

### Request and response types

```typescript
// lib/types/home.ts
import type { SearchResultDto } from '@/lib/types/search'; // reuse, not redefine — this is the
// existing canonical provider+service listing shape (spec 013); there is no separate
// "ServiceSummary" type anywhere in the codebase and this spec must not invent an incompatible
// duplicate. `curated_popular`/`recent_relevant` items are `SearchResultDto`, unchanged.

/** New in this spec — no "provider-only" summary DTO exists elsewhere to reuse (spec 013's
 * `SearchResultDto` is always a provider+service pair). Deliberately minimal: only baseline
 * `ProviderProfile` fields plus the same absent-until-reviewed `rating` convention `SearchResultDto`
 * already uses (spec 029 owns the aggregate; do not fabricate a rating for an unrated provider). */
export interface ProviderSummaryDto {
  providerId: string;
  businessName: string;
  rating?: number;
}

export interface HomeFeedDto {
  /** Omitted (not present as a falsy/empty value) until spec 020 (`Booking`) exists in code —
   * see §8 risk 4. Clients must treat "key absent" and "no active booking" identically. */
  activeBooking?: { bookingId: string; status: string; summary: string };
  sections: Array<
    | { type: 'curated_popular'; items: SearchResultDto[] }
    | { type: 'recent_relevant'; items: SearchResultDto[]; reason?: string }
    | { type: 'saved_providers'; items: ProviderSummaryDto[] }
  >;
}

export interface PersonalizationSettingsDto {
  personalizationEnabled: boolean;
}
```

`saved_providers` is included in the `sections` union for forward compatibility but is always
omitted from the response array (not sent as an empty-items entry) until a persistent
saved/followed-provider relationship exists — see §8 risk 2; there is no entity to source it from
today.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | malformed settings update |
| `401` | `UNAUTHENTICATED` | no valid session presented to a settings endpoint (both require `session`; `GET /api/v1/home` alone accepts guest) |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

No new core entity. This spec reads from:

- **`RecentSearch`** (spec 013, already real) as the "recent/relevant" and new-vs-returning
  signal — **not** `AnalyticsEvent`. Spec 013 §8 already established that `analytics_events` is
  still column-less (no `event_type`/`payload`/`occurred_at`) until spec 040 ships the ingestion
  pipeline, and that `RecentSearch` is deliberately "why AC-2's 'recent searches' source has
  anywhere to actually read from." An earlier draft of this spec named `AnalyticsEvent` as the
  history source, which does not work today; see §8 risk 3 for the richer-signal fallback once
  spec 040 exists.
- **A persistent saved/followed-provider relationship** for the `saved_providers` section — this
  does **not** exist yet. Neither spec 017 (provider matching/ranking) nor spec 019 (offer
  negotiation/comparison) defines such a relationship anywhere in their own text; the only
  "save/follow provider" action in the spec suite is spec 016 AC-6's one-off
  `POST /api/v1/providers/{id}/availability-notify` request, which is not a durable list a home
  feed can enumerate. An earlier draft of this spec incorrectly cited specs 017/019 as the
  owners. See §8 risk 2 — this is a genuine, currently-unowned cross-spec gap, not a sequencing
  detail this spec can wait out.
- **`Booking`** (active-booking priority) — correctly forward-dependent on spec 020. Spec 020's
  *document* is Approved, but no `Booking` entity/API exists in code yet (nothing past spec 013
  has been implemented). See §8 risk 4 for the fallback.

Adds one field:

| Entity | Change | Fields |
|---|---|---|
| `CustomerProfile` | extend | `personalization_enabled boolean default true` |

### Migration

- **Name:** `AddPersonalizationSettings`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Personalization inputs (view/search history) are the same data governed by spec 008's
export/deletion flow; disabling personalization stops using history for recommendations but
does not itself delete the underlying history (deletion is a separate, explicit action).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | home feed skeleton per section; navigation shell renders immediately (never blocks on feed data) |
| **Empty** | brand-new user path is itself a defined "curated" state, not a literal empty state — see AC-1 |
| **Error** | feed section failure degrades gracefully per-section (e.g. saved-providers fails but curated content still shows), never a full-page error for a partial personalization failure |
| **Unavailable (dependency not yet shipped)** | distinct from **Error**: `activeBooking` and the `saved_providers` section are simply absent from the response — never rendered as a loading spinner, retry button, or failed-section state — while spec 020 (Booking) and the saved/followed-provider relationship (§8 risk 2) don't exist yet. Once each ships, its section/field starts appearing; this is a capability gap, not a runtime failure |
| **Success** | active booking banner, then relevant sections; "why am I seeing this" affordance where personalization drove the section |

Navigation is a persistent, always-reachable shell across all screens; mode-appropriate (per
spec 006). Responsive: mobile bottom-tab nav, desktop side/top nav — same IA, adapted layout.

**Route(s):** `app/page.tsx` (this spec replaces spec 001's placeholder splash/health-check
home page — not `app/(home)`, since no other top-level route in this codebase uses a route
group for a single page, and a competing `app/(home)/page.tsx` would collide with the existing
`app/page.tsx` on the same `/` route); navigation shell in `app/layout.tsx` variants per persona.
**Shared components used/added:** `components` `NavShell`, `BottomTabBar`, `SideNav`,
`ActiveBookingBanner`. `NavShell`/`SideNav` compose with the existing `app/components/AppHeader.tsx`
(sticky top bar: logo + `AccountMenu`, already shipped) rather than replacing it — per this
project's single-primary-brand-placement rule (`CLAUDE.md`), `SideNav` must not add its own logo,
and must not duplicate the mode-switch entry point `AccountMenu` already exposes (spec 006 §5).

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | home-feed section selection logic (new vs. returning vs. active-booking) | `app/api/v1/home/**/*.test.ts` |
| **Integration** | feed API returns correct sections per user state | `app/api/v1/home/*.integration.test.ts` |
| **Component** | nav shell renders correct items per persona | the application (Testing Library) |
| **E2E** | new user sees curated home; user with active booking sees it prioritized; nav differs by mode | `e2e/home-nav.spec.ts` |
| **Accessibility** | nav shell keyboard/screen-reader tested (landmark roles, current-page indication) | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/home/feed.integration.test.ts::new user gets curated content` |
| AC-2 | `app/api/v1/home/feed.integration.test.ts::returning user gets recent/relevant sourced from RecentSearch` (saved-providers half of AC-2 is untestable until §8 risk 2 resolves — tracked there, not silently dropped) |
| AC-3 | `app/api/v1/home/feed.integration.test.ts::active booking prioritized` — **gated on spec 020 shipping** (§8 risk 4); until then this test is skipped/pending, not failing, and the spec is not blocked on it |
| AC-4 | `NavShell.test.tsx::customer mode shows exactly Home, Explore, Requests, Bookings, Account` |
| AC-5 | `NavShell.test.tsx::provider mode shows exactly Dashboard, Requests, Schedule, Earnings, Account` |
| AC-6 | `NavShell.test.tsx::admin shows exactly Overview, Operations, Users, Marketplace, Analytics, Settings` |
| AC-7 | `app/api/v1/users/me/personalization-settings.integration.test.ts::opt out disables personalization` + `NavShell.test.tsx::why-am-I-seeing-this affordance shown` |
| AC-8 | `NavShell.test.tsx::ai is contextual not permanent tab` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The recommendation-ranking algorithm's quality/relevance tuning —
functional correctness of section selection is tested here; ranking quality is a product
iteration concern, not a spec-level acceptance criterion.

---

## 7. Out of scope

- The save/follow-a-provider *action* and its persistence — no spec currently owns a durable
  saved/followed-provider entity (see §4 and §8 risk 2; it is **not** spec 017 or spec 019, an
  earlier draft's incorrect attribution). This spec only renders the `saved_providers` section
  once such an entity exists, and omits it entirely until then.
- Admin-specific dashboard *content* (spec 037) — this spec only fixes the admin nav IA.
- Provider dashboard *content* (today's work, earnings snapshot — spec 037/024) — this spec only
  fixes the provider nav IA.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact "new" vs. "returning" threshold | Product | **Resolved for this spec** — the only real per-user signal that exists at this spec's ship time is spec 013's `RecentSearch` (account age alone has no product backing and is not used). A user is **returning** if they have at least one `RecentSearch` row; otherwise **new**. This is deliberately coarse and may be revisited once spec 040 provides richer signals (view history, request/booking history) — that revision is tracked as a product iteration, not a re-open of AC-1/AC-2's pass/fail bar. |
| 2 | No spec defines a persistent saved/followed-provider relationship (§4, §7) — spec 016 AC-6 is a one-off availability-notify request, not a list; specs 017/019 don't mention it at all | Product/Platform | Open — needs an owning spec (candidates: extend spec 016, or a small dedicated spec) before the `saved_providers` section can ever be populated. Until resolved, this spec ships with that section permanently omitted (§5 "Unavailable" state) — not blocking, since AC-2 can still be met by `recent_relevant` alone. |
| 3 | `recent_relevant`'s only real signal today is `RecentSearch` (spec 013) — `AnalyticsEvent` is column-less until spec 040 (see spec 013 §8 risk 4) | — | Interim: source `recent_relevant` from `RecentSearch` only; the `reason` field must describe what was actually used ("based on your recent searches"), never imply a richer signal that doesn't exist yet. Revisit once spec 040 ships. |
| 4 | `Booking` (spec 020) doesn't exist in code yet, even though its spec document is Approved | — | Interim: `activeBooking` is always omitted from `HomeFeedDto`; AC-3's test is written but skipped/pending until spec 020 ships (§6 traceability) — this spec is not blocked on spec 020 landing first. |
| 5 | No feature-flag read/write infrastructure exists yet — spec 041 (which is what makes `home-personalization-v1` and any other named flag real and toggleable) is itself unimplemented, the same gap spec 013 §8 risk 3 already hit for `search-nl-interpretation` | — | Interim: an environment variable/hardcoded constant serves as the flag until spec 041 ships, per the identical precedent in spec 013 §9; see §9 below. |
| 6 | AC-6's admin nav mandates exactly six top-level items (Overview, Operations, Users, Marketplace, Analytics, Settings), but spec 009's already-implemented admin routes are flat siblings under `app/admin/` (`roles`, `approvals`, `actions/review`) that don't correspond 1:1 to those six labels — only `app/admin/marketplace` matches directly | Platform | Open — this spec must nest existing admin routes under the mandated IA (e.g. `roles`→`Settings` or `Users`, `approvals`/`actions/review`→`Operations`) rather than leaving them as unreachable orphans once the new nav ships; implementation must include the route move, not just add new top-level pages alongside the old ones. |

---

## 9. Rollout

- **Feature flag:** `home-personalization-v1` (default on) — allows falling back to a static
  curated feed for all users if personalization misbehaves. No feature-flag read/write mechanism
  exists yet (spec 041 is unimplemented; `feature_flags` is still a bare baseline table — spec
  041 itself lists `home-personalization-v1` as one of the flags it will register once it ships,
  confirming this key is correct and expected, just not yet backed by real infrastructure). An
  environment variable/hardcoded constant serves as the flag until spec 041 ships, identical to
  the precedent spec 013 §9 already set for `search-nl-interpretation`.
- **Migration order:** schema ships with code.
- **Rollback:** disable flag (interim env var, until spec 041); nav shell itself has no flag
  (always on, it's structural).
- **Observability:** section engagement/click-through tracked (spec 040, once its ingestion
  pipeline exists — until then, not tracked, and that gap is expected, not a regression); feed-
  generation latency monitored via existing request logging in the interim.
