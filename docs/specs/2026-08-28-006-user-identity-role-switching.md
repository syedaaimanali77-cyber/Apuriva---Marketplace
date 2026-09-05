# Spec: User Identity & Role Switching

**File:** `docs/specs/2026-08-28-006-user-identity-role-switching.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §9.2–§9.3, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 005 establishes identity/sessions but not the customer/provider profile model.
Master spec §9.2 requires one identity to support both a customer profile and a provider
profile without duplicate accounts, and §9.3 requires a low-friction way to switch between
"customer mode" and "provider mode" without cluttering primary navigation.

**Who is affected:** Any user who is both a customer and a provider (a common case in a local
services marketplace); every screen spec that needs to know "which mode is this user currently
in."

**Why it matters now:** Every later domain spec (requests, offers, bookings) is written from
either the customer or provider perspective and needs a reliable "current mode" concept
attached to the session.

**Success looks like:** A single `User` can have a `CustomerProfile`, a `ProviderProfile`, or
both; the UI exposes a quick account-menu mode switch with a persistent mode indicator scoped to
the current session; backend authorization checks the active mode/ownership for every
mode-specific action.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a logged-in user with only a customer profile **When** they select "Become a Provider" **Then** a `ProviderProfile` is created and linked to the same `User`, without creating a new account and without changing the current session's active mode — the user stays in customer mode until they explicitly switch via the account menu (AC-2) |
| AC-2 | **Given** a user with both profiles **When** they switch mode via the account menu **Then** the current session's active mode is updated server-side, the persistent mode indicator updates, and subsequent navigation reflects that mode's IA (master spec §59–§61) |
| AC-3 | **Given** a user in customer mode **When** they attempt an action gated by this spec's mode/ownership check (concrete provider-only actions, e.g. accepting a request, are defined by their owning domain spec — see §7) **Then** the backend rejects it with `403 FORBIDDEN` regardless of what the frontend displayed |
| AC-4 | **Given** a user with only a customer profile **When** they visit a provider-only route directly (the route itself is defined by its owning domain spec — see §7) **Then** they see a "Become a Provider" prompt, not a broken/empty provider screen |
| AC-5 | **Given** the active mode is set on the current session **When** the page is reloaded **Then** it still reflects that session's last-set mode (stored on `Session.active_mode`, server-side, validated on every request — never just in-memory React state); a different session for the same user (another device, or a fresh login) is unaffected and starts from the default in §4 |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/users/me` | session | `200` `ApiResponse<UserDto>` | includes which profiles exist and the current session's active mode |
| `POST` | `/api/v1/users/me/provider-profile` | session | `201` `ApiResponse<ProviderProfileDto>` | idempotent; creates provider profile for current user; does **not** change the session's active mode (see AC-1) |
| `PATCH` | `/api/v1/users/me/active-mode` | session | `200` `ApiResponse<UserDto>` | sets `active_mode` on the **current session** (`Session`, spec 005); rejected if target profile doesn't exist |

These routes are unchanged from the original draft — moving `active_mode` from `User` to
`Session` (§4) doesn't require new endpoints, since all three already operate on the current
session's identity (`session` auth) and were never keyed by a client-supplied user/session id.

### Request and response types

