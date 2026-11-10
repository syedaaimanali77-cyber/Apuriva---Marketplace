import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { expectDatabaseRejection } from '@/lib/bookings/bookings-test-support';
import { resetStepUpState } from '@/lib/auth/step-up';
import { queryRows } from '@/lib/offers/db';
import { getSandboxPayoutProvider, sandboxSetupToken } from '@/lib/payments/provider';
import { POST as stepUpRoute } from '@/app/api/v1/auth/step-up/route';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { GET as listMethods, POST as createMethodRoute } from '@/app/api/v1/providers/me/payout-methods/route';
import { DELETE as removeMethodRoute, PATCH as patchMethodRoute } from '@/app/api/v1/providers/me/payout-methods/[id]/route';
import { decryptDestinationToken } from './destination-crypto';
import { closeBatch } from './ledger';
import { removePayoutMethod } from './payout-methods';
import { revokePendingRemovedMethods } from './payout-methods';
import {
  accrueBooking,
  addDefaultMethod,
  isDatabaseReachable,
  resetPayoutIntegration,
  seedSettledBooking,
  usePayoutIntegration,
  type SettledBooking,
} from './payouts-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 120_000;
const BASE = 'http://localhost/api/v1/providers/me/payout-methods';

afterAll(async () => {
  await getPool().end();
});

async function stepUpToken(settled: SettledBooking, action = 'manage_payout_method'): Promise<string> {
  const provider = settled.scenario.provider;
  const res = await stepUpRoute(authenticatedRequest('http://localhost/api/v1/auth/step-up', provider.sessionId, provider.csrfToken, { body: { action } }));
  return ((await res.json()) as { data: { stepUpToken: string } }).data.stepUpToken;
}

function mutation(settled: SettledBooking, url: string, method: string, body: unknown, options?: { stepUp?: string; key?: string }): Request {
  const provider = settled.scenario.provider;
  const base = authenticatedRequest(url, provider.sessionId, provider.csrfToken, { method, body });
  const headers = new Headers(base.headers);
  if (options?.stepUp) headers.set('x-step-up-token', options.stepUp);
  if (options?.key) headers.set('Idempotency-Key', options.key);
  return new Request(base, { headers });
}

