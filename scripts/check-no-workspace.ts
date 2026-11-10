/**
 * Spec 001 AC-2, delivered as a CI check by spec 046 §3.4: the repository stays ONE application — no
 * workspace or monorepo tooling (pnpm workspaces, Turborepo, Nx, Lerna, a `packages/` directory, or
 * npm/yarn `workspaces` in package.json).
 *
 * Usage: tsx scripts/check-no-workspace.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FORBIDDEN_PATHS = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json', 'packages'];

export interface Fs {
  exists: (path: string) => boolean;
  readPackageJson: () => { workspaces?: unknown };
}

export function workspaceProblems(fs: Fs): string[] {
  const problems = FORBIDDEN_PATHS.filter((p) => fs.exists(p)).map((p) => `${p} exists`);
  if (fs.readPackageJson().workspaces !== undefined) problems.push('package.json declares "workspaces"');
  return problems;
}

export function run(fs: Fs, io: { log: (l: string) => void; error: (l: string) => void } = { log: console.log, error: console.error }): number {
  const problems = workspaceProblems(fs);
  if (problems.length > 0) {
    io.error(`check:no-workspace FAILED (spec 001 AC-2: one application, no workspace tooling):\n${problems.join('\n')}`);
    return 1;
  }
  io.log('check:no-workspace — OK.');
  return 0;
}

export function repoFs(root: string): Fs {
  return {
    exists: (p) => existsSync(join(root, p)),
    readPackageJson: () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: unknown },
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/check-no-workspace.ts')) {
  process.exit(run(repoFs(join(__dirname, '..'))));
}
