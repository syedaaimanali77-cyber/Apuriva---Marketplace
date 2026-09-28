import { describe, expect, it, vi } from 'vitest';
import type { DetailedHealthDto } from '../lib/types/ops';
import type { CheckResult, IssueClient } from './ops-health-check';
import { alertTitle, argValue, CHECKS, evaluate, fetchHealth, githubIssueClient, run, syncIssues } from './ops-health-check';

const NOW = new Date('2026-09-28T12:00:00Z');

function report(overrides: Partial<DetailedHealthDto> = {}, deps: DetailedHealthDto['dependencies'] = []): DetailedHealthDto {
  return {
    status: 'healthy',
    environment: 'production',
    version: '0.1.0',
    commit: 'abc',
    checkedAt: NOW.toISOString(),
    dependencies: [
      { name: 'database', status: 'up', latencyMs: 3 },
      { name: 'migrations', status: 'up' },
      { name: 'cron:payment-sweep', status: 'up' },
      { name: 'kill-switch:ai-assistant', status: 'up' },
      { name: 'adapter:payments', status: 'up' },
      ...deps,
    ],
    ...overrides,
  };
}

const status = (results: CheckResult[], check: string) => results.find((r) => r.check === check)!;

describe('evaluate (spec 046 §3.10)', () => {
  it('passes every check for a healthy, fresh report', () => {
    expect(evaluate({ httpStatus: 200, report: report() }, 'production', NOW).map((r) => r.status)).toEqual(CHECKS.map(() => 'ok'));
  });

  it('check 0: an unreachable endpoint fails fetch and leaves every other check unknown', () => {
    const results = evaluate({ error: 'unreachable' }, 'staging', NOW);
    expect(status(results, 'fetch')).toEqual({ check: 'fetch', status: 'fail', details: ['unreachable'] });
    expect(results.filter((r) => r.check !== 'fetch').every((r) => r.status === 'unknown')).toBe(true);
  });

  it('check 1: 503 with the database down, and migrations behind', () => {
    const down = report({ status: 'down' });
    down.dependencies[0] = { name: 'database', status: 'down', detail: 'unreachable' };
    down.dependencies[1] = { name: 'migrations', status: 'down', detail: 'database_unavailable' };
    expect(status(evaluate({ httpStatus: 503, report: down }, 'production', NOW), 'app-database')).toEqual({
      check: 'app-database',
      status: 'fail',
      details: ['http_503', 'database_down', 'database_unavailable'],
    });
    const behind = report();
    behind.dependencies[1] = { name: 'migrations', status: 'degraded', detail: 'migrations_behind' };
    expect(status(evaluate({ httpStatus: 200, report: behind }, 'production', NOW), 'app-database').details).toEqual(['migrations_behind']);
    const missing = report();
    missing.dependencies.splice(1, 1);
    expect(status(evaluate({ httpStatus: 200, report: missing }, 'production', NOW), 'app-database').details).toEqual(['migrations_missing']);
  });

  it('check 2: stale, never-run and failing sweeps', () => {
    const r = report({}, [
      { name: 'cron:offer-expiry-sweep', status: 'degraded', detail: 'stale' },
      { name: 'cron:sample', status: 'degraded', detail: 'never_ran' },
      { name: 'cron:payout-sweep', status: 'down' },
    ]);
    expect(status(evaluate({ httpStatus: 200, report: r }, 'staging', NOW), 'cron').details).toEqual([
      'offer-expiry-sweep: stale',
      'sample: never_ran',
      'payout-sweep: down',
    ]);
  });

  it('check 3: a kill switch that is off (spec 041 paging)', () => {
    const r = report();
    r.dependencies[3] = { name: 'kill-switch:ai-assistant', status: 'degraded', detail: 'kill_switch_off' };
    expect(status(evaluate({ httpStatus: 200, report: r }, 'production', NOW), 'kill-switch')).toEqual({
      check: 'kill-switch',
      status: 'fail',
      details: ['ai-assistant'],
    });
  });

  it('check 4: a report older than 120 s, from the future, or with a bad timestamp', () => {
    for (const checkedAt of [new Date(NOW.getTime() - 121_000).toISOString(), new Date(NOW.getTime() + 121_000).toISOString(), 'garbage']) {
      expect(status(evaluate({ httpStatus: 200, report: report({ checkedAt }) }, 'production', NOW), 'report-staleness').status).toBe('fail');
    }
    const fresh = new Date(NOW.getTime() - 119_000).toISOString();
    expect(status(evaluate({ httpStatus: 200, report: report({ checkedAt: fresh }) }, 'production', NOW), 'report-staleness').status).toBe('ok');
  });

  it('check 5: sandbox adapters fail only the production leg', () => {
    const r = report();
    r.dependencies[4] = { name: 'adapter:payments', status: 'degraded', detail: 'sandbox_in_production' };
    expect(status(evaluate({ httpStatus: 200, report: r }, 'production', NOW), 'production-adapters').details).toEqual(['payments']);
    expect(status(evaluate({ httpStatus: 200, report: r }, 'staging', NOW), 'production-adapters').status).toBe('ok');
  });
});

