/**
 * Spec 032 §6 "Export / deletion" (AC-10).
 *
 * Spec 008 owns the export artifact; this proves the two sections spec 032 adds to it carry exactly
 * the allow-listed columns and nothing more. The decisive assertion is over the SERIALIZED payload,
 * because that is what actually reaches the user.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { generateExportPayload } from '@/lib/privacy/export';
import { POST as CREATE } from '@/app/api/v1/support/tickets/route';
import { POST as SEND } from '@/app/api/v1/support/tickets/[id]/messages/route';
import { POST as NOTE } from '@/app/api/v1/admin/support/tickets/[id]/notes/route';
import { POST as ASSIGN } from '@/app/api/v1/admin/support/tickets/[id]/assign/route';
import { POST as RESOLVE } from '@/app/api/v1/admin/support/tickets/[id]/resolve/route';
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
} from './support-test-support';

const dbReachable = await isDatabaseReachable();

const NOTE_TEXT = 'Internal: this customer has contacted us three times this month.';
const ADMIN_REPLY = 'We have applied a fix on our side, please try again.';

async function supportAdmin(): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, 'support_admin');
  for (const [action, tier] of [
    ['read', 'low'],
    ['assign', 'low'],
    ['respond', 'low'],
    ['resolve', 'medium'],
  ] as const) {
    await seedPermission('support_admin', 'support', action, tier);
  }
  return admin;
}

describe.skipIf(!dbReachable)('spec 032 export boundary (integration)', () => {
  beforeEach(() => {
    useSupportIntegration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('exports the caller own tickets and thread, and NOTHING operational (AC-10)', async () => {
    const user = await registerAndLogin();
    const admin = await supportAdmin();

    const created = await CREATE(
      supportRequest(`${BASE}/support/tickets`, user, {
        body: {
          subject: 'My booking will not confirm',
          description: 'Every time I press confirm the page just reloads.',
          category: 'booking',
        },
      }),
    );
    const ticketId = (await created.json()).data.id;

    await SEND(
      supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, user, { body: { body: 'Still not working.' } }),
    );
    await SEND(supportRequest(`${BASE}/support/tickets/${ticketId}/messages`, admin, { body: { body: ADMIN_REPLY } }));
    await NOTE(supportRequest(`${BASE}/admin/support/tickets/${ticketId}/notes`, admin, { body: { body: NOTE_TEXT } }));
    await ASSIGN(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/assign`, admin, {
        body: { assigneeUserId: admin.userId, expectedStatus: 'open' },
      }),
    );
    await RESOLVE(
      supportRequest(`${BASE}/admin/support/tickets/${ticketId}/resolve`, admin, {
        body: { resolutionKind: 'answered', reason: 'Cleared a stale session for the customer.', expectedStatus: 'assigned' },
      }),
    );

    const payload = await generateExportPayload(user.userId);
    const json = JSON.stringify(payload);

    // The ticket is there, with the reason the user is entitled to.
    expect(payload.supportTickets).toHaveLength(1);
    const ticket = payload.supportTickets[0]!;
    expect(ticket.subject).toBe('My booking will not confirm');
    expect(ticket.resolutionKind).toBe('answered');
    expect(ticket.resolutionReason).toMatch(/stale session/);

    // Both directions of the thread, with a RELATIVE author.
    expect(payload.supportMessages).toHaveLength(2);
    const authors = payload.supportMessages.map((m) => m.author).sort();
    expect(authors).toEqual(['support', 'you']);
    expect(payload.supportMessages.find((m) => m.author === 'support')!.body).toBe(ADMIN_REPLY);

    // THE INTERNAL NOTE IS ABSENT, in any form.
    expect(json).not.toContain(NOTE_TEXT);
    expect(json).not.toContain('three times this month');

    // No admin identity, and nothing operational.
    expect(json).not.toContain(admin.userId);
    for (const forbidden of [
      'aiSummary',
      'ai_summary',
      'assignedAdminUserId',
      'assigned_admin_user_id',
      'slaDeadlineAt',
      'sla_deadline_at',
      'slaPausedSeconds',
      'legalHold',
      'legal_hold',
      'escalatedSafetyReportId',
      'escalatedDisputeId',
      'idempotencyKey',
      'idempotency_key',
      'requesterMode',
    ]) {
      expect(json, `export leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('exports nothing for a user with no tickets, rather than someone else data', async () => {
    const other = await registerAndLogin();
    await CREATE(
      supportRequest(`${BASE}/support/tickets`, other, {
        body: {
          subject: 'Another person ticket',
          description: 'This belongs to a different user entirely and must not travel.',
          category: 'other',
        },
      }),
    );

    const fresh = await registerAndLogin();
    const payload = await generateExportPayload(fresh.userId);
    expect(payload.supportTickets).toEqual([]);
    expect(payload.supportMessages).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('Another person ticket');
  });
});
