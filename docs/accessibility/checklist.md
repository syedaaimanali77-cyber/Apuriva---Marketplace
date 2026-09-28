# Accessibility checklist — master §106

**Owner:** Spec 043 (§3.10). Every master §106 requirement and testing item maps to a check below.
**Bar:** WCAG 2.2 AA. Contrast AA (4.5:1 normal text, 3:1 large text) is mandatory, with no exemption.

## How the gate works

- CI job `a11y` runs `browser/a11y/*.browser.ts` (Playwright + axe-core, Chromium) against
  `next build && next start` on the isolated `apuriva_browser_test` database, at **375×812** and
  **1280×800**.
- A pull request scans the routes its changes select (`scripts/a11y-changed-routes.ts`: docs-only →
  skipped; shared code → full manifest; route-local → those routes). A push to `main` scans everything.
- Counts per `route[@ur]|viewport|rule` are held against `browser/a11y/baseline.json`. A count above
  its entry fails (**new violation**); a count below it fails too (**baseline stale — lower it**), so the
  baseline only ratchets down. Raising an entry needs a PR that names it and says why.
- Adding an audited route: one entry in `browser/a11y/routes.ts`.

## §106 mapping

| §106 item | Check | Type |
|---|---|---|
| Automated accessibility checks in CI | `a11y` job: `scan.browser.ts` (axe `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) — AC-1 | automated, blocking |
| Keyboard testing | `keyboard.browser.ts` (dialogs/menus open with Enter, focus moves in, Escape closes, focus returns; primary actions reachable by Tab); focus walk in `focus.browser.ts`; the journey sign-offs | automated + manual |
| Screen-reader checks | [customer-journey-signoff.md](customer-journey-signoff.md), [provider-journey-signoff.md](provider-journey-signoff.md) (NVDA + Chrome, VoiceOver + iOS Safari) — AC-2, AC-3 | manual |
| Contrast validation | axe `color-contrast` in context — AC-4 (passes only at **zero** with no `color-contrast` baseline key); plus spec 002's `components/tokens.test.ts` | automated, blocking |
| Focus testing | `focus.browser.ts`: every Tab stop shows an outline or box-shadow and is visible (`apuriva-focus-visible`) — AC-8 | automated, blocking |
| Touch-target testing | **Gate:** axe `target-size` (WCAG 2.2 SC 2.5.8, 24×24 CSS px with its exceptions) — AC-7. **Goal (report only):** 44×44 for journey primary actions, `touch-target.browser.ts` → `touch-target-44.report.json` | automated (gate) + report |
| Reduced-motion testing | `reduced-motion.browser.ts`: computed animation/transition ≤ 0.01s under `prefers-reduced-motion: reduce` (`apuriva-reduced-motion`) — AC-5 | automated, blocking |
| RTL / Urdu testing | `rtl.browser.ts`: `lang="ur" dir="rtl"`, no horizontal overflow at 375px, axe/motion/focus under `@ur` keys — AC-6 | automated, blocking |
| Manual review of critical journeys | the two sign-off documents, repeated before each milestone release | manual |
| Semantic HTML, labels, forms, errors | the corresponding axe rules (`label`, `button-name`, `link-name`, `aria-*`, `heading-order`, `landmark-*`, `form-field-multiple-labels`, …) | automated |
| Dialogs and menus | `keyboard.browser.ts` plus axe's ARIA rules | automated |

## Open items (not passing yet)

The committed `browser/a11y/baseline.json` was captured in Linux on Node 22 (CI's runtime) with CI's
parallelism, and the gate then passed 436/436 against it. It holds **166 keys / 462 nodes** in two rules
only — every entry below is an open failure, not accepted debt. Nothing else (no `target-size`, no other axe
rule, no `apuriva-reduced-motion`, no keyboard, `lang`/`dir` or 375px-overflow failure) is outstanding.

- **AC-4 is not met — `color-contrast`, 310 nodes.** All are design-token colours, so the fix is spec 002's:
  regenerate the design-system export (`ui/_ds_manifest.json` → `app/styles/apuriva-tokens.css`) with AA
  values (spec 043 DEP-3). Measured in context, the failures are wider than the five pairs spec 043 §1 lists:

  | Rendered pair | Ratio | Nodes |
  |---|---|---|
  | `--text-muted` #6b777b on the page surface #f8fafb | 4.40:1 | 132 |
  | white on `--action-primary-bg` #0a918c (§1 pair) | 3.85:1 | 71 |
  | subtle text #98a4a8 on white | 2.55:1 | 29 |
  | `--text-muted` #6b777b on #effbfa | 4.36:1 | 8 |
  | warning #b86b00 on #fff3dc (§1 pair) | 3.71:1 | 4 |
  | success #168a5b on #e8f7f0 (§1 pair) | 3.94:1 | 4 |
  | #087f7a on #eaf4fb | 4.35:1 | 2 |
  | subtle text #98a4a8 on #f8fafb | 2.44:1 | 2 |

- **AC-8 is not met — `apuriva-focus-visible`, 152 nodes.** 116 are the design system's field primitives
  (`ui/components/forms/Select.jsx`, `Input.jsx`): they set `outline: none` on the `<select>`/`<input>` and
  draw `--ring-focus` on a wrapper `<div>`, so the focused element itself has no indicator (spec 043 D-7).
  2 are focus landing on a visually hidden input. Owners: spec 002 (primitives) and the owning screens.
- **AC-2 and AC-3 are not signed.** The manual NVDA/VoiceOver reviews have not been performed.

Fixed while landing the gate (in their owning components, not baselined): the account menu now moves focus
into the menu when opened (specs 006/014); `/explore`, `/explore/[category]`, `/search`, `/login` and
`/register` no longer overflow at 375px (their layout grids could not shrink below the search form's or the
auth panel's min-content — it reproduced in English too, and worst in Urdu).

## Not covered by this gate

- WCAG AAA; browsers other than Chromium (the manual reviews cover Safari/iOS); automated screen-reader
  testing; third-party hosted payment UI.
