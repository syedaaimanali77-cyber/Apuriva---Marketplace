# Spec: Design System & UI Primitives

**File:** `docs/specs/2026-08-28-002-design-system-ui-primitives.md`
**Status:** Draft
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §3, §106, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §12, [docs/workflow.md](../workflow.md)

---

## 1. Problem statement

**Today:** No design tokens, no accessible primitives, no centralized branding exist. Every
later screen spec (customer, provider, admin) needs buttons, inputs, cards, dialogs, and status
colors that behave consistently and are accessible by default — building these ad hoc per
feature would produce an inconsistent, inaccessible product and make a future rebrand require
rewriting business logic (explicitly prohibited, master spec §3.1).

**Who is affected:** Every user-facing spec from 007 onward; the brand/product team who may
rename "Apuriva" later; accessibility auditors.

**Why it matters now:** Master spec §3.1 requires branding (name, logo, colors, copy) to be
centralized so it never leaks into business logic, and §106 requires accessibility to be
foundational, not a final pass — both must exist before the first real screen is built.

**Success looks like:** A `packages/ui` library of accessible primitives (button, input, select,
dialog, card, badge, toast, skeleton) built on design tokens, all passing automated
accessibility checks, with brand values (name, logo, tagline, colors) defined in exactly one
place.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** `packages/config/branding.ts` **When** the app name/tagline/AI-assistant-name is changed there **Then** the change propagates to every screen, email template, and metadata tag with no other file edits |
| AC-2 | **Given** any `packages/ui` interactive primitive (button, input, dialog, menu) **When** operated via keyboard only **Then** all functionality is reachable and focus is visibly indicated |
| AC-3 | **Given** any `packages/ui` primitive that conveys state (success/warning/error/info) **When** rendered **Then** state is communicated via icon + text + color together, never color alone |
| AC-4 | **Given** the design token set **When** checked against WCAG contrast requirements for text/background pairs **Then** all documented token combinations meet AA contrast |
| AC-5 | **Given** `prefers-reduced-motion: reduce` **When** any `packages/ui` component with a transition/animation renders **Then** the animation is disabled or reduced |
| AC-6 | **Given** an Urdu locale context **When** a `packages/ui` primitive renders text **Then** layout mirrors correctly for RTL and uses the Urdu-compatible font stack |

---

## 3. API contract

Not applicable — `packages/ui` and `packages/config` are frontend/shared libraries, not API
endpoints.

---

## 4. Data model changes

Not applicable — no persisted entities. `packages/config` ships static/build-time configuration
(design tokens, branding constants), not database-backed data.

### Retention and privacy

None — no personal data.

---

## 5. UI states

This spec *defines* the states other specs reuse, rather than implementing one screen:

| State | Behaviour |
|---|---|
| **Loading** | `Skeleton` primitive: shape-matched placeholder blocks, no spinner-only pattern for content lists |
| **Empty** | `EmptyState` primitive: icon + message + primary action slot |
| **Error** | `ErrorState` primitive: message + optional `traceId` + retry action slot |
| **Success** | `Toast` / inline confirmation primitives; `ConfirmDialog` for destructive/high-risk actions |

Density is adaptive per persona per master spec §3.7 (marketing: spacious, customer:
comfortable, provider: moderately dense, admin: information-dense) — implemented as a density
token consumed by layout primitives, not hard-coded per screen.

**Route(s):** N/A (library, not a route) — a `/design-system` internal storybook-style route may
be added for visual QA but is not user-facing.
**Shared components used/added:** `packages/ui`: `Button`, `Input`, `Select`, `Checkbox`,
`Radio`, `Dialog`, `ConfirmDialog`, `Card`, `Badge`, `Toast`, `Skeleton`, `EmptyState`,
`ErrorState`, `Menu`, `Tabs`, `FocusRing` utilities, RTL-aware `Text` primitive.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | token resolution, branding config lookups | `packages/ui/**/*.test.ts`, `packages/config/**/*.test.ts` |
| **Integration** | N/A | — |
| **Component** | each primitive's states (default/hover/focus/disabled/error), keyboard interaction | `packages/ui/**/*.test.tsx` (Testing Library) |
| **E2E** | N/A (covered indirectly by every screen's own E2E) | — |
| **Accessibility** | automated axe-core (or equivalent) scan on every primitive in isolation | CI accessibility gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `packages/config/branding.test.ts::propagates branding change` |
| AC-2 | `packages/ui/Button.test.tsx::keyboard operable`, similar per primitive |
| AC-3 | `packages/ui/Badge.test.tsx::renders icon+text+color for each status` |
| AC-4 | `packages/ui/tokens.test.ts::contrast ratios meet AA` |
| AC-5 | `packages/ui/*.test.tsx::respects prefers-reduced-motion` |
| AC-6 | `packages/ui/Text.test.tsx::RTL rendering` |

**Coverage:** ≥80% on new code.

**Not covered, deliberately:** Visual regression/pixel-perfect testing — out of scope for MVP;
automated a11y + interaction tests are the bar, not pixel diffing.

---

## 7. Out of scope

- Dark mode (explicitly Phase 2, master spec §122).
- The actual logo/icon artwork — this spec defines *where* branding assets are referenced from,
  not the creative design process for the logo itself.
- Marketing-site-specific expressive motion/backgrounds (master spec §3.14, §3.12) — those are
  scoped to marketing pages, not the shared primitive library.

---

## 8. Risks and open questions

| # | Risk / question | Owner | Resolution |
|---|---|---|---|
| 1 | Exact color token values (teal/navy/amber hex values) — master spec gives direction, not values | Design | Open — must be finalized and contrast-checked before AC-4 can be verified |
| 2 | Which underlying accessible-primitive library to build on (Radix UI, React Aria, headless UI) vs. fully custom | — | Open — recommend building on an existing accessible-primitives library rather than reinventing focus/aria management |
| 3 | Urdu font stack selection | Design | Open |

---

## 9. Rollout

- **Feature flag:** none — foundational library, not a togglable feature.
- **Migration order:** N/A.
- **Rollback:** revert the package version consumed by `apps/web`.
- **Observability:** N/A directly; a11y CI gate result is the signal that this spec's guarantees
  hold on every subsequent screen.
