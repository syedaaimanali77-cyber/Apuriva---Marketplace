import { describe, expect, it } from 'vitest';
import { withApiRoute } from '@/lib/api/handler';
import { ApiRouteError } from '@/lib/api/errors';
import { apiSuccess } from '@/lib/api/response';
import { getRequestCorrelationId, runWithRequestContext } from '@/lib/audit/request-context';

/** Spec 039 §3.5 / X-1 — the request context `withApiRoute` sets for the audit writer. */
describe('request context (spec 039 X-1)', () => {
  it('is absent outside a request', () => {
    expect(getRequestCorrelationId()).toBeNull();
  });

  it('carries the correlation id through awaits, and is gone afterwards', async () => {
    const seen = await runWithRequestContext({ correlationId: 'ctx-1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getRequestCorrelationId();
    });
    expect(seen).toBe('ctx-1');
    expect(getRequestCorrelationId()).toBeNull();
  });

  it('withApiRoute exposes the caller-supplied x-correlation-id to the handler', async () => {
    let seen: string | null = null;
    const route = withApiRoute(async (_request, correlationId) => {
      seen = getRequestCorrelationId();
      return apiSuccess({}, correlationId);
    });
    const res = await route(new Request('http://localhost/x', { headers: { 'x-correlation-id': 'caller-abc' } }));
    expect(seen).toBe('caller-abc');
    expect(res.headers.get('x-correlation-id')).toBe('caller-abc');
  });

  it('withApiRoute exposes a generated id equal to the one in the response when none is supplied', async () => {
    let seen: string | null = null;
    const route = withApiRoute(async (_request, correlationId) => {
      seen = getRequestCorrelationId();
      return apiSuccess({}, correlationId);
    });
    const res = await route(new Request('http://localhost/x'));
    expect(seen).toBeTruthy();
    expect(res.headers.get('x-correlation-id')).toBe(seen);
  });

  it('error handling is unchanged: a thrown ApiRouteError still becomes the envelope', async () => {
    const route = withApiRoute(async () => {
      throw new ApiRouteError('NOT_FOUND', 'nope');
    });
    const res = await route(new Request('http://localhost/x', { headers: { 'x-correlation-id': 'err-1' } }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND', correlationId: 'err-1' });
  });
});
