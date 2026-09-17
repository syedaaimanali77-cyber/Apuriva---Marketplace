import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { generateExportPayload } from '@/lib/privacy/export';
import { REDACTED_DESCRIPTION, sweepDeletions } from '@/lib/privacy/deletion';
import {
  conversationRowFor,
  isDatabaseReachable,
  resetMessagingIntegration,
  seedConfirmedBooking,
  seedPendingBooking,
  seedStranger,
  sent,
  storedMessages,
  useMessagingIntegration,
} from './messaging-test-support';

/**
 * Spec 025 AC-10 — spec 008's export carries the user's actual correspondence within the participant
 * boundary, and spec 008's deletion sweep anonymizes only the bodies the deleted user authored.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('messaging privacy (spec 025 AC-10)', { timeout: 120_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => resetMessagingIntegration());
  afterAll(async () => {
    await getPool().end();
  });

  it('export carries bodies for participated conversations only', async () => {
    const { scenario, bookingId } = await seedPendingBooking();
    const masked = await sent(scenario.customer, bookingId, 'Call 03001234567 please');
    const reply = await sent(scenario.provider, bookingId, 'Will message here instead');
    const conversation = await conversationRowFor(bookingId);

    const customerExport = await generateExportPayload(scenario.customer.userId);
    const mine = customerExport.messages.filter((m) => m.conversationId === conversation!.id);
    expect(mine).toEqual([
      {
        id: masked.id,
        conversationId: conversation!.id,
        bookingId,
        senderUserId: scenario.customer.userId,
        senderRole: 'customer',
        body: 'Call [contact removed] please',
        contactRedacted: true,
        contactFlagged: false,
        redactedByRetention: false,
        createdAt: masked.createdAt,
      },
      expect.objectContaining({ id: reply.id, senderRole: 'provider', body: 'Will message here instead' }),
    ]);
    // Never an idempotency key or fingerprint, and never the unmasked original.
    expect(JSON.stringify(mine)).not.toContain('03001234567');
    expect(Object.keys(mine[0]!)).not.toContain('idempotencyKey');

    // The counterparty exports the same conversation; an outsider exports none of it.
    const providerExport = await generateExportPayload(scenario.provider.userId);
    expect(providerExport.messages.filter((m) => m.conversationId === conversation!.id)).toHaveLength(2);
    const outsider = await seedStranger();
    const outsiderExport = await generateExportPayload(outsider.customer.userId);
    expect(outsiderExport.messages.filter((m) => m.conversationId === conversation!.id)).toEqual([]);
  });

  it("deletion redacts only the author's messages", async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const authored = await sent(scenario.customer, bookingId, 'My flat is 4B, blue door');
    const counterparty = await sent(scenario.provider, bookingId, 'Noted, see you at 10');

    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, scenario.customer.userId));
    await sweepDeletions();

    const rows = await storedMessages(bookingId);
    expect(rows.map((m) => ({ id: m.id, body: m.body, redacted: m.redacted_by_retention }))).toEqual([
      { id: authored.id, body: REDACTED_DESCRIPTION, redacted: true },
      { id: counterparty.id, body: 'Noted, see you at 10', redacted: false },
    ]);
    // The conversation record and its timestamps survive.
    expect(await conversationRowFor(bookingId)).toBeDefined();
    expect(new Date(rows[0]!.created_at).toISOString()).toBe(authored.createdAt);
  });
});
