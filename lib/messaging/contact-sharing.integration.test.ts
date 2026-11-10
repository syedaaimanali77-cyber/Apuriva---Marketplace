import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '@/lib/db';
import {
  getConversation,
  isDatabaseReachable,
  json,
  listMessages,
  resetMessagingIntegration,
  seedConfirmedBooking,
  seedPendingBooking,
  sendMessage,
  storedMessages,
  useMessagingIntegration,
} from './messaging-test-support';

/**
 * Spec 025 AC-2 end to end: what is STORED and DELIVERED on each side of the `confirmed` gate, that nothing
 * is ever rejected, and that the flag signal carries identifiers only — never content.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('contact-sharing protection (spec 025 AC-2)', { timeout: 90_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => {
    resetMessagingIntegration();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await getPool().end();
  });

  it('before confirmation: masks only the token, stores no original, delivers and tells the sender', async () => {
    const { scenario, bookingId } = await seedPendingBooking();
    expect((await json(await getConversation(scenario.customer, bookingId))).data.contactSharingAllowed).toBe(false);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });

    const response = await sendMessage(scenario.customer, bookingId, { body: 'Flat 4B, 2nd floor. Call 0300 123 4567 when here.' });
    expect(response.status).toBe(201);
    const { data } = await json(response);
    expect(data).toMatchObject({
      body: 'Flat 4B, 2nd floor. Call [contact removed] when here.',
      contactRedacted: true,
      contactFlagged: false,
    });

    const [stored] = await storedMessages(bookingId);
    expect(stored!.body).toBe('Flat 4B, 2nd floor. Call [contact removed] when here.');
    expect(stored!.body).not.toContain('0300');

    // Delivered to the recipient exactly as stored.
    const inbox = await json(await listMessages(scenario.provider, bookingId));
    expect(inbox.data[0].body).toBe(stored!.body);

    // The signal: identifiers and a count, never the content (redacted or not).
    const flag = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === 'messaging.contact_flagged');
    expect(flag).toMatchObject({ bookingId, senderUserId: scenario.customer.userId, mode: 'masked', count24h: 1 });
    expect(logs.join('\n')).not.toContain('0300');
    expect(logs.join('\n')).not.toContain('Flat 4B');
  });

  it('after confirmation: stores verbatim, masks nothing, and flags for Trust & Safety', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    expect((await json(await getConversation(scenario.provider, bookingId))).data.contactSharingAllowed).toBe(true);

    const text = 'I am at the gate — my number is 03001234567, or ali@example.com.';
    const response = await sendMessage(scenario.provider, bookingId, { body: text });
    expect(response.status).toBe(201);
    expect((await json(response)).data).toMatchObject({ body: text, contactRedacted: false, contactFlagged: true });

    const [stored] = await storedMessages(bookingId);
    expect(stored).toMatchObject({ body: text, contact_redacted: false, contact_flagged: true });
    expect((await json(await listMessages(scenario.customer, bookingId))).data[0].body).toBe(text);
  });

  it('never rejects legitimate service information in either stage', async () => {
    for (const seed of [seedPendingBooking, seedConfirmedBooking]) {
      const { scenario, bookingId } = await seed();
      const text = 'Agreed Rs. 3,500. Arriving 12/05/2026 at 10:30, bring the 2 m ladder.';
      const response = await sendMessage(scenario.customer, bookingId, { body: text });
      expect(response.status).toBe(201);
      expect((await json(response)).data).toMatchObject({ body: text, contactRedacted: false, contactFlagged: false });
    }
  });

  it('validates the body bounds before redaction: blank and over-2000 are 400, 2000 is accepted', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();

    const blank = await sendMessage(scenario.customer, bookingId, { body: '   ' });
    expect(blank.status).toBe(400);
    expect((await json(blank)).errors).toEqual([expect.objectContaining({ field: 'body' })]);

    const tooLong = await sendMessage(scenario.customer, bookingId, { body: 'a'.repeat(2001) });
    expect(tooLong.status).toBe(400);

    const atLimit = await sendMessage(scenario.customer, bookingId, { body: 'a'.repeat(2000) });
    expect(atLimit.status).toBe(201);
  });
});
