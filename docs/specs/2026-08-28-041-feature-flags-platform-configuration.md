# Spec: Feature Flags & Platform Configuration

**File:** `docs/specs/2026-08-28-041-feature-flags-platform-configuration.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §69 (admin roles), §70 (risk tiers), §71 (admin configuration), §72 (audit), §117 (observability), §119 (feature flags), [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §16 (environments), [docs/workflow.md](../workflow.md); specs 001 (environments, env-var contract), 003 (`feature_flags` stub, schema conventions), 004 (API envelope, pagination, OpenAPI registry), 007, 009 (RBAC), 013, 014, 017, 023, 026, 033, 034, 036, 037, 038, 039 (audit log). See §8.

---

## 1. Problem statement

**Today:** Master §119 requires flags for new features, gradual rollout, environment-specific
activation and emergency kill switches. Business admins control approved business flags,
developers control security/technical flags, and every change is audited. None of this exists.

- `feature_flags` is spec 003's column-less stub: `baseColumns()` only. Nothing reads or writes it.
- Five approved specs ship their flag as an **environment-variable stand-in** "until spec 041
  exists". Each is a synchronous `(): boolean` function:

  | Stand-in | Module | Env var | Semantics |
  |---|---|---|---|
  | spec 013 `search-nl-interpretation` | `lib/search/feature-flags.ts` `isNlInterpretationEnabled()` | `SEARCH_NL_INTERPRETATION_ENABLED` | on unless `'false'` |
  | spec 014 `home-personalization-v1` | `lib/home/feature-flags.ts` `isHomePersonalizationEnabled()` | `HOME_PERSONALIZATION_ENABLED` | on unless `'false'` |
  | spec 033 `ai-assistant` | `lib/ai/feature-flags.ts` `isAiAssistantEnabled()` | `AI_ASSISTANT_ENABLED` | on unless `'false'` |
  | spec 034 `ai-conversational-assistant` | `lib/ai-assistant/feature-flags.ts` `isConversationalAssistantEnabled()` | `AI_CONVERSATIONAL_ASSISTANT_ENABLED` | on unless `'false'` |
  | spec 038 `ai-fraud-signals` | `lib/moderation/flags.ts` `isAiFraudSignalsEnabled()` | `AI_FRAUD_SIGNALS_ENABLED` | off unless `'true'` |

- Spec 007 names `onboarding-intro-v1` (default on), but nothing gates the intro:
  `app/_components/OnboardingOverlay.tsx` always shows it to a first-run visitor.
- Changing an env var needs a redeploy. So no flag can be flipped in an emergency without a deploy,
  and no flag change is audited.

**Who is affected:**

- Content/Marketplace and Operations admins, who toggle approved business features.
- Super Admins, who hold the developer-controlled technical switches (§3.5).
- Every owning spec above.

**Success looks like:**

- The flags that approved specs define are registered, DB-backed and environment-isolated.
- Business flags are toggled by business admins without a deploy.
- Technical flags are visible and toggleable only by Super Admin.
- Every change is recorded in spec 039's audit log.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a business flag (§3.3) **When** a Content/Marketplace, Operations or Super Admin toggles it for the running environment **Then** the next read of that flag in that environment returns the new value, with no deploy or restart, and no other environment's value changes. |
| AC-2 | **Given** a developer (technical) flag **When** any admin without `feature_flags/read_technical` lists flags, or without `feature_flags/toggle_technical` toggles one **Then** it is absent from their list and the toggle is refused `403 FORBIDDEN`, its value unchanged. It is also never returned by the effective-flags endpoint. |
| AC-3 | **Given** any successful flag change **When** it is applied **Then** exactly one spec 039 `audit_logs` row is written, immediately after the change commits. The row records: actor and roles, flag key, environment, `before`/`after` values, reason and correlation id. A refused, invalid or no-op request writes no row. |
| AC-4 | **Given** a kill-switch flag turned off **When** the next request reads it **Then** the feature stops for that request. No deploy, no restart and no process-local cache delays it (§3.7). |
| AC-5 | **Given** the flag registry **When** it is inspected **Then** it holds exactly the six flags of §3.3. Each has the default its owning spec documents, and has one seeded value per environment in `feature_flag_environment_values`. |
| AC-6 | **Given** different stored values for the same flag in two environments **When** read under each environment **Then** each read returns only its own environment's value. A toggle in one environment never changes another's. |

### 2.1 AC implementation matrix

| AC | Path | Named test |
|---|---|---|
| AC-1 | `PATCH /admin/feature-flags/{key}` → `toggleFeatureFlag()` → `isFeatureEnabled()` | `lib/feature-flags/toggle.integration.test.ts` |
| AC-2 | the §3.5 permissions, the list filter, the `client_readable` CHECK | `app/api/v1/admin/feature-flags/access.integration.test.ts` |
| AC-3 | `recordAdminAuditEvent()` right after the toggle commits | `lib/feature-flags/audit.integration.test.ts` |
| AC-4 | uncached `isFeatureEnabled()`, and the X-list gate sites | `lib/feature-flags/kill-switch.integration.test.ts` |
| AC-5 | `lib/feature-flags/registry.ts`, migration 0036's seed | `lib/feature-flags/registry.test.ts`, `lib/feature-flags/migration.integration.test.ts` |
| AC-6 | `currentFlagEnvironment()` and the `(flag, environment)` rows | `lib/feature-flags/environment.test.ts`, `lib/feature-flags/environment-isolation.integration.test.ts` |

---

## 3. Architecture and API contract

### 3.1 Repository reality

This is a single Next.js application. There is no `apps/*` or `packages/*`.

- **Code:** `lib/feature-flags/**`, `lib/types/feature-flags.ts`
- **Routes:** `app/api/v1/admin/feature-flags/route.ts`, `app/api/v1/admin/feature-flags/[key]/route.ts`,
  `app/api/v1/feature-flags/effective/route.ts`
- **Page:** `app/admin/settings/feature-flags/page.tsx`
- **Migration:** `drizzle/0036_implement_feature_flags.sql` and its `_down.sql`
- **Tests:** colocated `*.test.ts(x)` / `*.integration.test.ts`, run by Vitest (`npm test`) on the
  isolated `*_test` database

There is no third-party flag service. The draft's open question is closed: the implementation is a
small custom one, with no vendor dependency.

### 3.2 Environment model (AC-6)

The application only knows `NODE_ENV` (`development` | `test` | `production`), which cannot tell
staging from production. Architecture §16 requires strict dev/staging/production separation, and
spec 001 gives each environment its own `DATABASE_URL`.

- **New variable `APP_ENV`:** one of `development`, `staging`, `production`. It is read only by
  `lib/feature-flags/environment.ts` `currentFlagEnvironment()`.
  - When unset: `production` if `NODE_ENV=production`, else `development`. A staging deployment
    **must** set `APP_ENV=staging`.
  - Any other value is a configuration error. `FeatureFlagEnvironmentError` is thrown, following
    the repository's "no silent fallback" adapter idiom (spec 021 `PAYMENT_PROVIDER`).
- **Storage.** Values are keyed by `(feature_flag_id, environment)`. Every database holds one row
  per flag per environment, but a deployment **reads and writes only its own environment's row**.
  - Each environment normally has its own database, so a staging toggle cannot reach production.
  - The environment key also keeps a database copied between environments (a production snapshot
    restored into staging) isolated. The copy reads its own environment's rows, never the other's.
- **Writes** target only the running environment. The `PATCH` body must name it, and a mismatch is
  refused `409` (§3.8). The page shows the environment on every toggle and confirms production
  changes (§5).

### 3.3 The flag registry (AC-5), authoritative

`lib/feature-flags/registry.ts` exports `FEATURE_FLAG_REGISTRY`, a closed, typed list. It is the
source of truth for keys, classification and defaults. Migration 0036 seeds exactly these rows, and
`registry.test.ts` asserts the two agree.

| Key | Owning spec | Purpose (as documented) | Default (dev / staging / prod) | Source of default | Controlled by | Kill switch | Client-readable | Env override var |
|---|---|---|---|---|---|---|---|---|
| `onboarding-intro-v1` | 007 | Disable the first-run intro without a redeploy if it underperforms | on / on / on | spec 007 §9 "(default on)" | business | no | **yes** | — |
| `search-nl-interpretation` | 013 | Fall back to keyword-only search if AI interpretation misbehaves | on / on / on | spec 013 §9 "(default on)"; `.env.example` | business | no | no | `SEARCH_NL_INTERPRETATION_ENABLED` |
| `home-personalization-v1` | 014 | Fall back to a static curated home feed if personalization misbehaves | on / on / on | spec 014 §9 "(default on)"; `.env.example` | business | no | no | `HOME_PERSONALIZATION_ENABLED` |
| `ai-conversational-assistant` | 034 | Ask Apuriva on/off, independent of the platform AI switch | on / on / on | spec 034 §9 "default on" | business | no | no | `AI_CONVERSATIONAL_ASSISTANT_ENABLED` |
| `ai-assistant` | 033 | Platform-wide AI kill switch: off makes every `completeAi()` throw `AiUnavailableError` | on / on / on | spec 033 §9 "default on" | developer | **yes** (spec 033 §9, master §119) | no | `AI_ASSISTANT_ENABLED` |
| `ai-fraud-signals` | 038 | Gates only the `ai_assisted` fraud-signal source | off / off / off | spec 038 §3.6/§9 "default off" | developer | no | no | `AI_FRAUD_SIGNALS_ENABLED` |

**Classification** follows master §71: "AI suggestions" and "marketplace features" are
business-configurable; "safety-critical technical controls" are developer-controlled. The platform
AI kill switch and the AI fraud-signal source are therefore developer flags (D-4).

**Deliberately not registered** (each named by the draft or an AC-5 spec):

| Name | Why |
|---|---|
| `matching-fairness-exposure` | Removed by approved spec 017 (§8 risk #7, §9). Exposure is `EXPLORATION_SHARE` configuration, and `0` disables it. |
| `marketing-notifications` | Removed by approved spec 026 (§9). Marketing is gated by consent, which is stronger. |
| Per-tool MCP flags | Spec 036 §7/§9 defers them, but names no key and no default. Nothing can be registered without inventing both. |
| Specs 016 and 014 (nav) | Spec 016 §9: "Feature flag: none". Spec 014's only flag is `home-personalization-v1`. |
| `urdu-locale`, `demo-mode` | Owned by Draft specs 042 and 045. They register their own row (a registry entry plus a migration seed) when implemented. |
| `ANALYTICS_INGESTION_ENABLED` | Spec 040 §9: "Feature flag: none". An operational pause switch, left as it is. |

Adding a flag later means one registry entry plus a new migration that seeds its three rows, under
the owning spec.

### 3.4 Reading a flag: resolution order (AC-1, AC-4, AC-6)

`lib/feature-flags/resolve.ts` exports `isFeatureEnabled(key: FeatureFlagKey, db?: Executor): Promise<boolean>`.
The registry types the key as a union, so an unregistered key does not compile.

1. **Env override.** If the flag has an override var (§3.3) and it is set to **exactly** `'true'`
   or `'false'`, that value wins. Any other value, including empty or unset, means no override.
   - This keeps developer and deploy-level control (master §71).
   - It keeps every existing test that sets these variables working unchanged (D-3).
2. **Stored value.** Otherwise, `enabled` of the `feature_flag_environment_values` row for
   `(key, currentFlagEnvironment())`.
3. **Registry default.** If that row is missing, the §3.3 default for the environment, and one
   `feature_flags.value_missing` warning line is logged.

A failed database read **throws**; it is never silently replaced by the default. A switched-off
kill switch must not come back on because a read failed.

`resolveClientFlags(): Promise<Record<ClientFlagKey, boolean>>` resolves every `clientReadable`
flag in one query, for §3.6.

**The existing stand-in functions are not changed.** Their names, sync signatures and env semantics
stay, and their callers' tests keep calling them. What changes is **the gate sites** (X-1…X-6).
They call `await isFeatureEnabled(key)`, so the DB value, and so an admin toggle, now governs them.

### 3.5 RBAC (master §69, §70, §71; seeded by `0036`)

Only the seven existing roles are used. No "developer" role is created; spec 037 D-1/D-2 confirm
there is none. Master §69 makes Super Admin "highest platform control", so Super Admin holds the
developer-controlled technical flags (D-1).

| resource | action | tier | roles | Grants |
|---|---|---|---|---|
| `feature_flags` | `read` | low | content_admin, operations_admin, super_admin | list business flags |
| `feature_flags` | `toggle` | medium | content_admin, operations_admin, super_admin | change a business flag |
| `feature_flags` | `read_technical` | low | super_admin | list developer flags too |
| `feature_flags` | `toggle_technical` | medium | super_admin | change a developer flag |

- **Tier `medium`, not `high`.** Master §70's second-admin approval "where appropriate" would queue
  a kill switch behind a second person. AC-4 requires the change to take effect immediately. Each
  change is still single-admin, reason-required and audited (D-5).
- Support, Finance, Trust & Safety and Analytics admins get no flag permission.
- Checks go through spec 009's `resolvePermission` on every call. Nothing is cached.

### 3.6 Endpoints

| # | Method and route | Auth | Success |
|---|---|---|---|
| F1 | `GET /api/v1/admin/feature-flags` | session; `feature_flags/read` | `200 ApiResponse<FeatureFlagDto[]>` |
| F2 | `PATCH /api/v1/admin/feature-flags/{key}` | session + CSRF; `feature_flags/toggle` (business) or `toggle_technical` (developer) | `200 ApiResponse<FeatureFlagDto>` |
| F3 | `GET /api/v1/feature-flags/effective` | none (guest or signed-in) | `200 ApiResponse<EffectiveFeatureFlagsDto>` |

**Shared conventions:** `withApiRoute`, the `default` rate-limit bucket, and a registration in
`lib/api/openapi-registry.ts` (F1–F3). Only F2 needs CSRF (`requireCsrf`), because it is the only
write.

**F1: list.**

- Registry order, unpaged. The registry is a closed list of a handful of rows, the same case as
  spec 036's `GET /admin/mcp/tools` (`apiSuccess` over its closed catalogue). This is also the
  draft's `ApiResponse<FeatureFlagDto[]>`.
- A caller holding only `feature_flags/read` sees business flags only. `read_technical` adds the
  developer flags.
- No `feature_flags/read` → `403 FORBIDDEN`. No session → `401 UNAUTHENTICATED`.

**F2: toggle.** Body `{ environment, enabled, expectedVersion, reason }`. Steps, in order:

1. Session, CSRF, rate limit.
2. Body validation → `400 VALIDATION_ERROR`:
   - `environment` must be a known environment;
   - `enabled` must be a boolean;
   - `expectedVersion` must be a positive integer;
   - `reason` must be 1–500 characters after trimming.
3. Unknown key → `404 FLAG_NOT_REGISTERED`.
4. Permission for the flag's class → `403 FORBIDDEN`. This is also the answer for a business admin
   toggling a developer flag (AC-2).
5. `environment` ≠ `currentFlagEnvironment()` → `409 FLAG_ENVIRONMENT_MISMATCH`.
6. In one transaction:
   - lock the `(flag, environment)` row `FOR UPDATE`;
   - stale `expectedVersion` → `409 CONFLICT` (spec 003 AC-6 idiom), with the current version;
   - `enabled` equal to the stored value → `200` with the current DTO, **no write and no audit** (idempotent);
   - otherwise update `enabled`, `updated_by_admin_id`, `updated_at` and `version + 1`.
7. After the commit, write the §3.9 audit row.
8. Return the fresh DTO. The response notes an active env override (`overriddenBy`). The admin's
   stored change is recorded but inert until the override is removed.

There is no `Idempotency-Key`: `expectedVersion` plus the no-op rule make retries safe, as spec
017's `PATCH …/matching-weights` does.

**F3: effective flags.**

- Returns `resolveClientFlags()` for the running environment: only flags with
  `client_readable = true`. Today that is `onboarding-intro-v1` only.
- A developer flag is never returned. The `feature_flags_client_readable_business_ck` CHECK makes
  it impossible (§4).
- The same response for guests and signed-in users. No personal data.
- Rate-limited by session user id, else `hashRequestIp()`, as `/search` does.
- `Cache-Control: no-store`, so no shared cache delays a change.
- **Consumer:** `OnboardingOverlay` (X-6). Server code never calls F3; it calls `isFeatureEnabled()`
  in-process.

### 3.7 Kill-switch semantics (AC-4)

- **No process-local cache.** Each `isFeatureEnabled()` call is one indexed primary-key-sized
  query on `feature_flag_environment_values ⋈ feature_flags`.
  - An in-process TTL cache would delay emergency disablement per instance.
  - Serverless instances cannot be invalidated together, so none is used.
- **Scope.** Committed values are visible to the next request on any instance. A request that read
  the flag before the commit finishes with its old value, which is the meaning of "new requests".
- **The two AI gates:**
  - With `ai-assistant` off, `completeAi()` throws `AiUnavailableError`, which every consumer already
    degrades on (spec 033).
  - With `ai-assistant` or `ai-conversational-assistant` off, `requireAskApurivaAvailable()` rejects
    with spec 034's `503 AI_PROVIDER_UNAVAILABLE`.
- **Firing a kill switch** logs one structured `feature_flags.kill_switch_changed` line with key,
  environment, before/after and correlation id. This lets alerting page on it (master §117); the
  paging rule itself belongs to spec 046.

### 3.8 Error codes

| HTTP | `code` | When |
|---|---|---|
| `400` | `VALIDATION_ERROR` | malformed F2 body |
| `401` | `UNAUTHENTICATED` | F1/F2 without a session |
| `403` | `FORBIDDEN` | missing the §3.5 permission, including a business admin toggling a developer flag |
| `404` | `FLAG_NOT_REGISTERED` | F2 on a key not in the registry |
| `409` | `FLAG_ENVIRONMENT_MISMATCH` | F2 `environment` ≠ the running environment |
| `409` | `CONFLICT` | stale `expectedVersion` |
| `429` | `RATE_LIMITED` | bucket exhausted |

### 3.9 Audit (AC-3): spec 039, through spec 009's one write path

Every applied change calls `recordAdminAuditEvent()` (`lib/admin-rbac/audit.ts` → spec 039's
`writeAuditEntry()`) **right after the toggle commits**. This follows the spec 017 matching-weights
and spec 023 cancellation-policy precedent.

- `writeAuditEntry()` always writes through its own `getDb()`, so no caller can put the audit row
  inside its own transaction. Spec 041 does not change spec 039's API to make that possible.
- A failed audit write is **not swallowed** (spec 039 D-8). It emits spec 039's critical
  structured line and is rethrown, so the request fails `500`.
- The committed flag change then stands without its audit row. That gap is visible through the
  critical line and the error response, which is the same guarantee every other audited admin
  write in this repository has.

| Field | Value |
|---|---|
| `actorUserId` / `actorRoles` | the admin; `getAdminRoleNames()` |
| `eventType` | `feature_flag.toggled` |
| `resource` | `feature_flags` (business flag) or `feature_flags.technical` (developer flag) |
| `action` | `toggle` or `toggle_technical` |
| `targetType` / `targetId` | `feature_flag` / the flag key |
| `before` / `after` | `{ "environment": "<env>", "enabled": <bool> }` |
| `reason` | the request's `reason` |
| `approvalChain` | `[]`: a medium-tier action needs no approval (spec 009 §3.1.4) |
| `correlationId` | from the request context (spec 039 X-1) |

Read scope (X-7):

- `feature_flags` entries are visible to holders of `feature_flags/read`.
- `feature_flags.technical` entries are visible to holders of `feature_flags/read_technical`, i.e.
  Super Admin only. A technical change is never disclosed to a business admin through the audit
  log either (AC-2).

### 3.10 Types: `lib/types/feature-flags.ts`

```typescript
export const FLAG_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type FlagEnvironment = (typeof FLAG_ENVIRONMENTS)[number];
export type FlagControl = 'business' | 'developer';

export interface FeatureFlagDto {
  key: string;
  description: string;
  controlledBy: FlagControl;
  isKillSwitch: boolean;
  clientReadable: boolean;
  removalCriteria: string | null;
  /** The running deployment's environment; the only one this deployment reads or writes. */
  environment: FlagEnvironment;
  /** The stored value for `environment`. */
  enabled: boolean;
  /** What `isFeatureEnabled()` returns now (after any env override). */
  effective: boolean;
  /** The env var pinning `effective`, or null. */
  overriddenBy: string | null;
  /** Optimistic-concurrency version of the (flag, environment) row. */
  version: number;
  updatedAt: string;
}

