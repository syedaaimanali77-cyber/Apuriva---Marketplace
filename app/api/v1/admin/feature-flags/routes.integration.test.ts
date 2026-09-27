import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimitState } from '@/lib/api/rate-limit';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { adminWithRole, isDatabaseReachable } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import type { TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import type { FeatureFlagDto } from '@/lib/types/feature-flags';
import { useFlagEnvironment } from '@/lib/feature-flags/feature-flags-test-support';
import { GET as LIST } from './route';
import { PATCH } from './[key]/route';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/admin/feature-flags';

describe('feature-flag routes in OpenAPI (spec 041 §3.6)', () => {
  it('registers exactly F1, F2 and F3', () => {
    const flags = OPENAPI_ROUTES.filter((r) => r.path.includes('feature-flags'));
    expect(flags.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      ['GET /admin/feature-flags', 'GET /feature-flags/effective', 'PATCH /admin/feature-flags/{key}'].sort(),
    );
  });
});

/**
 * Spec 041 §3.6 F1/F2 — envelopes, validation, 404, CSRF, rate limiting and the environment guard.
 * Nothing here changes a stored value (every PATCH is refused before the write).
 */
describe.skipIf(!dbReachable)('feature-flag admin routes (spec 041 §3.6)', { timeout: 120_000 }, () => {
  useFlagEnvironment('staging');
  let admin: TestAdmin;

  beforeAll(async () => {
    admin = await adminWithRole('super_admin');
  }, 120_000);

  beforeEach(() => resetRateLimitState());

  const patch = (key: string, body: unknown, csrf = admin.csrfToken) =>
    PATCH(authenticatedRequest(`${BASE}/${key}`, admin.sessionId, csrf, { method: 'PATCH', body }));

  it('F1 returns the success envelope: every flag with the §3.10 DTO for the running environment', async () => {
    const res = await LIST(authenticatedRequest(BASE, admin.sessionId, admin.csrfToken, { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: FeatureFlagDto[]; correlationId: string };
    expect(typeof body.correlationId).toBe('string');
    expect(body.data).toHaveLength(7); // spec 042 X-15: `urdu-locale` is the seventh
    for (const flag of body.data) {
      expect(Object.keys(flag).sort()).toEqual(
        ['clientReadable', 'controlledBy', 'description', 'effective', 'enabled', 'environment', 'isKillSwitch', 'key', 'overriddenBy', 'removalCriteria', 'updatedAt', 'version'].sort(),
      );
      expect(flag.environment).toBe('staging');
      expect(flag.overriddenBy).toBeNull();
      expect(flag.effective).toBe(flag.enabled);
    }
  });

  it('F1 reports an active env override and the pinned effective value', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'false';
    try {
      const res = await LIST(authenticatedRequest(BASE, admin.sessionId, admin.csrfToken, { method: 'GET' }));
      const flag = ((await res.json()) as { data: FeatureFlagDto[] }).data.find((f) => f.key === 'ai-assistant')!;
      expect(flag).toMatchObject({ overriddenBy: 'AI_ASSISTANT_ENABLED', effective: false });
    } finally {
      delete process.env.AI_ASSISTANT_ENABLED;
    }
  });

  it('F2 400 VALIDATION_ERROR names every bad field', async () => {
    const res = await patch('onboarding-intro-v1', { environment: 'qa', enabled: 'yes', expectedVersion: 0, reason: '   ' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; errors: { field: string }[] };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors.map((e) => e.field).sort()).toEqual(['enabled', 'environment', 'expectedVersion', 'reason']);
    expect((await patch('onboarding-intro-v1', { environment: 'staging', enabled: true, expectedVersion: 1, reason: 'x'.repeat(501) })).status).toBe(400);
  });

  it('F2 404 FLAG_NOT_REGISTERED for an unknown key (including removed flags)', async () => {
    for (const key of ['no-such-flag', 'matching-fairness-exposure']) {
      const res = await patch(key, { environment: 'staging', enabled: true, expectedVersion: 1, reason: 'unknown' });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe('FLAG_NOT_REGISTERED');
    }
  });

  it('F2 409 FLAG_ENVIRONMENT_MISMATCH when the body names another environment', async () => {
    const res = await patch('onboarding-intro-v1', { environment: 'production', enabled: true, expectedVersion: 1, reason: 'wrong env' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('FLAG_ENVIRONMENT_MISMATCH');
  });

  it('F2 requires the CSRF token', async () => {
    const res = await patch('onboarding-intro-v1', { environment: 'staging', enabled: true, expectedVersion: 1, reason: 'csrf' }, 'wrong-token');
    expect(res.status).toBe(403);
  });

  it('both routes are rate-limited by the default bucket (429)', async () => {
    for (let i = 0; i < 100; i += 1) checkRateLimit('default', admin.userId);
    expect((await LIST(authenticatedRequest(BASE, admin.sessionId, admin.csrfToken, { method: 'GET' }))).status).toBe(429);
    expect((await patch('onboarding-intro-v1', { environment: 'staging', enabled: true, expectedVersion: 1, reason: 'r' })).status).toBe(429);
  });
});
