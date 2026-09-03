import { describe, expect, it, vi } from 'vitest';
import { apiError, apiPaged, apiSuccess } from '@/lib/api/response';
import { API_ERROR_CODES, ApiRouteError, forbiddenError, validationError } from '@/lib/api/errors';
import { CORRELATION_ID_HEADER, getOrCreateCorrelationId } from '@/lib/api/correlation-id';
import { withApiRoute } from '@/lib/api/handler';
import { logForbiddenAttempt } from '@/lib/api/security-log';

describe('response envelope (spec 004 AC-1, AC-2)', () => {
  it('AC-1: wraps success responses as { data, correlationId }', async () => {
    const res = apiSuccess({ id: '1' }, 'corr-1');
    expect(res.status).toBe(200);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe('corr-1');

    const body = await res.json();
    expect(body).toEqual({ data: { id: '1' }, correlationId: 'corr-1' });
  });

  it('AC-1/AC-6: wraps paged responses as { data, page, correlationId }', async () => {
    const page = { limit: 20, offset: 0, total: 1, nextOffset: null };
    const res = apiPaged([{ id: '1' }], page, 'corr-2');
    const body = await res.json();
    expect(body).toEqual({ data: [{ id: '1' }], page, correlationId: 'corr-2' });
  });

  it('AC-2: error responses carry status, code, message, and correlationId', async () => {
    const res = apiError('NOT_FOUND', 'No such resource.', 'corr-3');
    expect(res.status).toBe(404);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe('corr-3');

    const body = await res.json();
    expect(body).toEqual({ status: 404, code: 'NOT_FOUND', message: 'No such resource.', correlationId: 'corr-3' });
  });

  it('every code in the taxonomy maps to its documented HTTP status', () => {
    expect(API_ERROR_CODES).toEqual({
      VALIDATION_ERROR: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      DOMAIN_RULE_VIOLATION: 422,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
    });
  });
});

describe('correlation ID (spec 004 AC-1, AC-2)', () => {
  it('reuses a well-formed caller-supplied correlation ID', () => {
    const req = new Request('http://localhost/api/v1/x', { headers: { [CORRELATION_ID_HEADER]: 'caller-id-123' } });
    expect(getOrCreateCorrelationId(req)).toBe('caller-id-123');
  });

  it('generates a fresh ID when none is supplied or the supplied one is malformed', () => {
    const noHeader = new Request('http://localhost/api/v1/x');
    expect(getOrCreateCorrelationId(noHeader)).toMatch(/^[0-9a-f-]{36}$/);

    const badHeader = new Request('http://localhost/api/v1/x', {
      headers: { [CORRELATION_ID_HEADER]: 'has spaces / slashes' },
    });
    expect(getOrCreateCorrelationId(badHeader)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('withApiRoute (spec 004 AC-1 through AC-5)', () => {
  it('AC-3: converts a thrown validationError into 400 VALIDATION_ERROR with errors[]', async () => {
    const handler = withApiRoute(async () => {
      throw validationError([{ field: 'email', message: 'is required' }]);
    });

    const res = await handler(new Request('http://localhost/api/v1/x'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toEqual([{ field: 'email', message: 'is required' }]);
  });

  it('AC-4: converts a thrown forbiddenError into 403 and logs the attempt', async () => {
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = withApiRoute(async () => {
      throw forbiddenError('Not your resource.');
    });

    const res = await handler(new Request('http://localhost/api/v1/widgets/1'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('FORBIDDEN');

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({ event: 'api.forbidden', path: '/api/v1/widgets/1', method: 'GET' });
    logSpy.mockRestore();
  });

  it('never leaks internal error detail for an unexpected thrown error — returns 500 INTERNAL_ERROR', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withApiRoute(async () => {
      throw new Error('leaked stack trace / connection string');
    });

    const res = await handler(new Request('http://localhost/api/v1/x'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('connection string');
    errSpy.mockRestore();
  });

  it('propagates a non-ApiRouteError-typed retryAfterSeconds via the Retry-After header', async () => {
    const handler = withApiRoute(async () => {
      throw new ApiRouteError('RATE_LIMITED', 'Rate limit exceeded.', { retryAfterSeconds: 42 });
    });

    const res = await handler(new Request('http://localhost/api/v1/x'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
  });
});

describe('logForbiddenAttempt (spec 004 AC-4)', () => {
  it('logs a structured, correlatable record without persisting to the database', () => {
    const logSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logForbiddenAttempt({ correlationId: 'corr-9', method: 'DELETE', path: '/api/v1/x/9', reason: 'not owner' });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({
      event: 'api.forbidden',
      correlationId: 'corr-9',
      method: 'DELETE',
      path: '/api/v1/x/9',
      reason: 'not owner',
    });
    logSpy.mockRestore();
  });
});