export interface UpdateFeatureFlagRequest {
  environment: FlagEnvironment;
  enabled: boolean;
  expectedVersion: number;
  reason: string;
}

/** F3: client-readable flags only. */
export interface EffectiveFeatureFlagsDto {
  flags: Record<string, boolean>;
}
```

### Breaking-change check

- [x] No existing route or DTO changes shape.
- The stand-in functions keep their signatures.
- `isAskApurivaAvailable` / `requireAskApurivaAvailable` become `async` (X-4). Their only callers are
  the five `lib/ai-assistant` modules updated in the same change, and no test calls them directly.

---

## 4. Data model changes

### `feature_flags`: spec 003 stub, **altered** by `0036` (never recreated)

`baseColumns()` (`id`, `created_at`, `updated_at`, `version`) are kept, as spec 003's schema-lint
requires. The table has never been written, so the NOT NULL columns are added to an empty table,
and unexpected rows make the migration fail loudly.

| Added column | Type | Notes |
|---|---|---|
| `key` | `text not null` | UNIQUE; CHECK `key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'` and length ≤ 64 |
| `description` | `text not null` | CHECK length 1–500 |
| `controlled_by` | `text not null` | CHECK in `('business','developer')` |
| `is_kill_switch` | `boolean not null default false` | |
| `client_readable` | `boolean not null default false` | CHECK `feature_flags_client_readable_business_ck`: `NOT client_readable OR controlled_by = 'business'` (AC-2) |
| `removal_criteria` | `text null` | |

