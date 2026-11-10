# Provider journey — accessibility sign-off

**Owner:** Spec 043 AC-3 (§3.8). **Status: NOT SIGNED — the manual review has not been performed.**
AC-3 is met only when every step that has a route is recorded as passing, with the reviewer's name and date.

- **Tools:** keyboard only on desktop Chrome; **NVDA** with Chrome on Windows; **VoiceOver** with Safari on iOS.
- **Data:** spec 045's demo environment once it exists (blocked by its DEP-1); until then the browser test
  database.
- **Cadence:** before each milestone release.
- **Automated support:** `browser/a11y/keyboard.browser.ts` and the `a11y` job; they do not replace this review.

## Steps

| # | Step | Route | Keyboard pass | NVDA + Chrome | VoiceOver + iOS Safari | Issues (links) |
|---|---|---|---|---|---|---|
| 1 | Sign up | `/register` | — | — | — | |
| 2 | Switch to provider mode | `/account` (provider mode) | — | — | — | |
| 3 | Availability | `/provider/schedule` | — | — | — | |
| 4 | Incoming request and offer | `/provider/requests` | — | — | — | |
| 5 | Booking | `/provider/schedule/bookings/[id]` | — | — | — | |
| 6 | Completion | `/provider/schedule/bookings/[id]` (completion) | — | — | — | |
| 7 | Earnings | `/provider/earnings` | — | — | — | |
| — | Provider profile | **not built** — no route exists (spec 043 §7) | n/a | n/a | n/a | |
| — | Provider services | **not built** — no route exists (spec 043 §7) | n/a | n/a | n/a | |

Record each cell as **Pass** or **Fail (#issue)**.

## Sign-off

| Reviewer | Date | Build / commit | Result |
|---|---|---|---|
| — | — | — | not performed |