describe('fetchHealth', () => {
  const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('sends the bearer token to /api/v1/health/detailed and returns the report with its status', async () => {
    const f = ok({ data: report() }, 503);
    const out = await fetchHealth('https://staging.example/', 'tok', f);
    expect(out).toMatchObject({ httpStatus: 503, report: { commit: 'abc' } });
    const [url, init] = vi.mocked(f).mock.calls[0]!;
    expect(url).toBe('https://staging.example/api/v1/health/detailed');
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('is unreachable on a network error, non-JSON, or a body without a report', async () => {
    expect(await fetchHealth('https://x', 't', vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch)).toEqual({ error: 'unreachable' });
    expect(await fetchHealth('https://x', 't', vi.fn(async () => new Response('<html>')) as unknown as typeof fetch)).toEqual({ error: 'unreachable' });
    expect(await fetchHealth('https://x', 't', ok({ code: 'UNAUTHENTICATED' }, 401))).toEqual({ error: 'unreachable', httpStatus: 401 });
  });
});

describe('syncIssues — one issue per environment and check', () => {
  function client(open: Array<{ number: number; title: string }> = []) {
    return {
      openAlerts: vi.fn(async () => open),
      create: vi.fn<IssueClient['create']>(async () => {}),
      comment: vi.fn<IssueClient['comment']>(async () => {}),
      close: vi.fn<IssueClient['close']>(async () => {}),
    } satisfies IssueClient;
  }
  const ctx = { environment: 'staging', runUrl: 'https://run/1', checkedAt: NOW.toISOString() };

  it('opens a titled, labelled issue for a new failure', async () => {
    const c = client();
    await syncIssues([{ check: 'cron', status: 'fail', details: ['sample: stale'] }], ctx, c);
    expect(c.create).toHaveBeenCalledWith('[ops-alert] staging: cron', expect.stringContaining('`sample: stale`'));
    expect(c.create.mock.calls[0]![1]).toContain('https://run/1');
  });

  it('comments instead of duplicating when the issue is already open', async () => {
    const c = client([{ number: 7, title: alertTitle('staging', 'cron') }]);
    await syncIssues([{ check: 'cron', status: 'fail', details: [] }], ctx, c);
    expect(c.create).not.toHaveBeenCalled();
    expect(c.comment).toHaveBeenCalledWith(7, expect.stringContaining('(no detail)'));
  });

  it('comments "recovered" and closes on a pass; leaves unknown checks and other environments alone', async () => {
    const c = client([
      { number: 7, title: alertTitle('staging', 'cron') },
      { number: 8, title: alertTitle('staging', 'kill-switch') },
      { number: 9, title: alertTitle('production', 'cron') },
    ]);
    await syncIssues(
      [
        { check: 'cron', status: 'ok', details: [] },
        { check: 'kill-switch', status: 'unknown', details: [] },
      ],
      ctx,
      c,
    );
    expect(c.comment).toHaveBeenCalledWith(7, expect.stringMatching(/^Recovered at /));
    expect(c.close).toHaveBeenCalledWith(7);
    expect(c.close).toHaveBeenCalledTimes(1);
  });
});

describe('githubIssueClient', () => {
  it('lists open ops-alert issues (not PRs), and creates, comments and closes through the REST API', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const f = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (init.method === 'GET') return new Response(JSON.stringify([{ number: 1, title: 'a' }, { number: 2, title: 'pr', pull_request: {} }]));
      return new Response(init.method === 'PATCH' ? null : '{}', { status: init.method === 'PATCH' ? 204 : 201 });
    }) as unknown as typeof fetch;
    const c = githubIssueClient('o/r', 'gh', f);

    expect(await c.openAlerts()).toEqual([{ number: 1, title: 'a' }]);
    await c.create('t', 'b');
    await c.comment(1, 'c');
    await c.close(1);
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'GET https://api.github.com/repos/o/r/issues?state=open&labels=ops-alert&per_page=100',
      'POST https://api.github.com/repos/o/r/issues',
      'POST https://api.github.com/repos/o/r/issues/1/comments',
      'PATCH https://api.github.com/repos/o/r/issues/1',
    ]);
    expect(calls[1]!.body).toEqual({ title: 't', body: 'b', labels: ['ops-alert'] });
    expect(calls[3]!.body).toEqual({ state: 'closed' });
  });

  it('throws on a GitHub API error, so the run fails loudly', async () => {
    const c = githubIssueClient('o/r', 'gh', vi.fn(async () => new Response('no', { status: 403 })) as unknown as typeof fetch);
    await expect(c.openAlerts()).rejects.toThrow(/403/);
  });
});

