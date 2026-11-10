# Customer journey — accessibility sign-off

**Owner:** Spec 043 AC-2 (§3.8). **Status: NOT SIGNED — the manual review has not been performed.**
AC-2 is met only when every step below is recorded as passing, with the reviewer's name and date.

- **Tools:** keyboard only on desktop Chrome; **NVDA** with Chrome on Windows; **VoiceOver** with Safari on iOS.
- **Data:** spec 045's demo environment once it exists (it is blocked by its DEP-1); until then the browser
  test database (`npm run build && npm run test:browser` seeds one real request → offer → booking).
- **Cadence:** before each milestone release.
- **Automated support:** `browser/a11y/keyboard.browser.ts` and the `a11y` job cover keyboard reachability,
  focus and axe rules; they do not replace this review.

## Steps

| # | Step | Route | Keyboard pass | NVDA + Chrome | VoiceOver + iOS Safari | Issues (links) |
|---|---|---|---|---|---|---|
| 1 | Guest home | `/` | — | — | — | |
| 2 | Search | `/search` | — | — | — | |
| 3 | Service detail | `/explore/[category]/[service]` | — | — | — | |
| 4 | Create request | `/requests/new/[serviceId]` | — | — | — | |
| 5 | Offers | `/requests/[id]` | — | — | — | |
| 6 | Compare offers | `/requests/[id]/compare` | — | — | — | |
| 7 | Booking | `/bookings/[id]` | — | — | — | |
| 8 | Payment | `/bookings/[id]/payment` | — | — | — | |
| 9 | Completion | `/bookings/[id]` (completed state) | — | — | — | |
| 10 | Review | `/bookings/[id]/review` | — | — | — | |

Record each cell as **Pass** or **Fail (#issue)**. Each step must be operable (every control reachable and
usable) and announced (name, role, state and changes read correctly).

## Sign-off

| Reviewer | Date | Build / commit | Result |
|---|---|---|---|
| — | — | — | not performed |
