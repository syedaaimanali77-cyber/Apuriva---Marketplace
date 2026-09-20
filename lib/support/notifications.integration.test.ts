/**
 * Spec 032 §6 "Notifications" (DECIDED-12).
 *
 * The assertions that matter most are the NEGATIVE ones. Four types exist; the design decision is
 * everything that deliberately does NOT notify — a requester's own reply, assignment, closure and
 * an SLA breach. An accidental fifth notification would quietly turn a visibility feature into an
 * escalation engine, so the absences are tested as firmly as the presences.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { POST as SEND } from '@/app/api/v1/support/tickets/[id]/messages/route';
import { POST as ASSIGN } from '@/app/api/v1/admin/support/tickets/[id]/assign/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
import { POST as ADMIN_CLOSE } from '@/app/api/v1/admin/support/tickets/[id]/close/route';
import { NOTIFICATION_CATALOGUE } from '@/lib/notifications/catalogue';
import {
  BASE,
  expireSla,
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

const SUPPORT_TYPES = [
  'support_ticket_created',
  'support_reply_posted',
  'support_info_requested',
  'support_ticket_resolved',
] as const;

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

async function makeTicket(user: TestSession): Promise<string> {
  const res = await CREATE(
    supportRequest(`${BASE}/support/tickets`, user, {
      body: {
        subject: 'A question about my account',
        description: 'I would like to understand something about how this works.',
        category: 'account',
      },
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

async function typesFor(userId: string): Promise<string[]> {
  const rows = await queryRows<{ type: string }>(
    getDb(),
    sql`SELECT type FROM notifications WHERE recipient_user_id = ${userId} ORDER BY created_at ASC`,
  );
  return rows.map((r) => r.type);
}

describe('the support catalogue entries', () => {
  it('all four sit in the existing operational category — no new category, no migration', () => {
    for (const type of SUPPORT_TYPES) {
      expect(NOTIFICATION_CATALOGUE[type].category).toBe('operational');
    }
  });

  it('every body is content-free: no placeholder carries the ticket subject or an admin word', () => {
    for (const type of SUPPORT_TYPES) {
      const entry = NOTIFICATION_CATALOGUE[type];
      const text = `${entry.title} ${entry.body}`;
      expect(text).not.toMatch(/\{subject\}|\{body\}|\{reason\}|\{description\}/);
      // Only the resolved notification carries a param at all, and it is a deadline.
      expect(entry.params.every((p) => p === 'reopenBy')).toBe(true);
    }
  });
});

describe.skipIf(!dbReachable)('spec 032 notifications (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('notifies the requester when their ticket is created', async () => {
    const user = await registerAndLogin();
    await makeTicket(user);
    expect(await typesFor(user.userId)).toContain('support_ticket_created');
  });

  it('notifies the requester on an ADMIN reply, and on a request for information', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, admin, { body: { body: 'Here is what we found.' } }),
    );
    expect(await typesFor(user.userId)).toContain('support_reply_posted');

    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, admin, {
        body: { body: 'Could you confirm the date this happened?', requestsInformation: true },
      }),
    );
    expect(await typesFor(user.userId)).toContain('support_info_requested');
  });

  it('a REQUESTER reply notifies nobody — the queue is the admin surface', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    const before = (await typesFor(admin.userId)).length;
    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, user, { body: { body: 'Any update on this?' } }),
    );
    expect((await typesFor(admin.userId)).length).toBe(before);
  });

  it('ASSIGNMENT notifies nobody — it is internal bookkeeping', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    const before = await typesFor(user.userId);
    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    expect(await typesFor(user.userId)).toEqual(before);
  });

  it('resolution notifies with the reopen deadline; CLOSURE notifies nobody', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user);

    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Explained how the feature works in detail.', expectedStatus: 'open' },
      }),
    );
    expect(await typesFor(user.userId)).toContain('support_ticket_resolved');

    // The body renders the deadline it was given, and nothing about the resolution itself.
    const rows = await queryRows<{ body: string }>(
      getDb(),
      sql`SELECT body FROM notifications WHERE recipient_user_id = ${user.userId} AND type = 'support_ticket_resolved' LIMIT 1`,
    );
    expect(rows[0]!.body).not.toMatch(/Explained how the feature works/);

    const beforeClose = await typesFor(user.userId);
    await ADMIN_CLOSE(supportRequest(`${BASE}/admin/support/tickets/${ticketId}/close`, admin, { body: {} }));
    expect(await typesFor(user.userId)).toEqual(beforeClose);
  });

  it('an SLA BREACH notifies nobody — the most important absence (DECIDED-12)', async () => {
    const user = await registerAndLogin();
    const ticketId = await makeTicket(user);

    const before = await typesFor(user.userId);
    await expireSla(ticketId);
    expect(await typesFor(user.userId)).toEqual(before);
  });

  it('a retried emission is suppressed rather than sent twice (spec 026 AC-7)', async () => {
    const user = await registerAndLogin();
    await makeTicket(user);

    const counts = await queryRows<{ count: number }>(
      getDb(),
      sql`SELECT count(*)::int AS count FROM notifications
           WHERE recipient_user_id = ${user.userId} AND type = 'support_ticket_created'`,
    );
    expect(counts[0]!.count).toBe(1);
  });
});
