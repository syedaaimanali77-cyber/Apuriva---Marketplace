/**
 * Spec 043 §3.5 — the accessibility violation baseline and its ratchet, as pure functions. Kept outside
 * `browser/` (which Vitest excludes) so `scripts/a11y-baseline.test.ts` covers it; the browser checks in
 * `browser/a11y/*.browser.ts` import it.
 *
 * `browser/a11y/baseline.json` maps `"<routeId>[@ur]|<viewport>|<ruleId>"` to the number of violating
 * nodes. Counts, not selectors: this repository's CSS-module class names are hashed per build.
 *
 *   NEW violation — a key whose count is above its baseline, or absent from the baseline with count > 0.
 *   STALE entry   — a key whose count is BELOW its baseline: "baseline stale: lower <key> to <n>"; at 0 the
 *                   key is deleted. The baseline only ratchets down.
 *
 * There is no update path in CI: capturing (`A11Y_CAPTURE_BASELINE`) refuses to run when `CI` is set.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type A11yBaseline = Readonly<Record<string, number>>;

export const CUSTOM_RULES = ['apuriva-reduced-motion', 'apuriva-focus-visible'] as const;

export function baselineKey(routeId: string, ur: boolean, viewport: string, ruleId: string): string {
  return `${routeId}${ur ? '@ur' : ''}|${viewport}|${ruleId}`;
}

export function scopeOf(routeId: string, ur: boolean, viewport: string): string {
  return `${routeId}${ur ? '@ur' : ''}|${viewport}|`;
}

export function ruleOf(key: string): string {
  return key.slice(key.lastIndexOf('|') + 1);
}

export interface CountDifference {
  key: string;
  current: number;
  baseline: number;
}

export interface BaselineComparison {
  newViolations: CountDifference[];
  stale: CountDifference[];
}

/**
 * Compares the counts one check produced for one `route[@ur]|viewport` scope with the baseline entries of
 * that scope whose rule the check owns (`ownsRule`): an axe scan owns the axe rule ids, the focus check owns
 * `apuriva-focus-visible`, and so on. A rule absent from `current` counts as 0.
 */
export function compareScope(
  scope: string,
  current: Readonly<Record<string, number>>,
  baseline: A11yBaseline,
  ownsRule: (ruleId: string) => boolean,
): BaselineComparison {
  const keys = new Set<string>();
  for (const k of Object.keys(current)) if (k.startsWith(scope) && ownsRule(ruleOf(k))) keys.add(k);
  for (const k of Object.keys(baseline)) if (k.startsWith(scope) && ownsRule(ruleOf(k))) keys.add(k);

  const newViolations: CountDifference[] = [];
  const stale: CountDifference[] = [];
  for (const key of [...keys].sort()) {
    const now = current[key] ?? 0;
    const was = baseline[key] ?? 0;
    if (now > was) newViolations.push({ key, current: now, baseline: was });
    else if (now < was) stale.push({ key, current: now, baseline: was });
  }
  return { newViolations, stale };
}

export const isAxeRule = (ruleId: string): boolean => !(CUSTOM_RULES as readonly string[]).includes(ruleId);

export function describeComparison(c: BaselineComparison): string[] {
  return [
    ...c.newViolations.map((d) => `NEW violation: ${d.key} = ${d.current} (baseline ${d.baseline})`),
    ...c.stale.map((d) => `baseline stale: lower \`${d.key}\` to \`${d.current}\`${d.current === 0 ? ' (delete the key)' : ''}`),
  ];
}

/** Problems with the committed file itself: every key well-formed, every count a positive integer. */
export function validateBaseline(baseline: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(baseline)) {
    if (!/^[a-z0-9.-]+(@ur)?\|(mobile|desktop)\|[a-z0-9-]+$/.test(key)) problems.push(`malformed key "${key}"`);
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) problems.push(`"${key}" must be a positive integer (a key at 0 is deleted)`);
  }
  return problems;
}

/** Which keys a capture would raise or create relative to the committed baseline (printed for review, §3.5). */
export function raisedKeys(captured: Readonly<Record<string, number>>, baseline: A11yBaseline): CountDifference[] {
  return Object.entries(captured)
    .filter(([key, n]) => n > (baseline[key] ?? 0))
    .map(([key, n]) => ({ key, current: n, baseline: baseline[key] ?? 0 }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Merges capture lines (each a scope's full set of counts for the rules one check owns) into a baseline. */
export function mergeCapture(
  base: A11yBaseline,
  captures: ReadonlyArray<{ scope: string; owns: 'axe' | (typeof CUSTOM_RULES)[number]; counts: Record<string, number> }>,
): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const { scope, owns, counts } of captures) {
    const own = (rule: string) => (owns === 'axe' ? isAxeRule(rule) : rule === owns);
    for (const key of Object.keys(out)) if (key.startsWith(scope) && own(ruleOf(key))) delete out[key];
    for (const [key, n] of Object.entries(counts)) if (n > 0 && key.startsWith(scope) && own(ruleOf(key))) out[key] = n;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * `tsx scripts/a11y-baseline.ts merge <capture.jsonl>` — folds a local capture run
 * (`A11Y_CAPTURE_BASELINE=1 npm run test:browser -- browser/a11y`) into browser/a11y/baseline.json and prints
 * every key it creates or raises, so the PR shows them. Refused in CI.
 */
export function runMerge(
  args: readonly string[],
  io: { readFile: (p: string) => string; writeFile: (p: string, c: string) => void; log: (l: string) => void; error: (l: string) => void; env: Record<string, string | undefined> },
  baselinePath: string,
): number {
  if (args[0] !== 'merge' || !args[1]) {
    io.error('Usage: tsx scripts/a11y-baseline.ts merge <capture.jsonl>');
    return 2;
  }
  if (io.env.CI) {
    io.error('a11y-baseline: merging a capture is refused in CI (spec 043 §3.5).');
    return 1;
  }
  const base = JSON.parse(io.readFile(baselinePath)) as Record<string, number>;
  const captures = io.readFile(args[1]).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Parameters<typeof mergeCapture>[1][number]);
  const merged = mergeCapture(base, captures);
  for (const r of raisedKeys(merged, base)) io.log(`RAISED ${r.key}: ${r.baseline} -> ${r.current}`);
  io.writeFile(baselinePath, `${JSON.stringify(merged, null, 2)}\n`);
  io.log(`a11y-baseline: ${Object.keys(merged).length} key(s) written.`);
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/a11y-baseline.ts')) {
  process.exit(
    runMerge(
      process.argv.slice(2),
      { readFile: (p) => readFileSync(p, 'utf8'), writeFile: (p, c) => writeFileSync(p, c), log: console.log, error: console.error, env: process.env },
      join(__dirname, '..', 'browser', 'a11y', 'baseline.json'),
    ),
  );
}
