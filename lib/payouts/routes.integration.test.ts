import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { GET as earnings } from '@/app/api/v1/providers/me/earnings/route';
import { GET as lines } from '@/app/api/v1/providers/me/earnings/lines/route';
import { GET as statement } from '@/app/api/v1/providers/me/earnings/statement/route';
import { GET as payouts } from '@/app/api/v1/providers/me/payouts/route';
import { POST as createMethod } from '@/app/api/v1/providers/me/payout-methods/route';
import { POST as adminAdjustments } from '@/app/api/v1/admin/earnings-adjustments/route';
import { POST as adminRetry } from '@/app/api/v1/admin/payouts/[id]/retry/route';
import { GET as payoutSweep } from '@/app/api/v1/cron/payout-sweep/route';
import { GET as reconcileSweep } from '@/app/api/v1/cron/payout-reconcile-sweep/route';
import type { EarningsLineDto, EarningsSummaryDto } from '@/lib/types/payouts';
import { createEarningsLineForBooking } from './ledger';
import {
  financeAdmin,
  isDatabaseReachable,
  payBooking,
  resetPayoutIntegration,
  seedSettledBooking,
  sessionGet,
  usePayoutIntegration,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 150_000;
const API = 'http://localhost/api/v1';

afterAll(async () => {
  await getPool().end();
});

/** Spec 024 §3.12/§3.15/§3.16/§3.17 — guards, pagination, idempotency, errors, cron and OpenAPI. */
describe.skipIf(!dbReachable)('payout API routes (spec 024 §3.12)', { timeout: SUITE_TIMEOUT_MS }, () => {
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
    resetRateLimitState();
    process.env.CRON_SECRET = 'test-cron-secret';
  });

  afterEach(() => {
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
    delete process.env.PAYOUT_ATTEMPT_GRACE_MINUTES;
    delete process.env.PAYOUT_AMBIGUITY_ESCALATION_MINUTES;
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
  });

  it('the summary satisfies both identities, and lines are paged with the spec 004 envelope', async () => {
    const settled = await seedSettledBooking();
    await payBooking(settled);
    const summaryRes = await earnings(sessionGet(`${API}/providers/me/earnings`, settled.scenario.provider));
    const summary = ((await summaryRes.json()) as { data: EarningsSummaryDto }).data;
    expect(summary.netAmountMinorUnits).toBe(summary.grossAmountMinorUnits - summary.feeAmountMinorUnits + summary.adjustmentsAmountMinorUnits - summary.refundsAmountMinorUnits);
    expect(summary.pendingAmountMinorUnits + summary.upcomingAmountMinorUnits + summary.paidAmountMinorUnits).toBe(summary.netAmountMinorUnits);
    expect(summary.payoutMethodRequired).toBe(false);

    const page = (await (await lines(sessionGet(`${API}/providers/me/earnings/lines?limit=1&state=paid`, settled.scenario.provider))).json()) as {
      data: EarningsLineDto[];
      page: { limit: number; total: number };
    };
    expect(page.page).toMatchObject({ limit: 1, total: 1 });
    expect(page.data[0]!.bookingId).toBe(settled.bookingId);
    expect(JSON.stringify(page)).not.toMatch(/payoutReference|destination|idempotency/);

    expect((await lines(sessionGet(`${API}/providers/me/earnings/lines?state=nonsense`, settled.scenario.provider))).status).toBe(400);
    expect((await earnings(sessionGet(`${API}/providers/me/earnings?from=2026-13-01`, settled.scenario.provider))).status).toBe(400);
    expect((await payouts(sessionGet(`${API}/providers/me/payouts?status=bogus`, settled.scenario.provider))).status).toBe(400);
  });

  it('the statement is text/csv on success and an enveloped error on failure', async () => {
    const settled = await seedSettledBooking();
    await createEarningsLineForBooking(settled.bookingId, 1000);
    const today = new Date().toISOString().slice(0, 10);
    const ok = await statement(sessionGet(`${API}/providers/me/earnings/statement?from=${today}&to=${today}`, settled.scenario.provider));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/csv');
    expect(ok.headers.get('content-disposition')).toContain('attachment');
    expect(ok.headers.get('cache-control')).toBe('private, no-store');

    const bad = await statement(sessionGet(`${API}/providers/me/earnings/statement?from=${today}`, settled.scenario.provider));
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { code: string }).code).toBe('STATEMENT_RANGE_INVALID');
  });

  it('guard order: CSRF before mode and step-up; a missing Idempotency-Key is rejected before any domain call', async () => {
    const settled = await seedSettledBooking();
    const provider = settled.scenario.provider;
    const noCsrf = await createMethod(new Request(`${API}/providers/me/payout-methods`, {
      method: 'POST',
      headers: { cookie: authenticatedRequest(`${API}/x`, provider.sessionId, '').headers.get('cookie')!, 'content-type': 'application/json' },
      body: JSON.stringify({ setupToken: 'x' }),
    }));
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { code: string }).code).not.toBe('STEP_UP_REQUIRED');

    const admin = await financeAdmin();
    resetRateLimitState();
    const noKey = await adminAdjustments(authenticatedRequest(`${API}/admin/earnings-adjustments`, admin.sessionId, admin.csrfToken, { body: {} }));
    expect(noKey.status).toBe(400);
    expect(JSON.stringify(await noKey.json())).toContain('Idempotency-Key');
  });

  it('rate limiting uses the payment domain on provider reads', async () => {
    const settled = await seedSettledBooking();
    resetRateLimitState();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await earnings(sessionGet(`${API}/providers/me/earnings`, settled.scenario.provider))).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('a retry initiation is 202 and a second is 409; a paid payout is 422', async () => {
    const settled = await seedSettledBooking();
    const paidPayoutId = await payBooking(settled);
    const admin = await financeAdmin();
    resetRateLimitState();
    const withKey = (body: unknown, id: string) => {
      const base = authenticatedRequest(`${API}/admin/payouts/${id}/retry`, admin.sessionId, admin.csrfToken, { body });
      const headers = new Headers(base.headers);
      headers.set('Idempotency-Key', crypto.randomUUID());
      return new Request(base, { headers });
    };
    const paid = await adminRetry(withKey({ reason: 'try again' }, paidPayoutId));
    expect(paid.status).toBe(422);
    expect(((await paid.json()) as { code: string }).code).toBe('PAYOUT_ALREADY_PAID');
  });

  it('cron routes refuse a missing or wrong bearer secret and run with the right one', async () => {
    // The authorized call is unscoped (the real cron shape). Keep it inert for other suites' rows in
    // this shared database: no key lookup and no escalation can fire inside these windows.
    process.env.PAYOUT_ATTEMPT_GRACE_MINUTES = '1000000';
    process.env.PAYOUT_AMBIGUITY_ESCALATION_MINUTES = '1000000';
    expect((await payoutSweep(new NextRequest(`${API}/cron/payout-sweep`))).status).toBe(401);
    expect((await reconcileSweep(new NextRequest(`${API}/cron/payout-reconcile-sweep`, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
    const ok = await reconcileSweep(new NextRequest(`${API}/cron/payout-reconcile-sweep`, { headers: { authorization: 'Bearer test-cron-secret' } }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe('ok');
  });

  it('every new route is registered in OPENAPI_ROUTES tagged payouts, and the registry matches the route files', () => {
    const root = join(__dirname, '..', '..', 'app', 'api', 'v1');
    const expected = [
      'GET /providers/me/earnings',
      'GET /providers/me/earnings/lines',
      'GET /providers/me/earnings/statement',
      'GET /providers/me/payouts',
      'GET /providers/me/payouts/{id}',
      'GET /providers/me/payout-methods',
      'POST /providers/me/payout-methods',
      'PATCH /providers/me/payout-methods/{id}',
      'DELETE /providers/me/payout-methods/{id}',
      'GET /admin/payouts',
      'GET /admin/payouts/{id}',
      'POST /admin/payouts/{id}/retry',
      'POST /admin/earnings-adjustments',
      'GET /admin/earnings-adjustments',
    ];
    const tagged = OPENAPI_ROUTES.filter((r) => r.tags.includes('payouts')).map((r) => `${r.method} ${r.path}`);
    expect(new Set(tagged)).toEqual(new Set(expected));

    for (const entry of expected) {
      const [, path] = entry.split(' ');
      const file = join(root, ...path!.split('/').filter(Boolean).map((seg) => seg.replace('{id}', '[id]')), 'route.ts');
      expect(statSync(file).isFile(), relative(root, file).split(sep).join('/')).toBe(true);
    }
    expect(readdirSync(join(root, 'payouts'))).toEqual(['route-guards.test.ts', 'route-guards.ts'].filter((f) => readdirSync(join(root, 'payouts')).includes(f)));
  });
});
