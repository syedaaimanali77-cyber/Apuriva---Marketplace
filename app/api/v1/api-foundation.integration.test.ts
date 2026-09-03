import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getHealth } from './health/route';
import { GET as getOpenApiDocument } from './openapi.json/route';
import { getPool } from '@/lib/db';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError, rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';

/**
 * Spec 004 §6 Test plan, Integration row: "`/api/v1/health` returns `200`; a deliberately
 * invalid request returns `400 VALIDATION_ERROR`; rate limit returns `429` after threshold."
 * Exercises the real, registered `/api/v1/health` and `/api/v1/openapi.json` routes plus the
 * shared lib/api/* helpers composed the way a domain route (spec 005+) would use them — this
 * spec introduces no domain endpoints of its own to hit directly (§3, §7).
 */
describe('API foundation (spec 004, integration)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('GET /api/v1/health responds 200', async () => {
    const res = await getHealth();
    expect(res.status).toBe(200);
  });

  it('GET /api/v1/openapi.json responds 200 with a generated document covering the registered routes', async () => {
    const res = await getOpenApiDocument();
    expect(res.status).toBe(200);

    const doc = await res.json();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.paths['/health'].get).toBeDefined();
    expect(doc.paths['/openapi.json'].get).toBeDefined();
  });

  it('a deliberately invalid request returns 400 VALIDATION_ERROR', async () => {
    const handler = withApiRoute(async (request, correlationId) => {
      const body = (await request.json()) as { email?: unknown };
      if (typeof body.email !== 'string' || !body.email.includes('@')) {
        throw validationError([{ field: 'email', message: 'must be a valid email address' }]);
      }
      return apiSuccess({ ok: true }, correlationId);
    });

    const res = await handler(
      new Request('http://localhost/api/v1/example', { method: 'POST', body: JSON.stringify({ email: 'not-an-email' }) }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toEqual([{ field: 'email', message: 'must be a valid email address' }]);
  });

  describe('rate limit returns 429 after threshold', () => {
    beforeEach(() => {
      resetRateLimitState();
    });

    it('rejects once the domain threshold is exceeded, with a Retry-After header', async () => {
      const handler = withApiRoute(async (request, correlationId) => {
        const result = checkRateLimit('security', 'caller-x', { limit: 2, windowMs: 60_000 });
        if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
        return apiSuccess({ ok: true }, correlationId);
      });

      const req = () => handler(new Request('http://localhost/api/v1/example'));
      expect((await req()).status).toBe(200);
      expect((await req()).status).toBe(200);

      const limited = await req();
      expect(limited.status).toBe(429);
      expect(limited.headers.get('Retry-After')).not.toBeNull();
      expect((await limited.json()).code).toBe('RATE_LIMITED');
    });
  });
});
