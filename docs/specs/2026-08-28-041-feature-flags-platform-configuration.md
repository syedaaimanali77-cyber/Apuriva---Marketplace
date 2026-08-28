# Spec: Feature Flags & Platform Configuration

**File:** `docs/specs/2026-08-28-041-feature-flags-platform-configuration.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §71, §119, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §16, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Multiple prior specs (007, 013, 026, 033, 034, 036, 038) reference feature flags as
if a flag system already exists ("`onboarding-intro-v1`", "`search-nl-interpretation`",
"`marketing-notifications`", "`ai-assistant`", "`ai-fraud-signals`", per-tool MCP flags), but no
flag infrastructure has been built. Master spec §119 requires flags for new features, gradual
rollout, environment-specific activation, and emergency kill switches, with business admins
controlling approved business-level flags and developers controlling security/technical flags —
every flag change audited.

**Who is affected:** Every spec that referenced a flag by name; Business/Content admins toggling
approved business features; developers needing an emergency kill switch.

**Why it matters now:** Sequenced last among admin specs because it's the mechanism that makes
every earlier spec's named flag actually real and toggleable — building it earlier would mean
guessing at the full set of flags before they were named by their owning specs.

**Success looks like:** A real, environment-aware feature-flag system exists; every flag named
by a prior spec (`onboarding-intro-v1`, `search-nl-interpretation`, `marketing-notifications`,
`ai-assistant`, `ai-conversational-assistant`, `ai-fraud-signals`, `home-personalization-v1`,
`matching-fairness-exposure`) is registered and toggleable; business-vs-developer flag
boundaries are enforced; every change is audited.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a flag classified as business-level **When** a Content/Marketplace or Operations admin toggles it **Then** the change takes effect without a code deploy, scoped to the target environment |
| AC-2 | **Given** a flag classified as security/technical **When** a non-developer admin attempts to toggle it **Then** they cannot — it is not exposed in the business-admin surface at all |
| AC-3 | **Given** any flag change **When** applied **Then** it is recorded to the audit log (spec 039) with actor, before/after value, and environment |
| AC-4 | **Given** an emergency kill-switch flag **When** toggled off **Then** the corresponding feature stops taking effect immediately for new requests, without requiring a deploy or restart |
| AC-5 | **Given** every flag referenced by name in specs 007, 013, 026, 033, 034, 036, 038, 016, 014 **When** the registry is inspected **Then** each exists as a registered flag with its documented default |
| AC-6 | **Given** a flag scoped to a specific environment (dev/staging/production) **When** read **Then** its value is correctly environment-isolated — a staging toggle never affects production |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/admin/feature-flags` | admin (scoped: business flags visible to Content/Marketplace/Operations; technical flags only to Super Admin/developer role) | `200` `ApiResponse<FeatureFlagDto[]>` | |
| `PATCH` | `/api/v1/admin/feature-flags/{key}` | admin (scoped per flag's `controlledBy`) | `200` | environment-specific |
| `GET` | `/api/v1/feature-flags/effective` | any authenticated/guest (internal use by frontend/backend) | `200` `ApiResponse<Record<string, boolean>>` | only publicly-relevant flags, not internal-only ones |

### Request and response types

```typescript
// packages/types/src/feature-flags.ts
export interface FeatureFlagDto {
  key: string; // e.g. "onboarding-intro-v1"
  description: string;
  controlledBy: 'business' | 'developer';
  environments: Record<'development' | 'staging' | 'production', boolean>;
  isKillSwitch: boolean;
  removalCriteria?: string;
}
```

### Error codes

| HTTP | `code` | When |
|---|---|---|
| `403` | `FORBIDDEN` | business admin attempts to toggle a developer-controlled flag |
| `404` | `FLAG_NOT_REGISTERED` | attempt to read/write an unregistered flag key |

### Breaking-change check

- [x] N/A — new spec

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `FeatureFlag` | fully implement (stubbed spec 003) | `id uuid pk`, `key text unique`, `description text`, `controlled_by text`, `is_kill_switch boolean`, `removal_criteria text nullable`, `created_at`, `updated_at` |
| (new) `FeatureFlagEnvironmentValue` | new | `id uuid pk`, `feature_flag_id uuid fk->FeatureFlag`, `environment text`, `enabled boolean`, `updated_at`, `updated_by_admin_id uuid nullable` |

Every flag key referenced by name in a prior spec is seeded as a registry row during this
spec's implementation (a data migration, not a schema migration).

### Migration

- **Name:** `ImplementFeatureFlagTables`
- **Reversible:** yes
- **Backfill required:** yes — seed all previously-referenced flag keys with their documented
  defaults
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

No personal data; flag-change history is itself an audit-relevant record (AC-3), retained per
audit policy.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | flag list skeleton |
| **Empty** | N/A (registry always has the seeded flags) |
| **Error** | toggle failure reverts the UI state and shows why (e.g. permission denied) |
| **Success** | toggle confirms immediately per environment, with a visible "production" warning state before confirming a production change |

**Route(s):** `apps/web/app/admin/settings/feature-flags`
**Shared components used/added:** `packages/ui` `Table`, `Toggle`, `ConfirmDialog`
(production-change confirmation)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | environment-isolation logic, business/developer scope enforcement | `apps/api/feature-flags/**/*.test.ts` |
| **Integration** | toggle takes effect without deploy; business admin blocked from developer flags; all previously-referenced flags present in registry | `apps/api/feature-flags/*.integration.test.ts` |
| **E2E** | admin toggles a business flag and observes the effect live (e.g. disables `home-personalization-v1`, sees static feed) | `apps/web-e2e/feature-flags.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/api/feature-flags/toggle.integration.test.ts::business flag, no deploy needed` |
| AC-2 | `apps/api/feature-flags/scope.integration.test.ts::technical flag hidden from business admin` |
| AC-4 | `apps/api/feature-flags/kill-switch.integration.test.ts::immediate effect` |
| AC-5 | `apps/api/feature-flags/registry.test.ts::all referenced flags present` |
| AC-6 | `apps/api/feature-flags/environment-isolation.test.ts::staging change does not affect production` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Gradual/percentage-based rollout mechanics (a possible Phase 2
enhancement; MVP is on/off per environment, per master spec §119's baseline requirement).

---

## 7. Out of scope

- Percentage-based/gradual rollout (binary on/off per environment is the MVP bar).
- A/B testing infrastructure — not requested by master spec.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Whether to build a custom flag system or adopt a third-party flag service | — | Open — recommend a simple custom implementation for MVP given the modest flag count, avoiding an extra vendor dependency |

---

## 9. Rollout

- **Feature flag:** N/A — this spec *is* the flag system.
- **Migration order:** schema + seed data (all previously-referenced flag keys) ships with code.
- **Rollback:** revert deploy; flag values persist independent of app-code version.
- **Observability:** flag-change frequency and kill-switch activation events are themselves
  alert-worthy (a kill switch firing in production should page someone, master spec §117).
