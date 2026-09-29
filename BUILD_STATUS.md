# Build status

Maintained per master specification §129–§130 and spec 046 §3.12 (AC-7). **Update this file in the
same PR as every spec implementation** — CI's `check:build-status` fails a PR that moves a
`docs/specs/*` status to `Approved` or `Implemented` without changing it.

_Last updated: 2026-09-29 — Account Profile & Preferences (feature work, not a numbered spec)._

## Completed

Specs **001–042** are implemented and `Approved` (each landed as its own `feat(spec-NNN)` commit).
Spec **046**'s repository-side implementation lands with this update; its status stays `Draft` until
the externally-verified criteria pass (see **In progress**).

| Range | Area |
|---|---|
| 001–004 | Foundation: single Next.js app and env contract, design system, database and core data model, API standards |
| 005–009 | Accounts: authentication, identity and role switching, onboarding/guest, sessions and privacy center, admin RBAC |
| 010–014 | Marketplace: catalog, category/service pages, location, search, home and navigation |
| 015–020 | Requests, availability, matching, offers and negotiation, booking state machine |
| 021–024 | Payments, refunds, cancellation and no-show, payouts |
| 025–027 | Messaging, notifications, file uploads |
| 028–032 | Service execution, reviews, safety, disputes, support |
| 033–036 | AI assistant, conversation/memory, MCP architecture and tool catalog |
| 037–042 | Admin operations, moderation/fraud, audit logging, analytics, feature flags, i18n |
| 046 | CI (`.github/workflows/ci.yml`), deploy workflows, `withCronRoute` + `cron_job_heartbeats`, `/api/v1/health/detailed`, `logEvent` and correlation IDs, the `ops-health-check` monitor, runbooks in `docs/operations/`, this file |
| Account Profile & Preferences (feature, not a numbered spec) | `/account/profile` — the customer display name (`customer_profiles.display_name`, the migration-0003 column now declared in the schema) and, in provider mode, the business name, both editable (trimmed, ≤ 60 characters, any script, no control characters, `expectedVersion`); email and phone read-only with verified state. `GET/PATCH /api/v1/users/me/profile`, `GET/PATCH /api/v1/providers/me/profile`. `/account/preferences` — a hub reusing the existing language (042), marketing consent (026), Ask Apuriva suggestions (034) and home personalization (014) APIs. The customer display name now reaches the provider's booking list and the booking conversation (specs 020/025 contracts). No migration. |

## In progress

- **Spec 046** — implemented in the repository; awaiting account-side verification before `Approved`:
  AC-2 (the first staging and production deploys, which need the Vercel projects and GitHub
  Environments, DEP-1/DEP-3), AC-6 (the first recorded Neon restore drill, DEP-2), and the
  branch-protection half of AC-1 (DEP-3), plus the manual pipeline and monitor verification records
  of §6.
