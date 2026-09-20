/**
 * Spec 032 §6 "E2E" — the whole journey, through the real routes:
 *
 *   a customer asks the assistant → escalates to a ticket → a Support Admin claims it, asks for
 *   information, the customer answers, the admin resolves with a reason → the customer reopens
 *   once → the admin resolves again → the ticket closes.
 *
 * Vitest, not Playwright: this repository has no browser runner, and `e2e/*.spec.ts` is the
 * filename convention spec 005 §6 established for end-to-end coverage.
 *
 * The assertions that make this worth running end to end are the crossing ones — that the SLA
 * pause really opens and closes across two different actors' requests, that the internal note
 * written midway never appears in anything the customer can fetch, and that `closed` is genuinely
 * the end of the line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { POST as ASK } from '@/app/api/v1/support/assistant/route';
import { POST as CREATE, GET as LIST } from '@/app/api/v1/support/tickets/route';
import { GET as DETAIL } from '@/app/api/v1/support/tickets/[id]/route';
import { POST as SEND, GET as THREAD } from '@/app/api/v1/support/tickets/[id]/messages/route';
import { POST as USER_REOPEN } from '@/app/api/v1/support/tickets/[id]/reopen/route';
import { GET as INBOX } from '@/app/api/v1/admin/support/tickets/route';
import { GET as ADMIN_DETAIL } from '@/app/api/v1/admin/support/tickets/[id]/route';
import { POST as ASSIGN } from '@/app/api/v1/admin/support/tickets/[id]/assign/route';
import { POST as NOTE } from '@/app/api/v1/admin/support/tickets/[id]/notes/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
import { POST as ADMIN_CLOSE } from '@/app/api/v1/admin/support/tickets/[id]/close/route';
import {
  BASE,
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
} from '@/lib/support/support-test-support';

const dbReachable = await isDatabaseReachable();

const INTERNAL_NOTE = 'Internal: third contact this month, consider a goodwill gesture.';

describe.skipIf(!dbReachable)('spec 032 support, end to end', () => {
  let customer: TestSession;
  let admin: TestAdmin;

  beforeAll(async () => {
    if (!dbReachable) return;
    useSupportIntegration();
    customer = await registerAndLogin();
    admin = await registerAdmin();
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
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('carries a customer from a question to a closed ticket', async () => {
    // 1. The customer asks the assistant. Whatever the AI does, the human path stays open.
    const askRes = await ASK(
      supportRequest(`${BASE}/support/assistant`, customer, { body: { question: 'How do I change my booking time?' } }),
    );
    expect(askRes.status).toBe(200);
    const assistant = (await askRes.json()).data;
    expect(assistant.escalationAvailable).toBe(true);

    // 2. They escalate to a human.
    const createRes = await CREATE(
      supportRequest(`${BASE}/support/tickets`, customer, {
        body: {
          subject: 'I need to move my booking',
          description: 'The time no longer works for me and I cannot see how to change it.',
          category: 'booking',
        },
      }),
    );
    expect(createRes.status).toBe(201);
    const ticket = (await createRes.json()).data;
    expect(ticket.status).toBe('open');
    expect(ticket.priority).toBe('medium'); // derived from `booking`, never sent by the client

    // 3. The admin claims it.
    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );

    // 4. It appears in that admin's queue, carrying its SLA. Scoped by `assignedToMe`, because the
    //    shared test database holds every other suite's tickets too and an unfiltered first page
    //    would be a coin toss rather than an assertion.
    const inboxRes = await INBOX(
      supportRequest(`${BASE}/admin/support/tickets?assignedToMe=true`, admin, { method: 'GET' }),
    );
    expect(inboxRes.status).toBe(200);
    const queued = ((await inboxRes.json()).data as { id: string; slaDeadlineAt: string; slaBreached: boolean }[]).find(
      (t) => t.id === ticket.id,
    );
    expect(queued).toBeTruthy();
    expect(queued!.slaDeadlineAt).toBeTruthy();
    expect(queued!.slaBreached).toBe(false);

    // ...and the admin writes an internal note.

    await NOTE(supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/notes`, admin, { body: { body: INTERNAL_NOTE } }));

    // 5. The admin asks for information: the SLA clock pauses.
    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, admin, {
        body: { body: 'What time would suit you instead?', requestsInformation: true },
      }),
    );
    let row = await readTicketRow(ticket.id);
    expect(row!.status).toBe('awaiting_user');
    expect(row!.awaiting_user_since).toBeTruthy();

    // 6. The customer answers: the pause closes, in the same request.
    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, customer, { body: { body: 'Friday morning, please.' } }),
    );
    row = await readTicketRow(ticket.id);
    expect(row!.status).toBe('assigned');
    expect(row!.awaiting_user_since).toBeNull();

    // 7. Nothing internal ever reaches the customer.
    const threadRes = await THREAD(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/messages`, customer, { method: 'GET' }),
    );
    const threadJson = JSON.stringify(await threadRes.json());
    expect(threadJson).not.toContain(INTERNAL_NOTE);
    expect(threadJson).not.toContain(admin.userId);

    const detailRes = await DETAIL(supportRequest(`${BASE}/support/tickets/${ticket.id}`, customer, { method: 'GET' }));
    const detailJson = JSON.stringify(await detailRes.json());
    expect(detailJson).not.toContain(INTERNAL_NOTE);
    expect(detailJson).not.toContain('aiSummary');
    expect(detailJson).not.toContain('slaDeadlineAt');

    // 8. The admin resolves with a reason the customer is entitled to see.
    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/resolve`, admin, {
        body: {
          resolutionKind: 'answered',
          reason: 'Moved the booking to Friday morning and confirmed with the provider.',
          expectedStatus: 'assigned',
        },
      }),
    );
    const resolved = await DETAIL(supportRequest(`${BASE}/support/tickets/${ticket.id}`, customer, { method: 'GET' }));
    const resolvedTicket = (await resolved.json()).data;
    expect(resolvedTicket.status).toBe('resolved');
    expect(resolvedTicket.resolutionReason).toMatch(/Friday morning/);
    expect(resolvedTicket.reopenBy).toBeTruthy();

    // 9. The customer reopens once — it was not actually sorted.
    const reopenRes = await USER_REOPEN(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/reopen`, customer, { body: {} }),
    );
    expect(reopenRes.status).toBe(200);
    expect((await reopenRes.json()).data.status).toBe('assigned');

    // 10. The admin resolves again and closes it. `closed` is the end of the line.
    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/resolve`, admin, {
        body: {
          resolutionKind: 'answered',
          reason: 'Confirmed the new time directly with the provider this time.',
          expectedStatus: 'assigned',
        },
      }),
    );
    await ADMIN_CLOSE(supportRequest(`${BASE}/admin/support/tickets/${ticket.id}/close`, admin, { body: {} }));

    row = await readTicketRow(ticket.id);
    expect(row!.status).toBe('closed');
    expect(row!.closed_at).toBeTruthy();

    const secondReopen = await USER_REOPEN(
      supportRequest(`${BASE}/support/tickets/${ticket.id}/reopen`, customer, { body: {} }),
    );
    expect(secondReopen.status).toBe(422);

    // 11. The whole thing is on the customer's own list, and audited for the admin.
    const listRes = await LIST(supportRequest(`${BASE}/support/tickets`, customer, { method: 'GET' }));
    expect(((await listRes.json()).data as { id: string }[]).some((t) => t.id === ticket.id)).toBe(true);

    await ADMIN_DETAIL(supportRequest(`${BASE}/admin/support/tickets/${ticket.id}`, admin, { method: 'GET' }));
    const events = await queryRows<{ event_type: string }>(
      getDb(),
      sql`SELECT DISTINCT event_type FROM security_events
           WHERE user_id = ${admin.userId} AND event_type LIKE 'support.%'`,
    );
    const types = events.map((e) => e.event_type);
    for (const expected of [
      'support.ticket_assigned',
      'support.note_added',
      'support.admin_replied',
      'support.ticket_resolved',
      'support.ticket_closed',
      'support.ticket_read',
    ]) {
      expect(types, `missing audit event ${expected}`).toContain(expected);
    }
  });
});
