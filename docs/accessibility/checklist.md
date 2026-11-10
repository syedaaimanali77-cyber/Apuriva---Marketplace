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

- **AC-2 and AC-3 are not signed.** The manual NVDA/VoiceOver reviews have not been performed (see the two
  sign-off documents). They are the only open items.

## Resolved by spec 002 (2026-10-01)

`browser/a11y/baseline.json` is now **empty (`{}`)**: every audited route, viewport and `@ur` scope reports zero
violations in every rule. It was refreshed with the documented mechanism, not by hand: a full capture on the
spec 002 tree (`9a1a75a`, Linux, Node 22, CI's two workers — 436/436, 138 scopes per check, every count 0)
folded in by `tsx scripts/a11y-baseline.ts merge`, after which the `CI=true` gate passed 436/436 against it.

- **AC-4 now passes — `color-contrast` 310 → 0 nodes.** Spec 002 regenerated its tokens from
  `ui/_ds_manifest.json` with AA values (spec 043 DEP-3). The failing rendered pairs were `--text-muted` on the
  page and brand-tint surfaces (4.36–4.40:1), white on `--action-primary-bg` (3.85:1), subtle text (2.44–2.55:1),
  the warning and success badges (3.71 and 3.94:1) and the link colour on the info tint (4.35:1).
- **AC-8 now passes — `apuriva-focus-visible` 152 → 0 nodes.** Spec 002 moved `--ring-focus` from a wrapper onto
  the focused `<input>`/`<select>` (`Input.jsx`, `Select.jsx`), and made the native radio/checkbox the visible,
  ringed control (`Radio.jsx`, `Checkbox.jsx`) — the "visually hidden input" focus stop on `/requests/new`.

Fixed while landing the gate (in their owning components, not baselined): the account menu now moves focus
into the menu when opened (specs 006/014); `/explore`, `/explore/[category]`, `/search`, `/login` and
`/register` no longer overflow at 375px (their layout grids could not shrink below the search form's or the
auth panel's min-content — it reproduced in English too, and worst in Urdu).

## Not covered by this gate

- WCAG AAA; browsers other than Chromium (the manual reviews cover Safari/iOS); automated screen-reader
  testing; third-party hosted payment UI.