### `feature_flag_environment_values`: **new**

| Column | Type | Notes |
|---|---|---|
| `baseColumns()` | | `id`, `created_at`, `updated_at`, `version` (the F2 optimistic-concurrency version) |
| `feature_flag_id` | `uuid not null` | FK → `feature_flags` ON DELETE RESTRICT |
| `environment` | `text not null` | CHECK in `('development','staging','production')` |
| `enabled` | `boolean not null` | |
| `updated_by_admin_id` | `uuid null` | FK → `admin_profiles` RESTRICT, indexed. `null` for the seed. The repository convention for an admin actor (e.g. `resolved_by_admin_id`). |

**Constraints and indexes:** UNIQUE `(feature_flag_id, environment)`, which also serves the read
path; index `updated_by_admin_id`. There is no jsonb and no money column, so nothing is added to
spec 003's jsonb allow-list.

### Migration

- **Files:** `drizzle/0036_implement_feature_flags.sql`, a hand-written
  `drizzle/0036_implement_feature_flags_down.sql`, and journal index 36. The schema declaration goes
  in `lib/db/schema.ts`.
- **Up:**
  1. `ALTER TABLE feature_flags ADD COLUMN …` with the CHECKs and the unique key.
  2. `CREATE TABLE feature_flag_environment_values`, with its FKs, CHECK, unique key and index.
  3. Seed the six §3.3 flags with `INSERT … ON CONFLICT ("key") DO NOTHING`.
  4. Seed their 18 environment values with
     `INSERT … SELECT … ON CONFLICT (feature_flag_id, environment) DO NOTHING`, so a re-run never
     overwrites an admin's change.
  5. Seed the four §3.5 permission rows with the `0033`–`0035`
     `INSERT … SELECT … FROM (VALUES …) … ON CONFLICT DO NOTHING` idiom.
