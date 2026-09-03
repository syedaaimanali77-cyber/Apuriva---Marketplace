import { beforeEach, describe, expect, it } from 'vitest';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';

/**
 * Spec 004 AC-5, integration-level: a real Route-Handler-shaped function built from the shared
 * lib/api/rate-limit.ts + lib/api/handler.ts returns 429 with a Retry-After header once a
 * caller exceeds their domain's threshold. Handler constructed inline for the same reason as
 * validation.integration.test.ts — this spec introduces no domain endpoints itself.
 */
const searchEndpoint = withApiRoute(async (request, correlationId) => {
  const identifier = request.headers.get('x-caller-id') ?? 'anonymous';
  const result = checkRateLimit('search', identifier, { limit: 3, windowMs: 60_000 });
  if (!result.allowed) throw rateLimitedError(result.retryAfterSeconds);
  return apiSuccess({ results: [] }, correlationId);
});

describe('rate-limited handler (spec 004 AC-5, integration)', () => {
  beforeEach(() => {
    resetRateLimitState();
  });

  it('allows requests under the threshold', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await searchEndpoint(new Request('http://localhost/api/v1/search', { headers: { 'x-caller-id': 'user-1' } }));
      expect(res.status).toBe(200);
    }
  });

  it('returns 429 RATE_LIMITED with a Retry-After header once the threshold is exceeded', async () => {
    const makeRequest = () =>
      searchEndpoint(new Request('http://localhost/api/v1/search', { headers: { 'x-caller-id': 'user-2' } }));

    for (let i = 0; i < 3; i++) {
      const res = await makeRequest();
      expect(res.status).toBe(200);
    }

    const limited = await makeRequest();
    expect(limited.status).toBe(429);
    const body = await limited.json();
    expect(body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('tracks callers independently — one caller being limited does not affect another', async () => {
    for (let i = 0; i < 3; i++) {
      await searchEndpoint(new Request('http://localhost/api/v1/search', { headers: { 'x-caller-id': 'user-3' } }));
    }
    const limited = await searchEndpoint(
      new Request('http://localhost/api/v1/search', { headers: { 'x-caller-id': 'user-3' } }),
    );
    expect(limited.status).toBe(429);

    const otherCaller = await searchEndpoint(
      new Request('http://localhost/api/v1/search', { headers: { 'x-caller-id': 'user-4' } }),
    );
    expect(otherCaller.status).toBe(200);
  });
});
