import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { GET as ADMIN_MESSAGES } from '@/app/api/v1/admin/conversations/[id]/messages/route';
import { registerConversationBlockGate } from './block-gate';
import { registerMessagingNotificationSink } from './notifications';
import { queryRows } from '@/lib/offers/db';
import {
  archivePendingBooking,
  BASE,
  getConversation,
  grantRole,
  isDatabaseReachable,
  json,
  listMessages,
  markRead,
  registerAdmin,
  resetMessagingIntegration,
  seedConfirmedBooking,
  seedPendingBooking,
  sendMessage,
  sent,
  storedMessages,
  useMessagingIntegration,
} from './messaging-test-support';
import { sessionGet } from '@/lib/payments/payments-test-support';

/**
 * Spec 025 AC-6 — spec 030 owns blocking; this spec enforces a registered gate's effect. A block stops new
 * messages in either direction and nothing else: history, read markers and safety/support admin access stay.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('blocking enforcement (spec 025 AC-6)', { timeout: 90_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => {
    resetMessagingIntegration();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await getPool().end();
  });

  it('blocked send rejected, history still readable, admin read unaffected', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const before = await sent(scenario.provider, bookingId, 'Confirmed for 10am');

    // Spec 030's stand-in: the customer has blocked the provider.
    const blockedPairs = new Set([`${scenario.provider.userId}:${scenario.customer.userId}`]);
    registerConversationBlockGate(async (_tx, a, b) => ({
      blocked: blockedPairs.has(`${a}:${b}`) || blockedPairs.has(`${b}:${a}`),
      reason: 'blocked_by_counterparty',
    }));
    const notified: unknown[] = [];
    registerMessagingNotificationSink(async (event) => {
      notified.push(event);
    });

    // Both directions are refused, nothing is written and nobody is notified.
    for (const sender of [scenario.provider, scenario.customer]) {
      const response = await sendMessage(sender, bookingId, { body: 'Are you there?' });
      expect(response.status).toBe(403);
      expect((await json(response)).code).toBe('BLOCKED');
    }
    expect(await storedMessages(bookingId)).toHaveLength(1);
    expect(notified).toEqual([]);

    // History stays visible to both parties, and read markers still work.
    for (const reader of [scenario.customer, scenario.provider]) {
      const history = await listMessages(reader, bookingId);
      expect(history.status).toBe(200);
      expect((await json(history)).data.map((m: { id: string }) => m.id)).toEqual([before.id]);
      expect((await getConversation(reader, bookingId)).status).toBe(200);
    }
    resetRateLimitState();
    expect((await markRead(scenario.customer, bookingId, before.id)).status).toBe(200);

    // The explicit safety/support exception: a Trust & Safety admin still reads the conversation.
    const admin = await registerAdmin();
    await grantRole(admin, 'trust_safety_admin');
    const { data } = await json(await getConversation(scenario.customer, bookingId));
    const adminRead = await ADMIN_MESSAGES(
      sessionGet(`${BASE}/admin/conversations/${data.id}/messages?reason=${encodeURIComponent('Safety review of blocked pair')}`, admin),
    );
    expect(adminRead.status).toBe(200);
    expect((await json(adminRead)).data.map((m: { id: string }) => m.id)).toEqual([before.id]);
  });

  it('a gate that throws is treated as not blocked, so an unshipped dependency never severs the channel', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    registerConversationBlockGate(async () => {
      throw new Error('user_blocks unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await sendMessage(scenario.customer, bookingId, { body: 'Still on for 10?' });
    expect(response.status).toBe(201);
  });

  it('the gate is consulted inside the send transaction, and never for an archived conversation', async () => {
    // First touch is a SEND, so the conversation row exists only inside that uncommitted transaction.
    const { scenario, bookingId } = await seedConfirmedBooking();
    const seen: { insideTx: number; outsideTx: number }[] = [];
    registerConversationBlockGate(async (tx) => {
      const inside = await queryRows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM conversations WHERE booking_id = ${bookingId}`);
      const outside = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM conversations WHERE booking_id = ${bookingId}`);
      seen.push({ insideTx: inside[0]!.n, outsideTx: outside[0]!.n });
      return { blocked: false };
    });

    expect((await sendMessage(scenario.customer, bookingId, { body: 'hello' })).status).toBe(201);
    expect(seen).toEqual([{ insideTx: 1, outsideTx: 0 }]);

    // Archive check first: an archived booking answers CONVERSATION_ARCHIVED and the gate is not asked.
    const archived = await seedPendingBooking();
    await archivePendingBooking(archived.bookingId);
    seen.length = 0;
    const response = await sendMessage(archived.scenario.customer, archived.bookingId, { body: 'late' });
    expect((await json(response)).code).toBe('CONVERSATION_ARCHIVED');
    expect(seen).toEqual([]);
  });
});
