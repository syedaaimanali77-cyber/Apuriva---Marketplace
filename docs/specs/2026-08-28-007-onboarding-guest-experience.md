# Spec: Onboarding & Guest Experience

**File:** `docs/specs/2026-08-28-007-onboarding-guest-experience.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §10–§12, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §12, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No first-run experience or guest browsing capability exists. Master spec §11
requires guests to browse categories, search, view providers/reviews, and prepare a request or
booking without an account — accounts are only required at the point identity is actually
needed (submit, message, book, pay, save, track).

**Who is affected:** Every first-time visitor; conversion depends on not forcing signup before
value is shown.

**Why it matters now:** It gates how every later browsing/discovery spec (010–014) treats
unauthenticated users, and must exist before those specs assume "the user may or may not be
logged in."

**Success looks like:** A first-time visitor sees a short skippable value intro, can browse and
search without an account, and is only asked to sign up at the exact moment an identity-requiring
action is attempted — with their in-progress action preserved through that signup.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a first-time visitor **When** they land on the app **Then** they see a short, skippable value introduction that never blocks exploration |
| AC-2 | **Given** a guest (no session) **When** they browse categories, search, view a provider profile, or view reviews **Then** all of these work with no login prompt |
| AC-3 | **Given** a guest **When** they attempt to submit a request, message, book, pay, save a provider, or track a booking **Then** they are prompted to sign up/log in, and upon success are returned to the exact in-progress action with its state intact |
| AC-4 | **Given** the app on first launch **When** it loads **Then** location is not requested immediately; it is only requested at a point where it provides clear value (spec 012 defines the actual prompt) |
| AC-5 | **Given** a guest who dismisses/skips onboarding **When** they return later **Then** onboarding does not reappear |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/categories`, `/api/v1/services`, `/api/v1/search`, `/api/v1/providers/{id}` | none | `200` | must all be guest-accessible (defined fully in specs 010–014); this spec only asserts the *auth policy*, not the full contract |

### Request and response types

No new types — this spec constrains which existing/future endpoints require auth, rather than
introducing its own resource.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `401` | `UNAUTHENTICATED` | guest attempts an identity-requiring action (submit request, message, book, pay, save, track) |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

None new. This spec introduces no entities; it constrains auth middleware policy on existing/
future routes (`packages/auth`: a route-level `authRequired: boolean` policy flag, defaulting
to `false` for browse/search/view routes and `true` for identity-requiring actions).

### Retention and privacy

An in-progress guest action (e.g. a half-filled request) that must survive the signup redirect
is held client-side (browser storage) until signup completes, then submitted — never persisted
server-side against an anonymous identity.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | onboarding intro and browse screens use skeletons, never block on network before showing something |
| **Empty** | N/A at this level (per-screen empty states are specs 010–014's concern) |
| **Error** | signup-redirect failure preserves the original in-progress action and shows a retry |
| **Success** | after signup/login triggered mid-action, user lands back exactly where they were, action state intact |

Onboarding intro is skippable via a visible, keyboard-reachable "Skip" control; screen-reader
announces it as dismissible, not as a modal trap.

**Route(s):** `apps/web/app/(marketing)/onboarding` (or an in-app first-run overlay),
guest-accessible routes across `apps/web/app/explore/*`
**Shared components used/added:** `packages/ui` `Dialog`/`Overlay`, new `AuthGate` wrapper
component that redirects-and-resumes

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | `AuthGate` resume-state serialization | `apps/web/**/*.test.ts` |
| **Integration** | route auth-policy middleware allows guest GETs, blocks guest POSTs on identity-requiring actions | `apps/api/*.integration.test.ts` |
| **Component** | onboarding intro skip behavior, persistence of "seen" state | `apps/web` (Testing Library) |
| **E2E** | guest browses → attempts to book → redirected to signup → resumes booking after signup | `apps/web-e2e/guest-to-signup.spec.ts` |
| **Accessibility** | onboarding overlay keyboard/screen-reader dismissal | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-2 | `apps/api/browse.integration.test.ts::guest can browse without session` |
| AC-3 | `apps/web-e2e/guest-to-signup.spec.ts::resumes action after signup` |
| AC-5 | `apps/web/onboarding.test.ts::does not reappear after skip` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The actual location-permission prompt copy/flow (spec 012).

---

## 7. Out of scope

- Location permission UX itself (spec 012).
- Home personalization content (spec 014).
- Provider-side onboarding ("Become a Provider" flow) beyond the profile-creation mechanism
  already covered in spec 006 — provider-specific onboarding steps (verification, services
  setup) are referenced by later specs, not detailed here.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Where "seen onboarding" state is stored (server-side on `User`, or client-side only) for guests who later sign up | — | Open — recommend client-side for guests, migrated to server-side `User` flag on signup |

---

## 9. Rollout

- **Feature flag:** `onboarding-intro-v1` (default on) — allows disabling the intro without a
  redeploy if it underperforms.
- **Migration order:** N/A.
- **Rollback:** disable flag; guest browsing itself has no flag (always on).
- **Observability:** onboarding skip rate and guest-to-signup conversion funnel tracked via
  spec 040's analytics events.
