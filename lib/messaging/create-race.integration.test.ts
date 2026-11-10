import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { expectDatabaseRejection } from '@/lib/bookings/bookings-test-support';
import { queryRows } from '@/lib/offers/db';
import {
  getConversation,
  isDatabaseReachable,
  json,
  resetMessagingIntegration,
  seedConfirmedBooking,
  sendMessage,
  useMessagingIntegration,
} from './messaging-test-support';

/**
 * Spec 025 AC-7 — concurrent first access converges on ONE conversation with exactly one customer and one
 * provider participant, guaranteed by the database's unique indexes rather than a read-then-write check.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('conversation creation race (spec 025 AC-7)', { timeout: 90_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => resetMessagingIntegration());
  afterAll(async () => {
    await getPool().end();
  });

  it('concurrent first access yields one conversation and two participants', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();

    const responses = await Promise.all([
      getConversation(scenario.customer, bookingId),
      getConversation(scenario.provider, bookingId),
      getConversation(scenario.customer, bookingId),
      sendMessage(scenario.customer, bookingId, { body: 'First!' }),
      sendMessage(scenario.provider, bookingId, { body: 'Hello' }),
      getConversation(scenario.provider, bookingId),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201, 201]);

    const conversations = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM conversations WHERE booking_id = ${bookingId}`);
    expect(conversations).toHaveLength(1);

    const participants = await queryRows<{ user_id: string; role: string }>(
      getDb(),
      sql`SELECT user_id, role FROM conversation_participants WHERE conversation_id = ${conversations[0]!.id} ORDER BY role`,
    );
    expect(participants).toEqual([
      { user_id: scenario.customer.userId, role: 'customer' },
      { user_id: scenario.provider.userId, role: 'provider' },
    ]);

    const ids = await Promise.all(responses.slice(0, 3).map(async (r) => (await json(r)).data.id));
    expect(new Set(ids)).toEqual(new Set([conversations[0]!.id]));
  });

  it('the database itself refuses a second conversation, a third participant, or a second customer', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const { data } = await json(await getConversation(scenario.customer, bookingId));

    await expectDatabaseRejection(
      () => getDb().execute(sql`INSERT INTO conversations (booking_id) VALUES (${bookingId})`),
      /conversations_booking_id_uq/,
    );
    await expectDatabaseRejection(
      () =>
        getDb().execute(
          sql`INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES (${data.id}, ${scenario.provider.userId}, 'customer')`,
        ),
      /conversation_participants_conversation_user_uq|conversation_participants_conversation_role_uq/,
    );
    await expectDatabaseRejection(
      () =>
        getDb().execute(
          sql`INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES (${data.id}, gen_random_uuid(), 'observer')`,
        ),
      /conversation_participants_role_ck|foreign key|violates/,
    );
  });
});
