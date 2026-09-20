/**
 * Spec 032 §6 "Authorization" (DECIDED-9).
 *
 * Needs no booking: authorization is about who may act on a ticket, and a ticket needs no context.
 *
 * The two claims that matter most here are the ones a reviewer would doubt: that
 * `operations_admin` really can only WATCH, and that an admin who raised a ticket is refused for
 * the RIGHT reason rather than being told they lack a permission they in fact hold.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { GET as INBOX } from '@/app/api/v1/admin/support/tickets/route';
import { GET as ADMIN_DETAIL } from '@/app/api/v1/admin/support/tickets/[id]/route';
import { POST as ASSIGN } from '@/app/api/v1/admin/support/tickets/[id]/assign/route';
import { POST as PRIORITY } from '@/app/api/v1/admin/support/tickets/[id]/priority/route';
import { POST as NOTE, GET as NOTES } from '@/app/api/v1/admin/support/tickets/[id]/notes/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
import { POST as SEND } from '@/app/api/v1/support/tickets/[id]/messages/route';
import {
  BASE,
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  registerAndLogin,
  seedPermission,
  supportRequest,
  useSupportIntegration,
  type TestAdmin,
  type TestSession,
} from './support-test-support';

const dbReachable = await isDatabaseReachable();

const ALL_ACTIONS = [
  ['read', 'low'],
  ['assign', 'low'],
  ['respond', 'low'],
  ['triage', 'medium'],
  ['resolve', 'medium'],
] as const;

async function supportAdmin(): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, 'support_admin');
  for (const [action, tier] of ALL_ACTIONS) await seedPermission('support_admin', 'support', action, tier);
  return admin;
}

/** Operations holds READ ONLY — master §69 gives support tickets to the Support Admin. */
async function operationsAdmin(): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, 'operations_admin');
  await seedPermission('operations_admin', 'support', 'read', 'low');
  return admin;
}

async function makeTicket(user: TestSession): Promise<string> {
  const res = await CREATE(
    supportRequest(`${BASE}/support/tickets`, user, {
      body: {
        subject: 'A question for support',
        description: 'I would like some help understanding something on my account.',
        category: 'account',
      },
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

describe.skipIf(!dbReachable)('spec 032 authorization (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('refuses every admin route to a signed-in user with no support permission', async () => {
    const user = await registerAndLogin();
    const outsider = await registerAndLogin();
    const ticketId = await makeTicket(user);

    const calls: [string, Response][] = [
      ['inbox', await INBOX(supportRequest(`${BASE}/admin/support/tickets`, outsider, { method: 'GET' }))],
      ['detail', await ADMIN_DETAIL(supportRequest(`${BASE}/admin/support/tickets/${ticketId}`, outsider, { method: 'GET' }))],
      ['notes', await NOTES(supportRequest(`${BASE}/admin/support/tickets/${ticketId}/notes`, outsider, { method: 'GET' }))],
      [
        'assign',
        await ASSIGN(
          supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, outsider, {
            body: { assigneeUserId: outsider.userId, expectedStatus: 'open' },
          }),
        ),
      ],
      [
        'resolve',
        await RESOLVE(
          supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, outsider, {
            body: { resolutionKind: 'answered', reason: 'Trying to resolve without permission.', expectedStatus: 'open' },
          }),
        ),
      ],
    ];

    for (const [name, res] of calls) {
      expect(res.status, `${name} should be forbidden`).toBe(403);
    }
  });

  it('operations_admin can WATCH the queue and do nothing else (DECIDED-9)', async () => {
    const user = await registerAndLogin();
    const ops = await operationsAdmin();
    const ticketId = await makeTicket(user);

    // Read: allowed.
    const inbox = await INBOX(supportRequest(`${BASE}/admin/support/tickets`, ops, { method: 'GET' }));
    expect(inbox.status).toBe(200);
    const detail = await ADMIN_DETAIL(supportRequest(`${BASE}/admin/support/tickets/${ticketId}`, ops, { method: 'GET' }));
    expect(detail.status).toBe(200);

    // Every acting route: refused.
    const assign = await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, ops, {
        body: { assigneeUserId: ops.userId, expectedStatus: 'open' },
      }),
    );
    expect(assign.status).toBe(403);

    const priority = await PRIORITY(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/priority`, ops, {
        body: { priority: 'critical', reason: 'Trying to escalate without the permission.', expectedStatus: 'open' },
      }),
    );
    expect(priority.status).toBe(403);

    const note = await NOTE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/notes`, ops, { body: { body: 'An internal note.' } }),
    );
    expect(note.status).toBe(403);

    const resolve = await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, ops, {
        body: { resolutionKind: 'answered', reason: 'Operations should not be able to do this.', expectedStatus: 'open' },
      }),
    );
    expect(resolve.status).toBe(403);
  });

  it('an admin who RAISED the ticket is refused for the conflict, not for a permission', async () => {
    const admin = await supportAdmin();
    // The admin raises a ticket as an ordinary user.
    const ticketId = await makeTicket(admin);

    const res = await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    expect(res.status).toBe(403);
    // The precise code matters: they DO hold `support/assign`, so a bare FORBIDDEN would mislead.
    expect((await res.json()).code).toBe('SUPPORT_PARTICIPANT_CONFLICT');

    const resolve = await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Resolving my own support ticket.', expectedStatus: 'open' },
      }),
    );
    expect((await resolve.json()).code).toBe('SUPPORT_PARTICIPANT_CONFLICT');
  });

  it('but that admin keeps full access AS THE REQUESTER', async () => {
    const admin = await supportAdmin();
    const ticketId = await makeTicket(admin);

    const send = await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, admin, { body: { body: 'Adding detail to my own ticket.' } }),
    );
    expect(send.status).toBe(201);
    // Posted as the requester, not as an official support reply.
    expect((await send.json()).data.author).toBe('you');
  });

  it('a stranger cannot read another user ticket through the admin route either', async () => {
    const user = await registerAndLogin();
    const stranger = await registerAndLogin();
    const ticketId = await makeTicket(user);

    const res = await ADMIN_DETAIL(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}`, stranger, { method: 'GET' }),
    );
    expect(res.status).toBe(403);
  });

  it('refuses an assignment to an admin who cannot reply', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ops = await operationsAdmin(); // read-only: cannot hold a ticket
    const ticketId = await makeTicket(user);

    const res = await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, admin, {
        body: { assigneeUserId: ops.userId, expectedStatus: 'open' },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SUPPORT_ASSIGNEE_NOT_ELIGIBLE');
  });

  it('internal notes are unreachable by the requester through any route (AC-3)', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    await NOTE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/notes`, admin, {
        body: { body: 'Internal: customer has three similar tickets this month.' },
      }),
    );

    // The requester hitting the admin notes route is refused outright.
    const res = await NOTES(supportRequest(`${BASE}/admin/support/tickets/${ticketId}/notes`, user, { method: 'GET' }));
    expect(res.status).toBe(403);
  });
});
