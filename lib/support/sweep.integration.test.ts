/**
 * Spec 032 §6 — the reopen-window sweep.
 *
 * The sweep exists so `closed` is reachable at all. What it must NOT do is as important as what it
 * does: it is not an SLA sweep, it decides no outcome, and it touches nothing that has not actually
 * run out its reopen window.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
import { GET as SWEEP } from '@/app/api/v1/cron/support-reopen-sweep/route';
import { NextRequest } from 'next/server';
import {
  BASE,
  backdateResolution,
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
import { runSupportReopenSweep } from './sweep';

const dbReachable = await isDatabaseReachable();

async function supportAdmin(): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, 'support_admin');
  await seedPermission('support_admin', 'support', 'resolve', 'medium');
  await seedPermission('support_admin', 'support', 'read', 'low');
  return admin;
}

async function resolvedTicket(user: TestSession, admin: TestAdmin): Promise<string> {
  const res = await CREATE(
    supportRequest(`${BASE}/support/tickets`, user, {
      body: {
        subject: 'A question that gets answered',
        description: 'Asking something that support will be able to answer for me.',
        category: 'other',
      },
    }),
  );
  const ticketId = (await res.json()).data.id;
  await RESOLVE(
    supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
      body: { resolutionKind: 'answered', reason: 'Answered the question the customer asked.', expectedStatus: 'open' },
    }),
  );
  return ticketId;
}

describe.skipIf(!dbReachable)('spec 032 reopen sweep (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('closes a resolved ticket whose reopen window has elapsed', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await resolvedTicket(user, admin);

    await backdateResolution(ticketId, 30);
    const { closed } = await runSupportReopenSweep();
    expect(closed).toBeGreaterThanOrEqual(1);

    const row = await readTicketRow(ticketId);
    expect(row!.status).toBe('closed');
    expect(row!.closed_at).toBeTruthy();
    // It made the decision final; it did not change what the decision was.
    expect(row!.resolution_kind).toBe('answered');
  });

  it('leaves a ticket still inside its window completely alone', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await resolvedTicket(user, admin);

    await runSupportReopenSweep();
    expect((await readTicketRow(ticketId))!.status).toBe('resolved');
  });

  it('is idempotent: a second run does not re-close or double-count', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await resolvedTicket(user, admin);
    await backdateResolution(ticketId, 30);

    await runSupportReopenSweep();
    const closedAt = (await readTicketRow(ticketId))!.closed_at;

    const second = await runSupportReopenSweep();
    // The same row cannot be picked up twice — its status is no longer `resolved`.
    const after = await readTicketRow(ticketId);
    expect(after!.closed_at).toEqual(closedAt);
    expect(second.closed).toBe(0);
  });

  it('is NOT an SLA sweep: a badly breached live ticket is untouched', async () => {
    const user = await registerAndLogin();
    const res = await CREATE(
      supportRequest(`${BASE}/support/tickets`, user, {
        body: {
          subject: 'Something urgent that nobody answered',
          description: 'This has been sitting unanswered for a very long time indeed.',
          category: 'payment',
        },
      }),
    );
    const ticketId = (await res.json()).data.id;
    await expireSla(ticketId);

    await runSupportReopenSweep();

    const row = await readTicketRow(ticketId);
    // Still open, still `high`, still unassigned — a breach has no automated consequence.
    expect(row!.status).toBe('open');
    expect(row!.priority).toBe('high');
    expect(row!.assigned_admin_user_id).toBeNull();
  });

  it('the cron route refuses a request without the bearer secret', async () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    try {
      const unauth = await SWEEP(new NextRequest('http://localhost/api/v1/cron/support-reopen-sweep'));
      expect(unauth.status).toBe(401);

      const authed = await SWEEP(
        new NextRequest('http://localhost/api/v1/cron/support-reopen-sweep', {
          headers: { authorization: 'Bearer test-secret' },
        }),
      );
      expect(authed.status).toBe(200);
      expect((await authed.json()).status).toBe('ok');
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});
