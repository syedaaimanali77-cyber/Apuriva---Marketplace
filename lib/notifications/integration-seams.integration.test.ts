import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { dispatchAvailabilityNotifications } from '@/lib/availability/notify-dispatch';
import { emitCancellationNotification, resetCancellationNotificationSink } from '@/lib/cancellation/notifications';
import { emitMessagingNotification, resetMessagingNotificationSink } from '@/lib/messaging/notifications';
import { emitPayoutNotification, resetPayoutNotificationSink } from '@/lib/payouts/ports';
import { emitRefundNotification, resetRefundNotificationSink } from '@/lib/refunds/notifications';
import { notifyProvidersOfCancellation } from '@/lib/requests/cancellation-notification';
import { seedMinimalRequest } from '@/lib/db/test-support';
import { getPool } from '@/lib/db';
import { captureLogs, createUser, isDatabaseReachable, notificationCount } from './notifications-test-support';
import { registerNotificationIntegration, resetNotificationIntegrationRegistration } from './sinks';
import { queryRows } from './sql';

const dbReachable = await isDatabaseReachable();

async function typesFor(userId: string): Promise<string[]> {
  const rows = await queryRows<{ type: string }>(
    getDb(),
    sql`SELECT type FROM notifications WHERE recipient_user_id = ${userId} ORDER BY created_at ASC, id ASC`,
  );
  return rows.map((r) => r.type);
}

