import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { getPool } from '@/lib/db';
import {
  archivePendingBooking,
  getConversation,
  isDatabaseReachable,
  json,
  listMessages,
  markRead,
  resetMessagingIntegration,
  seedConfirmedBooking,
  seedPendingBooking,
  seedStranger,
  sendMessage,
  sent,
  useMessagingIntegration,
} from './messaging-test-support';

/**
 * Spec 025 AC-1 / AC-3 — the participant surface end to end through the real route handlers: lazy creation,
 * the two frozen participants, full paged history in one stable order, the read marker and unread counts,
 * the archived read-only state, and the 404/403 authorization boundary.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('booking conversation read surface (spec 025 AC-1, AC-3)', { timeout: 90_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => resetMessagingIntegration());
  afterAll(async () => {
    await getPool().end();
  });

  it('creates the conversation on first access with exactly the two booking parties', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();

    const response = await getConversation(scenario.customer, bookingId);
    expect(response.status).toBe(200);
    const { data } = await json(response);

    expect(data).toMatchObject({ bookingId, isActive: true, contactSharingAllowed: true, messageCount: 0, unreadCount: 0 });
    expect(data.participants).toEqual([
      { userId: scenario.customer.userId, role: 'customer', displayName: null, lastReadAt: null },
      expect.objectContaining({ userId: scenario.provider.userId, role: 'provider' }),
    ]);

    // Idempotent: the provider opening it sees the very same conversation.
    const again = await json(await getConversation(scenario.provider, bookingId));
    expect(again.data.id).toBe(data.id);
  });

  it('active conversation exposes full paged history in one stable order', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const bodies = ['one', 'two', 'three', 'four', 'five'];
    for (const [index, text] of bodies.entries()) {
      await sent(index % 2 === 0 ? scenario.customer : scenario.provider, bookingId, text);
    }

    const first = await json(await listMessages(scenario.provider, bookingId, '?limit=2&offset=0'));
    const second = await json(await listMessages(scenario.provider, bookingId, '?limit=2&offset=2'));
    const third = await json(await listMessages(scenario.provider, bookingId, '?limit=2&offset=4'));
    expect(first.page).toEqual({ limit: 2, offset: 0, total: 5, nextOffset: 2 });
    expect(third.page.nextOffset).toBeNull();

    const paged = [...first.data, ...second.data, ...third.data];
    expect(paged.map((m: { body: string }) => m.body)).toEqual(bodies);
    expect(paged.map((m: { senderRole: string }) => m.senderRole)).toEqual(['customer', 'provider', 'customer', 'provider', 'customer']);

    // Strictly increasing timestamps: the total order has no ties to break.
    const stamps = paged.map((m: { createdAt: string }) => m.createdAt);
    expect([...stamps].sort()).toEqual(stamps);
    expect(new Set(stamps).size).toBe(stamps.length);

    // Both parties read the identical history; never an idempotency key or fingerprint.
    const customerView = await json(await listMessages(scenario.customer, bookingId, '?limit=100'));
    expect(customerView.data).toEqual(paged);
    expect(Object.keys(customerView.data[0]).sort()).toEqual(
      ['body', 'contactFlagged', 'contactRedacted', 'conversationId', 'createdAt', 'id', 'readByCounterpartyAt', 'redactedByRetention', 'senderRole', 'senderUserId'].sort(),
    );
  });

  it('counts unread for the recipient only and advances the read marker monotonically', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const early = await sent(scenario.provider, bookingId, 'On my way');
    const late = await sent(scenario.provider, bookingId, 'Five minutes out');

    expect((await json(await getConversation(scenario.customer, bookingId))).data.unreadCount).toBe(2);
    expect((await json(await getConversation(scenario.provider, bookingId))).data.unreadCount).toBe(0);

    const readLate = await markRead(scenario.customer, bookingId, late.id);
    expect(readLate.status).toBe(200);
    expect((await json(readLate)).data).toMatchObject({ lastReadAt: late.createdAt, unreadCount: 0 });

    // A stale client marking the OLDER message can never move the marker backwards.
    resetRateLimitState();
    const stale = await json(await markRead(scenario.customer, bookingId, early.id));
    expect(stale.data).toMatchObject({ lastReadAt: late.createdAt, unreadCount: 0 });

    // The provider's messages now report being read by the counterparty.
    const history = await json(await listMessages(scenario.provider, bookingId));
    expect(history.data.map((m: { readByCounterpartyAt: string | null }) => m.readByCounterpartyAt)).toEqual([late.createdAt, late.createdAt]);
  });

  it('rejects a read marker naming a message from another conversation, or not a uuid', async () => {
    const a = await seedConfirmedBooking();
    const b = await seedConfirmedBooking();
    const foreign = await sent(b.scenario.customer, b.bookingId, 'Elsewhere');
    await getConversation(a.scenario.customer, a.bookingId);

    const wrong = await markRead(a.scenario.customer, a.bookingId, foreign.id);
    expect(wrong.status).toBe(422);
    expect((await json(wrong)).code).toBe('MESSAGE_NOT_IN_CONVERSATION');

    const malformed = await markRead(a.scenario.customer, a.bookingId, 'nope');
    expect(malformed.status).toBe(400);
    expect((await json(malformed)).errors).toEqual([expect.objectContaining({ field: 'lastReadMessageId' })]);
  });

  it('archived conversation stays readable but refuses new messages and read markers', async () => {
    const { scenario, bookingId } = await seedPendingBooking();
    const message = await sent(scenario.customer, bookingId, 'Please confirm the time');
    await archivePendingBooking(bookingId);

    const conversation = await json(await getConversation(scenario.provider, bookingId));
    expect(conversation.data).toMatchObject({ isActive: false, messageCount: 1 });
    expect(conversation.data.archivedAt).toEqual(expect.any(String));

    const history = await listMessages(scenario.provider, bookingId);
    expect(history.status).toBe(200);
    expect((await json(history)).data.map((m: { id: string }) => m.id)).toEqual([message.id]);

    const send = await sendMessage(scenario.provider, bookingId, { body: 'Too late' });
    expect(send.status).toBe(422);
    expect((await json(send)).code).toBe('CONVERSATION_ARCHIVED');

    const read = await markRead(scenario.provider, bookingId, message.id);
    expect(read.status).toBe(422);
    expect((await json(read)).code).toBe('CONVERSATION_ARCHIVED');
  });

  it('non-participant gets 404 CONVERSATION_NOT_FOUND on every route, indistinguishable from a missing booking', async () => {
    const { bookingId } = await seedConfirmedBooking();
    const stranger = await seedStranger();

    for (const response of [
      await getConversation(stranger.customer, bookingId),
      await listMessages(stranger.customer, bookingId),
      await sendMessage(stranger.customer, bookingId, { body: 'hello' }),
      await markRead(stranger.customer, bookingId, '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'),
      await getConversation(stranger.provider, bookingId),
      await getConversation(stranger.customer, '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'),
      await getConversation(stranger.customer, 'not-a-uuid'),
    ]) {
      expect(response.status).toBe(404);
      expect((await json(response)).code).toBe('CONVERSATION_NOT_FOUND');
    }
  });

  it('wrong active mode gets 403 FORBIDDEN even for a participant', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    // The customer's session switched to provider mode: they are a participant, but not in that role.
    const { getDb } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    await getDb().execute(sql`UPDATE sessions SET active_mode = 'provider' WHERE id = ${scenario.customer.sessionId}`);

    const response = await getConversation(scenario.customer, bookingId);
    expect(response.status).toBe(403);
    expect((await json(response)).code).toBe('FORBIDDEN');
  });

  it('requires a session', async () => {
    const { bookingId } = await seedConfirmedBooking();
    const { GET } = await import('@/app/api/v1/bookings/[id]/conversation/route');
    const response = await GET(new Request(`http://localhost/api/v1/bookings/${bookingId}/conversation`));
    expect(response.status).toBe(401);
  });
});
