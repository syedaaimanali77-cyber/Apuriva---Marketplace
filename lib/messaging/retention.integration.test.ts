import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '@/lib/db';
import { REDACTED_DESCRIPTION } from '@/lib/privacy/deletion';
import { GET as CRON } from '@/app/api/v1/cron/message-retention-sweep/route';
import { runMessageRetentionSweep } from './retention';
import {
  ageArchive,
  archivePendingBooking,
  conversationRowFor,
  getConversation,
  isDatabaseReachable,
  json,
  listMessages,
  resetMessagingIntegration,
  seedConfirmedBooking,
  seedPendingBooking,
  sent,
  storedMessages,
  useMessagingIntegration,
} from './messaging-test-support';

/**
 * Spec 025 AC-4 — historical retention anonymizes, never deletes, never touches an active conversation, and
 * is idempotent. Time is moved by backdating `archived_at` against the database clock, never by sleeping.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('message retention sweep (spec 025 AC-4)', { timeout: 120_000 }, () => {
  const originalWindow = process.env.MESSAGE_RETENTION_DAYS;

  beforeEach(() => {
    useMessagingIntegration();
    process.env.MESSAGE_RETENTION_DAYS = '90';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    resetMessagingIntegration();
    vi.restoreAllMocks();
    if (originalWindow === undefined) delete process.env.MESSAGE_RETENTION_DAYS;
    else process.env.MESSAGE_RETENTION_DAYS = originalWindow;
  });
  afterAll(async () => {
    await getPool().end();
  });

  it('anonymizes expired archived conversations, never active ones, idempotently', async () => {
    // Expired: archived 91 days ago.
    const expired = await seedPendingBooking();
    const e1 = await sent(expired.scenario.customer, expired.bookingId, 'Please call before arriving');
    await sent(expired.scenario.provider, expired.bookingId, 'Will do');
    await archivePendingBooking(expired.bookingId);
    await getConversation(expired.scenario.customer, expired.bookingId); // observes the archive
    await ageArchive((await conversationRowFor(expired.bookingId))!.id, 91);

    // Archived but still inside the window.
    const recent = await seedPendingBooking();
    await sent(recent.scenario.customer, recent.bookingId, 'Recent history');
    await archivePendingBooking(recent.bookingId);
    await getConversation(recent.scenario.customer, recent.bookingId);
    await ageArchive((await conversationRowFor(recent.bookingId))!.id, 89);

    // Active, with an old conversation row: must never be swept whatever its age.
    const active = await seedConfirmedBooking();
    await sent(active.scenario.customer, active.bookingId, 'Still live');

    const result = await runMessageRetentionSweep();
    expect(result.windowDays).toBe(90);
    expect(result.conversationsSwept).toBeGreaterThanOrEqual(1);

    // Rows retained, bodies anonymized, flags and ids and timestamps intact.
    const expiredRows = await storedMessages(expired.bookingId);
    expect(expiredRows).toHaveLength(2);
    expect(expiredRows.every((m) => m.body === REDACTED_DESCRIPTION && m.redacted_by_retention)).toBe(true);
    expect(expiredRows[0]!.id).toBe(e1.id);
    expect(new Date(expiredRows[0]!.created_at).toISOString()).toBe(e1.createdAt);
    expect((await conversationRowFor(expired.bookingId))!.retention_applied_at).not.toBeNull();

    // Participants see an honest anonymized state, not words presented as the user's.
    const seen = await json(await listMessages(expired.scenario.customer, expired.bookingId));
    expect(seen.data[0]).toMatchObject({ body: REDACTED_DESCRIPTION, redactedByRetention: true });

    expect((await storedMessages(recent.bookingId))[0]).toMatchObject({ body: 'Recent history', redacted_by_retention: false });
    expect((await storedMessages(active.bookingId))[0]).toMatchObject({ body: 'Still live', redacted_by_retention: false });
    expect((await conversationRowFor(active.bookingId))!.archived_at).toBeNull();

    // Idempotent: a second run changes nothing for the already-swept conversation.
    const stampedAt = (await conversationRowFor(expired.bookingId))!.retention_applied_at;
    await runMessageRetentionSweep();
    expect((await conversationRowFor(expired.bookingId))!.retention_applied_at).toEqual(stampedAt);
  });

  it('starts the retention clock for an archived conversation no participant has opened since', async () => {
    const { scenario, bookingId } = await seedPendingBooking();
    await sent(scenario.customer, bookingId, 'hello');
    await archivePendingBooking(bookingId);
    expect((await conversationRowFor(bookingId))!.archived_at).toBeNull();

    const result = await runMessageRetentionSweep();
    expect(result.archivedStamped).toBeGreaterThanOrEqual(1);
    expect((await conversationRowFor(bookingId))!.archived_at).not.toBeNull();
    // Just stamped, so inside the window: nothing anonymized yet.
    expect((await storedMessages(bookingId))[0]!.body).toBe('hello');
  });

  it('the cron route requires the bearer secret', async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-cron-secret';
    try {
      const { NextRequest } = await import('next/server');
      const denied = await CRON(new NextRequest('http://localhost/api/v1/cron/message-retention-sweep'));
      expect(denied.status).toBe(401);

      const allowed = await CRON(
        new NextRequest('http://localhost/api/v1/cron/message-retention-sweep', { headers: { authorization: 'Bearer test-cron-secret' } }),
      );
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ status: 'ok', windowDays: 90 });
    } finally {
      if (original === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = original;
    }
  });
});
