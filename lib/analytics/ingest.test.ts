import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Spec 040 §3.3 (AC-1, AC-5) — the bounded buffer, batch flush, drop-and-count, no retry, the
 * disabled switch, and the `after()` → `setTimeout(0)` fallback. The database and `after()` are
 * mocked: this file tests ingestion mechanics, `emitters.integration.test.ts` the real inserts.
 */
const insertedBatches: unknown[][] = [];
let failInserts = false;
const afterMock = vi.fn((_task: () => void): void => {
  throw new Error('`after` was called outside a request scope');
});

vi.mock('next/server', () => ({ after: (task: () => void) => afterMock(task) }));
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    insert: () => ({
      values: async (rows: unknown[]) => {
        if (failInserts) throw new Error('database unavailable');
        insertedBatches.push(rows);
      },
    }),
  }),
}));

const {
  ANALYTICS_FLUSH_BATCH_SIZE,
  MAX_PENDING_ANALYTICS_EVENTS,
  analyticsBufferStateForTests,
  drainAnalyticsForTests,
  isAnalyticsIngestionEnabled,
  recordAnalyticsEvent,
  resetAnalyticsForTests,
} = await import('./ingest');

const USER = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const event = () => ({ type: 'ai_conversation_started' as const, actorUserId: USER, properties: { conversationId: ID } });

let logged: string[] = [];

beforeEach(() => {
  insertedBatches.length = 0;
  failInserts = false;
  logged = [];
  afterMock.mockClear();
  resetAnalyticsForTests();
  delete process.env.ANALYTICS_INGESTION_ENABLED;
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(async () => {
  await drainAnalyticsForTests();
  vi.restoreAllMocks();
  delete process.env.ANALYTICS_INGESTION_ENABLED;
});

const loggedEvents = () => logged.map((line) => JSON.parse(line) as Record<string, unknown>);

describe('recordAnalyticsEvent (spec 040 §3.3)', () => {
  it('is synchronous, returns nothing, and records after the caller has moved on', async () => {
    const result = recordAnalyticsEvent(event());
    expect(result).toBeUndefined();
    // Nothing is written in the caller's own turn.
    expect(insertedBatches).toHaveLength(0);
    await drainAnalyticsForTests();
    expect(insertedBatches).toHaveLength(1);
    const [row] = insertedBatches[0] as { eventType: string; actorUserId: string; properties: object; occurredAt: Date }[];
    expect(row).toMatchObject({ eventType: 'ai_conversation_started', actorUserId: USER, properties: { conversationId: ID } });
    expect(row!.occurredAt).toBeInstanceOf(Date);
  });

  it('tries `after()` first and falls back to setTimeout when outside a request scope', async () => {
    recordAnalyticsEvent(event());
    await drainAnalyticsForTests();
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(insertedBatches).toHaveLength(1);
  });

  it('inside a request scope, the flush is handed to `after()`', async () => {
    const scheduled: (() => void)[] = [];
    afterMock.mockImplementationOnce((task) => {
      scheduled.push(task);
    });
    recordAnalyticsEvent(event());
    expect(scheduled).toHaveLength(1);
    expect(insertedBatches).toHaveLength(0); // not until after() runs it, i.e. after the response
    scheduled[0]!();
    await drainAnalyticsForTests();
    expect(insertedBatches).toHaveLength(1);
  });

  it('batches the buffer into multi-row inserts of ANALYTICS_FLUSH_BATCH_SIZE', async () => {
    const n = ANALYTICS_FLUSH_BATCH_SIZE * 2 + 5;
    for (let i = 0; i < n; i += 1) recordAnalyticsEvent(event());
    await drainAnalyticsForTests();
    expect(insertedBatches.map((b) => b.length)).toEqual([ANALYTICS_FLUSH_BATCH_SIZE, ANALYTICS_FLUSH_BATCH_SIZE, 5]);
  });

  it('AC-5 spike: beyond the bound the new events are dropped and counted, once per flush', async () => {
    const excess = 37;
    for (let i = 0; i < MAX_PENDING_ANALYTICS_EVENTS + excess; i += 1) recordAnalyticsEvent(event());
    expect(analyticsBufferStateForTests()).toEqual({ pending: MAX_PENDING_ANALYTICS_EVENTS, dropped: excess });
    await drainAnalyticsForTests();
    const inserted = insertedBatches.reduce((sum, b) => sum + b.length, 0);
    expect(inserted).toBe(MAX_PENDING_ANALYTICS_EVENTS);
    const drops = loggedEvents().filter((l) => l.event === 'analytics.events_dropped');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ count: excess, bound: MAX_PENDING_ANALYTICS_EVENTS });
    expect(analyticsBufferStateForTests()).toEqual({ pending: 0, dropped: 0 });
  });

  it('AC-5 failure: a failed batch is dropped and logged, never retried, and never thrown', async () => {
    failInserts = true;
    expect(() => recordAnalyticsEvent(event())).not.toThrow();
    await drainAnalyticsForTests();
    expect(insertedBatches).toHaveLength(0);
    const failures = loggedEvents().filter((l) => l.event === 'analytics.flush_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ dropped: 1, error: 'database unavailable' });
    // No retry: once the database recovers, the dropped event does not reappear.
    failInserts = false;
    await drainAnalyticsForTests();
    expect(insertedBatches).toHaveLength(0);
    expect(analyticsBufferStateForTests().pending).toBe(0);
  });

  it('events recorded while a flush is running get a flush of their own', async () => {
    recordAnalyticsEvent(event());
    const firstFlush = drainAnalyticsForTests();
    recordAnalyticsEvent(event());
    await firstFlush;
    await drainAnalyticsForTests();
    expect(insertedBatches.reduce((sum, b) => sum + b.length, 0)).toBe(2);
  });

  it('an invalid event is rejected with one log line and nothing recorded', async () => {
    recordAnalyticsEvent({ type: 'request_submitted', actorUserId: USER, properties: { requestId: ID, serviceId: ID, q: 'plumber' } });
    await drainAnalyticsForTests();
    expect(insertedBatches).toHaveLength(0);
    const rejected = loggedEvents().filter((l) => l.event === 'analytics.event_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ eventType: 'request_submitted' });
    // The rejected value itself is never logged.
    expect(logged.join('\n')).not.toContain('plumber');
  });

  it('ANALYTICS_INGESTION_ENABLED=false pauses ingestion; any other value keeps it on', async () => {
    process.env.ANALYTICS_INGESTION_ENABLED = 'false';
    expect(isAnalyticsIngestionEnabled()).toBe(false);
    recordAnalyticsEvent(event());
    await drainAnalyticsForTests();
    expect(insertedBatches).toHaveLength(0);
    expect(analyticsBufferStateForTests().pending).toBe(0);

    for (const value of ['true', '0', 'FALSE', '']) {
      process.env.ANALYTICS_INGESTION_ENABLED = value;
      expect(isAnalyticsIngestionEnabled()).toBe(true);
    }
    delete process.env.ANALYTICS_INGESTION_ENABLED;
    expect(isAnalyticsIngestionEnabled()).toBe(true);
  });

  it('never throws, even when the input itself is unusable or logging fails', () => {
    expect(() => recordAnalyticsEvent(undefined as never)).not.toThrow();
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('log sink down');
    });
    expect(() => recordAnalyticsEvent(undefined as never)).not.toThrow();
    const hostile = {
      get type(): never {
        throw new Error('boom');
      },
    };
    expect(() => recordAnalyticsEvent(hostile as never)).not.toThrow();
  });
});