describe('run', () => {
  function deps(healthBody: unknown, healthStatus = 200) {
    const logs: string[] = [];
    const errors: string[] = [];
    const written: Record<string, string> = {};
    const github: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: { method?: string }) => {
      if (url.includes('/api/v1/health/detailed')) return new Response(JSON.stringify(healthBody), { status: healthStatus });
      github.push(`${init.method} ${url}`);
      return new Response(init.method === 'GET' ? '[]' : '{}', { status: 200 });
    }) as unknown as typeof fetch;
    return {
      logs,
      errors,
      written,
      github,
      d: {
        env: { MONITORING_TOKEN: 'm', GITHUB_TOKEN: 'g' },
        now: () => NOW,
        fetchImpl,
        writeFile: (p: string, c: string) => {
          written[p] = c;
        },
        log: (l: string) => logs.push(l),
        error: (l: string) => errors.push(l),
      },
    };
  }
  const args = ['--environment', 'production', '--base-url', 'https://prod.example', '--repo', 'o/r', '--run-url', 'https://run/9', '--output', 'h.json'];

  it('exits 0 for a healthy report, writes the artefact, and opens no issue', async () => {
    const t = deps({ data: report() });
    expect(await run(args, t.d)).toBe(0);
    expect(JSON.parse(t.written['h.json']!).httpStatus).toBe(200);
    expect(t.github).toEqual(['GET https://api.github.com/repos/o/r/issues?state=open&labels=ops-alert&per_page=100']);
  });

  it('exits 1 and opens an issue when a check fails', async () => {
    const r = report();
    r.dependencies[3] = { name: 'kill-switch:ai-assistant', status: 'degraded', detail: 'kill_switch_off' };
    const t = deps({ data: r });
    expect(await run(args, t.d)).toBe(1);
    expect(t.errors[0]).toMatch(/production FAILED: kill-switch/);
    expect(t.github).toContain('POST https://api.github.com/repos/o/r/issues');
  });

  it('exits 2 when required arguments or tokens are missing', async () => {
    const t = deps({});
    expect(await run(['--environment', 'staging'], t.d)).toBe(2);
    expect(await run(args, { ...t.d, env: {} })).toBe(2);
    expect(argValue(['--x', 'y'], '--x')).toBe('y');
    expect(argValue([], '--x')).toBeUndefined();
  });
});
