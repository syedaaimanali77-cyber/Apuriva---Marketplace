# Spec: Accessibility Standards

**File:** `docs/specs/2026-08-28-043-accessibility-standards.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §106, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §12, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** Spec 002 established accessible primitives, and every screen spec since has included
per-screen accessibility notes in its own §5/§6, but there is no platform-wide accessibility
testing gate, standard, or audit checklist ensuring those per-screen intentions actually hold
across the full built product. Master spec §106 requires accessibility to be foundational, with
a specific testing checklist: automated CI checks, keyboard testing, screen-reader checks,
contrast validation, focus testing, touch-target testing, reduced-motion testing, RTL/Urdu
testing, and manual review of critical journeys.

**Who is affected:** Every user relying on assistive technology; the whole product's legal/
ethical accessibility posture.

**Why it matters now:** Sequenced as cross-cutting hardening because it establishes the CI gate
and audit process that verifies every prior spec's accessibility acceptance criteria actually
hold together as a system, not just individually.

**Success looks like:** An automated accessibility CI gate blocks regressions on every PR; the
full checklist from master spec §106 is run and passing across the critical customer/provider/
admin journeys; manual review sign-off exists for those critical journeys.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** any PR touching `apps/web` **When** CI runs **Then** an automated accessibility scan (axe-core or equivalent) runs against changed routes and fails the build on new violations |
| AC-2 | **Given** the critical customer journey (guest → search → request → offer → booking → payment → completion → review) **When** manually reviewed **Then** it is fully keyboard-operable and screen-reader-navigable end to end |
| AC-3 | **Given** the critical provider journey (signup → profile → services → availability → request → offer → booking → completion → earnings) **When** manually reviewed **Then** the same standard holds |
| AC-4 | **Given** every design token color pair used for text/background **When** checked **Then** it meets WCAG AA contrast (extends spec 002's token-level check to actual usage in context) |
| AC-5 | **Given** `prefers-reduced-motion: reduce` **When** any screen with a transition renders **Then** motion is reduced/disabled, verified across the built product, not just in `packages/ui` isolation |
| AC-6 | **Given** the Urdu/RTL locale (spec 042) **When** accessibility-tested **Then** it passes the same checklist as the English/LTR experience |
| AC-7 | **Given** all interactive touch targets **When** measured **Then** they meet minimum touch-target size guidelines |

---

## 3. API contract

Not applicable — this is a testing/process/CI spec, not an API surface.

---

## 4. Data model changes

Not applicable — no persisted entities.

### Retention and privacy

None.

---

## 5. UI states

Not applicable as a standalone screen; this spec is the verification layer over every prior
screen spec's own §5 "UI states" accessibility notes (keyboard/screen-reader/contrast/reduced-
motion/RTL behaviour), turning per-spec intentions into a continuously enforced guarantee.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Accessibility (automated)** | axe-core scan on every route in CI, blocking on new violations | CI gate, `apps/web-e2e/a11y/*.spec.ts` |
| **Keyboard** | full keyboard-only walkthroughs of the three critical journeys | manual review checklist + Playwright keyboard-navigation tests |
| **Screen-reader** | NVDA/VoiceOver walkthroughs of the three critical journeys | manual review checklist |
| **Contrast** | automated contrast check across all token combinations in actual rendered context | CI script extending spec 002's token-level test |
| **Focus** | focus order and visibility across forms/dialogs/menus | Playwright focus-order assertions |
| **Touch target** | minimum tap-target size across mobile breakpoints | Playwright/visual assertion |
| **Reduced motion** | `prefers-reduced-motion` respected across all animated components in situ | Playwright with emulated media feature |
| **RTL/Urdu** | full checklist re-run against the Urdu locale | `apps/web-e2e/a11y/rtl.spec.ts` |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | CI `a11y-scan` job, required status check |
| AC-2, AC-3 | manual review sign-off document (per journey), linked in the implementing PR |
| AC-4 | `packages/ui/tokens-in-context.test.ts` |
| AC-6 | `apps/web-e2e/a11y/rtl.spec.ts` |

**Coverage:** Every route reachable from the three critical journeys must pass the automated
scan with zero new violations; 100% of the master spec §106 checklist items must have at least
one corresponding automated or documented-manual check.

**Not covered, deliberately:** Full WCAG AAA compliance — AA is the target bar per common
practice; AAA is not required by the master spec.

---

## 7. Out of scope

- Accessibility of any Phase 2 feature not yet built.
- Third-party embedded content (e.g. the payment provider's own hosted payment UI from spec
  021) — accessible only to the extent that vendor's own component is accessible; tracked as a
  vendor-selection criterion, not something this spec can directly fix.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Automated a11y tooling choice (axe-core, Pa11y, or a commercial service) | — | Open — recommend axe-core for its Playwright/Testing Library integration |
| 2 | Cadence of manual screen-reader review (every release vs. periodic) | — | Open — recommend at minimum before each milestone's features ship |

---

## 9. Rollout

- **Feature flag:** none — accessibility is not optional/togglable.
- **Migration order:** N/A.
- **Rollback:** N/A.
- **Observability:** CI a11y-gate pass/fail rate tracked over time as a quality trend (master
  spec §117); any production accessibility complaint routed through spec 032's support system
  and reviewed against this checklist.
