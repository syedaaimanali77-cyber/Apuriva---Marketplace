# Spec: Authentication

**File:** `docs/specs/2026-08-28-005-authentication.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §9.1, §78, §132.2, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §4, §9.3, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No authentication exists. Customers, providers, and admins all need to establish and
prove identity before any personalized or transactional action (submitting a request,
messaging, booking, payment — master spec §11).

**Who is affected:** Every user of the platform; especially Pakistan-market customers who
primarily expect phone-based login over email/password.

**Why it matters now:** It is the first Milestone-2 dependency — role switching, profiles, and
every protected endpoint from spec 006 onward require a session/identity to attach to.

**Success looks like:** A user can register and log in via phone+OTP (primary path),
email+password, Google, or Apple; sessions are server-issued and validated on every protected
request; admins have mandatory MFA; step-up re-authentication is enforced for sensitive actions.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a new phone number **When** the user requests an OTP and submits the correct code within its validity window **Then** an account is created (or an existing one is logged in) and a session is issued |
| AC-2 | **Given** an OTP request **When** an incorrect code is submitted 5 times **Then** further attempts are rate-limited per master spec §100, and the attempt is logged as a security event |
| AC-3 | **Given** an email+password account **When** the password is submitted correctly **Then** a session is issued; **When** incorrect **Then** `401 UNAUTHENTICATED` with no indication of whether the email exists |
| AC-4 | **Given** a Google or Apple OAuth flow **When** completed successfully **Then** the account is linked/created and a session is issued, without exposing the OAuth provider's raw token to the frontend beyond what's needed |
| AC-5 | **Given** an admin account **When** logging in **Then** MFA is mandatory and login is rejected without a valid second factor, per master spec §78 |
| AC-6 | **Given** a logged-in session **When** the user attempts a sensitive action (e.g. change payout method, per spec 024) **Then** step-up re-authentication is required even though the session is otherwise valid |
| AC-7 | **Given** any authentication attempt **When** it succeeds or fails **Then** the server is the sole authority on the outcome — no client-side flag can mark a session as authenticated |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/auth/otp/request` | none | `200` `{ requestId, expiresAt }` | rate-limited per phone number and per IP |
| `POST` | `/api/v1/auth/otp/verify` | none | `200` `ApiResponse<SessionDto>` | idempotent on `requestId` |
| `POST` | `/api/v1/auth/register` | none | `201` `ApiResponse<SessionDto>` | email+password |
| `POST` | `/api/v1/auth/login` | none | `200` `ApiResponse<SessionDto>` | email+password |
| `POST` | `/api/v1/auth/oauth/google` | none | `200` `ApiResponse<SessionDto>` | exchanges provider auth code server-side |
| `POST` | `/api/v1/auth/oauth/apple` | none | `200` `ApiResponse<SessionDto>` | exchanges provider auth code server-side |
| `POST` | `/api/v1/auth/mfa/verify` | session (partial) | `200` `ApiResponse<SessionDto>` | completes MFA-pending login |
| `POST` | `/api/v1/auth/logout` | session | `204` | invalidates current session |
| `POST` | `/api/v1/auth/step-up` | session | `200` `ApiResponse<{ stepUpToken, expiresAt }>` | short-lived, bound to the specific sensitive action |

### Request and response types

```typescript
// packages/types/src/auth.ts
export interface SessionDto {
  userId: string;
  sessionId: string;
  expiresAt: string;
  mfaRequired: boolean;
  roles: Array<'customer' | 'provider' | 'admin'>;
}

export interface RequestOtpRequest {
  phoneNumber: string; // E.164
}

export interface VerifyOtpRequest {
  requestId: string;
  code: string;
}
```

Never return the OAuth provider's raw access token, password hash, or OTP code to the client.
Session tokens are set as httpOnly, secure, sameSite cookies — never exposed to JS.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | malformed phone/email/password |
| `401` | `UNAUTHENTICATED` | wrong password/OTP, or expired/missing session |
| `401` | `MFA_REQUIRED` | admin login pending second factor |
| `409` | `OTP_ALREADY_USED` | OTP request already consumed (idempotency) |
| `422` | `OTP_EXPIRED` | code submitted after validity window |
| `429` | `RATE_LIMITED` | too many OTP/login attempts |

### Breaking-change check

