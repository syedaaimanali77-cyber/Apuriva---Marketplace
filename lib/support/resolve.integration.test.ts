/**
 * Spec 032 §6 (AC-9) — "support owns the conversation, not the consequence", proved end to end.
 *
 * The sharpest test here is the LAST one: it bypasses the application entirely and tries the
 * forbidden write directly against the database, because AC-9's guarantee is only worth anything if
 * it survives code that does not go through `resolveTicket()`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { pgError, queryRows } from '@/lib/offers/db';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
import { POST as HANDOFF } from '@/app/api/v1/admin/support/tickets/[id]/hand-off/route';
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

async function makeTicket(user: TestSession, category: string): Promise<string> {
  const res = await CREATE(
    supportRequest(`${BASE}/support/tickets`, user, {
      body: {
        subject: 'Reporting something that happened',
        description: 'I want to report something that happened during a recent job.',
        category,
      },
    }),
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}

describe.skipIf(!dbReachable)('spec 032 resolution ownership (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('a SAFETY ticket cannot be resolved as answered (AC-9)', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user, 'safety');

    const res = await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
        body: {
          resolutionKind: 'answered',
          reason: 'Spoke to the customer and considered the matter closed.',
          expectedStatus: 'open',
        },
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('SUPPORT_RESOLUTION_INVALID');
    // The message must explain the alternative, not merely refuse.
    expect(body.message).toMatch(/hand it off|not actionable/i);

    // And the ticket is untouched.
    expect((await readTicketRow(ticketId))?.status).toBe('open');
  });

  it('a safety ticket CAN be recorded as not actionable', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user, 'safety');

    const res = await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
        body: {
          resolutionKind: 'not_actionable',
          reason: 'Duplicate of a report the customer already filed directly.',
          expectedStatus: 'open',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.resolutionKind).toBe('not_actionable');
  });

  it('a safety ticket CAN be handed off, and the pointer plus legal hold are recorded', async () => {
    const reporter = await registerAndLogin();
    const reported = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(reporter, 'safety');

    const res = await HANDOFF(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/hand-off`, admin, {
        body: {
          target: 'safety',
          reason: 'Customer describes unsafe conduct during the visit; passing to Trust and Safety.',
          targetUserId: reported.userId,
          expectedStatus: 'open',
        },
      }),
    );
    expect(res.status).toBe(200);

    const row = await readTicketRow(ticketId);
    expect(row!.escalated_safety_report_id).toBeTruthy();
    expect(row!.legal_hold).toBe(true);
    // A handoff is NOT a transition: the ticket is still live until it is resolved.
    expect(row!.status).toBe('open');

    // Spec 030 filed the report as the REQUESTER, not as the admin.
    const reports = await queryRows<{ reporter_user_id: string; target_user_id: string; category: string; priority: string }>(
      getDb(),
      sql`SELECT reporter_user_id, target_user_id, category, priority FROM safety_reports WHERE id = ${row!.escalated_safety_report_id as string}`,
    );
    expect(reports[0]!.reporter_user_id).toBe(reporter.userId);
    expect(reports[0]!.target_user_id).toBe(reported.userId);
    // Support does not classify a safety matter, and does not set its priority.
    expect(reports[0]!.category).toBe('other');
    expect(reports[0]!.priority).toBe('medium');
  });

  it('a refunds handoff records the intent and creates NO refund', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user, 'payment');

    const before = await queryRows<{ count: number }>(getDb(), sql`SELECT count(*)::int AS count FROM refunds`);

    const res = await HANDOFF(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/hand-off`, admin, {
        body: {
          target: 'refunds',
          reason: 'Customer is asking for money back; this is a Finance decision, not ours.',
          expectedStatus: 'open',
        },
      }),
    );
    expect(res.status).toBe(200);

    const after = await queryRows<{ count: number }>(getDb(), sql`SELECT count(*)::int AS count FROM refunds`);
    // Support quotes no amount and creates no refund — Finance acts through spec 022's own chain.
    expect(after[0]!.count).toBe(before[0]!.count);
    expect((await readTicketRow(ticketId))!.legal_hold).toBe(true);
  });

  it('a dispute handoff refuses an id that names no dispute', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();
    const ticketId = await makeTicket(user, 'booking');

    const res = await HANDOFF(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/hand-off`, admin, {
        body: {
          target: 'dispute',
          reason: 'Pointing this ticket at the dispute the customer opened.',
          disputeId: '00000000-0000-4000-8000-000000000000',
          expectedStatus: 'open',
        },
      }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('SUPPORT_RESOLUTION_INVALID');
  });

  it('THE DATABASE REFUSES THE FORBIDDEN WRITE even when the application is bypassed (AC-9)', async () => {
    const user = await registerAndLogin();
    const ticketId = await makeTicket(user, 'safety');

    // No route, no validation, no domain function — straight at the table.
    // Drizzle wraps the driver error, so the constraint name is read off the cause chain with the
    // repository's own `pgError()` rather than matched against the wrapper's message.
    let violated: string | undefined;
    try {
      await getDb().execute(sql`
        UPDATE support_tickets
           SET resolution_kind = 'answered',
               resolution_reason = 'Bypassing the application layer entirely.',
               resolved_at = clock_timestamp(),
               status = 'resolved'
         WHERE id = ${ticketId}
      `);
      throw new Error('the database accepted a write AC-9 forbids');
    } catch (err) {
      violated = pgError(err)?.constraint;
    }
    expect(violated).toBe('support_tickets_safety_resolution_ck');

    expect((await readTicketRow(ticketId))?.status).toBe('open');
  });

  it('the same direct write is permitted for a non-safety ticket, so the constraint is precise', async () => {
    const user = await registerAndLogin();
    const ticketId = await makeTicket(user, 'account');

    await getDb().execute(sql`
      UPDATE support_tickets
         SET resolution_kind = 'answered',
             resolution_reason = 'A perfectly ordinary support answer.',
             resolved_at = clock_timestamp(),
             status = 'resolved'
       WHERE id = ${ticketId}
    `);
    expect((await readTicketRow(ticketId))?.status).toBe('resolved');
  });
});
