# Apuriva

Single Next.js application (App Router) containing both the frontend and the backend. See
[`docs/specs/2026-08-28-001-application-environment-foundation.md`](docs/specs/2026-08-28-001-application-environment-foundation.md)
for the spec this foundation implements, and [`docs/workflow.md`](docs/workflow.md) for the
full feature build order.

There is no monorepo: one `package.json`, one deployable app, no workspace tooling.

## Prerequisites

- Node.js >= 20
- Docker (for local Postgres)

## Local setup

```bash
npm install
cp .env.example .env      # fill in local values if you change any defaults
docker compose up -d      # starts local Postgres on localhost:5432
npm run db:migrate        # applies migrations (none yet — schema starts in spec 003)
npm run dev                # starts the app at http://localhost:3000
```

Health check: `GET http://localhost:3000/api/v1/health` — returns process status, DB
connectivity, and build/version metadata.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the app locally (hot reload) |
| `npm run build` | Production build |
| `npm run start` | Run the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run the test suite once (Vitest) |
| `npm run test:watch` | Run the test suite in watch mode |
| `npm run check:env` | Fail if any `process.env.X` read in the app is undocumented in `.env.example` |
| `npm run db:generate` | Generate a SQL migration from `lib/db/schema.ts` (Drizzle Kit) |
| `npm run db:migrate` | Apply pending migrations against `DATABASE_URL` |

## Environment variables

Every variable the app reads from `process.env` is documented in [`.env.example`](.env.example)
— `npm run check:env` enforces this. Never commit a real secret; `.env` is gitignored.

## Project structure (modular monolith)

The app is one deployable unit, but internally it's organized as a modular monolith: each
domain module (auth, requests, offers, bookings, payments, etc. — one per feature spec) lives in
its own clearly-bounded folder under `lib/`, rather than as a separately-versioned workspace
package. Modules are added as their specs are implemented; `lib/db/` (this spec) is the first —
it owns the shared Postgres connection pool and migration tooling that every later module's data
access builds on.

```
app/                    Next.js App Router — pages and API routes (app/api/v1/...)
lib/
  db/                    Connection pooling (pg) + Drizzle ORM client + migration runner
scripts/                 Standalone CLI/CI scripts (env-parity check, etc.)
drizzle/                 Generated SQL migrations (reviewed in PR, never hand-edited)
docs/specs/              Feature specs, one per numbered build-order entry
ui/                      APURIVA Design System source of truth (tokens, components) — imported
                         directly by app/ (see "Design system" below); full component-library
                         wiring is spec 002's job, not this one
```

## Background/scheduled jobs

Scheduled work (offer expiry, notification dispatch, payout eligibility, etc.) runs through
**Vercel Cron** calling internal Next.js API routes under `app/api/v1/cron/**` — not a
separately-deployed, always-on worker process. Each cron route checks a shared `CRON_SECRET`
bearer token so it can't be triggered by anyone else. See `app/api/v1/cron/sample/route.ts` for
the reference implementation and `vercel.json` for the schedule.

## Design system

UI/styling is sourced from the approved APURIVA Design System in [`ui/`](ui/) — no other design
system or UI library is introduced.

- **Tokens:** `app/styles/apuriva-tokens.css` is generated verbatim from `ui/_ds_manifest.json`
  (colors, typography scale, spacing, radius, elevation, motion, layout, and semantic aliases
  like `--action-primary-bg`). Regenerate it from the manifest if `ui/` changes — never hand-edit
  values.
- **Fonts:** `app/fonts.ts` self-hosts the four brand fonts (`ui/_ds_manifest.json` →
  `brandFonts`: Sora, Source Sans 3, IBM Plex Mono, Noto Nastaliq Urdu) via `next/font/google`,
  each exposed under the exact CSS variable name the DS's components expect (`--font-display`,
  `--font-sans`, `--font-mono`, `--font-urdu`).
- **Components:** the home page (`app/page.tsx`) imports real components straight from
  `ui/components/` (`Badge`, `Button`, `Card`, `Icon`) rather than reimplementing them — the
  full primitive library is still spec 002's job, but nothing here forks or duplicates it.
- **Branding:** the root layout applies the font-variable classes to `<html>`; the home page
  renders `ui/assets/apuriva-logo-full.jpeg` via `next/image`.
