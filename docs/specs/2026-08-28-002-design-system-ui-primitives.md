# Spec: Design System & UI Primitives

**File:** `docs/specs/2026-08-28-002-design-system-ui-primitives.md`
**Status:** Approved
**Author:** Platform team
**Reviewer:** —
**Related:** [Apuriva Master Specification](../../Apuriva_Master_Specification%20-%20Copy.md) §3, §106, [Apuriva Architecture](../../Apuriva_Architecture%20-%20Copy.md) §12, [docs/workflow.md](../workflow.md)

> **Existing Design System note (verified against `ui/`):** An Apuriva Design System already
> exists in this repository at `ui/` (component/token bundle, namespace
> `ApurivaDesignSystem_90e8bd`) — finalized brand colors, typography, spacing/radius/elevation/
> motion tokens, 50 Lucide-sourced icons, and a React component library already implement most
> of what this spec describes. This spec's job is to **integrate that existing system** into the
> single Next.js application from spec 001 — not to design new tokens or components from
> scratch. The sections below are updated to accurately reflect what already exists; two gaps
> between this spec's original wording and the existing system have since been resolved (§2
> AC-1's branding values; §8's accepted focus/RTL approach) rather than guessed at.

---

## 1. Problem statement

**Today:** Design tokens and an accessible component library already exist in this repo (`ui/`,
the Apuriva Design System) but are not yet wired into the single Next.js application from spec
001 — no app currently consumes them. Every later screen spec (customer, provider, admin) needs
buttons, inputs, cards, dialogs, and status colors that behave consistently and are accessible
by default — integrating the existing system (rather than building ad hoc per feature) keeps the
product consistent and accessible, and keeps a future rebrand from requiring business-logic
rewrites (explicitly prohibited, master spec §3.1).

**Who is affected:** Every user-facing spec from 007 onward; the brand/product team who may
rename "Apuriva" later; accessibility auditors.

**Why it matters now:** Master spec §3.1 requires branding (name, logo, colors, copy) to be
centralized so it never leaks into business logic, and §106 requires accessibility to be
foundational, not a final pass — both must exist before the first real screen is built.

**Success looks like:** The existing `ui/` Design System (accessible primitives — button, input,
select, dialog, card, badge, toast, skeleton, icon, and more — built on its existing design
tokens) is integrated into the single Next.js application as `components`, all passing automated
accessibility checks, with brand values (name, logo, tagline, colors) defined in exactly one
place.

---

## 2. Acceptance criteria

| # | Criterion |
|---|---|
| AC-1 | **Given** `lib/config/branding.ts` (app name `APURIVA`, AI assistant name `Apuriva Assistant`, tagline `Get the right help. Get it done.`) **When** the app name/tagline/AI-assistant-name is changed there **Then** the change propagates to every screen, email template, and metadata tag with no other file edits |
| AC-2 | **Given** any `components` interactive primitive (button, input, dialog, menu) **When** operated via keyboard only **Then** all functionality is reachable and focus is visibly indicated |
| AC-3 | **Given** any `components` primitive that conveys state (success/warning/error/info) **When** rendered **Then** state is communicated via icon + text + color together, never color alone |
| AC-4 | **Given** the design token set **When** checked against WCAG contrast requirements for text/background pairs **Then** all documented token combinations meet AA contrast |
| AC-5 | **Given** `prefers-reduced-motion: reduce` **When** any `components` component with a transition/animation renders **Then** the animation is disabled or reduced |
| AC-6 | **Given** an Urdu locale context **When** a `components` primitive renders text **Then** layout mirrors correctly for RTL and uses the Urdu-compatible font stack |

---

## 3. API contract

Not applicable — `components` and `lib/config` are frontend/shared libraries, not API
endpoints.

---

## 4. Data model changes