- **Down:** delete the four permission rows, drop `feature_flag_environment_values`, and drop the
  added constraints and columns, returning `feature_flags` to the spec 003 stub. It is reversible
  and discards stored flag values; the registry defaults then apply again on re-up.
- **Backfill:** none beyond the seed. **Downtime:** none. Every added column is defaulted, or its
  table is empty.

### Retention and privacy

- There is no personal data. `updated_by_admin_id` is an admin profile reference.
- Change history lives in `audit_logs` and is retained under spec 039's policy.
- Flags are not part of any user data export.

---

## 5. UI states

**Route:** `app/admin/settings/feature-flags/page.tsx`, linked from the Settings index
`app/admin/settings/page.tsx` (X-8). It uses the dense admin layout (`data-density="dense"`,
`app/admin/admin.module.css`), like `app/admin/settings/ai-usage`.

**Components:**

- From `@/components`: `Table`, `Switch` (the design system's toggle; there is no `Toggle`),
  `ConfirmDialog`, `Badge`, `Alert`, `Input`, `Button`, `Card`, `Skeleton`, `ErrorState`.
- No new primitive. Colors, spacing and type come from `app/styles/apuriva-tokens.css` tokens only.

**Behaviour:**

- The running environment is shown once at the top, and on the confirmation.
- Each row shows the key, description, a *Kill switch* badge where it applies, and the `Switch`.
- When a flag is pinned by an env var, an "Overridden by `<VAR>`" note appears and the `Switch` is
  disabled.
- Developer flags appear only for Super Admin, badged "Technical".
- Toggling happens in two steps (resolved during implementation, D-9):
  1. An inline panel (`Card`) opens under the table, with the required reason `Input`, a
     production warning `Alert`, and *Review change* / *Cancel* `Button`s.
  2. *Review change* opens `ConfirmDialog` with a text-only description (environment, change,
     reason). It uses `tone="danger"` in **production** and `tone="primary"` elsewhere.
  - Spec 008's `ConfirmDialog` renders `description` inside a `<p>`, and the design system's
    `Input`/`Alert` render `<div>`s. Placing them in the dialog would be invalid HTML, so they live
    in the panel. No other spec's component is changed.
- The request carries `environment` and `expectedVersion`.

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` rows |
| **Empty** | not reachable for an authorized caller (the registry is seeded); a caller seeing no rows still gets a sentence, not a blank table |
| **Error** | list: `ErrorState` with retry. Toggle failure: the `Switch` returns to its prior state and an `Alert` says why (403 no access, 409 changed by someone else → refetch, 409 environment mismatch) |
| **Forbidden** | a `403` list shows "You don't have access to feature flags" |
| **Success** | the row updates from the response DTO. There is no optimistic toggle: the UI changes only after the server confirms |

---

## 6. Test plan

Integration tests run on the isolated `*_test` database (`vitest.config.ts`, `test/db-reset.ts`).
Flag state is global, so tests that change a stored value:

- run inside spec 037's `withSnapshot` (a rolled-back transaction) wherever the code path accepts an
  `Executor`; or
- restore the row in `afterEach`, and use a flag no parallel file toggles.

Tests unset the flag's env override var first, because the developer's `.env` may set it.

| Level | What it covers | Where |
|---|---|---|
| **Unit** | registry shape, closed keys, defaults and classification; client-readable ⇒ business; exact match with §3.3 | `lib/feature-flags/registry.test.ts` |
| **Unit** | `APP_ENV` parsing, the `NODE_ENV` fallback, a bad value throws | `lib/feature-flags/environment.test.ts` |
| **Unit** | resolution order: override `'true'`/`'false'` wins, other values ignored; missing row → default and a warning; a DB error throws | `lib/feature-flags/resolve.test.ts` |
| **Integration** | AC-1: toggle → the next read changes, with no restart; no-op writes nothing; stale version `409` | `lib/feature-flags/toggle.integration.test.ts` |
| **Integration** | AC-3: exactly one audit row with the §3.9 fields after the commit; none on refusal, no-op or validation failure; an audit-write failure surfaces as `500` and is not swallowed | `lib/feature-flags/audit.integration.test.ts` |
| **Integration** | AC-4: `ai-assistant` off → `completeAi()` throws `AiUnavailableError` on the next call; conversational off → `503`; back on → works | `lib/feature-flags/kill-switch.integration.test.ts` |
| **Integration** | AC-6: different stored values per environment; each environment reads only its own; a toggle touches one row; `FLAG_ENVIRONMENT_MISMATCH` | `lib/feature-flags/environment-isolation.integration.test.ts` |
| **Integration** | 0036 up/down files, columns, CHECKs, unique keys, 6 flags × 3 environments seeded, permissions, idempotent re-seed | `lib/feature-flags/migration.integration.test.ts` |
| **Security** | every role × F1/F2 × business/developer flag; `401`/`403`; the technical flag absent from business lists; the audit-scope visibility of both resources | `app/api/v1/admin/feature-flags/access.integration.test.ts` |
| **Routes** | envelopes, validation `400`, `404 FLAG_NOT_REGISTERED`, CSRF, `429`, OpenAPI registration; F3 guest and signed-in, client-readable only, `no-store` | `app/api/v1/admin/feature-flags/routes.integration.test.ts`, `app/api/v1/feature-flags/effective/route.integration.test.ts` |
| **Integration** | the gate sites X-1…X-6 honour the stored value | `lib/feature-flags/gates.integration.test.ts` |
| **Boundary** | only `lib/feature-flags` writes the flag tables; no in-process cache (no module-level Map/TTL); every gate site calls `isFeatureEnabled`; F3 cannot return a developer flag | `lib/feature-flags/boundary.test.ts` |
| **Page** | loading, error-retry, forbidden, success; technical rows only for Super Admin; inline reason panel then confirm dialog; production warning; override note; revert on failure | `app/admin/settings/feature-flags/page.test.tsx` |
| **Component** | the overlay hidden when F3 says off; shown on default and on fetch failure | `app/_components/OnboardingOverlay.flag.test.tsx` (new; spec 007's own test is not edited) |

**Traceability:** AC-1 toggle; AC-2 access; AC-3 audit; AC-4 kill-switch; AC-5 registry and
migration; AC-6 environment and environment-isolation (see §2.1).

**E2E:** there is no `apps/web-e2e`. The draft's browser scenario is covered by the page test plus
the gates and toggle integration tests.

**Coverage:** ≥80% statements, branches, functions and lines on `lib/feature-flags/**`:

`npx vitest run lib/feature-flags app/api/v1/admin/feature-flags app/api/v1/feature-flags app/admin/settings/feature-flags --coverage.enabled --coverage.provider=v8 --coverage.include=lib/feature-flags/**`

**Other specs' tests (must stay green, unedited except X-7):** 013's
`app/api/v1/search/interpret.integration.test.ts`; 033's `lib/ai/config.test.ts`; 034's AI route
tests; 038's `lib/moderation/rules.test.ts` and `ai-safeguard.integration.test.ts`; 007's
`OnboardingOverlay.test.tsx`. The env-override precedence (§3.4) is what keeps them green.

**Deliberately not covered:** percentage rollout (§7).

---

## 7. Out of scope

- Percentage-based or gradual rollout, and A/B testing. MVP is on/off per environment.
- **Numeric or structured platform configuration.** This covers the cancellation-policy editor UI,
  which specs 023 §3 and 037 DEP-4 assign to "041", and the env-var settings of specs 025, 029, 031
  and 032 that "may migrate to 041". This spec stores per-environment booleans only (D-6), and
  those surfaces stay unowned for a follow-up (§8).
- Per-tool MCP flags (no key or default is defined).
- Registering Draft specs' flags (`urdu-locale`, `demo-mode`).
- A cross-environment control plane: one admin UI editing every environment's database.
- Alert or paging rules (spec 046).

---

## 8. Dependencies, decisions, risks

### Authorized cross-spec changes (X-list)

| # | Owning spec | File | Exact change |
|---|---|---|---|
| X-1 | 033 | `lib/ai/complete.ts` | The gate becomes `if (!(await isFeatureEnabled('ai-assistant'))) throw new AiUnavailableError(…)`. `lib/ai/feature-flags.ts` is unchanged. |
| X-2 | 013 | `app/api/v1/search/interpret/route.ts` | The gate becomes `await isFeatureEnabled('search-nl-interpretation')`. |
| X-3 | 014 | `lib/home/feed.ts` | The gate becomes `await isFeatureEnabled('home-personalization-v1')`. |
| X-4 | 034 | `lib/ai-assistant/feature-flags.ts`, plus the `await` at its call sites in `actions.ts`, `conversations.ts`, `memory.ts`, `turns.ts` and `suggestions.ts` | `isAskApurivaAvailable()` / `requireAskApurivaAvailable()` become async and resolve both `ai-conversational-assistant` and `ai-assistant` through `isFeatureEnabled`. `isConversationalAssistantEnabled()` is unchanged. |
| X-5 | 038 | `lib/moderation/fraud-signals.ts` | The gate becomes `await isFeatureEnabled('ai-fraud-signals')`. `lib/moderation/flags.ts` is unchanged. |
| X-6 | 007 | `app/_components/OnboardingOverlay.tsx` | Show the intro only if F3 does not return `onboarding-intro-v1: false`. A fetch or parse failure uses the registry default (on). |
| X-7 | 039 | `lib/audit/scope.ts` and `lib/audit/scope.test.ts` (**approved**) | Map `feature_flags` → `feature_flags/read` and `feature_flags.technical` → `feature_flags/read_technical`, and add both keys to the test's exact-table list. Nothing else changes. |
| X-8 | 014 | `app/admin/settings/page.tsx` | Add the `{ href: '/admin/settings/feature-flags', label: 'Feature flags' }` link. |
| X-9 | 013/014/033/034/038 | `.env.example` | Add `APP_ENV`. Change the five override vars to empty values, with a comment that setting `'true'`/`'false'` pins the flag and overrides the admin toggle. |

`lib/support/ai-assist.ts` (spec 032) is **not** changed. Its early `isAiAssistantEnabled()` check
still honours the env override, and with the stored flag off, the `completeAi()` it then calls throws
the degradable `AiUnavailableError`. It already returns `null` on that path.

**Shared registries:** `lib/db/schema.ts`, `drizzle/meta/_journal.json`,
`lib/api/openapi-registry.ts`, `.env.example`.

### Decisions

| # | Decision |
|---|---|
| D-1 | Developer flags are toggled by **Super Admin** through F2 (DB-backed). No developer role is created. This supersedes, for flags, spec 037 §3 "Developer-controlled boundary", which describes such kill switches as env vars changed by deployment. Spec 037 is not edited; its Dashboard DTOs are unaffected. |
| D-2 | Environment = `APP_ENV`; values are keyed per environment; a deployment reads and writes only its own (§3.2). |
| D-3 | The existing env vars are kept as a **deploy-level override** that wins over the stored value. The stand-in functions keep their contracts; only the gate sites change. |
| D-4 | Classification per master §71 (§3.3): four business flags, two developer flags. |
| D-5 | All toggles are tier `medium`, reason required, single admin, audited. There is no four-eyes step, because AC-4 requires immediacy. |
| D-6 | The scope is boolean flags only; numeric and policy configuration is out of scope (§7). |
| D-7 | There is no process-local cache; every read is one query (§3.7). |
| D-8 | The registry is exactly §3.3. The draft's `matching-fairness-exposure` and `marketing-notifications` are not registered, because their owning specs removed them. |
| D-9 | The toggle confirmation is an inline reason panel followed by a text-only `ConfirmDialog` (§5), because spec 008's `ConfirmDialog` wraps `description` in a `<p>`. |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | A deployment leaves an override var set, so admin toggles look inert | The DTO's `overriddenBy`, the UI note, and the X-9 `.env.example` guidance |
| R-2 | A staging deployment forgets `APP_ENV=staging` and reads its `production` rows | These are its own database's rows, so real production is unaffected. Documented in `.env.example`. |
| R-3 | One extra query per gated call | A unique-index lookup on a table of about 18 rows |
| R-4 | The Draft specs' flags (042, 045) arrive later | They add one registry entry plus one seed migration each |

### Pre-existing conditions (not caused by this spec)

- Spec 003's `lib/db/schema-coverage.test.ts` and `lib/db/migrations.integration.test.ts` pin table
  lists or counts that are already stale on this branch. The new table widens that gap. They are
  reported, not edited.
- Approved specs 023 §3 and 037 DEP-4 still name spec 041 as the owner of the cancellation-policy
  UI. That ownership is now unassigned (D-6), and is reported for a follow-up spec.

---

## 9. Rollout

- **Feature flag:** not applicable; this spec is the flag system.
- **Order:** `0036` ships with the code. Set `APP_ENV` on every non-development deployment, and
  `staging` on staging. Remove any `…_ENABLED` override var from deployments that should be
  admin-controlled.
- **Rollback:** revert the deploy. The gates then read env vars again, as before. `0036_…_down.sql`
  is optional and discards stored values.
- **Observability:** the structured lines `feature_flags.toggled` (every change),
  `feature_flags.kill_switch_changed` (alert-worthy, master §117) and `feature_flags.value_missing`.
