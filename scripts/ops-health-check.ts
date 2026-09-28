/**
 * Spec 046 §3.10 — the logic behind `.github/workflows/ops-health-check.yml`.
 *
 * WHAT THIS IS: a SCHEDULED HEALTH CHECK run by GitHub Actions (every 5 minutes, best-effort). It is
 * not a 24/7 monitoring service: no on-call rotation, no escalation, no delivery guarantee, and it
 * cannot notice its own absence (the weekly human check in docs/operations/monitoring.md covers that).
 *
 * For one environment it fetches `GET <base-url>/api/v1/health/detailed` with the MONITORING_TOKEN,
 * evaluates the six §3.10 checks, and turns the result into a signal:
 *   - a failed check → exit 1 (the run goes red) and exactly one open `[ops-alert] <env>: <check>` issue
 *     (labelled `ops-alert`), created or commented on;
 *   - a passing check whose issue is open → a "recovered" comment and the issue is closed;
 *   - a check that could not be evaluated (the endpoint was unreachable) → its issue is left as it is.
 *
 * Usage (CI):
 *   MONITORING_TOKEN=… GITHUB_TOKEN=… tsx scripts/ops-health-check.ts \
 *     --environment staging --base-url https://… --repo owner/name --run-url https://… [--output health.json]
 */
import { writeFileSync } from 'node:fs';
import type { DetailedHealthDto } from '../lib/types/ops';

export const CHECKS = ['fetch', 'app-database', 'cron', 'kill-switch', 'report-staleness', 'production-adapters'] as const;
export type CheckName = (typeof CHECKS)[number];
export type CheckStatus = 'ok' | 'fail' | 'unknown';

export interface CheckResult {
  check: CheckName;
  status: CheckStatus;
  details: string[];
}

export interface FetchOutcome {
  /** Set when the request failed, timed out, or the body was not JSON. */
  error?: 'unreachable';
  httpStatus?: number;
  report?: DetailedHealthDto;
}

export const MAX_REPORT_AGE_MS = 120_000;
export const FETCH_TIMEOUT_MS = 20_000;
export const ALERT_LABEL = 'ops-alert';

export function evaluate(outcome: FetchOutcome, environment: string, runnerNow: Date): CheckResult[] {
  const result = (check: CheckName, status: CheckStatus, details: string[] = []): CheckResult => ({ check, status, details });

  if (outcome.error || !outcome.report) {
    return CHECKS.map((c) => (c === 'fetch' ? result('fetch', 'fail', ['unreachable']) : result(c, 'unknown')));
  }
  const { report, httpStatus } = outcome;
  const deps = report.dependencies;
  const failing = (prefix: string) => deps.filter((d) => d.name.startsWith(prefix) && d.status !== 'up');

  const appDetails: string[] = [];
  if (httpStatus !== 200) appDetails.push(`http_${httpStatus}`);
  if (deps.find((d) => d.name === 'database')?.status !== 'up') appDetails.push('database_down');
  const migrations = deps.find((d) => d.name === 'migrations');
  if (migrations?.status !== 'up') appDetails.push(migrations?.detail ?? 'migrations_missing');

  const cron = failing('cron:').map((d) => `${d.name.slice('cron:'.length)}: ${d.detail ?? d.status}`);
  const killSwitches = failing('kill-switch:').map((d) => d.name.slice('kill-switch:'.length));
  const checkedAt = Date.parse(report.checkedAt);
  const stale = Number.isNaN(checkedAt) || Math.abs(runnerNow.getTime() - checkedAt) > MAX_REPORT_AGE_MS;
  const sandboxes = deps.filter((d) => d.name.startsWith('adapter:') && d.detail === 'sandbox_in_production').map((d) => d.name.slice('adapter:'.length));

  return [
    result('fetch', 'ok'),
    result('app-database', appDetails.length ? 'fail' : 'ok', appDetails),
    result('cron', cron.length ? 'fail' : 'ok', cron),
    result('kill-switch', killSwitches.length ? 'fail' : 'ok', killSwitches),
    result('report-staleness', stale ? 'fail' : 'ok', stale ? ['report_stale'] : []),
    environment === 'production'
      ? result('production-adapters', sandboxes.length ? 'fail' : 'ok', sandboxes)
      : result('production-adapters', 'ok'),
  ];
}

