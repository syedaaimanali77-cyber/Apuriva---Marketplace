# Spec: Accessibility Standards

**File:** `docs/specs/2026-08-28-043-accessibility-standards.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §106, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §12, [docs/workflow.md](../workflow.md); specs 002 (design system: tokens, reduced motion, focus ring), 042 (Urdu/RTL), 046 (CI and the browser-test architecture). See §8.

---

## 1. Problem statement

**Today (verified against the repository):**

- Spec 002 established accessible primitives. Its component tests exist (`components/*.test.tsx`), a
  token-level contrast test exists (`components/tokens.test.ts`), and a site-wide
  `prefers-reduced-motion` backstop exists (`app/globals.css`, verified by
  `components/motion.test.ts`).
- Spec 042 established server-rendered `lang`/`dir`, the Urdu font stack, `DirectionalIcon` and the
  `urdu-locale` flag (off everywhere).
- Every screen spec includes its own accessibility notes in §5/§6.

**These are missing:**

- There is no CI of any kind (`.github/` does not exist) and no browser runner. Vitest with jsdom
  cannot compute rendered styles, so no test today checks contrast, target size, focus visibility or
  motion **as rendered**. Spec 002's "axe scan in CI" and spec 042's deferred browser/axe checks were
  never delivered; both name specs 043/046 as the owners.
- **Five design-token pairs render normal-size text below WCAG AA 4.5:1**, measured from the token
  values in `app/styles/apuriva-tokens.css`:

  | Pair | Ratio | Rendered as |
  |---|---|---|
  | `--action-primary-fg` on `--action-primary-bg` (white on `--teal-600`) | 3.86:1 | `Button` label, 13–16px semibold |
  | `--action-accent-fg` on `--action-accent-bg` (white on `--amber-600`) | 3.50:1 | `Button` label |
  | `--status-success-fg` on `--status-success-bg` | 3.94:1 | `Badge` text, 11–12px semibold |
  | `--status-warning-fg` on `--status-warning-bg` | 3.72:1 | `Badge` text |
  | `--status-error-fg` on `--status-error-bg` | 4.46:1 | `Badge` text |

  `components/tokens.test.ts` holds these pairs to the 3:1 "large text / UI component" tier. The text
  sizes involved are not large text under WCAG (≥ 24px, or ≥ 18.66px bold), so the rendered product
  fails AA text contrast wherever they appear.
- Touch targets: the token `--touch-target-min: 44px` exists but is barely applied. `Button` is 40px
  (`md`) and 32px (`sm`), and `Tag` is 30px.

Master §106 requires automated accessibility checks in CI, keyboard, screen-reader, contrast, focus,
touch-target, reduced-motion and RTL/Urdu testing, and manual review of critical journeys.

**Who is affected:** Every user relying on assistive technology; the whole product's legal/
ethical accessibility posture.

**Why it matters now:** Sequenced as cross-cutting hardening because it establishes the CI gate
and audit process that verifies every prior spec's accessibility acceptance criteria actually
hold together as a system, not just individually.

**Success looks like:** A browser-based accessibility gate runs on every PR and blocks new
violations against a committed, ratcheting baseline. The master §106 checklist is covered by an
automated or documented-manual check. Manual sign-off exists for the critical customer and provider
journeys.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** a PR whose changes select at least one audited route (§3.4) **When** CI runs **Then** the `a11y` browser job scans every selected route with axe-core (§3.3), and fails the build if any `(route, rule)` violation count exceeds the committed baseline (§3.5), or if any count has fallen below the baseline without the baseline being lowered in the same PR |
| AC-2 | **Given** the critical customer journey (guest → search → request → offer → booking → payment → completion → review) **When** manually reviewed with keyboard only and with a screen reader (§3.8) **Then** every step is operable and announced, recorded in the signed customer-journey sign-off document |
| AC-3 | **Given** the critical provider journey steps that have a route today (signup → availability → request → offer → booking → completion → earnings; §3.8) **When** manually reviewed the same way **Then** the same standard holds, recorded in the signed provider-journey sign-off document. The *profile* and *services* steps have no route yet; the document lists them as not built (§7). |
| AC-4 | **Given** any audited route **When** rendered in the browser **Then** every text/background pair meets WCAG 2.x AA (4.5:1 normal text, 3:1 large text) as computed in context by axe's `color-contrast` rule. **This is mandatory and has no exemption.** AC-4 passes only when `color-contrast` reports **zero** violations on every audited route. The baseline (§3.5) only prevents new regressions while the known failures are open; it never counts as passing (§3.6). |
| AC-5 | **Given** `prefers-reduced-motion: reduce` emulated in the browser **When** any audited route renders **Then** no element has a computed `animation-duration` or `transition-duration` above 0.01s (the spec 002 backstop's value), checked in situ (§3.7) |
| AC-6 | **Given** `urdu-locale` on and the resolved locale `ur` **When** the audited routes in spec 042's §5.1 scope render **Then** `<html lang="ur" dir="rtl">` is present, the page has no horizontal overflow at 375px width, and the axe, reduced-motion and focus checks pass against their own `@ur` baseline keys exactly as they do for `en` (§3.9) |
| AC-7 | **Given** any audited route at the mobile viewport **When** measured **Then** every pointer target satisfies the **WCAG 2.2 AA compliance gate, SC 2.5.8: ≥ 24×24 CSS px, subject to the SC's exceptions** (spacing, equivalent, inline, user-agent control, essential), evaluated by axe's `target-size` rule. This is the only touch-target failure gate. The existing 32px (`Button sm`) and 40px (`Button md`) components are judged against this 24px gate and pass it; being below 44px is **not** a failure. Separately, the APURIVA design-system **goal** of 44×44 CSS px (`--touch-target-min`) is measured for the journey routes' declared primary actions and **reported only** (§3.6). It is not an additional WCAG gate. |
| AC-8 | **Given** any audited route **When** traversed with the Tab key **Then** every element that receives focus shows a visible focus indicator (a computed non-`none` `outline` or `box-shadow`), and focus never lands on a hidden element (§3.7) |

---

## 3. Architecture and API contract

This is a testing/process/CI spec: **no API surface, no endpoint and no OpenAPI change.**

### 3.1 Repository reality

This is a single Next.js 16 application. There is no `apps/*` or `packages/*`.

| What | Path | Owner |
|---|---|---|
| Browser runner, config, browser test database, Vitest exclusion, CI browser job | `playwright.config.ts`, `browser/**`, `vitest.config.ts`, `.github/workflows/*` | **spec 046** (§8 DEP-1) |
| Accessibility browser tests | `browser/a11y/*.browser.ts` | 043 |
| Audited-route manifest | `browser/a11y/routes.ts` | 043 |
| Violation baseline | `browser/a11y/baseline.json` | 043 |
| Changed-route selector | `scripts/a11y-changed-routes.ts` | 043 |
| Baseline comparison (pure module, imported by `scan.browser.ts`) | `scripts/a11y-baseline.ts` | 043 |
| Manual checklist and sign-offs | `docs/accessibility/checklist.md`, `docs/accessibility/customer-journey-signoff.md`, `docs/accessibility/provider-journey-signoff.md` | 043 |
| Existing unit-level checks (reused, **not edited**) | `components/tokens.test.ts`, `components/motion.test.ts`, `components/rtl.test.tsx`, `app/rtl-scope.test.tsx` | specs 002 / 042 |

### 3.2 Browser testing (decision D-1)

- **Runner:** Playwright (`@playwright/test`), with Chromium for the automated gate. The runner, its
  config, the `browser/` directory, the browser test database and the CI job are **spec 046's**
  architecture. 043 only adds its tests to it.
- **Directory and naming:** `browser/a11y/*.browser.ts`. The `.browser.ts` suffix never matches Vitest's
  `include` (`**/*.test.{ts,tsx}`, `e2e/**/*.spec.{ts,tsx}`), and spec 046 also adds `browser/**` to
  Vitest's `exclude`. The existing `e2e/*.spec.ts` files stay Vitest route-level tests; **nothing
  browser-based goes in `e2e/`.**
- **axe integration:** `@axe-core/playwright` (a new devDependency, added by 043).
  `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'])`. The
  `target-size` rule comes with `wcag22aa`.
- **Target:** the production build (`next build && next start`) against spec 046's browser test
  database, whose name ends in `_test`. The developer's normal database is never used.
- **Viewports:** mobile 375×812 and desktop 1280×800. Every check runs at both, except the 44px check
  (mobile only).

### 3.3 Audited routes: `browser/a11y/routes.ts`

The manifest is the closed list of what the gate audits. Each entry declares:

- `id`: stable, for example `explore.category`;
- `path`: a template, with dynamic segments resolved at run time from the browser test database
  (for example the first published category seeded by migration 0006);
- `persona`: `guest`, `customer`, `provider` or `admin`, signed in by the browser global setup;
- `sourceDir`: the `app/` directory that owns the route, for example `app/explore/[category]`;
- `journey`: `customer`, `provider` or none;
- `primaryActions`: the accessible names of the route's primary actions (journey routes only);
- `ur`: `true` when the route is in spec 042's §5.1 scope.

**Initial scope:** every `page.tsx` route reachable from the two critical journeys, plus the shared
chrome states (`/`, `app/not-found.tsx`, and error states forced through a failing fixture). The
`/admin/**` routes are added with persona `admin` under English only. Adding a route later means
adding one manifest entry.

### 3.4 Changed routes (decision D-4)

`scripts/a11y-changed-routes.ts` computes the routes a PR scans, deterministically:

1. `git diff --name-only $(git merge-base origin/main HEAD)...HEAD`.
2. If nothing changed under `app/`, `components/`, `ui/`, `lib/`, `browser/a11y/`,
   `package.json` or `package-lock.json`, the job is skipped with a logged reason (for example a
   docs-only PR).
3. **Full manifest** if any changed file is outside a route directory: `components/**`, `ui/**`,
   `lib/**`, `app/layout.tsx`, `app/globals.css`, `app/styles/**`, `app/components/**`,
   `app/_components/**`, `app/error.tsx`, `app/loading.tsx`, `app/not-found.tsx`,
   `app/global-error.tsx`, `browser/a11y/**`, `package.json`, `package-lock.json` or `next.config.ts`.
4. Otherwise, every manifest entry whose `sourceDir` is a path prefix of a changed file, including
   each route's own `_components/` and CSS modules.

**Pushes to `main` always scan the full manifest**, so nothing escapes a mis-scoped PR.

### 3.5 Baseline and "new violation" (decision D-3)

`browser/a11y/baseline.json` maps `"<routeId>[@ur]|<viewport>|<ruleId>"` to the number of
violating nodes. The key covers:

- axe rule ids;
- the custom rule ids `apuriva-reduced-motion` and `apuriva-focus-visible`.

The 44px design-system goal is **not** in the baseline, because it is not a gate (§3.6).

Counts are used, not CSS selectors, because this repository's CSS-module class names are hashed per
build and would make selector identities unstable.

- **New violation:** a key whose current count is greater than its baseline count, or a key missing
  from the baseline with count > 0. The job fails and prints the violating nodes.
- **Fixed violation:** a current count below the baseline also **fails** the job, with the message
  "baseline stale: lower `<key>` to `<n>`". The fixing PR must lower the entry, and a key reaching
  zero is deleted. The baseline can only ratchet down.
- **Creating or raising an entry** is allowed only in 043's implementing PR (initial capture) or in a
  PR whose description names the specific entries and why. The `a11y` job prints every raised key,
  so a raise is always visible in review. There is no silent `--update` path in CI.

### 3.6 Contrast and touch targets (decisions D-2, D-5)

- **AA stays the bar.** In-context contrast is axe's `color-contrast` rule on the rendered page. It
  replaces the draft's `components/tokens-in-context.test.ts`, which could not work under jsdom.
- **The rendered-text AA requirement is not weakened or exempted** by where the fix lives.
  - The five §1 token pairs are **open AC-4 failures**. They are recorded in the baseline only so that
    CI can distinguish them from *new* regressions while they remain open. A baseline entry is never
    "accepted debt".
  - AC-4 is verified, and 043 can move to Approved, only when `color-contrast` reports **zero**
    violations on every audited route, with no `color-contrast` key left in `baseline.json`.
- **Token remediation is a separate spec 002 concern.** 043 changes no token and no primitive.
  `app/styles/apuriva-tokens.css` is generated verbatim from `ui/_ds_manifest.json`, so correcting the
  five pairs means regenerating the design-system export with AA-compliant values (§8 DEP-3). When
  that lands, the counts fall to zero and the ratchet (§3.5) requires deleting the entries.
- `components/tokens.test.ts` (spec 002) is not edited. Its 3:1 tier for those five pairs is reported
  to spec 002 as part of DEP-3.
- **Touch targets, one measurement rule:** a target's size is the width and height, in CSS px, of the
  interactive element's `getBoundingClientRect()` at the 375×812 viewport.
  - **The WCAG AA compliance gate (AC-7, blocking, every route):** SC 2.5.8, **≥ 24×24 CSS px, subject
    to the SC's exceptions** (spacing, equivalent, inline, user-agent control, essential), as
    evaluated by axe `target-size`.
    - Every component is judged against this gate only.
    - The existing 32px (`Button sm`) and 40px (`Button md`) sizes, and the 30px `Tag`, meet it and
      do not fail because they are under 44px.
  - **The APURIVA design-system goal (AC-7, report-only, journey routes):** each `primaryActions`
    element is measured against 44×44 CSS px (`--touch-target-min`).
    - Results are written to `browser/a11y/touch-target-44.report.json` (a CI artefact) and printed
      as a job summary.
    - They **never fail the build and never enter the baseline**; this is not a WCAG gate.
    - Raising primary controls to 44px is design-system work (DEP-3).

### 3.7 Reduced motion and focus (decisions D-6, D-7)

- **Reduced motion reuses spec 002's backstop.** `page.emulateMedia({ reducedMotion: 'reduce' })`, then
  each element's computed `animationDuration` and `transitionDuration` are read. Any value above
  `0.01s` counts under `apuriva-reduced-motion`. No second motion system and no new CSS: a failure
  means some rule escaped `app/globals.css`, and the fix goes to that component's owner.
- **Focus visibility:** the test presses Tab through the page (at most 200 stops) and records, for each
  focused element, whether its computed `outline-style` is not `none` or its `box-shadow` is not `none`
  (the design system's `--ring-focus` is a box-shadow), and whether it is visible
  (`checkVisibility()`). A failure counts under `apuriva-focus-visible`.
- **Dialogs and menus** in the journey routes are keyboard-walked in
  `browser/a11y/keyboard.browser.ts`: open with Enter or Space, focus moves inside, Escape closes, and
  focus returns to the trigger.

### 3.8 Manual review (AC-2, AC-3; decision D-8)

- **Tools:** NVDA on Windows with Chrome, and VoiceOver on iOS with Safari; keyboard only on desktop
  Chrome.
- **Data:** the reviewer uses realistic seeded data: spec 045's demo environment once it exists,
  otherwise the browser test database.
- **Documents:** each document lists every journey step, its route, the result of the keyboard pass
  and the screen-reader pass, any issue found with a link, and the reviewer's name and date. It is
  linked in 043's implementing PR.
- **Cadence:** repeated before each milestone release (resolves the draft's open question #2).
- **Steps reviewed:**
  - Customer journey: `/`, `/search`, `/explore/[category]/[service]`, `/requests/new/[serviceId]`,
    `/requests/[id]` (offers), `/requests/[id]/compare`, `/bookings/[id]`, `/bookings/[id]/payment`,
    `/bookings/[id]/review`.
  - Provider journey: `/register`, `/account` (provider mode), `/provider/schedule`,
    `/provider/requests` (request and offer), `/provider/schedule/bookings/[id]` (booking and
    completion), `/provider/earnings`.
  - Provider *profile* and *services* have no route today and are recorded as not built.

### 3.9 RTL/Urdu (AC-6; decision D-9)

043 validates **accessibility parity** under `ur`. It does not re-test spec 042's localization.

- The browser setup turns `urdu-locale` on in the browser test database (the flag has no env
  override, per spec 042 §4), then selects `ur` through the `apuriva_locale` cookie.
- For every manifest entry with `ur: true`, the test checks:
  - `html[lang="ur"][dir="rtl"]`;
  - `document.documentElement.scrollWidth <= clientWidth` at 375px (no horizontal overflow);
  - the axe, reduced-motion and focus checks, under `@ur` keys.
- **Not re-tested here:** translation coverage (`lib/i18n/coverage.test.ts`), directional-icon
  mirroring (`components/rtl.test.tsx`) and first-paint `lang`/`dir` (`app/layout.locale.test.tsx`).
  Those remain spec 042's tests.

### 3.10 The master §106 checklist mapping

`docs/accessibility/checklist.md` maps every master §106 requirement and testing item to its check:

| §106 item | Check |
|---|---|
| Automated checks in CI | `a11y` job (AC-1) |
| Keyboard testing | `keyboard.browser.ts`, AC-8, sign-offs |
| Screen-reader checks | sign-offs (manual) |
| Contrast validation | axe `color-contrast` (AC-4) plus spec 002's token test |
| Focus testing | `apuriva-focus-visible` (AC-8) |
| Touch-target testing | axe `target-size`, the 24px WCAG AA gate (AC-7); plus the report-only 44px design-system goal |
| Reduced-motion testing | `apuriva-reduced-motion` (AC-5) |
| RTL/Urdu testing | `rtl.browser.ts` (AC-6) |
| Manual review of critical journeys | sign-offs (AC-2, AC-3) |
| Semantic HTML, labels, forms, errors, dialogs, menus | the corresponding axe rules plus `keyboard.browser.ts` |

---

## 4. Data model changes

Not applicable: no persisted entities and no migration.

### Retention and privacy

None. Browser tests run only against the isolated `*_test` browser database.

---

## 5. UI states

Not applicable as a standalone screen. This spec is the verification layer over every prior
screen spec's own §5 "UI states" accessibility notes (keyboard/screen-reader/contrast/reduced-
motion/RTL behaviour), turning per-spec intentions into a continuously enforced guarantee. It adds
no component and changes no UI. Every fix a failing check points to belongs to the owning spec of
that screen or primitive.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Accessibility (automated)** | axe scan (WCAG 2.0–2.2 A/AA tags) of the selected manifest routes at both viewports; baseline comparison | `browser/a11y/scan.browser.ts` |
| **Unit** | the changed-route rule (docs-only skip, shared file → full, route file → that route); the baseline comparison (new, fixed/stale, missing key, zero deletion) | `scripts/a11y-changed-routes.test.ts`, `scripts/a11y-baseline.test.ts` (Vitest; pure functions, kept **outside** `browser/`, which spec 046 excludes from Vitest) |
| **Keyboard** | dialogs and menus open, trap and restore focus; primary actions reachable and operable by keyboard | `browser/a11y/keyboard.browser.ts` |
| **Focus** | visible indicator on every tab stop | `browser/a11y/focus.browser.ts` |
| **Touch target** | the 24px WCAG AA gate comes from axe `target-size` in `scan.browser.ts`; this file only produces the report-only 44px design-system goal for declared primary actions (never fails) | `browser/a11y/touch-target.browser.ts` |
| **Reduced motion** | computed durations under emulated `reduce` | `browser/a11y/reduced-motion.browser.ts` |
| **RTL/Urdu** | the §3.9 parity checks under `ur` | `browser/a11y/rtl.browser.ts` |
| **Screen-reader and journeys** | NVDA and VoiceOver walkthroughs | the sign-off documents (manual) |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | CI `a11y` job (spec 046 browser job) running `scan.browser.ts`; `scripts/a11y-changed-routes.test.ts`; `scripts/a11y-baseline.test.ts` |
| AC-2 | `docs/accessibility/customer-journey-signoff.md` (signed), plus `keyboard.browser.ts` |
| AC-3 | `docs/accessibility/provider-journey-signoff.md` (signed), plus `keyboard.browser.ts` |
| AC-4 | `scan.browser.ts` (`color-contrast`): verified only at **zero** violations with no `color-contrast` baseline key |
| AC-5 | `reduced-motion.browser.ts` |
| AC-6 | `rtl.browser.ts` |
| AC-7 | `scan.browser.ts` (`target-size`, the 24px gate); `touch-target.browser.ts` (the 44px goal report, informational) |
| AC-8 | `focus.browser.ts` |

**Coverage:**

- Every manifest route passes the gate against the baseline.
- Every master §106 item maps to a check in `docs/accessibility/checklist.md`.
- The two pure modules (`scripts/a11y-changed-routes.ts` and `scripts/a11y-baseline.ts`) have ≥ 80%
  statement coverage.

**Other specs' tests must stay green and unedited:** `components/tokens.test.ts`,
`components/motion.test.ts`, `components/rtl.test.tsx`, `app/rtl-scope.test.tsx`,
`app/layout.locale.test.tsx`.

**Not covered, deliberately:**

- Full WCAG AAA. AA is the bar. The 44px primary-action size is an APURIVA design-system goal,
  reported only, never a failure gate.
- Automated screen-reader testing (no reliable tooling; manual per §3.8).
- Browsers other than Chromium in the automated gate. Master §107's cross-browser matrix belongs to
  the manual sign-offs, not this gate.

---

## 7. Out of scope

- Accessibility of any Phase 2 feature not yet built. This includes the provider *profile* and
  *services* journey steps, which have no route today.
- Third-party embedded content (e.g. the payment provider's own hosted payment UI from spec
  021) — accessible only to the extent that vendor's own component is accessible; tracked as a
  vendor-selection criterion, not something this spec can directly fix.
- **Changing design tokens or primitives.** Corrections to `ui/_ds_manifest.json` /
  `app/styles/apuriva-tokens.css` or the `ui/` components are design-system (spec 002) work (§8 DEP-3).
- The Playwright runner, the browser database and the CI pipeline (spec 046).
- Translation coverage and directional-icon mirroring (spec 042).

---

## 8. Dependencies, decisions, risks

### Dependencies

| # | Dependency | Owner | Needed for |
|---|---|---|---|
| DEP-1 | Playwright installed and configured; the `browser/` directory; `browser/**` excluded from Vitest; a `_test`-suffixed browser database with migrations applied; persona sign-in in global setup; a CI browser job that runs `next build && next start` | spec 046 | every browser test, AC-1 |
| DEP-2 | The GitHub Actions pipeline (the `a11y` job runs inside it) | spec 046 | AC-1 |
| DEP-3 | AA-compliant values for the five §1 token pairs, delivered by regenerating the design-system export; optionally, 44px primary controls (the design-system goal) | spec 002 follow-up (design) | **verifying AC-4.** 043 can be implemented without it, but cannot move to Approved until `color-contrast` is at zero, which requires this remediation. The 44px goal is not required for approval. |
| DEP-4 | Realistic seeded data for the manual reviews | spec 045 (preferred) or the browser database | AC-2, AC-3 |
| DEP-5 | The in-flight working-tree changes to `package.json`/`package-lock.json` (spec 033 OpenAI work) are landed first, so 043's `@axe-core/playwright` addition is not a mixed-file change | — | implementation start |

### Decisions

| # | Decision |
|---|---|
| D-1 | The browser runner is Playwright, with axe via `@axe-core/playwright`. The tests live in `browser/a11y/*.browser.ts`, never in `e2e/`. The runner infrastructure is spec 046's. |
| D-2 | WCAG AA 4.5:1 / 3:1 rendered text contrast is mandatory, measured in context by axe, with no exemption. The five failing token pairs are open AC-4 failures, tracked in the baseline only to block new regressions. AC-4 passes at zero. The token fix is spec 002's, and 043 changes no token. |
| D-3 | The baseline counts violations per `route[@ur]\|viewport\|rule`. A new violation is a count above baseline. A count below baseline fails as stale until lowered, so the baseline only ratchets down. |
| D-4 | Changed routes follow §3.4: a docs-only change skips; a shared or `lib/` change scans the full manifest; route-local changes scan those routes. A push to `main` always scans everything. |
| D-5 | Touch targets: the only failure gate is WCAG 2.2 AA SC 2.5.8, 24×24 CSS px subject to its exceptions (axe `target-size`), against which the 32px/40px components are judged. 44×44 is the APURIVA design-system goal, measured and reported for journey primary actions and never a gate. One measurement rule: the bounding rect at 375×812. |
| D-6 | Reduced motion reuses spec 002's `app/globals.css` backstop and is verified by computed durations ≤ 0.01s. |
| D-7 | Focus visibility means a computed non-`none` `outline` or `box-shadow` on every tab stop. |
| D-8 | Manual reviews use NVDA with Chrome and VoiceOver with iOS Safari, repeated before each milestone release. The provider profile and services steps are recorded as not built. |
| D-9 | Under `ur`, 043 checks accessibility parity only. Spec 042 keeps localization correctness. |

### Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | AC-4 cannot pass until spec 002's token remediation (DEP-3) lands, so 043's approval waits on it | The ratchet blocks any new contrast failure in the meantime. The dependency is explicit, and AC-4 is never marked passed while a `color-contrast` entry exists. |
| R-2 | axe does not catch everything | The manual sign-offs plus the keyboard and focus tests |
| R-3 | A raised baseline slips through review | The `a11y` job prints every raised key, and raises are restricted by §3.5 |
| R-4 | Browser-job duration on full-manifest runs | Route-scoped PR runs (§3.4); the full scan only on shared changes and on `main` |

---

## 9. Rollout

- **Feature flag:** none — accessibility is not optional/togglable.
- **Migration order:** N/A.
- **Order:**
  1. Spec 046 lands the runner and the CI browser job.
  2. 043 lands its tests, manifest, script and the initially captured `baseline.json`.
  3. Branch protection makes `a11y` a required check.
- **Rollback:** remove `a11y` from the required checks. No product behaviour depends on this spec.
- **Observability:** the `a11y` job's pass/fail history and the baseline's total count over time
  are the quality trend (master §117). Any production accessibility complaint is routed through
  spec 032's support system and reviewed against `docs/accessibility/checklist.md`.
