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
both; the UI exposes a quick account-menu mode switch with a persistent mode indicator; backend
authorization checks the active mode/ownership for every mode-specific action.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a logged-in user with only a customer profile **When** they select "Become a Provider" **Then** a `ProviderProfile` is created and linked to the same `User`, without creating a new account |
| AC-2 | **Given** a user with both profiles **When** they switch mode via the account menu **Then** the persistent mode indicator updates and subsequent navigation reflects that mode's IA (master spec §59–§61) |
| AC-3 | **Given** a user in customer mode **When** they attempt a provider-only action (e.g. accept a request) **Then** the backend rejects it with `403 FORBIDDEN` regardless of what the frontend displayed |
| AC-4 | **Given** a user with only a customer profile **When** they visit a provider-only route directly **Then** they see a "Become a Provider" prompt, not a broken/empty provider screen |
| AC-5 | **Given** the active mode **When** persisted **Then** it survives a page reload (stored server-side or in a durable client store validated server-side, not just in-memory React state) |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/users/me` | session | `200` `ApiResponse<UserDto>` | includes which profiles exist and active mode |
| `POST` | `/api/v1/users/me/provider-profile` | session | `201` `ApiResponse<ProviderProfileDto>` | idempotent; creates provider profile for current user |
| `PATCH` | `/api/v1/users/me/active-mode` | session | `200` `ApiResponse<UserDto>` | switches mode; rejected if target profile doesn't exist |

### Request and response types

```typescript
// packages/types/src/users.ts
export interface UserDto {
  id: string;
  hasCustomerProfile: boolean;
  hasProviderProfile: boolean;
  activeMode: 'customer' | 'provider';
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
| `User` | extend (from spec 005) | `active_mode text check in ('customer','provider')` |
| `CustomerProfile` | new | `id uuid pk`, `user_id uuid fk->User unique`, `display_name text`, `created_at`, `updated_at`, `version` |
| `ProviderProfile` | new | `id uuid pk`, `user_id uuid fk->User unique`, `business_name text nullable`, `lifecycle_status text` (Draft/Pending Verification/Active/Paused/Restricted/Suspended/Banned, master spec §66), `created_at`, `updated_at`, `version` |

Every mode-scoped backend endpoint added from spec 007 onward must resolve ownership via
`CustomerProfile.user_id` / `ProviderProfile.user_id`, never via a client-supplied "I am the
provider" flag.

### Migration

- **Name:** `AddProfileTables`
- **Reversible:** yes
- **Backfill required:** no
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
fully keyboard operable; screen-reader announces mode change.

**Route(s):** `apps/web/app/account/*` (mode switch UI lives in the account menu, available
globally)
**Shared components used/added:** `packages/ui` `Menu`, new `ModeIndicator` component

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | mode-switch validation logic | `apps/api/users/**/*.test.ts` |
| **Integration** | create provider profile, switch mode, attempt cross-mode action | `apps/api/users/*.integration.test.ts` |
| **Component** | account menu mode switch UI states | `apps/web` (Testing Library) |
| **E2E** | customer becomes provider, switches mode, sees provider dashboard | `apps/web-e2e/role-switching.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/users/provider-profile.integration.test.ts::creates without new account` |
| AC-2 | `apps/web-e2e/role-switching.spec.ts::switches and updates nav` |
| AC-3 | `apps/api/users/authorization.integration.test.ts::rejects cross-mode action` |
| AC-4 | `apps/web-e2e/role-switching.spec.ts::prompts become-provider on direct nav` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Provider verification workflow itself (foundation only
referenced here; full verification flow is part of provider onboarding, out of scope for this
spec — see master spec §121 Provider "Verification workflow foundation").

---

## 7. Out of scope

- Admin profile creation (admins are provisioned separately, not via self-service "Become an
  Admin" — see spec 009).
- Full provider verification document review flow.
- Any provider-only or customer-only feature behavior itself (each lives in its own spec) —
  this spec only covers the identity/mode model those features check against.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Whether `active_mode` should be per-device or per-user (a user on two devices in different modes simultaneously) | — | Open — recommend per-session, not global per-user, so multi-device use isn't forced to sync |

---

## 9. Rollout

- **Feature flag:** none.
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; existing sessions default to `customer` mode if `active_mode` is
  unset.
- **Observability:** mode-switch and provider-profile-creation events logged for funnel
  analytics (spec 040).