- **Spec 043** — Accessibility standards: implemented (`browser/a11y/*`, the `a11y` CI job,
  `scripts/a11y-*.ts`, `docs/accessibility/`, and the Linux-captured `browser/a11y/baseline.json`); status
  stays `Draft` because three criteria depend on work outside this spec
  ([checklist](docs/accessibility/checklist.md#open-items-not-passing-yet)):
  AC-4 (`color-contrast`, 310 nodes — design-token colours, spec 002 DEP-3, wider than the five pairs in
  §1), AC-8 (`apuriva-focus-visible`, 152 nodes — mostly the `Select`/`Input` primitives drawing their ring
  on a wrapper) and AC-2/AC-3 (the manual NVDA/VoiceOver sign-offs, not performed). AC-1, AC-5, AC-6 and
  AC-7 pass. The account-menu focus defect (specs 006/014) and the 375px overflow on Explore, Category,
  Search, Login and Register were fixed in their owning components.
- **Spec 044** — Frontend platform quality: implemented (`app/manifest.ts`, `public/sw.js` +
  `public/sw-rules.js`, `/offline`, `OfflineBanner` and the offline-disabled critical writes, `lib/seo/*`,
  `robots.txt`, `sitemap.xml`, per-segment metadata and JSON-LD, the `perf` CI job with
  `lighthouserc.json`, `scripts/perf-budget.ts` and `browser/perf/inp.browser.ts`); status stays `Draft`:
  - **AC-1** is open on **DEP-2**: the 192px, 512px and maskable 512px icon artwork has not been delivered
    to `public/icons/`. The manifest, worker and offline launch pass; the icon test skips with that reason.
  - **AC-4** is open: the `perf` gate is committed as specified and currently fails. Every budget route
    already transfers 222–227 KB of JavaScript (budget 204,800 bytes; unchanged by 044), `/search` has
    CLS 0.144, and LCP/INP breach too (measured on an under-powered host; CI gives the authoritative values).
    The fixes belong to the owning specs (042's per-page dictionary, 013's `/search`, the shared chrome) —
    see spec 044 §3.7.
  - AC-2, AC-3, AC-5, AC-6 and AC-7 pass. Deployments must set `SITE_URL` (`.env.example`).

## Blocked

- **Spec 045** — Demo mode and seed data. **Blocked by its DEP-1:** a hosted demo runs under
  `NODE_ENV=production`, where every sandbox adapter (payments, payouts, notifications, files, AI)
  refuses to start, and no real adapter exists. Changing that guard is owned by specs
  021/024/026/027/033; spec 046 does not alter it.

## Tested

- Vitest (unit, integration, MCP, security/permission, route-level E2E) — see **Test status**.
- Playwright browser runner (spec 046 §3.6): `browser/smoke.browser.ts` against `next start` on the
  isolated `apuriva_browser_test` database.
- PWA and SEO (spec 044): `browser/pwa/*.browser.ts` (manifest, worker registration, offline page with its
  cached assets, no private data in Cache Storage, offline honesty); `lib/seo/*` and `lib/pwa/*` tests.
- Performance budgets (spec 044): the `perf` job — Lighthouse CI (LCP, CLS, JS bytes) and
  `browser/perf/inp.browser.ts` (INP) on six routes; currently failing (AC-4 open).
- Accessibility gate (spec 043): `browser/a11y/*.browser.ts` — axe (WCAG 2.0–2.2 A/AA), focus visibility,
  reduced motion, keyboard, Urdu parity and 375px overflow, plus the report-only 44px goal — held against
  `browser/a11y/baseline.json` by the `a11y` CI job.
- Static checks: `npm run lint`, `npm run typecheck`, `check:env`, `check:schema-baseline`,
  `check:openapi-drift`, `check:migration-pairing`, `check:no-workspace`, `check:build-status`.

## Known limitations

- **No production adapters.** Every sandbox adapter refuses `NODE_ENV=production`; staging and
  production answer each affected domain's documented `503` until specs 021/024/026/027/033 add real
  adapters. `/api/v1/health/detailed` reports `sandbox_in_production`.
- **File storage** is `local` only; Vercel's filesystem is ephemeral, so production needs spec 027's
  durable object-storage adapter.
- **Rate limits are in-process** (spec 004): per serverless instance on Vercel (spec 046 R-3).
- **Monitoring is a best-effort scheduled GitHub Actions check**, not 24/7 paging
  ([docs/operations/monitoring.md](docs/operations/monitoring.md)).
- **Docker** (`Dockerfile`, `docker-compose.yml`) is local/self-host development only; nothing
  schedules the crons there.

## Next recommended task

For spec 044: the icon artwork (DEP-2)
and the performance remediation in the owning specs (§3.7). For spec 043: spec 002 to regenerate the design
tokens with AA values and move the field primitives' focus ring onto the focused control; then the
manual NVDA/VoiceOver sign-offs.

## Environment setup

```bash
npm ci
cp .env.example .env            # every variable is documented there; check with `npm run check:env`
docker compose up -d postgres   # local Postgres 16
npm run db:migrate
npm run dev                     # http://localhost:3000
```

- Tests: `npm test` — Vitest rewrites `DATABASE_URL` to the isolated `<name>_test` database; it never
  touches the development database.
- Browser tests: `npm run build && npm run test:browser` — Playwright uses `<name>_browser_test`.
- Lint: `npm run lint` (ESLint with `eslint-suppressions.json`; prune fixed entries with
  `npx eslint --prune-suppressions`).

## External integrations

| Integration | State |
|---|---|
| Vercel (`apuriva-staging`, `apuriva-production`, Pro plan, Git auto-deploy off) | **Not provisioned** (spec 046 DEP-1). Workflows are ready. |
| Neon (production with 7-day PITR retention window; staging database) | **Not provisioned** (DEP-2). No restore drill yet ([docs/operations/restore-drills.md](docs/operations/restore-drills.md)). |
| GitHub Environments `staging`, `production` (required reviewer), `monitor-staging`, `monitor-production`; `ops-alert` label; branch protection on `main` | **Not configured** (DEP-3). See [docs/operations/deploy-rollback.md](docs/operations/deploy-rollback.md). |
| Payments, payouts, notifications (SMS/email/push), file storage, AI | Sandbox adapters only. |
| Error tracking / log aggregation / paging vendor | None by decision (spec 046 D-10, D-11); Vercel runtime logs and structured events. |

## Test status

The committed baseline of pre-existing failures is
[`test/known-failures.json`](test/known-failures.json) (spec 046 §3.5). CI fails on any failure not
listed there and on any listed test that now passes. Entries belong to other specs and are reported to
them; none was edited, skipped or weakened.

**Captured 2026-09-28** by one clean full run on the committed tree, in Linux on Node 22 (CI's
runtime) against an isolated `apuriva_test` database: **550 files, 502 passed, 48 failed**. Every
failing file was then re-run alone on the spec 046 tree and on the previous commit without it:

- **33 files passed alone** — timeouts from that run's CPU contention, not defects; not listed.
- **15 files / 19 tests failed alone on both trees** — pre-existing and owned elsewhere; these are the
  baseline's 19 entries:

| Owner | Tests | Cause |
|---|---|---|
| spec 042 (`formatMoney`) | 12, in money-display tests of specs 021–024, 026, 033, 037, 042 | **environment**: Node 22's ICU/CLDR data gives PKR 0 fraction digits (`PKR 150,000`); Node 25 gives 2 (`PKR 1,500.00`) |
| spec 003 | 5 (`schema-coverage`, `migrations`, `concurrency`, `schema-lint`) | stale table lists / fixtures, and jsonb allow-list entries not yet committed (spec 041 §8) |
| spec 011 | 1 (service page "Ask Apuriva" empty state) | ambiguous text query: the label renders twice |
| spec 007 | 1 (`seen-state` localStorage failure) | **environment**: Node 25 has a native `localStorage`, Node 22 does not |

The **environment** entries fail only on Node 22. On a Node 25 developer machine they pass, so
`check-test-baseline` there reports them as stale; CI (Node 22) is the reference runtime.

Browser: `browser/smoke.browser.ts` 3/3 passed against `next start` (customer, provider and admin
personas, the admin completing TOTP MFA).

Accessibility (spec 043, 2026-09-29, Linux Node 22, 2 workers as on CI's 4-vCPU runner, full manifest):
the capture pass ran 436/436 (every keyboard, `lang`/`dir` and 375px-overflow check passing) and produced
the committed baseline; the `CI=true` gate then passed 436/436 against it on two consecutive runs. The
spec 043 unit modules have 95.4% statement coverage (`scripts/a11y-baseline.ts`,
`scripts/a11y-changed-routes.ts`; 39 tests).

PWA/SEO (spec 044, 2026-09-29, Linux Node 22, production build): 56/56 targeted Vitest tests (SEO unit and
integration, service-worker rules, offline components, and the untouched layout and branding tests), with
98.4% statement coverage on `lib/seo/**` (lowest file 97.1%) and 100% on `public/sw-rules.js` and
`lib/pwa/**`; smoke + PWA browser tests
9 passed, 1 skipped (the icon test, DEP-2). The `perf` job fails as documented under **In progress** (AC-4).

## Migration status

- `drizzle/` holds 38 journal entries: `0001_baseline_schema` … `0038_add_cron_job_heartbeats`.
- Each migration from spec 046 onward must ship with a hand-written `_down.sql` and its journal entry
  in the same PR (`check:migration-pairing`). Migrations are expand/contract; `_down.sql` is run only by
  a human ([docs/operations/deploy-rollback.md](docs/operations/deploy-rollback.md)).

## Demo credentials

None — per-visitor sessions; admin evaluators provisioned by operator (spec 045, which is blocked).

## Known bugs

- `check:openapi-drift` reports a mismatch between `lib/api/openapi-registry.ts`
  (`/admin/categories/{categoryId}/subcategories`) and the route directory
  (`app/api/v1/admin/categories/[id]/subcategories`). Pre-existing, owned by spec 010; it makes CI's
  `static` job fail until fixed.
- `check:env` fails on the committed tree: `lib/reviews/limits.ts` (spec 029) reads
  `REVIEW_WINDOW_DAYS`, whose `.env.example` entry exists only as an uncommitted working-tree change.
  Pre-existing, owned by spec 029; it makes CI's `static` job fail until that entry is committed.
- Pre-existing failing tests: see **Test status**.
