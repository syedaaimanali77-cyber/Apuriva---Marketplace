#!/bin/sh
# APURIVA container entrypoint: apply database migrations, then start the Next.js server.
#
# `npm run db:migrate` is the repository's own migration command (tsx lib/db/migrate.ts).
# Drizzle records every applied migration in its __drizzle_migrations table, so running this
# on every container start is idempotent — a restart re-applies nothing.
#
# `set -e` means a failed migration aborts the container instead of starting an application
# against a schema it does not match.
set -e

echo "[apuriva] applying database migrations..."
cd /migrate
npm run db:migrate

cd /app
echo "[apuriva] starting Next.js on ${HOSTNAME}:${PORT}"
exec node server.js
