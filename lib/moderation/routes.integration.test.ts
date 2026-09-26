import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { GET as listActions, POST as createAction } from '@/app/api/v1/admin/moderation-actions/route';
import { GET as getAction } from '@/app/api/v1/admin/moderation-actions/[id]/route';
import { POST as executeAction } from '@/app/api/v1/admin/moderation-actions/[id]/execute/route';
import { POST as reverseAction } from '@/app/api/v1/admin/moderation-actions/[id]/reverse/route';
import { POST as executeReverse } from '@/app/api/v1/admin/moderation-actions/[id]/reverse/execute/route';
import { GET as listSignals } from '@/app/api/v1/admin/fraud-signals/route';
import { POST as dismissSignal } from '@/app/api/v1/admin/fraud-signals/[id]/dismiss/route';
import { POST as escalateSignal } from '@/app/api/v1/admin/fraud-signals/[id]/escalate/route';
import { GET as listAppeals } from '@/app/api/v1/admin/moderation-appeals/route';
import { POST as decideAppeal } from '@/app/api/v1/admin/moderation-appeals/[id]/decide/route';
import { GET as listMine } from '@/app/api/v1/moderation-actions/route';
import { POST as fileAppeal } from '@/app/api/v1/moderation-actions/[id]/appeals/route';
import { GET as sweep } from '@/app/api/v1/cron/fraud-signal-sweep/route';
import { recordFraudSignal } from './fraud-signals';
import { adminWithRole, approve, asUser, isDatabaseReachable, json, resetModerationForTests, seedCustomer, useModerationIntegration } from './moderation-test-support';

const dbReachable = await isDatabaseReachable();

afterAll(async () => {
  await getPool().end();
});

/** Spec 038 §3.13 / AC-10 — envelopes, statuses, CSRF, Idempotency-Key, errors, OpenAPI. */
describe('moderation routes are registered in OpenAPI (spec 038 §3.13)', () => {
  it('lists all thirteen non-cron routes', () => {
    const expected = [
      'GET /admin/moderation-actions',
      'POST /admin/moderation-actions',
      'GET /admin/moderation-actions/{id}',
      'POST /admin/moderation-actions/{id}/execute',
      'POST /admin/moderation-actions/{id}/reverse',
      'POST /admin/moderation-actions/{id}/reverse/execute',
      'GET /admin/fraud-signals',
      'POST /admin/fraud-signals/{id}/dismiss',
      'POST /admin/fraud-signals/{id}/escalate',
      'GET /admin/moderation-appeals',
      'POST /admin/moderation-appeals/{id}/decide',
      'GET /moderation-actions',
      'POST /moderation-actions/{id}/appeals',
    ];
    const registered = new Set(OPENAPI_ROUTES.map((r) => `${r.method} ${r.path}`));
    for (const route of expected) expect(registered.has(route), route).toBe(true);
  });
});