/** Spec 024 §3.9 — payout-method security (AC-4, AC-10, AC-11). */
describe.skipIf(!dbReachable)('payout-method security (spec 024 §3.9)', { timeout: SUITE_TIMEOUT_MS }, () => {
  let logs: string[] = [];

  beforeEach(() => {
    usePayoutIntegration();
    registerBookingBusyIntervals();
    resetStepUpState();
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void logs.push(args.join(' ')));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPayoutIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  it('create, default and remove each require step-up', async () => {
    const settled = await seedSettledBooking();
    const noStepUp = await createMethodRoute(mutation(settled, BASE, 'POST', { setupToken: sandboxSetupToken('bank', '4321') }, { key: 'k1' }));
    expect(noStepUp.status).toBe(403);
    expect(((await noStepUp.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');

    const created = await createMethodRoute(mutation(settled, BASE, 'POST', { setupToken: sandboxSetupToken('bank', '4321') }, { key: 'k1', stepUp: await stepUpToken(settled) }));
    expect(created.status).toBe(201);
    const method = ((await created.json()) as { data: { id: string; maskedDetail: string } }).data;
    expect(method.maskedDetail).toBe('****4321');

    const patch = await patchMethodRoute(mutation(settled, `${BASE}/${method.id}`, 'PATCH', { isDefault: true }));
    expect(patch.status).toBe(403);
    const remove = await removeMethodRoute(mutation(settled, `${BASE}/${method.id}`, 'DELETE', undefined));
    expect(remove.status).toBe(403);
    const removed = await removeMethodRoute(mutation(settled, `${BASE}/${method.id}`, 'DELETE', undefined, { stepUp: await stepUpToken(settled) }));
    expect(removed.status).toBe(200);
  });

  it('an expired, consumed, wrong-action or wrong-session token is an indistinguishable 403', async () => {
    const settled = await seedSettledBooking();
    const other = await seedSettledBooking();
    const body = () => ({ setupToken: sandboxSetupToken('bank', String(1000 + Math.floor(Math.random() * 8999))) });

    const wrongAction = await stepUpToken(settled, 'toggle_mfa');
    const wrongSession = await stepUpToken(other);
    const consumed = await stepUpToken(settled);
    expect((await createMethodRoute(mutation(settled, BASE, 'POST', body(), { key: 'a', stepUp: consumed }))).status).toBe(201);

    const responses = await Promise.all([
      createMethodRoute(mutation(settled, BASE, 'POST', body(), { key: 'b', stepUp: wrongAction })),
      createMethodRoute(mutation(settled, BASE, 'POST', body(), { key: 'c', stepUp: wrongSession })),
      createMethodRoute(mutation(settled, BASE, 'POST', body(), { key: 'd', stepUp: consumed })),
      createMethodRoute(mutation(settled, BASE, 'POST', body(), { key: 'e', stepUp: 'garbage' })),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ code: string; message: string }>));
    for (const [index, res] of responses.entries()) {
      expect(res.status).toBe(403);
      expect(bodies[index]!.code).toBe('STEP_UP_REQUIRED');
      expect(bodies[index]!.message).toBe(bodies[0]!.message);
    }

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const expiring = await stepUpToken(settled);
      vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000 + 1));
      const expired = await createMethodRoute(mutation(settled, BASE, 'POST', body(), { key: 'f', stepUp: expiring }));
      expect(expired.status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the stored token is never plaintext and round-trips; a client-supplied mask is ignored in favour of the rail', async () => {
    const settled = await seedSettledBooking();
    const res = await createMethodRoute(
      mutation(settled, BASE, 'POST', { setupToken: sandboxSetupToken('bank', '7777'), maskedDetail: '1234567890123', institutionLabel: 'HBL' }, { key: 'k', stepUp: await stepUpToken(settled) }),
    );
    const dto = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(dto.maskedDetail).toBe('****7777');
    expect(dto.institutionLabel).toBe('Sandbox Bank');

    const [row] = await queryRows<{ destination_token_encrypted: string }>(getDb(), sql`SELECT destination_token_encrypted FROM payout_methods WHERE id = ${dto.id as string}`);
    expect(row!.destination_token_encrypted).not.toContain('sandbox_payout_');
    expect(decryptDestinationToken(row!.destination_token_encrypted).startsWith('sandbox_payout_dest_')).toBe(true);
  });

  it('no response, log line, error body or security event contains a token, and the database rejects a long mask', async () => {
    const settled = await seedSettledBooking();
    const setup = sandboxSetupToken('bank', '8888');
    const created = await createMethodRoute(mutation(settled, BASE, 'POST', { setupToken: setup }, { key: 'k', stepUp: await stepUpToken(settled) }));
    const createdText = await created.clone().text();
    const listed = await (await listMethods(new Request(BASE, { headers: { cookie: authenticatedRequest(BASE, settled.scenario.provider.sessionId, '').headers.get('cookie')! } }))).text();
    const reuse = await createMethodRoute(mutation(settled, BASE, 'POST', { setupToken: setup }, { key: 'k2', stepUp: await stepUpToken(settled) }));
    const errorText = await reuse.text();
    expect(reuse.status).toBe(422);

    const events = await queryRows<{ metadata: unknown }>(getDb(), sql`SELECT metadata FROM security_events WHERE user_id = ${settled.scenario.provider.userId} AND event_type LIKE 'payout_method.%'`);
    expect(events.length).toBeGreaterThan(0);
    for (const text of [createdText, listed, errorText, logs.join('\n'), JSON.stringify(events)]) {
      expect(text).not.toContain('sandbox_payout_dest_');
      expect(text).not.toContain('sandbox_setup:');
      expect(text).not.toMatch(/destinationToken|destination_token/);
    }

    const methodId = ((JSON.parse(createdText) as { data: { id: string } }).data).id;
    await expectDatabaseRejection(() => getDb().execute(sql`UPDATE payout_methods SET masked_detail = '****12345' WHERE id = ${methodId}`), /payout_methods_masked_detail_ck/);
  });

  it('removal soft-deletes first and revokes after commit; a rail revocation failure does not block removal and is retried', async () => {
    const settled = await seedSettledBooking();
    const methodId = await addDefaultMethod(settled);
    const [row] = await queryRows<{ destination_token_encrypted: string }>(getDb(), sql`SELECT destination_token_encrypted FROM payout_methods WHERE id = ${methodId}`);
    const destination = decryptDestinationToken(row!.destination_token_encrypted);

    getSandboxPayoutProvider().failNextRevocationOnce();
    const removed = await removePayoutMethod({ userId: settled.scenario.provider.userId, providerProfileId: settled.providerProfileId, methodId, correlationId: 'c' });
    expect(removed.removedAt).not.toBeNull();
    expect(getSandboxPayoutProvider().isRevoked(destination)).toBe(false);

    await revokePendingRemovedMethods({ providerProfileIds: [settled.providerProfileId] });
    expect(getSandboxPayoutProvider().isRevoked(destination)).toBe(true);
    const [after] = await queryRows<{ revoked_at: Date | null; is_default: boolean }>(getDb(), sql`SELECT revoked_at, is_default FROM payout_methods WHERE id = ${methodId}`);
    expect(after!.revoked_at).not.toBeNull();
    expect(after!.is_default).toBe(false);
  });

  it('the last method cannot be removed while a payout is in flight, and a snapshotted method is in use', async () => {
    const settled = await seedSettledBooking();
    const methodId = await addDefaultMethod(settled);
    const payoutId = await accrueBooking(settled);
    expect(await closeBatch(payoutId)).toBe('closed');

    const res = await removeMethodRoute(mutation(settled, `${BASE}/${methodId}`, 'DELETE', undefined, { stepUp: await stepUpToken(settled) }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('PAYOUT_METHOD_IN_USE');
  });

  it('each mutation writes the documented security_events row', async () => {
    const settled = await seedSettledBooking();
    const first = await addDefaultMethod(settled);
    const second = await addDefaultMethod(settled);
    const res = await patchMethodRoute(mutation(settled, `${BASE}/${second}`, 'PATCH', { isDefault: true }, { stepUp: await stepUpToken(settled) }));
    expect(res.status).toBe(200);
    await removePayoutMethod({ userId: settled.scenario.provider.userId, providerProfileId: settled.providerProfileId, methodId: first, correlationId: 'c' });

    const events = await queryRows<{ event_type: string; severity: string; metadata: Record<string, unknown> }>(
      getDb(),
      sql`SELECT event_type, severity, metadata FROM security_events WHERE user_id = ${settled.scenario.provider.userId} AND event_type LIKE 'payout_method.%' ORDER BY created_at`,
    );
    expect(events.map((e) => e.event_type)).toEqual(['payout_method.created', 'payout_method.created', 'payout_method.default_changed', 'payout_method.removed']);
    for (const event of events) {
      expect(event.severity).toBe('warning');
      expect(Object.keys(event.metadata).sort()).toEqual(['correlationId', 'maskedDetail', 'payoutMethodId', 'type']);
    }
  });
});
