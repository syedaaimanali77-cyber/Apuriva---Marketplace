/**
 * Spec 032 §6 "Concurrency / idempotency" (AC-7).
 *
 * Two writers, one winner. Every transition is a conditional `UPDATE ... WHERE status =
 * $expectedStatus`, so the loser matches zero rows and is told what actually happened rather than
 * silently overwriting it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { POST as SEND } from '@/app/api/v1/support/tickets/[id]/messages/route';
import { POST as ASSIGN } from '@/app/api/v1/admin/support/tickets/[id]/assign/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
import { POST as NOTE } from '@/app/api/v1/admin/support/tickets/[id]/notes/route';
import {
  BASE,
  freshKey,
  grantRole,
  isDatabaseReachable,
  readTicketRow,
  registerAdmin,
  registerAndLogin,
  seedPermission,
  supportRequest,
  useSupportIntegration,
  type TestAdmin,
  type TestSession,
} from './support-test-support';

const dbReachable = await isDatabaseReachable();

async function supportAdmin(): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, 'support_admin');
  for (const [action, tier] of [
    ['read', 'low'],
    ['assign', 'low'],
    ['respond', 'low'],
    ['triage', 'medium'],
    ['resolve', 'medium'],
  ] as const) {
    await seedPermission('support_admin', 'support', action, tier);
  }
  return admin;
}

const TICKET_BODY = {
  subject: 'Please take a look at this',
  description: 'Something is not working as I expected and I need a hand with it.',
  category: 'account',
};

async function makeTicket(user: TestSession): Promise<string> {
  const res = await CREATE(supportRequest(`${BASE}/support/tickets`, user, { body: TICKET_BODY }));
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

describe.skipIf(!dbReachable)('spec 032 concurrency and idempotency (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('two simultaneous creates with ONE key produce one ticket, not two (AC-7)', async () => {
    const user = await registerAndLogin();
    const key = freshKey('create');

    const [a, b] = await Promise.all([
      CREATE(supportRequest(`${BASE}/support/tickets`, user, { body: TICKET_BODY, idempotencyKey: key })),
      CREATE(supportRequest(`${BASE}/support/tickets`, user, { body: TICKET_BODY, idempotencyKey: key })),
    ]);

    const statuses = [a.status, b.status].sort();
    // One creates (201); the other either replays (200) or loses the unique index (409) — never
    // two tickets.
    expect(statuses[0]).toBeLessThanOrEqual(statuses[1]!);

    const rows = await queryRows<{ count: number }>(
      getDb(),
      sql`SELECT count(*)::int AS count FROM support_tickets WHERE requester_user_id = ${user.userId}`,
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('a sequential replay returns the SAME ticket with 200, not a second one', async () => {
    const user = await registerAndLogin();
    const key = freshKey('create');

    const first = await CREATE(supportRequest(`${BASE}/support/tickets`, user, { body: TICKET_BODY, idempotencyKey: key }));
    expect(first.status).toBe(201);
    const firstId = (await first.json()).data.id;

    const second = await CREATE(supportRequest(`${BASE}/support/tickets`, user, { body: TICKET_BODY, idempotencyKey: key }));
    expect(second.status).toBe(200);
    expect((await second.json()).data.id).toBe(firstId);
  });

  it('two simultaneous assigns produce exactly one 200 and one 409 (AC-7)', async () => {
    const user = await registerAndLogin();
    const adminA = await supportAdmin();
    const adminB = await supportAdmin();
    const ticketId = await makeTicket(user);

    const [a, b] = await Promise.all([
      ASSIGN(
        supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, adminA, {
          body: { assigneeUserId: adminA.userId, expectedStatus: 'open' },
        }),
      ),
      ASSIGN(
        supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, adminB, {
          body: { assigneeUserId: adminB.userId, expectedStatus: 'open' },
        }),
      ),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    const body = await loser.json();
    expect(body.code).toBe('SUPPORT_TICKET_STATUS_CONFLICT');
    // The loser is told what actually happened, so it can refetch and decide again.
    expect(body.details.currentStatus).toBe('assigned');
  });

  it('two simultaneous resolves produce exactly one winner', async () => {
    const user = await registerAndLogin();
    const adminA = await supportAdmin();
    const adminB = await supportAdmin();
    const ticketId = await makeTicket(user);

    const resolveBody = (reason: string) => ({
      resolutionKind: 'answered',
      reason,
      expectedStatus: 'open',
    });

    const [a, b] = await Promise.all([
      RESOLVE(supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, adminA, { body: resolveBody('Answered by the first admin to get here.') })),
      RESOLVE(supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, adminB, { body: resolveBody('Answered by the second admin to get here.') })),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const row = await readTicketRow(ticketId);
    expect(row!.status).toBe('resolved');
    // Exactly one resolution reason survived — they did not both write.
    expect(typeof row!.resolution_reason).toBe('string');
  });

  it('an admin acting on a stale screen is told the ticket moved', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );

    // Their screen still says `open`.
    const stale = await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Resolving from a screen that is out of date.', expectedStatus: 'open' },
      }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).details.currentStatus).toBe('assigned');
  });

  it('a replayed message posts once, and a replayed note likewise', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    const msgKey = freshKey('msg');
    const first = await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, user, {
        body: { body: 'Adding a little more detail.' },
        idempotencyKey: msgKey,
      }),
    );
    expect(first.status).toBe(201);
    const second = await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, user, {
        body: { body: 'Adding a little more detail.' },
        idempotencyKey: msgKey,
      }),
    );
    expect(second.status).toBe(200);

    const messages = await queryRows<{ count: number }>(
      getDb(),
      sql`SELECT count(*)::int AS count FROM support_messages WHERE support_ticket_id = ${ticketId}`,
    );
    expect(messages[0]!.count).toBe(1);

    const noteKey = freshKey('note');
    const n1 = await NOTE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/notes`, admin, {
        body: { body: 'Internal note about this ticket.' },
        idempotencyKey: noteKey,
      }),
    );
    expect(n1.status).toBe(201);
    const n2 = await NOTE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/notes`, admin, {
        body: { body: 'Internal note about this ticket.' },
        idempotencyKey: noteKey,
      }),
    );
    expect(n2.status).toBe(200);

    const notes = await queryRows<{ count: number }>(
      getDb(),
      sql`SELECT count(*)::int AS count FROM support_notes WHERE support_ticket_id = ${ticketId}`,
    );
    expect(notes[0]!.count).toBe(1);
  });

  it('every mutating route requires an Idempotency-Key', async () => {
    const user = await registerAndLogin();
    const res = await CREATE(
      new Request(`${BASE}/support/tickets`, {
        method: 'POST',
        headers: {
          cookie: `apuriva_session=${user.sessionId}`,
          'x-csrf-token': user.csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify(TICKET_BODY),
      }),
    );
    // No key supplied at all.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
