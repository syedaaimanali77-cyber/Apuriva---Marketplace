import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequestCorrelationId } from '@/lib/audit/request-context';

vi.mock('./heartbeats', () => ({
  recordCronStart: vi.fn(async () => {}),
  recordCronSuccess: vi.fn(async () => {}),
  recordCronFailure: vi.fn(async () => {}),
}));

const heartbeats = await import('./heartbeats');
const { isAuthorizedCronRequest, withCronRoute } = await import('./route');

const JOB = 'sample';
const SECRET = 'test-cron-secret';
const originalSecret = process.env.CRON_SECRET;

function cronRequest(authorization?: string): Request {
  return new Request(`http://localhost/api/v1/cron/${JOB}`, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

function lines(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

describe('withCronRoute (spec 046 §3.2)', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    vi.mocked(heartbeats.recordCronStart).mockClear().mockResolvedValue();
    vi.mocked(heartbeats.recordCronSuccess).mockClear().mockResolvedValue();
    vi.mocked(heartbeats.recordCronFailure).mockClear().mockResolvedValue();
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  describe('authorization', () => {
    it.each([
      ['no header', undefined],
      ['a wrong secret', 'Bearer wrong'],
      ['the secret without Bearer', SECRET],
      ['a longer value', `Bearer ${SECRET}x`],
    ])('refuses %s with the existing 401 body, writing no heartbeat', async (_label, header) => {
      const handler = vi.fn(async () => NextResponse.json({ status: 'ok' }));
      const res = await withCronRoute(JOB, handler)(cronRequest(header));

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } });
      expect(handler).not.toHaveBeenCalled();
      expect(heartbeats.recordCronStart).not.toHaveBeenCalled();
    });

    it('refuses everything when CRON_SECRET is unset, even "Bearer undefined"', () => {
      delete process.env.CRON_SECRET;
      expect(isAuthorizedCronRequest(cronRequest('Bearer undefined'))).toBe(false);
      expect(isAuthorizedCronRequest(cronRequest('Bearer '))).toBe(false);
    });

    it('accepts exactly "Bearer <CRON_SECRET>"', () => {
      expect(isAuthorizedCronRequest(cronRequest(`Bearer ${SECRET}`))).toBe(true);
    });
  });

  it('runs the handler in a request context, records start and success, and logs cron.run with counts', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let seenCorrelationId: string | null = null;
    const handler = withCronRoute(JOB, async () => {
      seenCorrelationId = getRequestCorrelationId();
      return NextResponse.json({ status: 'ok', processed: 3, skipped: 0, nested: { n: 1 } });
    });

    const res = await handler(cronRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', processed: 3, skipped: 0, nested: { n: 1 } });
    expect(seenCorrelationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-correlation-id')).toBe(seenCorrelationId);
    expect(heartbeats.recordCronStart).toHaveBeenCalledWith(JOB);
    expect(heartbeats.recordCronSuccess).toHaveBeenCalledWith(JOB);
    expect(heartbeats.recordCronFailure).not.toHaveBeenCalled();

    const [run] = lines(info).filter((l) => l.event === 'cron.run');
    expect(run).toMatchObject({ job: JOB, status: 'ok', httpStatus: 200, correlationId: seenCorrelationId, counts: { processed: 3, skipped: 0 } });
    expect(typeof run!.durationMs).toBe('number');
  });

  it('records a non-2xx answer as a failure with its status code and logs it as an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await withCronRoute(JOB, async () => NextResponse.json({ status: 'provider_unavailable' }, { status: 503 }))(
      cronRequest(`Bearer ${SECRET}`),
    );

    expect(res.status).toBe(503);
    expect(heartbeats.recordCronFailure).toHaveBeenCalledWith(JOB, 'http_503');
    expect(heartbeats.recordCronSuccess).not.toHaveBeenCalled();
    expect(lines(error).find((l) => l.event === 'cron.run')).toMatchObject({ status: 'error', httpStatus: 503 });
  });

  it('records a thrown handler as a failure and re-throws it unchanged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new TypeError('sweep exploded with secret detail');
    const handler = withCronRoute(JOB, async () => {
      throw boom;
    });

    await expect(handler(cronRequest(`Bearer ${SECRET}`))).rejects.toBe(boom);
    expect(heartbeats.recordCronFailure).toHaveBeenCalledWith(JOB, 'exception');
    const run = lines(error).find((l) => l.event === 'cron.run')!;
    expect(run).toMatchObject({ status: 'error', httpStatus: 500, error: 'TypeError' });
    expect(JSON.stringify(run)).not.toContain('secret detail');
  });

  it('never lets a failing heartbeat write change the sweep outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.mocked(heartbeats.recordCronStart).mockRejectedValueOnce(new Error('db down'));
    vi.mocked(heartbeats.recordCronSuccess).mockRejectedValueOnce(new Error('db down'));

    const res = await withCronRoute(JOB, async () => NextResponse.json({ status: 'ok' }))(cronRequest(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(lines(warn).filter((l) => l.event === 'cron.heartbeat_write_failed')).toHaveLength(2);
  });

  it('logs empty counts for a non-JSON or non-object body', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await withCronRoute(JOB, async () => new Response('done', { status: 200 }))(cronRequest(`Bearer ${SECRET}`));
    await withCronRoute(JOB, async () => NextResponse.json([1, 2]))(cronRequest(`Bearer ${SECRET}`));
    await withCronRoute(JOB, async () =>
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    )(cronRequest(`Bearer ${SECRET}`));
    expect(lines(info).filter((l) => l.event === 'cron.run').map((l) => l.counts)).toEqual([{}, {}, {}]);
  });

  it('refuses a job name that is not scheduled in vercel.json at module load', () => {
    expect(() => withCronRoute('not-a-job', async () => NextResponse.json({}))).toThrow(/not a job in vercel\.json/);
  });
});