async function createProviderUser(): Promise<{ userId: string; providerProfileId: string }> {
  const userId = await createUser();
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO provider_profiles (user_id, lifecycle_status, scheduling_timezone) VALUES (${userId}, 'active', 'UTC') RETURNING id`,
  );
  return { userId, providerProfileId: row!.id };
}

/**
 * Spec 026 §6 "Cross-spec boundary" — registering this spec's sinks makes the events specs 022, 023, 024
 * and 025 ALREADY emit produce exactly one notification each, without either spec changing; and specs
 * 015/016's handoffs reach `notify()`.
 */
describe.skipIf(!dbReachable)('notification integration seams (spec 026, integration)', () => {
  beforeAll(() => {
    resetNotificationIntegrationRegistration();
    registerNotificationIntegration();
  });
  afterAll(() => {
    resetRefundNotificationSink();
    resetCancellationNotificationSink();
    resetMessagingNotificationSink();
    resetPayoutNotificationSink();
    resetNotificationIntegrationRegistration();
  });

  it("spec 022's refund events produce exactly one notification each, even when re-emitted", async () => {
    const userId = await createUser();
    const refundId = randomUUID();
    const bookingId = randomUUID();
    for (let i = 0; i < 2; i += 1) {
      await emitRefundNotification({ kind: 'refund_completed', refundId, bookingId, recipientUserId: userId });
    }
    await emitRefundNotification({ kind: 'refund_failed', refundId: randomUUID(), bookingId, recipientUserId: userId });
    expect(await typesFor(userId)).toEqual(['refund_completed', 'refund_failed']);

    // Admin-audience events have no user recipient: logged, never an error and never a row.
    const logs = captureLogs();
    try {
      await emitRefundNotification({ kind: 'refund_approval_required', adminActionId: randomUUID() });
    } finally {
      logs.restore();
    }
    expect(logs.events()).toContainEqual(expect.objectContaining({ event: 'notification.not_user_addressed', kind: 'refund_approval_required' }));
  });

  it("spec 023's cancellation and no-show events produce exactly one notification each", async () => {
    const userId = await createUser();
    const bookingId = randomUUID();
    const reportId = randomUUID();
    const events = [
      { kind: 'booking_cancelled', bookingId, recipientUserId: userId, feeAmountMinorUnits: 0, refundAmountMinorUnits: 150_000, currencyCode: 'PKR' },
      { kind: 'no_show_reported', reportId, bookingId, recipientUserId: userId },
      { kind: 'no_show_response_requested', reportId, recipientUserId: userId, respondByAt: '2026-09-20T10:00:00.000Z' },
      { kind: 'no_show_resolved', reportId, recipientUserId: userId, outcome: 'no_fault' },
    ] as const;
    for (const event of [...events, ...events]) await emitCancellationNotification(event);

    expect(await typesFor(userId)).toEqual(['booking_cancelled', 'no_show_reported', 'no_show_response_requested', 'no_show_resolved']);
    const [cancelled] = await queryRows<{ body: string; category: string }>(
      getDb(),
      sql`SELECT body, category FROM notifications WHERE recipient_user_id = ${userId} AND type = 'booking_cancelled'`,
    );
    expect(cancelled!.body).toContain('1,500.00');
    const [response] = await queryRows<{ category: string }>(
      getDb(),
      sql`SELECT category FROM notifications WHERE recipient_user_id = ${userId} AND type = 'no_show_response_requested'`,
    );
    expect(response!.category).toBe('operational');
  });

  it("spec 025's message_received produces one notification per message, carrying no message body", async () => {
    const userId = await createUser();
    const conversationId = randomUUID();
    const bookingId = randomUUID();
    const messageId = randomUUID();
    await emitMessagingNotification({ kind: 'message_received', conversationId, bookingId, messageId, recipientUserId: userId });
    await emitMessagingNotification({ kind: 'message_received', conversationId, bookingId, messageId, recipientUserId: userId });
    await emitMessagingNotification({ kind: 'message_received', conversationId, bookingId, messageId: randomUUID(), recipientUserId: userId });
    const rows = await queryRows<{ category: string; body: string }>(
      getDb(),
      sql`SELECT category, body FROM notifications WHERE recipient_user_id = ${userId}`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.category === 'messages' && r.body === 'You have a new message about one of your bookings.')).toBe(true);
  });

  it("spec 024's provider payout events reach the provider's user once per attempt; finance-audience events do not", async () => {
    const provider = await createProviderUser();
    const [payout] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO payouts (provider_profile_id, status, payout_amount_minor_units, payout_currency_code, provider_name)
          VALUES (${provider.providerProfileId}, 'pending', 0, 'PKR', 'sandbox') RETURNING id`,
    );
    const payoutId = payout!.id;
    const failed = { kind: 'payout_failed', payoutId, providerProfileId: provider.providerProfileId, failureCode: 'transfer_rejected' } as const;

    await emitPayoutNotification({ ...failed, audience: 'provider' });
    await emitPayoutNotification({ ...failed, audience: 'provider' }); // retried emission of the same failure
    const logs = captureLogs();
    try {
      await emitPayoutNotification({ ...failed, audience: 'finance' });
      await emitPayoutNotification({ kind: 'payout_escalated', payoutId, audience: 'finance' });
    } finally {
      logs.restore();
    }
    expect(await typesFor(provider.userId)).toEqual(['payout_failed']);
    expect(logs.events().filter((e) => e.event === 'notification.not_user_addressed')).toHaveLength(2);

    // A later attempt that fails again is its own event; a paid payout is one more.
    await getDb().execute(sql`UPDATE payouts SET attempt_count = attempt_count + 1 WHERE id = ${payoutId}`);
    await emitPayoutNotification({ ...failed, audience: 'provider' });
    await emitPayoutNotification({ kind: 'payout_paid', payoutId, providerProfileId: provider.providerProfileId });
    await emitPayoutNotification({ kind: 'payout_paid', payoutId, providerProfileId: provider.providerProfileId });
    expect(await typesFor(provider.userId)).toEqual(['payout_failed', 'payout_failed', 'payout_paid']);
  });

  it("spec 015's request cancellation notifies each DISTRIBUTED provider exactly once", async () => {
    const client = await getPool().connect();
    let requestId: string;
    try {
      requestId = await seedMinimalRequest(client, 'cancelled');
    } finally {
      client.release();
    }
    const [told, untold] = [await createProviderUser(), await createProviderUser()];
    await getDb().execute(sql`
      INSERT INTO request_provider_matches (request_id, provider_profile_id, eligible, rank, notified_at)
      VALUES (${requestId}, ${told.providerProfileId}, true, 1, clock_timestamp()),
             (${requestId}, ${untold.providerProfileId}, true, 2, NULL)
    `);

    const first = await notifyProvidersOfCancellation(requestId);
    await notifyProvidersOfCancellation(requestId);
    expect(first.notifiedProviderProfileIds.sort()).toEqual([told.providerProfileId, untold.providerProfileId].sort());
    expect(await typesFor(told.userId)).toEqual(['request_cancelled']);
    expect(await notificationCount(untold.userId)).toBe(0);
  });

  it("spec 016's availability opt-in is delivered once the provider is available, then marked sent", async () => {
    const available = await createProviderUser();
    const unavailable = await createProviderUser();
    for (let day = 0; day < 7; day += 1) {
      await getDb().execute(sql`
        INSERT INTO provider_availabilities (provider_profile_id, day_of_week, start_minute, end_minute)
        VALUES (${available.providerProfileId}, ${day}, 0, 1440)
      `);
    }
    const customerUserId = await createUser();
    const [customer] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO customer_profiles (user_id) VALUES (${customerUserId}) RETURNING id`,
    );
    const [optIn] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO provider_availability_notification_requests (customer_profile_id, provider_profile_id)
          VALUES (${customer!.id}, ${available.providerProfileId}) RETURNING id`,
    );
    const [waiting] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO provider_availability_notification_requests (customer_profile_id, provider_profile_id)
          VALUES (${customer!.id}, ${unavailable.providerProfileId}) RETURNING id`,
    );

    const noon = new Date();
    noon.setUTCHours(12, 0, 0, 0);
    if (noon.getTime() < Date.now()) noon.setUTCDate(noon.getUTCDate() + 1);
    await dispatchAvailabilityNotifications(noon);
    await dispatchAvailabilityNotifications(noon);

    expect(await typesFor(customerUserId)).toEqual(['provider_available']);
    const statuses = await queryRows<{ id: string; status: string; notified_at: string | null }>(
      getDb(),
      sql`SELECT id, status, notified_at FROM provider_availability_notification_requests WHERE id IN (${optIn!.id}, ${waiting!.id})`,
    );
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s]));
    expect(byId[optIn!.id]).toMatchObject({ status: 'sent' });
    expect(byId[optIn!.id]!.notified_at).not.toBeNull();
    expect(byId[waiting!.id]).toMatchObject({ status: 'pending', notified_at: null });
  });
});
