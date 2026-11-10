/**
 * Spec 030 §6 — the HTTP surface: auth, CSRF, idempotency, rate limiting, status codes and the
 * 404-not-403 rule.
 *
 * Handlers are driven directly with a plain `Request`, the shape specs 025/027/029 established, so
 * the route's own guards are exercised rather than mocked away.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { POST as CREATE_BLOCK, GET as LIST_BLOCKS } from '@/app/api/v1/blocks/route';
import { DELETE as DELETE_BLOCK } from '@/app/api/v1/blocks/[id]/route';
import { POST as CREATE_REPORT } from '@/app/api/v1/safety-reports/route';
import { GET as READ_REPORT } from '@/app/api/v1/safety-reports/[id]/route';
import { GET as ADMIN_QUEUE } from '@/app/api/v1/admin/safety-reports/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/safety-reports/[id]/resolve/route';
import { POST as SET_PRIORITY } from '@/app/api/v1/admin/safety-reports/[id]/priority/route';
import {
  isDatabaseReachable,
  registerAdminWithPermission,
  registerCustomer,
  resetSafetyIntegrationForTests,
  seedBareUser,
  seedPermission,
  seedSafetyReport,
  sessionGet,
  sessionMutate,
  useSafetyIntegration,
  BASE,
  type TestSession,
} from './safety-test-support';

const dbReachable = await isDatabaseReachable();
const REASON = 'Reviewed this carefully and closed it after speaking to both parties.';

function withKey(request: Request, key = crypto.randomUUID()): Request {
  const headers = new Headers(request.headers);
  headers.set('idempotency-key', key);
  return new Request(request, { headers });
}

async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

describe.skipIf(!dbReachable)('spec 030 routes (integration)', () => {
  beforeEach(() => {
    useSafetyIntegration();
    resetRateLimitState();
  });

  afterAll(async () => {
    resetSafetyIntegrationForTests();
    await getPool().end();
  });

  describe('POST /blocks', () => {
    it('creates a block with 201 and replays a duplicate with 200', async () => {
      const customer = await registerCustomer();
      const target = await seedBareUser();

      const first = await CREATE_BLOCK(
        withKey(sessionMutate(`${BASE}/blocks`, customer, 'POST', { targetUserId: target })),
      );
      expect(first.status).toBe(201);

      const second = await CREATE_BLOCK(
        withKey(sessionMutate(`${BASE}/blocks`, customer, 'POST', { targetUserId: target })),
      );
      expect(second.status).toBe(200);
      expect((await json(second)).data.id).toBe((await json(first)).data.id);
    });

    it('requires a session', async () => {
      const response = await CREATE_BLOCK(
        new Request(`${BASE}/blocks`, { method: 'POST', body: JSON.stringify({ targetUserId: 'x' }) }),
      );
      expect(response.status).toBe(401);
    });

    it('requires a CSRF token', async () => {
      const customer = await registerCustomer();
      const target = await seedBareUser();
      const request = new Request(`${BASE}/blocks`, {
        method: 'POST',
        headers: { cookie: `apuriva_session=${customer.sessionId}`, 'content-type': 'application/json', 'idempotency-key': 'k' },
        body: JSON.stringify({ targetUserId: target }),
      });
      expect((await CREATE_BLOCK(request)).status).toBe(403);
    });

    it('requires an Idempotency-Key', async () => {
      const customer = await registerCustomer();
      const target = await seedBareUser();
      const response = await CREATE_BLOCK(sessionMutate(`${BASE}/blocks`, customer, 'POST', { targetUserId: target }));
      expect(response.status).toBe(400);
    });

    it('returns 400 with a field error for a malformed target', async () => {
      const customer = await registerCustomer();
      const response = await CREATE_BLOCK(
        withKey(sessionMutate(`${BASE}/blocks`, customer, 'POST', { targetUserId: 'not-a-uuid' })),
      );
      expect(response.status).toBe(400);
      expect((await json(response)).errors?.[0]?.field).toBe('targetUserId');
    });

    it('returns 422 for a self-block', async () => {
      const customer = await registerCustomer();
      const response = await CREATE_BLOCK(
        withKey(sessionMutate(`${BASE}/blocks`, customer, 'POST', { targetUserId: customer.userId })),
      );
      expect(response.status).toBe(422);
      expect((await json(response)).code).toBe('CANNOT_BLOCK_SELF');
    });
  });

  describe('GET /blocks and DELETE /blocks/{id}', () => {
    it("lists only the caller's own blocks", async () => {
      const customer = await registerCustomer();
      const other = await registerCustomer();
      const target = await seedBareUser();
      await CREATE_BLOCK(withKey(sessionMutate(`${BASE}/blocks`, customer, 'POST', { targetUserId: target })));

      const mine = await json(await LIST_BLOCKS(sessionGet(`${BASE}/blocks`, customer)));
      expect(mine.data).toHaveLength(1);

      const theirs = await json(await LIST_BLOCKS(sessionGet(`${BASE}/blocks`, other)));
      expect(theirs.data).toHaveLength(0);
    });

    it('unblocks with 204, and is idempotent for an unknown id', async () => {
      const customer = await registerCustomer();
      const target = await seedBareUser();
      const created = await json(
        await CREATE_BLOCK(withKey(sessionMutate(`${BASE}/blocks`, customer, 'POST', { targetUserId: target }))),
      );

      const first = await DELETE_BLOCK(sessionMutate(`${BASE}/blocks/${created.data.id}`, customer, 'DELETE'));
      expect(first.status).toBe(204);

      const again = await DELETE_BLOCK(sessionMutate(`${BASE}/blocks/${created.data.id}`, customer, 'DELETE'));
      expect(again.status).toBe(204);
    });
  });

  describe('POST /safety-reports', () => {
    it('files a report with 201 and replays the same key with 200', async () => {
      const customer = await registerCustomer();
      const target = await seedBareUser();
      const body = { targetUserId: target, category: 'harassment', description: 'They would not leave when asked.' };
      const key = crypto.randomUUID();

      const first = await CREATE_REPORT(withKey(sessionMutate(`${BASE}/safety-reports`, customer, 'POST', body), key));
      expect(first.status).toBe(201);

      const replay = await CREATE_REPORT(withKey(sessionMutate(`${BASE}/safety-reports`, customer, 'POST', body), key));
      expect(replay.status).toBe(200);
    });

    it('requires a session — a guest cannot report', async () => {
      const response = await CREATE_REPORT(
        new Request(`${BASE}/safety-reports`, { method: 'POST', body: JSON.stringify({}) }),
      );
      expect(response.status).toBe(401);
    });

    it('rejects reporting yourself with 422', async () => {
      const customer = await registerCustomer();
      const response = await CREATE_REPORT(
        withKey(
          sessionMutate(`${BASE}/safety-reports`, customer, 'POST', {
            targetUserId: customer.userId,
            category: 'other',
            description: 'Reporting myself for some reason.',
          }),
        ),
      );
      expect(response.status).toBe(422);
      expect((await json(response)).code).toBe('CANNOT_REPORT_SELF');
    });

    it('never accepts a priority from the reporter (DECIDED-1)', async () => {
      const customer = await registerCustomer();
      const target = await seedBareUser();
      const created = await json(
        await CREATE_REPORT(
          withKey(
            sessionMutate(`${BASE}/safety-reports`, customer, 'POST', {
              targetUserId: target,
              category: 'threat',
              description: 'A description long enough to be accepted.',
              priority: 'critical',
            }),
          ),
        ),
      );
      // The reporter's DTO carries no priority at all, and the stored value is the constant.
      expect(created.data).not.toHaveProperty('priority');
    });
  });

  describe('GET /safety-reports/{id}', () => {
    it('returns the reporter their own restricted view', async () => {
      const customer = await registerCustomer();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: customer.userId, targetUserId: target });

      const response = await READ_REPORT(sessionGet(`${BASE}/safety-reports/${id}`, customer));
      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body.data.id).toBe(id);
      expect(body.data).not.toHaveProperty('description');
    });

    it('gives a non-reporter 404, never 403', async () => {
      const customer = await registerCustomer();
      const stranger = await registerCustomer();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: customer.userId, targetUserId: target });

      const response = await READ_REPORT(sessionGet(`${BASE}/safety-reports/${id}`, stranger));
      expect(response.status).toBe(404);
    });
  });

  describe('admin routes', () => {
    async function safetyAdmin(): Promise<TestSession & { userId: string }> {
      const admin = await registerAdminWithPermission('trust_safety_admin', 'safety_reports', 'read', 'low');
      await seedPermission('trust_safety_admin', 'safety_reports', 'escalate', 'medium');
      await seedPermission('trust_safety_admin', 'safety_reports', 'resolve', 'medium');
      return admin;
    }

    it('lets Trust & Safety read the queue', async () => {
      const admin = await safetyAdmin();
      const response = await ADMIN_QUEUE(sessionGet(`${BASE}/admin/safety-reports`, admin));
      expect(response.status).toBe(200);
    });

    it('gives an ordinary customer 403 on the queue', async () => {
      const customer = await registerCustomer();
      const response = await ADMIN_QUEUE(sessionGet(`${BASE}/admin/safety-reports`, customer));
      expect(response.status).toBe(403);
    });

    it('requires a reason on resolve', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const response = await RESOLVE(
        sessionMutate(`${BASE}/admin/safety-reports/${id}/resolve`, admin, 'POST', { expectedStatus: 'submitted' }),
      );
      expect(response.status).toBe(400);
    });

    it('resolves with 200 when given a reason', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const response = await RESOLVE(
        sessionMutate(`${BASE}/admin/safety-reports/${id}/resolve`, admin, 'POST', {
          expectedStatus: 'submitted',
          reason: REASON,
        }),
      );
      expect(response.status).toBe(200);
      expect((await json(response)).data.status).toBe('resolved');
    });

    it('AC-5: returns 422 RESTRICTION_UNAVAILABLE when a restriction is requested', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const response = await RESOLVE(
        sessionMutate(`${BASE}/admin/safety-reports/${id}/resolve`, admin, 'POST', {
          expectedStatus: 'submitted',
          reason: REASON,
          requestRestriction: true,
        }),
      );
      expect(response.status).toBe(422);
      expect((await json(response)).code).toBe('RESTRICTION_UNAVAILABLE');
    });

    it('sets a priority by hand (DECIDED-1) and refuses a stale expectedStatus', async () => {
      const admin = await safetyAdmin();
      const reporter = await seedBareUser();
      const target = await seedBareUser();
      const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

      const ok = await SET_PRIORITY(
        sessionMutate(`${BASE}/admin/safety-reports/${id}/priority`, admin, 'POST', {
          priority: 'critical',
          expectedStatus: 'submitted',
        }),
      );
      expect(ok.status).toBe(200);
      expect((await json(ok)).data.priority).toBe('critical');

      const stale = await SET_PRIORITY(
        sessionMutate(`${BASE}/admin/safety-reports/${id}/priority`, admin, 'POST', {
          priority: 'low',
          expectedStatus: 'escalated',
        }),
      );
      expect(stale.status).toBe(409);
    });
  });

  describe('rate limiting', () => {
    it('bounds the safety domain', async () => {
      const customer = await registerCustomer();
      let limited = false;
      for (let i = 0; i < 40; i += 1) {
        const response = await LIST_BLOCKS(sessionGet(`${BASE}/blocks`, customer));
        if (response.status === 429) {
          limited = true;
          break;
        }
      }
      expect(limited).toBe(true);
    });
  });
});
