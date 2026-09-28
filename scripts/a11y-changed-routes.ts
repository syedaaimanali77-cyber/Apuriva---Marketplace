/**
 * Spec 043 §3.4 (decision D-4) — which audited routes (browser/a11y/routes.ts) a change must re-scan:
 *
 *   1. the files changed since the merge base with the base branch (`git diff <base>...HEAD`);
 *   2. none under app/, components/, ui/, lib/, browser/a11y/, package.json, package-lock.json or
 *      next.config.ts                                                   → SKIP (logged reason);
 *   3. any shared file (FULL_SCAN_PATTERNS)                              → FULL manifest;
 *   4. otherwise every route whose `sourceDir` is a path prefix of a changed file; none → SKIP.
 *
 * A push to main always scans the full manifest (`--push`), so nothing escapes a mis-scoped PR.
 *
 * Usage (CI): tsx scripts/a11y-changed-routes.ts --base origin/main [--push] >> "$GITHUB_OUTPUT"
 * prints `mode=<skip|full|routes>`, `routes=<comma-separated ids>` and `reason=<text>`.
 */
import { A11Y_ROUTES, sourceDirsOf, type AuditedRoute } from '../browser/a11y/routes';
import { baseArg, isUsableBase, realGit, type Git } from './ci-git';

export const RELEVANT_PREFIXES = ['app/', 'components/', 'ui/', 'lib/', 'browser/a11y/', 'package.json', 'package-lock.json', 'next.config.ts'];

export const FULL_SCAN_PATTERNS: readonly RegExp[] = [
  /^components\//,
  /^ui\//,
  /^lib\//,
  /^app\/layout\.tsx$/,
  /^app\/globals\.css$/,
  /^app\/styles\//,
  /^app\/components\//,
  /^app\/_components\//,
  /^app\/(error|loading|not-found|global-error)\.tsx$/,
  /^browser\/a11y\//,
  /^package(-lock)?\.json$/,
  /^next\.config\.ts$/,
];

export type Selection =
  | { mode: 'skip'; routes: []; reason: string }
  | { mode: 'full'; routes: string[]; reason: string }
  | { mode: 'routes'; routes: string[]; reason: string };

/** `sourceDir` is a path prefix of `file` on a path boundary (so `app/requests/new` never matches `app/requests/newer`). */
export function owns(route: AuditedRoute, file: string): boolean {
  return sourceDirsOf(route).some((dir) => file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`));
}

export function selectRoutes(changed: readonly string[], options: { push?: boolean; routes?: readonly AuditedRoute[] } = {}): Selection {
  const routes = options.routes ?? A11Y_ROUTES;
  const all = routes.map((r) => r.id);
  if (options.push) return { mode: 'full', routes: all, reason: 'push to main: full manifest' };

  const relevant = changed.filter((f) => RELEVANT_PREFIXES.some((p) => f === p || f.startsWith(p)));
  if (relevant.length === 0) return { mode: 'skip', routes: [], reason: 'no change under app/, components/, ui/, lib/, browser/a11y/ or the package manifests' };

  const shared = relevant.find((f) => FULL_SCAN_PATTERNS.some((re) => re.test(f)));
  if (shared) return { mode: 'full', routes: all, reason: `shared file changed: ${shared}` };

  const selected = routes.filter((r) => relevant.some((f) => owns(r, f))).map((r) => r.id);
  if (selected.length === 0) return { mode: 'skip', routes: [], reason: 'no audited route owns a changed file' };
  return { mode: 'routes', routes: selected, reason: `${selected.length} route(s) own a changed file` };
}

export function run(args: readonly string[], git: Pick<Git, 'changedFiles'> = realGit, log: (line: string) => void = console.log): number {
  const push = args.includes('--push');
  const base = baseArg(args);
  let selection: Selection;
  if (push) selection = selectRoutes([], { push: true });
  else if (!isUsableBase(base)) selection = { mode: 'full', routes: A11Y_ROUTES.map((r) => r.id), reason: 'no base ref: full manifest' };
  else selection = selectRoutes(git.changedFiles(base).map((c) => c.path));
  log(`mode=${selection.mode}`);
  log(`routes=${selection.routes.join(',')}`);
  log(`reason=${selection.reason}`);
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/a11y-changed-routes.ts')) {
  process.exit(run(process.argv.slice(2)));
}
