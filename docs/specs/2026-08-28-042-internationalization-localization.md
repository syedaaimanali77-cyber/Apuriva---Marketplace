# Spec: Internationalization & Localization

**File:** `docs/specs/2026-08-28-042-internationalization-localization.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §5, §120, §132.19, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §18, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Every prior spec assumes English UI and, where relevant, RTL/Urdu support in passing
(e.g. spec 002's design tokens, spec 005's phone formatting), but no actual i18n
infrastructure, translation pipeline, or locale-switching mechanism exists yet. Master spec §5
requires English default, full Urdu UI option, Roman Urdu as natural input (not a formal
locale), and proper RTL support. §120 requires no hard-coded Pakistan-specific assumptions in
core architecture.

**Who is affected:** Every Urdu-speaking user; every screen built in prior specs, which must now
actually support locale switching rather than just "leave room for it."

**Why it matters now:** Sequenced as cross-cutting hardening because it audits/completes i18n
across everything already built (010–041), rather than being buildable in isolation before
those screens exist.

**Success looks like:** A user can switch the UI to Urdu and get a fully translated, correctly
RTL-mirrored experience; Roman Urdu input works naturally in search/chat/AI without requiring a
locale switch; no currency/country/address/phone/tax/timezone assumption is hard-coded anywhere
in business logic.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a user switches to Urdu **When** any screen renders **Then** all UI text is translated and the layout mirrors correctly for RTL (nav, forms, icons with directional meaning) |
| AC-2 | **Given** Roman Urdu text typed in search or AI chat **When** processed **Then** it's understood naturally without requiring the user to switch locale first (ties to spec 013 AC-1, spec 034) |
| AC-3 | **Given** any money display **When** rendered **Then** formatting is locale-aware but the underlying `currency_code` is never hard-coded to PKR in business logic (ties to spec 003's money convention) |
| AC-4 | **Given** any address/phone input **When** validated **Then** the validation logic is configurable per country, not hard-coded to Pakistani formats (ties to spec 005, 012) |
| AC-5 | **Given** a new locale added in the future **When** translations are provided **Then** no core business-logic code requires changes — only translation resources and locale config |
| AC-6 | **Given** a screen with a missing translation key **When** rendered **Then** it falls back gracefully (e.g. to English) rather than showing a raw translation key to the user |

---

## 3. API contract

### Endpoints

| Method | Route | Auth | Success | Notes |
|---|---|---|---|---|
| `GET` | `/api/v1/locales` | none | `200` `ApiResponse<LocaleDto[]>` | available locales |
| `PATCH` | `/api/v1/users/me/locale` | session | `200` | persists preference; guests use client-side/header-based detection |

### Request and response types

```typescript
// packages/types/src/i18n.ts
export interface LocaleDto {
  code: 'en' | 'ur';
  label: string;
  direction: 'ltr' | 'rtl';
}
```

Every other API response's user-facing strings (error messages, notification content) are
resolved server-side against the caller's locale (from `Accept-Language` or the user's saved
preference), not hard-coded English in the payload.

### Error codes

No new error codes — this spec constrains existing response localization behavior.

### Breaking-change check

- [x] N/A — new spec; but retroactively touches every prior spec's user-facing string handling

---

## 4. Data model changes

### Entities

| Entity | Change | Fields |
|---|---|---|
| `User` | extend | `locale text default 'en'` |

No new core entity — translation resources live in `packages/config`/`apps/web` as versioned
translation-resource files, not database rows (translatable *content*, like catalog service
names, may need a separate translation-table design if admin-editable per-locale content is
required — flagged as a risk below).

### Migration

- **Name:** `AddUserLocalePreference`
- **Reversible:** yes
- **Backfill required:** no (defaults to `en`)
- **Downtime:** none
- **Reviewed SQL:** generated, reviewed in PR

### Retention and privacy

Locale preference is low-sensitivity personal data, included in export/deletion per spec 008
as a matter of completeness.

---

## 5. UI states

| State | Behaviour |
|---|---|
| **Loading** | locale switch shows a brief transition, not a full page reload where avoidable |
| **Empty** | N/A |
| **Error** | missing translation falls back to English per AC-6, logged for translation-coverage tracking |
| **Success** | full RTL mirror on Urdu switch: nav order, icon direction, form field alignment, date formatting all correct |

Applies retroactively across every route built in specs 007–041 — this spec's acceptance
criteria include an audit pass over those screens, not just new UI.

**Route(s):** locale switcher in `apps/web/app/account/settings`, applied globally via
`apps/web/app/layout.tsx`
**Shared components used/added:** `packages/ui` RTL-aware layout primitives (extends spec 002's
`Text`/layout components)

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | locale-fallback logic, RTL direction resolution | `packages/config/i18n/**/*.test.ts` |
| **Integration** | API responses localize error/notification messages per caller locale | `apps/api/i18n/*.integration.test.ts` |
| **Component** | representative screens render correctly in RTL (visual/structural, not just string swap) | `apps/web` (Testing Library + RTL snapshot) |
| **E2E** | user switches to Urdu, completes a core flow (search → request) fully in RTL | `apps/web-e2e/i18n.spec.ts` |
| **Accessibility** | RTL screen-reader behavior tested | CI gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `apps/web-e2e/i18n.spec.ts::full RTL mirror on Urdu` |
| AC-2 | `apps/api/search/interpret.integration.test.ts::roman urdu without locale switch` (extends spec 013's test) |
| AC-4 | `packages/validation/address.test.ts::country-configurable, not PK hard-coded` |
| AC-6 | `packages/config/i18n/fallback.test.ts::missing key falls back gracefully` |

**Coverage:** ≥80% on new code; the retroactive audit across specs 007–041 is tracked as a
checklist in the implementing PR rather than a numeric coverage target.

**Not covered, deliberately:** Machine-translation quality — translations are treated as
curated resources, not AI-generated at render time (AI *may* assist drafting them offline, per
master spec §80.2's translation task, but that's a content-authoring workflow, not a runtime
dependency).

---

## 7. Out of scope

- Additional locales beyond English/Urdu (structurally supported per AC-5, not built for MVP).
- Admin-editable per-locale catalog content translation UI (flagged as risk #1 below — may need
  its own follow-up spec if required for MVP).

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Whether catalog content (service names, descriptions) needs admin-managed per-locale translations, or whether Urdu UI applies only to platform chrome/labels for MVP | Product | Open — significantly affects scope; must be resolved before implementation |
| 2 | Translation resource management workflow (in-repo JSON vs. a TMS) | — | Open |

---

## 9. Rollout

- **Feature flag:** `urdu-locale` (default on once translations are complete; can gate
  incomplete rollout).
- **Migration order:** schema ships with code.
- **Rollback:** revert deploy; falls back to English.
- **Observability:** locale-switch rate and missing-translation-key rate monitored (master spec
  §117) — a rising missing-key rate signals incomplete translation coverage.