Not applicable — no persisted entities. `lib/config` ships static/build-time configuration
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
**Shared components used/added:** `components` (integrated from the existing `ui/` Design
System): `Button`, `Input`, `Select`, `Checkbox`, `Radio`, `Dialog`, `ConfirmDialog`, `Card`,
`Badge`, `Toast`, `Skeleton`, `EmptyState`, `ErrorState`, `Menu`, `Tabs`, `Icon`, `IconButton`.
Focus indication and RTL text rendering are provided by the existing token set applied directly
per component (a `--ring-focus` box-shadow token; a `[lang="ur"]`-scoped font/line-height swap)
rather than by dedicated `FocusRing` or `Text` primitive components — this existing approach is
accepted as-is (§8), no standalone `FocusRing`/`Text` component will be added.

---

## 6. Test plan

| Level | What it covers | Where |
|---|---|---|
| **Unit** | token resolution, branding config lookups | `components/**/*.test.ts`, `lib/config/**/*.test.ts` |
| **Integration** | N/A | — |
| **Component** | each primitive's states (default/hover/focus/disabled/error), keyboard interaction | `components/**/*.test.tsx` (Testing Library) |
| **E2E** | N/A (covered indirectly by every screen's own E2E) | — |
| **Accessibility** | automated axe-core (or equivalent) scan on every primitive in isolation | CI accessibility gate |

**Traceability**

| AC | Test |
|---|---|
| AC-1 | `lib/config/branding.test.ts::propagates branding change` |
| AC-2 | `components/Button.test.tsx::keyboard operable`, similar per primitive |
| AC-3 | `components/Badge.test.tsx::renders icon+text+color for each status` |
| AC-4 | `components/tokens.test.ts::contrast ratios meet AA` |
| AC-5 | `components/*.test.tsx::respects prefers-reduced-motion` |
| AC-6 | `components/*.test.tsx::RTL rendering under [lang="ur"] token scope` (no dedicated `Text` primitive — verified against the existing token-based approach, accepted per §8) |

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
| 1 | Exact color token values (teal/navy/amber hex values) — master spec gives direction, not values | Design | Decided — full palette already defined in the existing `ui/` Design System: Teal primary (`--teal-50`…`--teal-900`, brand step `--teal-600` `#0A918C`), Navy secondary (`--navy-50`…`--navy-950`), Amber accent (`--amber-50`…`--amber-700`, ~5% of any screen, never used for warnings), Gray neutrals, and semantic success/warning/error/info scales. AA contrast verification of these specific values against AC-4 is still outstanding — the values themselves are no longer undecided. |
| 2 | Which underlying accessible-primitive library to build on (Radix UI, React Aria, headless UI) vs. fully custom | — | Decided — fully custom. The existing `ui/` components are hand-built directly on React (`inlinedExternals: []` — no Radix/React Aria/headless-UI dependency) with manually-implemented ARIA patterns, confirmed in the existing `Dialog` (`role="dialog"`, `aria-modal`, Escape-to-close, initial-focus placement) and `Icon` (`aria-hidden` by default, `role="img"` + `aria-label` when given a `title`) implementations. |
| 3 | Urdu font stack selection | Design | Decided — `Noto Nastaliq Urdu`, falling back to `Noto Naskh Arabic`, then `serif` (`--font-urdu` token). Activated via `[lang="ur"]` attribute scoping, which also swaps `--font-sans`/`--font-display` to `--font-urdu` and loosens line-height (`--leading-normal: 1.9`, `--leading-snug: 1.7`) for that scope. |
| 4 | The existing Design System has no dedicated `FocusRing` or RTL-aware `Text` primitive components, unlike this spec's original component list. Focus indication is applied inline per component via the `--ring-focus` token; text/typography is applied via CSS tokens directly on whatever element renders it, with no wrapper component. | — | Decided — accept the existing per-component/token-only approach; no standalone `FocusRing` or `Text` component will be created. This is conditional on AC-2 (keyboard focus visibility) and AC-6 (RTL rendering) being verified by tests against the existing token-based implementation. |

---

## 9. Rollout

- **Feature flag:** none — foundational library, not a togglable feature.
- **Migration order:** N/A.
- **Rollback:** revert the commit/PR that changed the shared UI components (`components/`).
- **Observability:** N/A directly; a11y CI gate result is the signal that this spec's guarantees
  hold on every subsequent screen.
