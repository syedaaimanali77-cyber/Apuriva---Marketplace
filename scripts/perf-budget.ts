/**
 * Spec 044 §3.7 (AC-4, D-3) — the Lighthouse CI half of the performance budgets (LCP ≤ 2.5 s, CLS ≤ 0.1,
 * ≤ 204,800 bytes of compressed JavaScript on initial load; median of 3 runs, mobile emulation, simulated
 * Slow 4G + 4× CPU — see lighthouserc.json). INP is browser/perf/inp.browser.ts.
 *
 * Run after `npm run build`:  npx tsx scripts/perf-budget.ts
 *
 * It resets and migrates the isolated `<name>_browser_test` database (spec 046's, never the development
 * one), starts `next start` on :3100 against it, resolves the six budget routes' concrete ids from the
 * public catalog API, runs `lhci autorun` from a temporary directory (so `.lighthouseci/` never lands in
 * the repository) and exits with its status: any budget breach fails. There is no baseline or exception.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PERF_PORT = 3100;

/** The §3.7 budget routes, with the catalog ids resolved from the running app. */
export async function resolveBudgetUrls(base: string, getJson: (url: string) => Promise<unknown>): Promise<string[]> {
  const categories = ((await getJson(`${base}/api/v1/categories`)) as { data: Array<{ id: string }> }).data;
  for (const category of categories) {
    const page = ((await getJson(`${base}/api/v1/categories/${category.id}/page`)) as { data: { popularServices: Array<{ id: string }> } }).data;
    const service = page.popularServices[0];
    if (service) {
      return [
        `${base}/`,
        `${base}/explore`,
        `${base}/explore/${category.id}`,
        `${base}/explore/${category.id}/${service.id}`,
        `${base}/search?q=cleaning`,
        `${base}/login`,
      ];
    }
  }
  throw new Error('perf-budget: no published category with a published service (migration 0006 seeds them).');
}

/** `lhci autorun` arguments: the repository's config plus one --collect.url per budget route. */
export function lhciArgs(configPath: string, urls: readonly string[]): string[] {
  return ['autorun', `--config=${configPath}`, ...urls.map((u) => `--collect.url=${u}`)];
}

async function waitForHealth(base: string, server: ChildProcess): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    if (server.exitCode !== null) throw new Error(`perf-budget: next start exited with ${server.exitCode}`);
    try {
      if ((await fetch(`${base}/api/v1/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('perf-budget: the server did not become healthy in 120 s');
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  const root = path.resolve(__dirname, '..');
  const { config } = await import('dotenv');
  for (const file of ['.env.test.local', '.env.test', '.env.local', '.env']) config({ path: path.join(root, file), override: false, quiet: true });
  const { resetBrowserDatabase, toBrowserDatabaseUrl } = await import('../test/browser-database');
  if (!process.env.DATABASE_URL) throw new Error('perf-budget: DATABASE_URL is required (see .env.example).');
  const databaseUrl = toBrowserDatabaseUrl(process.env.DATABASE_URL);
  await resetBrowserDatabase(databaseUrl);

  const base = `http://localhost:${PERF_PORT}`;
  const env = { ...process.env, DATABASE_URL: databaseUrl, PORT: String(PERF_PORT) };
  // Next's own entry point, not `npx`: killing an npx wrapper would orphan the real server on the port.
  const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--port', String(PERF_PORT)], { cwd: root, env, stdio: 'inherit' });
  try {
    await waitForHealth(base, server);
    const urls = await resolveBudgetUrls(base, async (u) => (await fetch(u)).json());
    console.log(`perf-budget: measuring ${urls.length} routes, 3 runs each:\n  ${urls.join('\n  ')}`);
    // Lighthouse needs a Chrome; on a runner without one, use Playwright's Chromium.
    if (!process.env.CHROME_PATH) {
      const { chromium } = await import('@playwright/test');
      process.env.CHROME_PATH = chromium.executablePath();
    }
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'apuriva-lhci-'));
    console.log(`perf-budget: Lighthouse results in ${workDir}`);
    // The repository's installed CLI, run by path: `npx` from the temporary directory would look elsewhere.
    const lhci = require.resolve('@lhci/cli/src/cli.js');
    return await run(process.execPath, [lhci, ...lhciArgs(path.join(root, 'lighthouserc.json'), urls), `--upload.outputDir=${path.join(workDir, 'reports')}`], {
      cwd: workDir,
      env: process.env,
    });
  } finally {
    server.kill();
    await new Promise<void>((resolve) => (server.exitCode !== null ? resolve() : server.once('exit', () => resolve())));
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/perf-budget.ts')) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
