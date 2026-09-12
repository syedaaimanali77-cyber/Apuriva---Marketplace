# Spec: Authentication

**File:** `docs/specs/2026-08-28-005-authentication.md`
**Status:** Approved
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
// lib/types/auth.ts
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

**CSRF protection** (cookie-based sessions, §8 risk #4): double-submit token. The server issues a
`csrfToken` alongside the session as a separate, non-httpOnly cookie (`SameSite=Lax`, `secure`).
Every state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`) must echo that value in an
`X-CSRF-Token` header; the server compares header against cookie and rejects on mismatch or
absence. `GET` requests are exempt (no state change). The session cookie itself stays
`httpOnly`/`secure`/`SameSite=Lax` — `Lax`, not `Strict`, so the OAuth redirect flows in AC-4
still complete with the session intact.

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | malformed phone/email/password |
| `401` | `UNAUTHENTICATED` | wrong password/OTP, or expired/missing session |
| `401` | `MFA_REQUIRED` | admin login pending second factor |
| `403` | `CSRF_TOKEN_INVALID` | state-changing request missing or mismatched `X-CSRF-Token` header |
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

Verified against `docs/specs/2026-08-28-003-database-core-data-model.md`: `User`, `Session`,
`SecurityEvent`, and `AdminProfile` already exist as empty baseline tables (`id`/`created_at`/
`updated_at`/`version`, plus their structural FKs) from that spec's `0001_baseline_schema`
migration. **This spec creates no new tables** — per spec 003 §4 ("feature-specific columns are
added by the owning spec"), it `ALTER TABLE`s these four existing tables to add the
authentication-specific columns below; a duplicate/conflicting `CREATE TABLE` would fail against
the already-applied baseline and is not what ships here.

| Entity | Change | New fields added (id/created_at/updated_at/version already exist from spec 003) |
|---|---|---|
| `User` | extends spec 003 baseline table `users` | `phone_number text unique nullable`, `email text unique nullable`, `password_hash text nullable`, `phone_verified_at timestamptz nullable`, `email_verified_at timestamptz nullable` |
| `Session` | extends spec 003 baseline table `sessions` (already has `user_id uuid fk->User not null`) | `issued_at timestamptz`, `expires_at timestamptz`, `mfa_satisfied boolean`, `device_label text`, `ip_hash text`, `revoked_at timestamptz nullable` |
| `SecurityEvent` | extends spec 003 baseline table `security_events` (already has `user_id uuid fk->User nullable`) | `event_type text`, `severity text`, `metadata jsonb` |
| `AdminProfile` | extends spec 003 baseline table `admin_profiles` (already has `user_id uuid fk->User not null unique`) | `totp_secret_encrypted text nullable`, `mfa_enrolled_at timestamptz nullable` — admin TOTP MFA, §8 risk #2 |

`Role`/`Permission` (customer/provider/admin) are governed by spec 006 (role model) and 009
(admin RBAC) — this spec only establishes identity and session, not authorization scope.

### Migration

- **Name:** `AddAuthColumns` (not `AddAuthTables` — see Entities above: no table is created, only
  columns added to four existing spec 003 baseline tables)
- **Reversible:** yes
- **Backfill required:** no
- **Downtime:** none
- **Reviewed SQL:** generated by migration tool as the next sequentially-numbered migration after
  spec 003's `0001_baseline_schema` (e.g. `0002_*`), reviewed in the implementing PR

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

**Route(s):** `app/(auth)/login`, `app/(auth)/register`
**Shared components used/added:** `components` `Input`, `Button`, `OtpInput` (new)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | password hashing, OTP generation/expiry logic, session token issuance | `app/api/v1/auth/**/*.test.ts` |
| **Integration** | full OTP request→verify round trip; login rate limiting; MFA-pending admin login | `app/api/v1/auth/*.integration.test.ts` |
| **Component** | login/register form validation states | the application (Testing Library) |
| **E2E** | phone+OTP login happy path; failed login shows generic error | `e2e/auth.spec.ts` |
| **Accessibility** | login/register forms pass automated a11y scan | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `app/api/v1/auth/otp.integration.test.ts::verifies and creates session` |
| AC-2 | `app/api/v1/auth/otp.integration.test.ts::rate limits after 5 failures` |
| AC-5 | `app/api/v1/auth/mfa.integration.test.ts::admin login requires mfa` |
| AC-6 | `app/api/v1/auth/step-up.integration.test.ts::sensitive action requires step-up` |
| AC-7 | `app/api/v1/auth/session.test.ts::server is sole authority` |

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
| 1 | SMS/OTP provider selection (Twilio or a Pakistan-capable alternative) — needs real credentials or a sandbox adapter per master spec §133.7 | — | Decided — build behind an internal `SmsOtpProvider` adapter interface (one method: `send(phoneNumber, code)`); ship only a sandbox/mock implementation now (records the code for test/dev use, sends nothing externally). Selecting Twilio or a Pakistan-capable alternative is deferred to a later configuration decision that swaps the adapter implementation without touching any call site |
| 2 | MFA method for admins (TOTP app vs. SMS) | — | Decided — TOTP authenticator app (RFC 6238; Google Authenticator/Authy-compatible). Never SMS for admin MFA — avoids SIM-swap/SMS-delivery risk on the platform's most sensitive accounts. Requires `AdminProfile.totp_secret_encrypted` (§4) |
| 3 | Session lifetime and refresh strategy | — | Decided — session lifetime is **15 minutes**, silently refreshed (reissued with a new `expires_at`) on any authenticated request, up to a **30-day sliding inactivity window**; an **absolute 90-day cap** from `issued_at` forces re-authentication regardless of activity. Server-revocable at any time via `Session.revoked_at` (spec 001/006 admin session-management UI may expose this later) — refresh checks `revoked_at` first and short-circuits immediately if set |
| 4 | CSRF protection strategy for cookie-based sessions | — | Decided — double-submit CSRF token; see §3 "CSRF protection" |

---

## 9. Rollout

- **Feature flag:** none — required for any other feature to function.
- **Migration order:** schema ships with the code in the same release.
- **Rollback:** revert API deploy; sessions issued under old code remain valid if token format
  unchanged.
- **Observability:** failed-login and OTP-abuse rates alerted per master spec §117; all auth
  events recorded to `SecurityEvent`.