- [x] No existing field removed, renamed, or narrowed in type (new spec)
- [x] No existing status code or `code` value changed (new spec)
- [ ] N/A — no unchecked boxes

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `User` | new | `id uuid pk`, `phone_number text unique nullable`, `email text unique nullable`, `password_hash text nullable`, `phone_verified_at timestamptz nullable`, `email_verified_at timestamptz nullable`, `created_at`, `updated_at`, `version` |
| `Session` | new | `id uuid pk`, `user_id uuid fk->User`, `issued_at timestamptz`, `expires_at timestamptz`, `mfa_satisfied boolean`, `device_label text`, `ip_hash text`, `revoked_at timestamptz nullable` |
| `SecurityEvent` | new | `id uuid pk`, `user_id uuid fk->User nullable`, `event_type text`, `severity text`, `metadata jsonb`, `created_at` |

`Role`/`Permission` (customer/provider/admin) are governed by spec 006 (role model) and 009
(admin RBAC) — this spec only establishes identity and session, not authorization scope.

### Migration

- **Name:** `AddAuthTables`
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated by migration tool, reviewed in implementing PR

### Retention and privacy

`password_hash` is never logged or exported. OTP codes are never persisted in plaintext beyond
their short validity window (hashed or stored with strict TTL). `SecurityEvent` records feed
account deletion/export flows (spec 008) and are retained per platform security-log policy.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | OTP send/verify buttons show inline spinner state (short action, not skeleton) |
| **Empty** | N/A (form-based flow) |
| **Error** | "That code didn't work. You have N attempts left." / "We couldn't sign you in." — never reveals whether an email/phone is registered |
| **Success** | Redirect to intended destination (or home); session established silently, no unnecessary interstitial |

Validation fires on blur and on submit; phone input uses a country-aware formatter (not
Pakistan-hard-coded, per master spec §2.7). Fully keyboard operable; OTP input supports paste of
a full code. RTL layout for Urdu locale.

**Route(s):** `apps/web/app/(auth)/login`, `apps/web/app/(auth)/register`
**Shared components used/added:** `packages/ui` `Input`, `Button`, `OtpInput` (new)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | password hashing, OTP generation/expiry logic, session token issuance | `apps/api/auth/**/*.test.ts` |
| **Integration** | full OTP request→verify round trip; login rate limiting; MFA-pending admin login | `apps/api/auth/*.integration.test.ts` |
| **Component** | login/register form validation states | `apps/web` (Testing Library) |
| **E2E** | phone+OTP login happy path; failed login shows generic error | `apps/web-e2e/auth.spec.ts` |
| **Accessibility** | login/register forms pass automated a11y scan | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/auth/otp.integration.test.ts::verifies and creates session` |
| AC-2 | `apps/api/auth/otp.integration.test.ts::rate limits after 5 failures` |
| AC-5 | `apps/api/auth/mfa.integration.test.ts::admin login requires mfa` |
| AC-6 | `apps/api/auth/step-up.integration.test.ts::sensitive action requires step-up` |
| AC-7 | `apps/api/auth/session.test.ts::server is sole authority` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** SMS provider integration reliability (external dependency,
covered by provider's own SLA, mocked in tests via sandbox adapter per master spec §133.7).

---

## 7. Out of scope

- Role/profile switching UI (spec 006).
- Admin RBAC permission scopes beyond "is this user an admin + did they pass MFA" (spec 009).
- Provider-specific MFA "strongly encouraged" nudge UI (belongs with provider onboarding,
  referenced but not built here).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | SMS/OTP provider selection (Twilio or a Pakistan-capable alternative) — needs real credentials or a sandbox adapter per master spec §133.7 | — | Open |
| 2 | MFA method for admins (TOTP app vs. SMS) | — | Open — recommend TOTP to avoid SMS-delivery dependency for the most sensitive accounts |
| 3 | Session lifetime and refresh strategy | — | Open — recommend short-lived session + silent refresh, revocable server-side |

---

## 9. Rollout

- **Feature flag:** none — required for any other feature to function.
- **Migration order:** schema ships with the code in the same release.
- **Rollback:** revert API deploy; sessions issued under old code remain valid if token format
  unchanged.
- **Observability:** failed-login and OTP-abuse rates alerted per master spec §117; all auth
  events recorded to `SecurityEvent`.
