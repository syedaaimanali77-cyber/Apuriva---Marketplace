import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { expectDatabaseRejection } from '@/lib/bookings/bookings-test-support';
import { queryRows } from '@/lib/offers/db';
import { REDACTED_DESCRIPTION } from '@/lib/privacy/deletion';
import {
  isDatabaseReachable,
  resetMessagingIntegration,
  seedConfirmedBooking,
  sent,
  useMessagingIntegration,
} from './messaging-test-support';

/**
 * Spec 025 AC-9 — messages are immutable at the DATABASE, so no future code path can edit or delete one.
 * There is also no PATCH/DELETE route: `lib/api/openapi-registry.ts` registers none and the drift check
 * enforces that the route files match it.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('message immutability (spec 025 AC-9)', { timeout: 90_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => resetMessagingIntegration());
  afterAll(async () => {
    await getPool().end();
  });

  it('update and delete are refused; sentinel write is allowed', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const message = await sent(scenario.customer, bookingId, 'Original words');
    const other = await sent(scenario.provider, bookingId, 'Reply');

    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE messages SET body = 'Edited words' WHERE id = ${message.id}`),
      /message bodies are immutable/,
    );
    await expectDatabaseRejection(
      () => getDb().execute(sql`DELETE FROM messages WHERE id = ${message.id}`),
      /cannot be deleted/,
    );
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE messages SET sender_user_id = ${scenario.provider.userId} WHERE id = ${message.id}`),
      /identity columns are immutable/,
    );
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE messages SET created_at = created_at + interval '1 hour' WHERE id = ${message.id}`),
      /identity columns are immutable/,
    );
    await expectDatabaseRejection(
      () => getDb().execute(sql`UPDATE messages SET conversation_id = gen_random_uuid() WHERE id = ${message.id}`),
      /identity columns are immutable/,
    );

    // The one sanctioned body write — anonymization to the sentinel — succeeds, and touches only that row.
    await getDb().execute(
      sql`UPDATE messages SET body = ${REDACTED_DESCRIPTION}, redacted_by_retention = true WHERE id = ${message.id}`,
    );
    const rows = await queryRows<{ id: string; body: string }>(
      getDb(),
      sql`SELECT id, body FROM messages WHERE id IN (${message.id}, ${other.id}) ORDER BY created_at`,
    );
    expect(rows).toEqual([
      { id: message.id, body: REDACTED_DESCRIPTION },
      { id: other.id, body: 'Reply' },
    ]);
  });

  it('enforces the stored-body bounds and the masked/flagged exclusivity at the database', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const message = await sent(scenario.customer, bookingId, 'x');
    const [{ conversation_id } = { conversation_id: '' }] = await queryRows<{ conversation_id: string }>(
      getDb(),
      sql`SELECT conversation_id FROM messages WHERE id = ${message.id}`,
    );

    const insert = (body: string, redacted: boolean, flagged: boolean) =>
      getDb().execute(sql`
        INSERT INTO messages (conversation_id, sender_user_id, sender_role, body, contact_redacted, contact_flagged,
                              idempotency_key, idempotency_fingerprint)
        VALUES (${conversation_id}, ${scenario.customer.userId}, 'customer', ${body}, ${redacted}, ${flagged}, gen_random_uuid()::text, 'fp')
      `);

    await expectDatabaseRejection(() => insert('', false, false), /messages_body_length_ck/);
    await expectDatabaseRejection(() => insert('a'.repeat(2401), false, false), /messages_body_length_ck/);
    await expectDatabaseRejection(() => insert('both', true, true), /messages_contact_exclusive_ck/);
  });
});