export async function fetchHealth(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOutcome> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/v1/health/detailed`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const body = (await res.json()) as { data?: DetailedHealthDto };
    if (!body?.data || !Array.isArray(body.data.dependencies)) return { error: 'unreachable', httpStatus: res.status };
    return { httpStatus: res.status, report: body.data };
  } catch {
    return { error: 'unreachable' };
  }
}

export interface Issue {
  number: number;
  title: string;
}

export interface IssueClient {
  openAlerts: () => Promise<Issue[]>;
  create: (title: string, body: string) => Promise<void>;
  comment: (issue: number, body: string) => Promise<void>;
  close: (issue: number) => Promise<void>;
}

export const alertTitle = (environment: string, check: CheckName) => `[${ALERT_LABEL}] ${environment}: ${check}`;

export async function syncIssues(
  results: readonly CheckResult[],
  context: { environment: string; runUrl: string; checkedAt: string },
  client: IssueClient,
): Promise<void> {
  const open = await client.openAlerts();
  for (const r of results) {
    if (r.status === 'unknown') continue;
    const title = alertTitle(context.environment, r.check);
    const existing = open.find((i) => i.title === title);
    if (r.status === 'fail') {
      const body = [
        `**${r.check}** failed for **${context.environment}** at ${context.checkedAt}.`,
        '',
        ...(r.details.length ? r.details.map((d) => `- \`${d}\``) : ['- (no detail)']),
        '',
        `Run: ${context.runUrl}`,
        'Response guidance: docs/operations/monitoring.md',
      ].join('\n');
      if (existing) await client.comment(existing.number, body);
      else await client.create(title, body);
    } else if (existing) {
      await client.comment(existing.number, `Recovered at ${context.checkedAt}. Run: ${context.runUrl}`);
      await client.close(existing.number);
    }
  }
}

/** GitHub REST client for the repository's `ops-alert` issues. */
export function githubIssueClient(repo: string, token: string, fetchImpl: typeof fetch = fetch): IssueClient {
  const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw new Error(`GitHub API ${init.method ?? 'GET'} ${path} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    openAlerts: async () =>
      ((await api(`/issues?state=open&labels=${ALERT_LABEL}&per_page=100`)) as Array<{ number: number; title: string; pull_request?: unknown }>)
        .filter((i) => !i.pull_request)
        .map(({ number, title }) => ({ number, title })),
    create: async (title, body) => {
      await api('/issues', { method: 'POST', body: { title, body, labels: [ALERT_LABEL] } });
    },
    comment: async (issue, body) => {
      await api(`/issues/${issue}/comments`, { method: 'POST', body: { body } });
    },
    close: async (issue) => {
      await api(`/issues/${issue}`, { method: 'PATCH', body: { state: 'closed' } });
    },
  };
}

export function argValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export interface RunDeps {
  env: { MONITORING_TOKEN?: string; GITHUB_TOKEN?: string };
  now: () => Date;
  fetchImpl: typeof fetch;
  writeFile: (path: string, content: string) => void;
  log: (line: string) => void;
  error: (line: string) => void;
}

export async function run(args: readonly string[], deps: RunDeps): Promise<number> {
  const environment = argValue(args, '--environment');
  const baseUrl = argValue(args, '--base-url');
  const repo = argValue(args, '--repo');
  const runUrl = argValue(args, '--run-url') ?? '(local run)';
  const output = argValue(args, '--output');
  const token = deps.env.MONITORING_TOKEN;
  if (!environment || !baseUrl || !repo || !token || !deps.env.GITHUB_TOKEN) {
    deps.error('ops-health-check: --environment, --base-url, --repo, MONITORING_TOKEN and GITHUB_TOKEN are required.');
    return 2;
  }

  const outcome = await fetchHealth(baseUrl, token, deps.fetchImpl);
  if (output) deps.writeFile(output, JSON.stringify(outcome, null, 2));
  const now = deps.now();
  const results = evaluate(outcome, environment, now);

  for (const r of results) deps.log(`${r.status.toUpperCase().padEnd(7)} ${r.check}${r.details.length ? ` — ${r.details.join(', ')}` : ''}`);
  await syncIssues(results, { environment, runUrl, checkedAt: now.toISOString() }, githubIssueClient(repo, deps.env.GITHUB_TOKEN, deps.fetchImpl));

  const failed = results.filter((r) => r.status === 'fail');
  if (failed.length > 0) {
    deps.error(`ops-health-check: ${environment} FAILED: ${failed.map((r) => r.check).join(', ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/ops-health-check.ts')) {
  run(process.argv.slice(2), {
    env: { MONITORING_TOKEN: process.env.MONITORING_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    now: () => new Date(),
    fetchImpl: fetch,
    writeFile: (p, c) => writeFileSync(p, c),
    log: console.log,
    error: console.error,
  }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`ops-health-check crashed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
