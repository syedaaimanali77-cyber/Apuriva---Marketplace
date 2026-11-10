# syntax=docker/dockerfile:1

# APURIVA production image.
#
# ONE image for the ONE application: the same Next.js server handles both the frontend pages and
# the backend API routes under app/api/v1/**. There is no separate frontend or backend container.
#
# Node 22 Alpine satisfies package.json `engines.node: ">=20"` and next@16.3.4's ">=20.9.0".

# ---------------------------------------------------------------------------
# deps — the full lockfile tree (dev dependencies included), used by the build
# and by the migration toolchain below, which runs `npm run db:migrate` through
# `tsx` (a devDependency).
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# builder — `next build` with output: 'standalone'
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# runner — two trees, deliberately kept apart:
#
#   /app      the standalone server bundle that actually serves traffic
#   /migrate  package.json + lib/db + drizzle + node_modules, so the entrypoint can run the
#             repository's own `npm run db:migrate` verbatim. The standalone trace excludes
#             `tsx` and the drizzle SQL files, so the migration system needs its own tree —
#             it is the existing mechanism, not a second one.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Migration toolchain. `lib/db/migrate.ts` resolves `migrationsFolder: './drizzle'` relative to
# the working directory, which is why the entrypoint runs it from /migrate.
COPY --from=deps --chown=node:node /app/node_modules /migrate/node_modules
COPY --chown=node:node package.json package-lock.json tsconfig.json /migrate/
COPY --chown=node:node lib/db /migrate/lib/db
COPY --chown=node:node drizzle /migrate/drizzle

# Application. server.js, plus the two directories the standalone output does not copy itself.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
