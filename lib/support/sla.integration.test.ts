/**
 * Spec 032 §6 "SLA" (AC-8) — the clock, against the real SQL.
 *
 * `lib/support/sla.test.ts` pins the arithmetic; this proves the database agrees with it. The two
 * assertions that matter most are the ones that stop the SLA becoming a weapon: reassignment must
 * NOT reset the deadline (or passing a ticket around would erase a breach), and a priority change
 * must re-anchor to CREATION (or re-prioritising would buy time).
 *
 * And the whole of the consequence: a breach is FLAGGED and nothing else happens.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { POST as SEND } from '@/app/api/v1/support/tickets/[id]/messages/route';
import { GET as INBOX } from '@/app/api/v1/admin/support/tickets/route';
import { POST as ASSIGN } from '@/app/api/v1/admin/support/tickets/[id]/assign/route';
import { POST as PRIORITY } from '@/app/api/v1/admin/support/tickets/[id]/priority/route';
import {
  BASE,
  expireSla,
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

async function makeTicket(user: TestSession, category = 'account'): Promise<string> {
  const res = await CREATE(
    supportRequest(`${BASE}/support/tickets`, user, {
      body: {
        subject: 'Something needs looking at',
        description: 'Please take a look at this when you get a chance, thank you.',
        category,
      },
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

async function deadlineOf(ticketId: string): Promise<number> {
  const row = await readTicketRow(ticketId);
  return new Date(row!.sla_deadline_at as string).getTime();
}

describe.skipIf(!dbReachable)('spec 032 SLA clock (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('sets the deadline from the derived priority at creation', async () => {
    const user = await registerAndLogin();
    // `account` maps to `medium` = 24h.
    const ticketId = await makeTicket(user, 'account');
    const row = await readTicketRow(ticketId);
    const hours = (new Date(row!.sla_deadline_at as string).getTime() - new Date(row!.created_at as string).getTime()) / 3_600_000;
    expect(Math.round(hours)).toBe(24);
  });

  it('REASSIGNMENT DOES NOT RESET THE DEADLINE — otherwise it would erase a breach', async () => {
    const user = await registerAndLogin();
    const first = await supportAdmin();
    const second = await supportAdmin();
    const ticketId = await makeTicket(user);

    const before = await deadlineOf(ticketId);

    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, first, {
        body: { assigneeUserId: first.userId, expectedStatus: 'open' },
      }),
    );
    expect(await deadlineOf(ticketId)).toBe(before);

    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, first, {
        body: { assigneeUserId: second.userId, expectedStatus: 'assigned' },
      }),
    );
    // Byte-identical across both the claim and the handover.
    expect(await deadlineOf(ticketId)).toBe(before);
  });

  it('awaiting_user PAUSES the clock and resuming restores exactly the elapsed time', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    const beforePause = await deadlineOf(ticketId);

    // Admin asks for information: the pause begins and is stamped.
    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, admin, {
        body: { body: 'Could you tell us which device you were using?', requestsInformation: true },
      }),
    );
    let row = await readTicketRow(ticketId);
    expect(row!.status).toBe('awaiting_user');
    expect(row!.awaiting_user_since).toBeTruthy();
    // The deadline itself has not moved yet — only the stamp exists.
    expect(await deadlineOf(ticketId)).toBe(beforePause);

    // Backdate the pause so a measurable interval has elapsed without sleeping.
    await getDb().execute(
      sql`UPDATE support_tickets SET awaiting_user_since = clock_timestamp() - interval '2 hours' WHERE id = ${ticketId}`,
    );

    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, user, { body: { body: 'It was an iPhone.' } }),
    );

    row = await readTicketRow(ticketId);
    expect(row!.status).toBe('assigned');
    expect(row!.awaiting_user_since).toBeNull();
    // Pushed forward by ~2 hours, and the pause is banked for a later priority change.
    const afterResume = await deadlineOf(ticketId);
    const pushedHours = (afterResume - beforePause) / 3_600_000;
    expect(pushedHours).toBeGreaterThan(1.9);
    expect(pushedHours).toBeLessThan(2.2);
    expect(Number(row!.sla_paused_seconds)).toBeGreaterThan(7000);
  });

  it('a ticket waiting on the user is NEVER reported breached, however old its deadline', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, admin, {
        body: { body: 'We need a little more information, please.', requestsInformation: true },
      }),
    );
    await expireSla(ticketId);

    // Not in the breached filter...
    const breachedRes = await INBOX(
      supportRequest(`${BASE}/admin/support/tickets?slaBreached=true`, admin, { method: 'GET' }),
    );
    const breached = (await breachedRes.json()).data as { id: string }[];
    expect(breached.find((t) => t.id === ticketId)).toBeUndefined();

    // ...and not flagged in its own row either. The SQL filter and the projection agree.
    const allRes = await INBOX(supportRequest(`${BASE}/admin/support/tickets`, admin, { method: 'GET' }));
    const mine = ((await allRes.json()).data as { id: string; slaBreached: boolean }[]).find((t) => t.id === ticketId);
    expect(mine?.slaBreached).toBe(false);
  });

  it('a live ticket past its deadline IS flagged and filterable — and nothing else happens (AC-8)', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);
    await expireSla(ticketId);

    const before = await readTicketRow(ticketId);

    const res = await INBOX(
      supportRequest(`${BASE}/admin/support/tickets?slaBreached=true`, admin, { method: 'GET' }),
    );
    const breached = (await res.json()).data as { id: string; slaBreached: boolean }[];
    const found = breached.find((t) => t.id === ticketId);
    expect(found).toBeTruthy();
    expect(found!.slaBreached).toBe(true);

    // THE WHOLE OF THE CONSEQUENCE: reading the queue changed nothing about the ticket.
    const after = await readTicketRow(ticketId);
    expect(after!.status).toBe(before!.status);
    expect(after!.priority).toBe(before!.priority);
    expect(after!.assigned_admin_user_id).toBe(before!.assigned_admin_user_id);

    // And no notification was produced by the breach.
    const notes = await queryRows<{ count: number }>(
      getDb(),
      sql`SELECT count(*)::int AS count FROM notifications
           WHERE recipient_user_id = ${user.userId} AND type LIKE 'support_%'
             AND type <> 'support_ticket_created'`,
    );
    expect(notes[0]!.count).toBe(0);
  });

  it('a priority change re-anchors the deadline to CREATION, so it cannot buy time', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    // `technical` maps to `low` = 72h.
    const ticketId = await makeTicket(user, 'technical');

    const row = await readTicketRow(ticketId);
    const createdAt = new Date(row!.created_at as string).getTime();
    expect(Math.round((await deadlineOf(ticketId) - createdAt) / 3_600_000)).toBe(72);

    const res = await PRIORITY(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/priority`, admin, {
        body: { priority: 'critical', reason: 'Customer reports this is blocking their business.', expectedStatus: 'open' },
      }),
    );
    expect(res.status).toBe(200);

    // 4h for `critical`, measured from CREATION — not from the moment of the change.
    const hours = (await deadlineOf(ticketId) - createdAt) / 3_600_000;
    expect(Math.round(hours)).toBe(4);
  });

  it('records both the old and the new priority in the audit trail (AC-4, AC-6)', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user, 'technical');

    await PRIORITY(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/priority`, admin, {
        body: { priority: 'high', reason: 'Raising this after a second report of the same fault.', expectedStatus: 'open' },
      }),
    );

    const events = await queryRows<{ metadata: unknown }>(
      getDb(),
      sql`SELECT metadata FROM security_events
           WHERE user_id = ${admin.userId} AND event_type = 'support.priority_changed'
           ORDER BY created_at DESC LIMIT 1`,
    );
    const serialized = JSON.stringify(events[0]?.metadata ?? {});
    expect(serialized).toContain('low');
    expect(serialized).toContain('high');
  });
});
