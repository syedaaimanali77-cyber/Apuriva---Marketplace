import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { queryRows } from '@/lib/offers/db';
import { sessionGet } from '@/lib/payments/payments-test-support';
import { GET as ADMIN_CONVERSATION } from '@/app/api/v1/admin/conversations/[id]/route';
import { GET as ADMIN_MESSAGES } from '@/app/api/v1/admin/conversations/[id]/messages/route';
import { ADMIN_ROLES } from '@/lib/db/schema';
import type { AdminRole } from '@/lib/types/admin-rbac';
import {
  BASE,
  getConversation,
  grantRole,
  isDatabaseReachable,
  json,
  registerAdmin,
  resetMessagingIntegration,
  seedConfirmedBooking,
  sent,
  useMessagingIntegration,
} from './messaging-test-support';

/**
 * Spec 025 AC-5 — admin conversation access is limited to the three seeded roles, requires a reason, and
 * writes one audit event per read (per PAGE for bodies) carrying actor, roles, target, reason and the
 * correlation id. Permission rows come from migration 0021's own seed — this suite seeds none.
 */
const dbReachable = await isDatabaseReachable();
const REASON = 'Support ticket 4471: customer reports no-show';

async function adminWith(role: AdminRole) {
  const admin = await registerAdmin();
  await grantRole(admin, role);
  resetRateLimitState();
  return admin;
}

async function auditEventsFor(conversationId: string) {
  return queryRows<{ user_id: string; event_type: string; metadata: Record<string, any> }>(
    getDb(),
    sql`SELECT user_id, event_type, metadata FROM security_events
         WHERE event_type LIKE 'messaging.%' AND metadata->>'targetId' = ${conversationId}
         ORDER BY created_at ASC`,
  );
}

describe.skipIf(!dbReachable)('admin conversation access (spec 025 AC-5)', { timeout: 120_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => resetMessagingIntegration());
  afterAll(async () => {
    await getPool().end();
  });

  async function seededConversation() {
    const { scenario, bookingId } = await seedConfirmedBooking();
    await sent(scenario.customer, bookingId, 'Where are you?');
    await sent(scenario.provider, bookingId, 'Stuck in traffic');
    const { data } = await json(await getConversation(scenario.customer, bookingId));
    return { scenario, bookingId, conversationId: data.id as string };
  }

  it('only support/trust-safety/super admins', async () => {
    const { conversationId } = await seededConversation();

    for (const role of ADMIN_ROLES) {
      const admin = await adminWith(role);
      const response = await ADMIN_CONVERSATION(
        sessionGet(`${BASE}/admin/conversations/${conversationId}?reason=${encodeURIComponent(REASON)}`, admin),
      );
      const allowed = role === 'support_admin' || role === 'trust_safety_admin' || role === 'super_admin';
      expect({ role, status: response.status }).toEqual({ role, status: allowed ? 200 : 403 });
      if (!allowed) {
        const payload = await json(response);
        expect(payload.code).toBe('FORBIDDEN');
        expect(JSON.stringify(payload)).not.toContain(conversationId);
      }
    }

    // A signed-in ordinary user is no admin at all.
    const { scenario } = await seededConversation();
    const ordinary = await ADMIN_CONVERSATION(
      sessionGet(`${BASE}/admin/conversations/${conversationId}?reason=${encodeURIComponent(REASON)}`, scenario.customer),
    );
    expect(ordinary.status).toBe(403);
  });

  it('rejects a missing or short reason', async () => {
    const { conversationId } = await seededConversation();
    const admin = await adminWith('support_admin');

    for (const query of ['', '?reason=', '?reason=%20%20%20', '?reason=too%20short', `?reason=${'x'.repeat(501)}`]) {
      for (const route of [ADMIN_CONVERSATION, ADMIN_MESSAGES]) {
        const suffix = route === ADMIN_MESSAGES ? '/messages' : '';
        const response = await route(sessionGet(`${BASE}/admin/conversations/${conversationId}${suffix}${query}`, admin));
        expect(response.status).toBe(400);
        expect((await json(response)).errors).toEqual([expect.objectContaining({ field: 'reason' })]);
        resetRateLimitState();
      }
    }
    expect(await auditEventsFor(conversationId)).toEqual([]);
  });

  it('writes one audit event per page read', async () => {
    const { conversationId, bookingId } = await seededConversation();
    const admin = await adminWith('trust_safety_admin');

    const meta = await ADMIN_CONVERSATION(
      sessionGet(`${BASE}/admin/conversations/${conversationId}?reason=${encodeURIComponent(REASON)}`, admin),
    );
    expect(meta.status).toBe(200);
    const metaPayload = await json(meta);
    expect(metaPayload.data).toMatchObject({ id: conversationId, bookingId, isActive: true, messageCount: 2, contactFlaggedCount: 0 });
    expect(JSON.stringify(metaPayload.data)).not.toContain('Stuck in traffic'); // metadata view carries no bodies

    const page1 = await ADMIN_MESSAGES(
      sessionGet(`${BASE}/admin/conversations/${conversationId}/messages?limit=1&offset=0&reason=${encodeURIComponent(REASON)}`, admin),
    );
    const page2 = await ADMIN_MESSAGES(
      sessionGet(`${BASE}/admin/conversations/${conversationId}/messages?limit=1&offset=1&reason=${encodeURIComponent(REASON)}`, admin),
    );
    expect((await json(page1)).data.map((m: { body: string }) => m.body)).toEqual(['Where are you?']);
    expect((await json(page2)).data.map((m: { body: string }) => m.body)).toEqual(['Stuck in traffic']);

    const events = await auditEventsFor(conversationId);
    expect(events.map((e) => e.event_type)).toEqual([
      'messaging.admin_conversation_read',
      'messaging.admin_messages_read',
      'messaging.admin_messages_read',
    ]);
    for (const event of events) {
      expect(event.user_id).toBe(admin.userId);
      expect(event.metadata).toMatchObject({
        actorRoles: ['trust_safety_admin'],
        resource: 'messaging',
        action: 'read_conversation',
        targetType: 'conversation',
        targetId: conversationId,
        reason: REASON,
        correlationId: expect.any(String),
      });
    }
    expect(events[0]!.metadata.correlationId).toBe(meta.headers.get('x-correlation-id'));
  });

  it('answers 404 for an unknown or malformed conversation id, without an audit event', async () => {
    const admin = await adminWith('super_admin');
    for (const id of ['3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b', 'nope']) {
      const response = await ADMIN_CONVERSATION(sessionGet(`${BASE}/admin/conversations/${id}?reason=${encodeURIComponent(REASON)}`, admin));
      expect(response.status).toBe(404);
      expect((await json(response)).code).toBe('CONVERSATION_NOT_FOUND');
    }
  });

  it('seeds the permission for exactly the three roles at risk tier medium', async () => {
    const rows = await queryRows<{ name: string; risk_tier: string }>(
      getDb(),
      sql`SELECT r.name, p.risk_tier FROM permissions p JOIN roles r ON r.id = p.role_id
           WHERE p.resource = 'messaging' AND p.action = 'read_conversation' ORDER BY r.name`,
    );
    expect(rows).toEqual([
      { name: 'super_admin', risk_tier: 'medium' },
      { name: 'support_admin', risk_tier: 'medium' },
      { name: 'trust_safety_admin', risk_tier: 'medium' },
    ]);
  });
});
