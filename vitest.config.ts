import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { config as loadEnvFile } from 'dotenv';
import { toTestDatabaseUrl } from './test/test-database';

// Vitest, unlike `next dev`/`drizzle-kit`, does not read `.env` itself — so without this every
// integration test saw an undefined `DATABASE_URL` and silently `describe.skipIf`'d itself, and
// anything reaching `lib/auth/secret.ts` failed on a missing `AUTH_SECRET`. A suite that reports
// green while testing nothing is worse than one that fails, so load the project's env files the
// same way the rest of the toolchain does. `override: false` means an explicitly exported shell
// variable still wins, and earlier files in this list win over later ones.
const ENV_FILES = ['.env.test.local', '.env.test', '.env.local', '.env'] as const;
const projectEnvKeys = new Set<string>();
for (const file of ENV_FILES) {
  const { parsed } = loadEnvFile({ path: path.resolve(__dirname, file), override: false, quiet: true });
  for (const key of Object.keys(parsed ?? {})) projectEnvKeys.add(key);
}

// Tests must never touch the developer's normal database (the one `next dev` reads):
// test/db-reset.ts drops and recreates whatever DATABASE_URL names, and integration tests write
// fixture rows into it. Point this process — and so global setup and every worker it spawns — at
// a sibling `<name>_test` database instead (e.g. `apuriva` → `apuriva_test`).
if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = toTestDatabaseUrl(process.env.DATABASE_URL);
}

// Forwarded to every worker thread. Built after the rewrite above, so workers can only ever
// receive the isolated `*_test` URL — never the developer's own database.
const workerEnv: Record<string, string> = {};
for (const key of [...projectEnvKeys, 'DATABASE_URL', 'AUTH_SECRET']) {
  const value = process.env[key];
  if (value !== undefined) workerEnv[key] = value;
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // next/font/google only resolves inside Next's own build pipeline — stub it for tests.
      'next/font/google': path.resolve(__dirname, 'test/mocks/next-font-google.ts'),
    },
  },
  test: {
    // 'forks' (the default) times out spawning workers in this sandboxed environment;
    // 'threads' (worker_threads) starts reliably.
    pool: 'threads',
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    env: workerEnv,
    // Resets the isolated test database (above) to a clean, migrations-only state before and
    // after the whole run — see test/db-reset.ts for why integration tests need this instead of
    // per-file cleanup.
    globalSetup: ['./test/db-reset.ts'],
    // `e2e/*.spec.ts` is the filename spec 005 §6 names for end-to-end coverage; it does not match
    // the `*.test.*` convention every other suite uses, so it needs its own pattern.
    include: ['**/*.test.{ts,tsx}', 'e2e/**/*.spec.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'drizzle'],
    // The default 5000ms is tight for userEvent-driven component tests once the full suite runs
    // many files' worker threads concurrently in this sandboxed environment (same contention
    // `pool: 'threads'` above already works around) — those tests pass individually well under
    // 5s but can time out purely from CPU contention at full-suite scale.
    testTimeout: 15000,
  },
});
