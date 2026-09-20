/**
 * Spec 032 §6 "API integration" / "Lifecycle" (AC-3, AC-4, AC-6, AC-7).
 *
 * Drives the REAL route handlers with real sessions, so the assertions are about the product's own
 * path rather than about the domain functions in isolation.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { POST as CREATE, GET as LIST } from '@/app/api/v1/support/tickets/route';
import { GET as DETAIL } from '@/app/api/v1/support/tickets/[id]/route';
import { POST as SEND, GET as THREAD } from '@/app/api/v1/support/tickets/[id]/messages/route';
import { POST as USER_REOPEN } from '@/app/api/v1/support/tickets/[id]/reopen/route';
import { POST as USER_CLOSE } from '@/app/api/v1/support/tickets/[id]/close/route';
import { GET as INBOX } from '@/app/api/v1/admin/support/tickets/route';
import { GET as ADMIN_DETAIL } from '@/app/api/v1/admin/support/tickets/[id]/route';
import { POST as ASSIGN } from '@/app/api/v1/admin/support/tickets/[id]/assign/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
import { POST as ADMIN_CLOSE } from '@/app/api/v1/admin/support/tickets/[id]/close/route';
import {
  BASE,
  backdateResolution,
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

async function seedSupportAdmin(): Promise<TestAdmin> {
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

async function createTicket(
  user: TestSession,
  body: Record<string, unknown> = {},
): Promise<{ id: string; status: string; priority: string; category: string }> {
  const res = await CREATE(
    supportRequest(`${BASE}/support/tickets`, user, {
      body: {
        subject: 'Cannot complete my booking',
        description: 'The confirm button does nothing and I get no error.',
        category: 'booking',
        ...body,
      },
    }),
  );
  expect(res.status).toBe(201);
  const { data } = await res.json();
  return data;
}

describe.skipIf(!dbReachable)('spec 032 support lifecycle (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('creates a ticket at open with a server-derived priority and an SLA deadline (AC-4)', async () => {
    const user = await registerAndLogin();
    const ticket = await createTicket(user, { category: 'payment' });

    expect(ticket.status).toBe('open');
    // Derived from the category, not from the request — `payment` maps to `high`.
    expect(ticket.priority).toBe('high');

    const row = await readTicketRow(ticket.id);
    expect(row?.sla_deadline_at).toBeTruthy();
    expect(row?.requester_mode).toBe('customer');
    // 12 hours for `high`, measured from creation.
    const created = new Date(row!.created_at as string).getTime();
    const deadline = new Date(row!.sla_deadline_at as string).getTime();
    expect(Math.round((deadline - created) / 3_600_000)).toBe(12);
  });

  it('a safety ticket is created critical, never generic low priority (AC-4)', async () => {
    const user = await registerAndLogin();
    const ticket = await createTicket(user, { category: 'safety' });
    expect(ticket.priority).toBe('critical');
  });

  it('runs the whole lifecycle: open to assigned to awaiting_user to assigned to resolved to closed', async () => {
    const user = await registerAndLogin();
    const admin = await seedSupportAdmin();
    const ticket = await createTicket(user);

    // assign
    const assignRes = await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    expect(assignRes.status).toBe(200);
    expect((await assignRes.json()).data.status).toBe('assigned');

    // admin asks for information -> awaiting_user
    const askRes = await SEND(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, admin, {
        body: { body: 'Which browser are you using?', requestsInformation: true },
      }),
    );
    expect(askRes.status).toBe(201);
    expect((await readTicketRow(ticket.id))?.status).toBe('awaiting_user');

    // the user replies -> back to assigned, automatically
    const replyRes = await SEND(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, user, { body: { body: 'Safari on iOS.' } }),
    );
    expect(replyRes.status).toBe(201);
    expect((await readTicketRow(ticket.id))?.status).toBe('assigned');

    // resolve
    const resolveRes = await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/resolve`, admin, {
        body: {
          resolutionKind: 'answered',
          reason: 'Known Safari issue; guided the customer through the workaround.',
          expectedStatus: 'assigned',
        },
      }),
    );
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()).data;
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolutionKind).toBe('answered');

    // the requester sees the reason and a reopen deadline (AC-3)
    const detailRes = await DETAIL(supportRequest(`${BASE}/support/tickets/${ticket.id}`, user, { method: 'GET' }));
    const detail = (await detailRes.json()).data;
    expect(detail.resolutionReason).toMatch(/Safari/);
    expect(detail.reopenBy).toBeTruthy();

    // close
    const closeRes = await ADMIN_CLOSE(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/close`, admin, { body: {} }),
    );
    expect(closeRes.status).toBe(200);
    const row = await readTicketRow(ticket.id);
    expect(row?.status).toBe('closed');
    expect(row?.closed_at).toBeTruthy();
  });

  it('closed is terminal: no further transition is accepted from anyone (AC-7)', async () => {
    const user = await registerAndLogin();
    const admin = await seedSupportAdmin();
    const ticket = await createTicket(user);

    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Resolved after a short exchange.', expectedStatus: 'assigned' },
      }),
    );
    await ADMIN_CLOSE(supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/close`, admin, { body: {} }));

    // The requester cannot reopen a closed ticket.
    const reopenRes = await USER_REOPEN(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/reopen`, user, { body: {} }),
    );
    expect(reopenRes.status).toBe(422);
    expect((await reopenRes.json()).code).toBe('SUPPORT_TRANSITION_NOT_ALLOWED');

    // Nor can they post to it.
    const postRes = await SEND(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, user, { body: { body: 'One more thing' } }),
    );
    expect(postRes.status).toBe(422);
    expect((await postRes.json()).code).toBe('SUPPORT_TICKET_CLOSED');
  });

  it('the requester may reopen once, then never again (AC-7)', async () => {
    const user = await registerAndLogin();
    const admin = await seedSupportAdmin();
    const ticket = await createTicket(user);

    const resolveOnce = async () => {
      const current = (await readTicketRow(ticket.id))?.status as string;
      await RESOLVE(
        supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/resolve`, admin, {
          body: { resolutionKind: 'answered', reason: 'Answered the question in full.', expectedStatus: current },
        }),
      );
    };

    await resolveOnce();
    const first = await USER_REOPEN(supportRequest(`${BASE}/support/tickets/${ticket.id}/reopen`, user, { body: {} }));
    expect(first.status).toBe(200);
    expect((await first.json()).data.status).toBe('assigned');

    await resolveOnce();
    const second = await USER_REOPEN(supportRequest(`${BASE}/support/tickets/${ticket.id}/reopen`, user, { body: {} }));
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('SUPPORT_REOPEN_LIMIT_REACHED');
  });

  it('refuses a reopen once the window has elapsed', async () => {
    const user = await registerAndLogin();
    const admin = await seedSupportAdmin();
    const ticket = await createTicket(user);

    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Answered the question in full.', expectedStatus: 'open' },
      }),
    );
    await backdateResolution(ticket.id, 30);

    const res = await USER_REOPEN(supportRequest(`${BASE}/support/tickets/${ticket.id}/reopen`, user, { body: {} }));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SUPPORT_REOPEN_WINDOW_ELAPSED');
  });

  it('the requester can accept a resolution early by closing it themselves', async () => {
    const user = await registerAndLogin();
    const admin = await seedSupportAdmin();
    const ticket = await createTicket(user);

    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Answered the question in full.', expectedStatus: 'open' },
      }),
    );
    const res = await USER_CLOSE(supportRequest(`${BASE}/support/tickets/${ticket.id}/close`, user, { body: {} }));
    expect(res.status).toBe(200);
    expect((await readTicketRow(ticket.id))?.status).toBe('closed');
  });

  it('lists only the caller own tickets, and 404s a stranger ticket (AC-3)', async () => {
    const mine = await registerAndLogin();
    const theirs = await registerAndLogin();
    const myTicket = await createTicket(mine);
    await createTicket(theirs);

    const listRes = await LIST(supportRequest(`${BASE}/support/tickets`, mine, { method: 'GET' }));
    const list = await listRes.json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(myTicket.id);

    const strangerRes = await DETAIL(
      supportRequest(`${BASE}/support/tickets/${myTicket.id}`, theirs, { method: 'GET' }),
    );
    // 404, never 403: a 403 would confirm the ticket exists.
    expect(strangerRes.status).toBe(404);
    expect((await strangerRes.json()).code).toBe('SUPPORT_TICKET_NOT_FOUND');
  });

  it('the thread reads oldest-first and never names the admin who replied (AC-3)', async () => {
    const user = await registerAndLogin();
    const admin = await seedSupportAdmin();
    const ticket = await createTicket(user);

    await SEND(supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, user, { body: { body: 'First from me.' } }));
    await SEND(supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, admin, { body: { body: 'Reply from support.' } }));

    const res = await THREAD(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, user, { method: 'GET' }),
    );
    const { data } = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].body).toBe('First from me.');
    expect(data[0].author).toBe('you');
    expect(data[1].author).toBe('support');
    expect(JSON.stringify(data)).not.toContain(admin.userId);
  });

  it('records an audit event for every admin action (AC-6)', async () => {
    const user = await registerAndLogin();
    const admin = await seedSupportAdmin();
    const ticket = await createTicket(user);

    await ADMIN_DETAIL(supportRequest(`${BASE}/admin/support/tickets/${ticket.id}`, admin, { method: 'GET' }));
    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Answered the question in full.', expectedStatus: 'assigned' },
      }),
    );

    const events = await queryRows<{ event_type: string }>(
      getDb(),
      sql`SELECT event_type FROM security_events
           WHERE user_id = ${admin.userId} AND event_type LIKE 'support.%'
           ORDER BY created_at ASC`,
    );
    const types = events.map((e) => e.event_type);
    expect(types).toContain('support.ticket_read');
    expect(types).toContain('support.ticket_assigned');
    expect(types).toContain('support.ticket_resolved');
  });

  it('the admin inbox returns the master 63 fields and filters (AC-5)', async () => {
    const user = await registerAndLogin();
    const admin = await seedSupportAdmin();
    const ticket = await createTicket(user, { category: 'payment' });

    const res = await INBOX(supportRequest(`${BASE}/admin/support/tickets?priority=high`, admin, { method: 'GET' }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const found = data.find((t: { id: string }) => t.id === ticket.id);
    expect(found).toBeTruthy();
    expect(found.priority).toBe('high');
    expect(found).toHaveProperty('slaDeadlineAt');
    expect(found).toHaveProperty('slaBreached');

    const detailRes = await ADMIN_DETAIL(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}`, admin, { method: 'GET' }),
    );
    const detail = (await detailRes.json()).data;
    for (const field of ['requesterUserId', 'requesterMode', 'assignedAdminUserId', 'slaDeadlineAt', 'aiSummary', 'context']) {
      expect(detail).toHaveProperty(field);
    }
  });
});
