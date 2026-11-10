import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { formatMessageCursor } from '@/lib/messaging/cursor';
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
  sendMessage,
  useMessagingIntegration,
} from '@/lib/messaging/messaging-test-support';

/**
 * Spec 025 §6 "E2E (Vitest)".
 *
 * There is NO Playwright and NO WebSocket infrastructure in this repository, and this spec needs neither:
 * the transport is authenticated polling, so "real-time exchange" is exactly the delta read the client
 * polls with. `e2e/*.spec.ts` is the Vitest pattern `vitest.config.ts` already runs, driving the real route
 * handlers against the isolated `*_test` database with no module mocked.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('booking conversation journey (spec 025)', { timeout: 120_000 }, () => {
  beforeEach(() => {
    useMessagingIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetMessagingIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  afterAll(async () => {
    await getPool().end();
  });

  it('both parties exchange messages on a live booking', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();

    // Both screens open the conversation and start polling from an empty history.
    const opened = await json(await getConversation(scenario.customer, bookingId));
    expect(opened.data).toMatchObject({ isActive: true, messageCount: 0, unreadCount: 0 });
    await getConversation(scenario.provider, bookingId);

    // Customer posts.
    const posted = await sendMessage(scenario.customer, bookingId, { body: 'Hi! The building gate code is 4471.' });
    expect(posted.status).toBe(201);
    const question = (await json(posted)).data;

    // Provider's first poll (no cursor yet: full history) receives it.
    const providerHistory = await json(await listMessages(scenario.provider, bookingId, '?limit=100&offset=0'));
    expect(providerHistory.data.map((m: { id: string }) => m.id)).toEqual([question.id]);
    expect((await json(await getConversation(scenario.provider, bookingId))).data.unreadCount).toBe(1);

    // Provider replies; customer's delta poll from its cursor receives exactly the reply.
    resetRateLimitState();
    const reply = (await json(await sendMessage(scenario.provider, bookingId, { body: 'Thanks — arriving at 10.' }))).data;
    const delta = await json(
      await listMessages(scenario.customer, bookingId, `?after=${encodeURIComponent(formatMessageCursor(question))}&limit=50`),
    );
    expect(delta.data.map((m: { body: string }) => m.body)).toEqual(['Thanks — arriving at 10.']);

    // Customer marks it read; unread returns to zero and the provider sees it was read.
    const read = await json(await markRead(scenario.customer, bookingId, reply.id));
    expect(read.data.unreadCount).toBe(0);
    const providerView = await json(await getConversation(scenario.provider, bookingId));
    expect(providerView.data.participants.find((p: { role: string }) => p.role === 'customer').lastReadAt).toBe(reply.createdAt);
  });

  it('the conversation becomes read-only once the booking is archived, with its history intact', async () => {
    const { scenario, bookingId } = await seedPendingBooking();
    await sendMessage(scenario.customer, bookingId, { body: 'Waiting on payment confirmation' });
    await archivePendingBooking(bookingId);

    const conversation = await json(await getConversation(scenario.customer, bookingId));
    expect(conversation.data).toMatchObject({ isActive: false, messageCount: 1 });

    const attempt = await sendMessage(scenario.provider, bookingId, { body: 'Sorry, missed this' });
    expect(attempt.status).toBe(422);
    expect((await json(attempt)).code).toBe('CONVERSATION_ARCHIVED');

    const history = await json(await listMessages(scenario.provider, bookingId));
    expect(history.data.map((m: { body: string }) => m.body)).toEqual(['Waiting on payment confirmation']);
  });
});
