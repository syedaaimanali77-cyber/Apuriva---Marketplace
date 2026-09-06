# Spec: Onboarding & Guest Experience

**File:** `docs/specs/2026-08-28-007-onboarding-guest-experience.md`
**Status:** Approved
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

**Note on AC-3:** the sign-up/log-in prompt is enforced server-side as a `401 UNAUTHENTICATED`
API response (§3) and handled client-side by `AuthGate` (§5), which performs the redirect and
resumes the original action afterward. The `401` is the API-layer authorization contract, not
itself the UI the guest sees — the guest is never shown a raw error, only the signup/login
prompt and, on success, their resumed action.

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/categories`, `/api/v1/services`, `/api/v1/search`, `/api/v1/providers/{id}` | none | `200` | **policy examples only** — these routes' resource/API contracts are owned and defined in full by specs 010–014, not by this spec |

These endpoints are listed only to illustrate the guest-accessibility policy this spec
establishes; Spec 007 does not implement or define their request/response shapes, pagination,
filtering, or any other part of their contracts. Spec 007's only requirement of specs 010–014 is
that whichever browse/search/view (read) operations they end up exposing for these resources
must be guest-accessible, per AC-2.

### Request and response types

No new types — this spec constrains which existing/future endpoints require auth, rather than
introducing its own resource.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `401` | `UNAUTHENTICATED` | guest attempts an identity-requiring action (submit request, message, book, pay, save, track) |

This `401` is the API-layer authorization response only. The client's `AuthGate` (§5) intercepts
it, redirects the guest to signup/login, and resumes the in-progress action on success (AC-3) —
end users are never shown the raw `401`.

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

None new. This spec introduces no entities and no database migration. It establishes the
route-level authentication policy *contract* that this spec standardizes for every existing/
future route: a conceptual `authRequired: boolean` flag, where `false` means the route permits
unauthenticated (guest) access, and `true` means an unauthenticated request is rejected with
`401 UNAUTHENTICATED` (§3). Browse/search/view routes are `authRequired: false`;
identity-requiring actions are `authRequired: true`. This spec does not assume or require any
specific middleware implementation — how the policy is enforced (e.g. a shared middleware, a
per-route guard) is an implementation detail left open; later domain specs (010 onward) apply
this policy to their own routes as they're built.

**Onboarding "seen/skipped" state** (resolves §8 risk #1): stored client-side only, in durable
browser storage (e.g. `localStorage`), keyed to the device/browser rather than to any account.
No `User` database column or migration is added by this spec. This local state remains
effective after the guest later signs up or logs in on that same device — onboarding does not
reappear post-signup solely because the user now has an account. A server-side `User` flag that
would let "seen" state follow the user across devices is explicitly deferred and out of scope
(§7) unless a later spec establishes a concrete need for it.

### Retention and privacy

An in-progress guest action (e.g. a half-filled request) that must survive the signup redirect
is held client-side (browser storage) until signup completes, then submitted — never persisted
server-side against an anonymous identity. Onboarding "seen/skipped" state (above) is likewise
client-side only and is never sent to or stored by the server.

**AuthGate resume-state safety:** the resume state `AuthGate` holds across the signup/login
redirect may contain only the non-sensitive action data needed to reconstruct the guest's
in-progress flow (e.g. a request draft's form fields, the provider/service being acted on). It
must never contain passwords, OTP codes, authentication/session tokens, payment credentials, or
any other secret. Resume state must be validated before it is restored (rejected if malformed or
for a route/shape it doesn't recognize), must have a bounded lifetime/expiry after which it is
discarded rather than resumed, and the post-auth redirect target it drives must be restricted to
in-app routes — it must never permit an arbitrary external redirect (open redirect).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | onboarding intro and browse screens use skeletons, never block on network before showing something |
| **Empty** | N/A at this level (per-screen empty states are specs 010–014's concern) |
| **Error** | signup-redirect failure preserves the original in-progress action and shows a retry |
| **Success** | after signup/login triggered mid-action, user lands back exactly where they were, action state intact |

The onboarding intro is an in-app first-run overlay shown on top of the existing guest-accessible
entry screen — not a separate marketing route or a gate the visitor must pass through. It is
guest-accessible (no account or session required to see or dismiss it), skippable via a visible,
keyboard-reachable "Skip" control, screen-reader accessible (announced as dismissible, not as a
modal trap), and must never block exploration — a visitor can dismiss it or interact with the
page behind it immediately.

**Route(s):** no dedicated route; the overlay renders in-app on first launch, on top of the
guest-accessible routes across `app/explore/*`
**Shared components used/added:** `components` `Dialog`/`Overlay`, new `AuthGate` wrapper
component that redirects-and-resumes

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | `AuthGate` resume-state serialization/validation, and its expiry/security rules (no secrets, bounded lifetime, no open redirects) | `**/*.test.ts` |
| **Integration** | route auth-policy: guest-accessible routes allow unauthenticated GETs, identity-requiring routes reject unauthenticated requests with `401 UNAUTHENTICATED` | `app/api/v1/*.integration.test.ts` |
| **Component** | onboarding first-run overlay show/skip behavior and persistence of "seen" state; `AuthGate` behavior on an identity-requiring action | the application (Testing Library) |
| **E2E** | guest browses → attempts an identity-requiring action → redirected to signup/login → resumes the exact original action after successful authentication | `e2e/guest-to-signup.spec.ts` |
| **Accessibility** | onboarding overlay keyboard reachability and screen-reader dismissal | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `onboarding.test.ts::shows a skippable first-run overlay that never blocks exploration` |
| AC-2 | `app/api/v1/browse.integration.test.ts::guest can browse without session` |
| AC-3 | `e2e/guest-to-signup.spec.ts::resumes action after signup` + `app/api/v1/*.integration.test.ts::guest identity-required action returns 401 UNAUTHENTICATED` |
| AC-4 | `onboarding.test.ts::does not request location on first launch` |
| AC-5 | `onboarding.test.ts::does not reappear after skip` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** The actual location-permission prompt copy/flow (spec 012).

---

## 7. Out of scope

- Location permission UX itself (spec 012).
- Home personalization content (spec 014).
- Provider-side onboarding ("Become a Provider" flow) beyond the profile-creation mechanism
  already covered in spec 006 — provider-specific onboarding steps (verification, services
  setup) are referenced by later specs, not detailed here.
- Implementation of the browse/search/provider-profile resource contracts themselves (specs
  010–014); this spec only sets the guest-accessibility policy those contracts must satisfy.
- A server-side `User` onboarding-seen flag or any related database migration — deferred (§8,
  resolved) unless a later spec establishes a concrete need for it.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Where "seen onboarding" state is stored (server-side on `User`, or client-side only) for guests who later sign up | — | **Resolved** — client-side durable browser storage only (§4). This local state remains effective after the guest signs up/logs in; no `User` column or migration is added by this spec. A server-side flag is deferred (§7) unless a later spec needs cross-device persistence. |

---

## 9. Rollout

- **Feature flag:** `onboarding-intro-v1` (default on) — allows disabling the intro without a
  redeploy if it underperforms.
- **Migration order:** N/A.
- **Rollback:** disable flag; guest browsing itself has no flag (always on).
- **Observability:** onboarding skip rate and guest-to-signup conversion funnel tracked via
  spec 040's analytics events.
