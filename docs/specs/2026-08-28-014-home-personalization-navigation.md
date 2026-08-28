# Spec: Home, Personalization & Navigation

**File:** `docs/specs/2026-08-28-014-home-personalization-navigation.md`
**Status:** Draft
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
// packages/types/src/home.ts
export interface HomeFeedDto {
  activeBooking?: { bookingId: string; status: string; summary: string };
  sections: Array<
    | { type: 'curated_popular'; items: ServiceSummary[] }
    | { type: 'recent_relevant'; items: ServiceSummary[]; reason?: string }
    | { type: 'saved_providers'; items: ProviderSummary[] }
  >;
}

export interface PersonalizationSettingsDto {
  personalizationEnabled: boolean;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | malformed settings update |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

No new core entity; this spec reads from `AnalyticsEvent` (history), `CustomerProfile` (saved
providers, once spec 016/018 populate that relationship), and `Booking` (active-booking
priority, once spec 020 exists). Adds one field:

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
| **Success** | active booking banner, then relevant sections; "why am I seeing this" affordance where personalization drove the section |

Navigation is a persistent, always-reachable shell across all screens; mode-appropriate (per
spec 006). Responsive: mobile bottom-tab nav, desktop side/top nav — same IA, adapted layout.

**Route(s):** `apps/web/app/(home)`, navigation shell in `apps/web/app/layout.tsx` variants per
persona
**Shared components used/added:** `packages/ui` `NavShell`, `BottomTabBar`, `SideNav`,
`ActiveBookingBanner`

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | home-feed section selection logic (new vs. returning vs. active-booking) | `apps/api/home/**/*.test.ts` |
| **Integration** | feed API returns correct sections per user state | `apps/api/home/*.integration.test.ts` |
| **Component** | nav shell renders correct items per persona | `apps/web` (Testing Library) |
| **E2E** | new user sees curated home; user with active booking sees it prioritized; nav differs by mode | `apps/web-e2e/home-nav.spec.ts` |
| **Accessibility** | nav shell keyboard/screen-reader tested (landmark roles, current-page indication) | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/home/feed.integration.test.ts::new user gets curated content` |
| AC-3 | `apps/api/home/feed.integration.test.ts::active booking prioritized` |
| AC-4–AC-6 | `apps/web/NavShell.test.tsx::renders correct items per persona` |
| AC-8 | `apps/web/NavShell.test.tsx::ai is contextual not permanent tab` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The recommendation-ranking algorithm's quality/relevance tuning —
functional correctness of section selection is tested here; ranking quality is a product
iteration concern, not a spec-level acceptance criterion.

---

## 7. Out of scope

- Saved-providers mechanism itself (the "save" action lives with provider profile/comparison,
  spec 018) — this spec only renders the saved-providers section.
- Admin-specific dashboard *content* (spec 037) — this spec only fixes the admin nav IA.
- Provider dashboard *content* (today's work, earnings snapshot — spec 037/024) — this spec only
  fixes the provider nav IA.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact "new" vs. "returning" threshold (e.g. account age, activity count) | Product | Open |

---

## 9. Rollout

- **Feature flag:** `home-personalization-v1` (default on) — allows falling back to a static
  curated feed for all users if personalization misbehaves.
- **Migration order:** schema ships with code.
- **Rollback:** disable flag; nav shell itself has no flag (always on, it's structural).
- **Observability:** section engagement/click-through tracked (spec 040); feed-generation
  latency monitored.