describe.skipIf(!dbReachable)('moderation routes (spec 038 §3.13)', { timeout: 180_000 }, () => {
  beforeEach(() => useModerationIntegration());
  afterEach(() => resetModerationForTests());

  it('M1: 201 applied, 200 on idempotent replay, 409 on a key reused with another body, 400 without a key', async () => {
    const admin = await adminWithRole();
    const target = await seedCustomer();
    const key = randomUUID();
    const body = { actionType: 'warning', scope: 'account', targetUserId: target.userId, reason: 'Rude.' };

    const created = await createAction(asUser(admin, '/admin/moderation-actions', { body, idempotencyKey: key }));
    expect(created.status).toBe(201);
    const first = await json(created);
    expect(first.data).toMatchObject({ status: 'active', actionType: 'warning' });

    const replay = await createAction(asUser(admin, '/admin/moderation-actions', { body, idempotencyKey: key }));
    expect(replay.status).toBe(200);
    expect((await json(replay)).data.id).toBe(first.data.id);

    const conflict = await createAction(asUser(admin, '/admin/moderation-actions', { body: { ...body, reason: 'Other.' }, idempotencyKey: key }));
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const noKey = await createAction(asUser(admin, '/admin/moderation-actions', { body, idempotencyKey: null }));
    expect(noKey.status).toBe(400);
    expect((await json(noKey)).errors[0].field).toBe('Idempotency-Key');
  });

  it('M1: 400 without a reason; 403 for a caller without permission; CSRF is required', async () => {
    const [admin, ops] = [await adminWithRole(), await adminWithRole('operations_admin')];
    const target = await seedCustomer();
    const noReason = await createAction(asUser(admin, '/admin/moderation-actions', { body: { actionType: 'warning', scope: 'account', targetUserId: target.userId } }));
    expect(noReason.status).toBe(400);
    expect((await json(noReason)).errors.map((e: { field: string }) => e.field)).toContain('reason');

    const forbidden = await createAction(
      asUser(ops, '/admin/moderation-actions', { body: { actionType: 'warning', scope: 'account', targetUserId: target.userId, reason: 'x' } }),
    );
    expect(forbidden.status).toBe(403);

    const noCsrf = asUser(admin, '/admin/moderation-actions', { body: { actionType: 'warning', scope: 'account', targetUserId: target.userId, reason: 'x' } });
    const headers = new Headers(noCsrf.headers);
    headers.delete('x-csrf-token');
    expect((await createAction(new Request(noCsrf, { headers }))).status).toBe(403);
  });

  it('M1 202 → M4 422 before approval → 200 after; M5 202 → M6 200; M2/M3 read', async () => {
    const [a, b] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    const pending = await createAction(asUser(a, '/admin/moderation-actions', { body: { actionType: 'suspension', scope: 'account', targetUserId: target.userId, reason: 'Fraud ring.' } }));
    expect(pending.status).toBe(202);
    const action = (await json(pending)).data;

    const early = await executeAction(asUser(a, `/admin/moderation-actions/${action.id}/execute`));
    expect(early.status).toBe(422);
    expect((await json(early)).code).toBe('APPROVAL_REQUIRED');

    await approve(b, action.adminActionId);
    const executed = await executeAction(asUser(a, `/admin/moderation-actions/${action.id}/execute`));
    expect(executed.status).toBe(200);
    expect((await json(executed)).data.status).toBe('active');

    const reversal = await reverseAction(asUser(a, `/admin/moderation-actions/${action.id}/reverse`, { body: { reason: 'Cleared.' } }));
    expect(reversal.status).toBe(202);
    await approve(b, (await json(reversal)).data.reversalAdminActionId);
    const reversed = await executeReverse(asUser(a, `/admin/moderation-actions/${action.id}/reverse/execute`));
    expect((await json(reversed)).data.status).toBe('reversed');

    const list = await listActions(asUser(a, `/admin/moderation-actions?targetUserId=${target.userId}`, { method: 'GET' }));
    expect(list.status).toBe(200);
    expect((await json(list)).page.total).toBeGreaterThanOrEqual(1);
    const detail = await getAction(asUser(a, `/admin/moderation-actions/${action.id}`, { method: 'GET' }));
    expect((await json(detail)).data.approvalChain.length).toBeGreaterThanOrEqual(1);

    const bad = await listActions(asUser(a, '/admin/moderation-actions?status=bogus', { method: 'GET' }));
    expect(bad.status).toBe(400);
    const missing = await getAction(asUser(a, `/admin/moderation-actions/${randomUUID()}`, { method: 'GET' }));
    expect(missing.status).toBe(404);
  });

  it('F1–F3, A1–A2, U1–U2 respond with the documented envelopes and statuses', async () => {
    const [a, c] = [await adminWithRole(), await adminWithRole()];
    const target = await seedCustomer();
    await recordFraudSignal({ targetUserId: target.userId, source: 'rule_based', ruleKey: 'route_rule', observedCount: 2, threshold: 1, windowDays: 1 });

    const signals = await json(await listSignals(asUser(a, `/admin/fraud-signals?targetUserId=${target.userId}`, { method: 'GET' })));
    const signalId = signals.data[0].id;
    const escalated = await escalateSignal(asUser(a, `/admin/fraud-signals/${signalId}/escalate`, { body: { expectedStatus: 'pending_review', reason: 'Look closer.' } }));
    expect((await json(escalated)).data.status).toBe('escalated');
    const dismissed = await dismissSignal(asUser(a, `/admin/fraud-signals/${signalId}/dismiss`, { body: { expectedStatus: 'escalated', reason: 'Fine.' } }));
    expect((await json(dismissed)).data.status).toBe('dismissed');
    expect((await listSignals(asUser(a, '/admin/fraud-signals?status=nope', { method: 'GET' }))).status).toBe(400);

    const created = await json(
      await createAction(asUser(a, '/admin/moderation-actions', { body: { actionType: 'restriction', scope: 'account', targetUserId: target.userId, reason: 'Spam.' } })),
    );
    const mine = await json(await listMine(asUser(target, '/moderation-actions', { method: 'GET' })));
    expect(mine.data[0]).toMatchObject({ id: created.data.id, appealable: true });
    expect(mine.data[0].reason).toBeUndefined();

    const filed = await fileAppeal(asUser(target, `/moderation-actions/${created.data.id}/appeals`, { body: { statement: 'Not spam.' } }));
    expect(filed.status).toBe(201);
    const appealId = (await json(filed)).data.id;

    const queue = await json(await listAppeals(asUser(c, '/admin/moderation-appeals?status=pending', { method: 'GET' })));
    expect(queue.data.some((r: { id: string }) => r.id === appealId)).toBe(true);
    const decided = await decideAppeal(asUser(c, `/admin/moderation-appeals/${appealId}/decide`, { body: { decision: 'upheld', reason: 'Not spam.' } }));
    expect((await json(decided)).data.status).toBe('upheld');
  });

  it('C1: refuses without the cron secret; with it, reports the active rules', async () => {
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-cron-secret';
    try {
      const { NextRequest } = await import('next/server');
      expect((await sweep(new NextRequest('http://localhost/api/v1/cron/fraud-signal-sweep'))).status).toBe(401);
      const ok = await sweep(new NextRequest('http://localhost/api/v1/cron/fraud-signal-sweep', { headers: { authorization: 'Bearer test-cron-secret' } }));
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ status: 'ok', rulesActive: expect.any(Array) });
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
    }
  });

  it('rate-limits the moderation domain', async () => {
    const admin = await adminWithRole();
    resetRateLimitState();
    let last = 200;
    for (let i = 0; i < 31; i += 1) last = (await listSignals(asUser(admin, '/admin/fraud-signals', { method: 'GET' }))).status;
    expect(last).toBe(429);
    resetRateLimitState();
  });
});