```typescript
// lib/types/users.ts
export interface UserDto {
  id: string;
  hasCustomerProfile: boolean;
  hasProviderProfile: boolean;
  /**
   * Active mode of the CURRENT session (backed by `Session.active_mode`, §4) — not a global
   * user preference. The same user authenticated on another device/session may be in a
   * different mode; that's intentional (§8, resolved).
   */
  activeMode: 'customer' | 'provider';
  /**
   * Included so the frontend can gate admin-only UI (e.g. the admin console entry point, spec
   * 009) from this single `/users/me` call instead of a second round-trip. Read-only here;
   * admin status is provisioned out-of-band (§7), never set via this API.
   */
  isAdmin: boolean;
}

export interface SwitchModeRequest {
  mode: 'customer' | 'provider';
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `422` | `PROFILE_NOT_FOUND_FOR_MODE` | attempting to switch to a mode with no corresponding profile |
| `403` | `FORBIDDEN` | mode-scoped action attempted from the wrong mode/ownership |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `Session` | extend (from spec 005 baseline `sessions` table) | `active_mode text check in ('customer','provider') not null default 'customer'` |
| `CustomerProfile` | new | `id uuid pk`, `user_id uuid fk->User unique`, `display_name text`, `created_at`, `updated_at`, `version` |
| `ProviderProfile` | new | `id uuid pk`, `user_id uuid fk->User unique`, `business_name text nullable`, `lifecycle_status text check in ('draft','pending_verification','active','paused','restricted','suspended','banned') not null default 'draft'` (master spec §66; this spec only names the allowed values it depends on — the transition rules between them are owned by provider-onboarding/moderation specs, §7), `created_at`, `updated_at`, `version` |

`active_mode` is **not** a `User` column — it lives on `Session` (per-session, not per-user; see
§8, resolved) so the same user can be in different modes on different devices without either
session forcing the other to sync.

Every mode-scoped backend endpoint added from spec 007 onward must resolve ownership via
`CustomerProfile.user_id` / `ProviderProfile.user_id` (never via a client-supplied "I am the
provider" flag) *and* the current session's `active_mode` — both checks apply together, per AC-3.

### Active mode: persistence and default behavior

- A newly-issued session (fresh login, spec 005) starts with `active_mode = 'customer'` (the
  column default) regardless of what mode the user was last in on some other session.
- An existing session keeps whatever `active_mode` was last set on it as it's silently refreshed
  (same `Session` row, new `expires_at`, per spec 005 §8 risk #3) — so the selected mode survives
  a page reload for that session (AC-5), with no separate client-side persistence needed.
- Switching mode (`PATCH /api/v1/users/me/active-mode`) is rejected with `422
  PROFILE_NOT_FOUND_FOR_MODE` unless the corresponding profile (`CustomerProfile` /
  `ProviderProfile`) already exists for the user — a mode can never be selected without its
  profile.
- The server is the sole source of truth: `Session.active_mode` is read fresh on every request
  that needs it (e.g. for the AC-3 authorization check); the client never asserts the active mode
  unilaterally (consistent with spec 005 AC-7's "server is sole authority" principle).

### Migration

- **Name:** `AddProfilesAndSessionMode`
- **Reversible:** yes
- **Backfill required:** no — `sessions.active_mode` is `not null default 'customer'`, so
  existing rows backfill themselves at add-column time
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Profile data is personal data; deletion/export follows spec 008's flow. `lifecycle_status`
transitions (e.g. Suspended, Banned) are audited (spec 039).

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | account menu shows skeleton row while profile data resolves |
| **Empty** | user with no provider profile sees "Become a Provider" CTA instead of a broken provider dashboard |
| **Error** | mode-switch failure shows inline error, mode indicator does not change until confirmed by server |
| **Success** | mode indicator updates immediately on confirmed switch; navigation IA changes to match (master spec §59–§61) |

Mode switch is reachable via account menu (not primary nav clutter, per master spec §9.3);
fully keyboard operable; screen-reader announces mode change. The mode indicator always reflects
the current session only — it never implies anything about the user's mode on another device.

**Route(s):** `app/account/*` (mode switch UI lives in the account menu, available
globally)
**Shared components used/added:** `components` `Menu`, new `ModeIndicator` component

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | mode-switch validation logic | `app/api/v1/users/**/*.test.ts` |
| **Integration** | create provider profile (without a mode change), switch mode on the session, attempt cross-mode action, mode surviving a simulated reload | `app/api/v1/users/*.integration.test.ts` |
| **Component** | account menu mode switch UI states | the application (Testing Library) |
| **E2E** | customer becomes provider, switches mode, sees provider dashboard | `e2e/role-switching.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/users/provider-profile.integration.test.ts::creates without new account or session mode change` |
| AC-2 | `e2e/role-switching.spec.ts::switches and updates nav` |
| AC-3 | `app/api/v1/users/authorization.integration.test.ts::rejects cross-mode action` |
| AC-4 | `e2e/role-switching.spec.ts::prompts become-provider on direct nav` |
| AC-5 | `app/api/v1/users/active-mode.integration.test.ts::mode set on the session persists across a re-fetch of /users/me; a second, independent session for the same user is unaffected` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Provider verification workflow itself (foundation only
referenced here; full verification flow is part of provider onboarding, out of scope for this
spec — see master spec §121 Provider "Verification workflow foundation").

---

## 7. Out of scope

- Admin profile creation and provisioning (admins are provisioned separately, not via
  self-service "Become an Admin" — see spec 009). This spec's `isAdmin` field (§3) only surfaces
  that status; it does not set it.
- Full provider verification document review flow (`ProviderProfile.lifecycle_status`'s
  `pending_verification`/`active` transition and beyond — see master spec §121 "Verification
  workflow foundation"). This spec only names the allowed `lifecycle_status` values (§4).
- Any concrete provider-only or customer-only action or route (e.g. accepting a request,
  a provider dashboard page) — each lives in its own domain spec (starting spec 007 onward).
  This spec defines only the mechanism those specs build on: the mode/ownership check and the
  `403 FORBIDDEN` contract (AC-3), and the expected "Become a Provider" prompt behavior when a
  customer-only session reaches one of those routes (AC-4).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Whether `active_mode` should be per-device or per-user (a user on two devices in different modes simultaneously) | — | **Decided — per-session**, not global per-user: `active_mode` lives on `Session` (§4), not `User`, so multi-device use isn't forced to sync. See §1, §2 AC-1/AC-2/AC-5, §3, §4, §9. |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; every session (existing or newly issued) defaults to `customer`
  mode via `sessions.active_mode`'s column default (§4) if the deployed code stops setting it
  explicitly.
- **Observability:** mode-switch and provider-profile-creation events logged for funnel
  analytics (spec 040).
