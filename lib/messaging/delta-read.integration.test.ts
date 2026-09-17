import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '@/lib/db';
import { formatMessageCursor } from './cursor';
import {
  isDatabaseReachable,
  json,
  listMessages,
  resetMessagingIntegration,
  seedConfirmedBooking,
  sent,
  useMessagingIntegration,
} from './messaging-test-support';

/**
 * Spec 025 AC-1 "Real-time transport" — the cursor delta read the 5-second poller uses. Resume semantics are
 * the point: from any cursor the client holds, the next read returns exactly what it has not seen.
 */
const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('delta read (spec 025 AC-1)', { timeout: 90_000 }, () => {
  beforeEach(() => useMessagingIntegration());
  afterEach(() => resetMessagingIntegration());
  afterAll(async () => {
    await getPool().end();
  });

  it('after-cursor returns only newer messages', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const first = await sent(scenario.customer, bookingId, 'Is 10am still fine?');

    // The provider's poller holds `first` as its cursor; the customer then sends two more.
    const second = await sent(scenario.customer, bookingId, 'The gate code is 4471');
    const third = await sent(scenario.provider, bookingId, 'Yes, see you at 10');

    const delta = await listMessages(scenario.provider, bookingId, `?after=${encodeURIComponent(formatMessageCursor(first))}&limit=50`);
    expect(delta.status).toBe(200);
    const payload = await json(delta);
    expect(payload.data.map((m: { id: string }) => m.id)).toEqual([second.id, third.id]);
    expect(payload.page.total).toBe(2);

    // Resuming from the newest cursor after a "disconnect" returns nothing new — no duplicates, no gaps.
    const caughtUp = await json(await listMessages(scenario.provider, bookingId, `?after=${encodeURIComponent(formatMessageCursor(third))}`));
    expect(caughtUp.data).toEqual([]);

    // A message arriving later is the next delta.
    const fourth = await sent(scenario.customer, bookingId, 'Running two minutes late');
    const next = await json(await listMessages(scenario.provider, bookingId, `?after=${encodeURIComponent(formatMessageCursor(third))}`));
    expect(next.data.map((m: { id: string }) => m.id)).toEqual([fourth.id]);
  });

  it('bounds a delta by limit, so a long gap is drained over successive polls', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const anchor = await sent(scenario.customer, bookingId, 'start');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await sent(scenario.provider, bookingId, `update ${i}`)).id);

    const page1 = await json(await listMessages(scenario.customer, bookingId, `?after=${encodeURIComponent(formatMessageCursor(anchor))}&limit=2`));
    expect(page1.data.map((m: { id: string }) => m.id)).toEqual(ids.slice(0, 2));
    expect(page1.page.total).toBe(3);

    const page2 = await json(
      await listMessages(scenario.customer, bookingId, `?after=${encodeURIComponent(formatMessageCursor(page1.data[1]))}&limit=2`),
    );
    expect(page2.data.map((m: { id: string }) => m.id)).toEqual(ids.slice(2));
  });

  it('logs delivery latency for counterparty messages and a recovered poll, with no message content', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const anchor = await sent(scenario.provider, bookingId, 'anchor');
    const own = await sent(scenario.customer, bookingId, 'my own note');
    const incoming = await sent(scenario.provider, bookingId, 'Secret gate code 4471');

    const logs: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(JSON.parse(String(line)));
    });
    try {
      const cursor = encodeURIComponent(formatMessageCursor(anchor));
      expect((await listMessages(scenario.customer, bookingId, `?after=${cursor}&resumed=3:42`)).status).toBe(200);
      // A malformed telemetry value never fails the read.
      expect((await listMessages(scenario.customer, bookingId, `?after=${cursor}&resumed=lots`)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    const latency = logs.filter((l) => l.event === 'messaging.delivery_latency_ms');
    // Two reads, one counterparty message each time; the reader's own message is never counted.
    expect(latency).toHaveLength(2);
    expect(latency[0]).toEqual({ event: 'messaging.delivery_latency_ms', conversationId: incoming.conversationId, latencyMs: expect.any(Number) });
    expect(own.senderRole).toBe('customer');

    expect(logs.filter((l) => l.event === 'messaging.poll_recovered')).toEqual([
      { event: 'messaging.poll_recovered', conversationId: incoming.conversationId, failedAttempts: 3, gapSeconds: 42 },
    ]);
    expect(JSON.stringify(logs)).not.toContain('Secret gate code');
  });

  it('rejects after combined with offset, and a malformed after, with 400 VALIDATION_ERROR', async () => {
    const { scenario, bookingId } = await seedConfirmedBooking();
    const message = await sent(scenario.customer, bookingId, 'hello');

    const combined = await listMessages(scenario.customer, bookingId, `?after=${encodeURIComponent(formatMessageCursor(message))}&offset=0`);
    expect(combined.status).toBe(400);
    expect((await json(combined)).errors).toEqual([expect.objectContaining({ field: 'after' })]);

    const malformed = await listMessages(scenario.customer, bookingId, '?after=yesterday');
    expect(malformed.status).toBe(400);
    expect((await json(malformed)).code).toBe('VALIDATION_ERROR');
  });
});
