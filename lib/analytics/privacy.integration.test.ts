import { afterEach, describe, expect, it } from 'vitest';
import { insertUser, isDatabaseReachable, withSnapshot } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import { queryRows } from '@/lib/offers/db';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import {
  funnelReport,
  matchingFairnessReport,
  providerPerformanceReport,
  retentionReport,
  revenueReport,
  serviceTrendsReport,
  supplyDemandReport,
} from './reports';
import { analyticsRetentionDays, DEFAULT_ANALYTICS_RETENTION_DAYS, sweepAnalyticsRetention } from './retention';

/**
 * Spec 040 §4 "Retention and privacy" and AC-3 — raw events expire after the retention window,
 * events of deleted accounts are de-attributed, and no report ever carries an actor id.
 */
const dbReachable = await isDatabaseReachable();
const NOW = new Date('2026-09-27T12:00:00.000Z');
const DAY = 86_400_000;

async function insertEvent(client: PoolClient, input: { actor: string | null; occurredAt: Date; type?: string }): Promise<string> {
  const type = input.type ?? 'search_performed';
  const properties =
    type === 'search_performed' ? { hasQuery: false, hasLocation: false, resultCount: 0 } : { conversationId: '22222222-2222-4222-8222-222222222222' };
  const { rows } = await client.query<{ id: string }>(
    'INSERT INTO analytics_events (actor_user_id, event_type, occurred_at, properties) VALUES ($1, $2, $3, $4) RETURNING id',
    [input.actor, type, input.occurredAt.toISOString(), JSON.stringify(properties)],
  );
  return rows[0]!.id;
}

async function exists(client: PoolClient, id: string): Promise<{ actor_user_id: string | null } | undefined> {
  const { rows } = await client.query<{ actor_user_id: string | null }>('SELECT actor_user_id FROM analytics_events WHERE id = $1', [id]);
  return rows[0];
}

afterEach(() => {
  delete process.env.ANALYTICS_EVENT_RETENTION_DAYS;
});

describe('analyticsRetentionDays (spec 040 §4)', () => {
  it('is a positive integer, else the 90-day default', () => {
    expect(analyticsRetentionDays()).toBe(DEFAULT_ANALYTICS_RETENTION_DAYS);
    expect(DEFAULT_ANALYTICS_RETENTION_DAYS).toBe(90);
    process.env.ANALYTICS_EVENT_RETENTION_DAYS = '30';
    expect(analyticsRetentionDays()).toBe(30);
    for (const bad of ['0', '-5', '1.5', 'ninety', '']) {
      process.env.ANALYTICS_EVENT_RETENTION_DAYS = bad;
      expect(analyticsRetentionDays()).toBe(90);
    }
  });
});

describe.skipIf(!dbReachable)('analytics retention sweep and privacy (spec 040 §4, AC-3)', { timeout: 120_000 }, () => {
  it('deletes events older than the window and keeps newer ones', async () => {
    await withSnapshot(async (db, client) => {
      const expired = await insertEvent(client, { actor: null, occurredAt: new Date(NOW.getTime() - 91 * DAY) });
      const kept = await insertEvent(client, { actor: null, occurredAt: new Date(NOW.getTime() - 89 * DAY) });
      const result = await sweepAnalyticsRetention(NOW, db);
      expect(result.deleted).toBeGreaterThanOrEqual(1);
      expect(await exists(client, expired)).toBeUndefined();
      expect(await exists(client, kept)).toBeDefined();
    });
  });

  it('honours ANALYTICS_EVENT_RETENTION_DAYS', async () => {
    process.env.ANALYTICS_EVENT_RETENTION_DAYS = '7';
    await withSnapshot(async (db, client) => {
      const expired = await insertEvent(client, { actor: null, occurredAt: new Date(NOW.getTime() - 8 * DAY) });
      const kept = await insertEvent(client, { actor: null, occurredAt: new Date(NOW.getTime() - 6 * DAY) });
      await sweepAnalyticsRetention(NOW, db);
      expect(await exists(client, expired)).toBeUndefined();
      expect(await exists(client, kept)).toBeDefined();
    });
  });

  it("de-attributes a deleted account's events and leaves every other actor untouched", async () => {
    await withSnapshot(async (db, client) => {
      const closed = await insertUser(client);
      const live = await insertUser(client);
      const closedEvent = await insertEvent(client, { actor: closed, occurredAt: NOW, type: 'ai_conversation_started' });
      const liveEvent = await insertEvent(client, { actor: live, occurredAt: NOW, type: 'ai_conversation_started' });
      await client.query("UPDATE users SET lifecycle_status = 'deleted' WHERE id = $1", [closed]);

      const result = await sweepAnalyticsRetention(NOW, db);
      expect(result.deattributed).toBeGreaterThanOrEqual(1);
      expect(await exists(client, closedEvent)).toEqual({ actor_user_id: null });
      expect(await exists(client, liveEvent)).toEqual({ actor_user_id: live });

      // The row stays (it still counts in aggregates), only its user linkage is gone.
      const [row] = await queryRows<{ version: number }>(db, sql`SELECT version FROM analytics_events WHERE id = ${closedEvent}`);
      expect(row!.version).toBe(2);
    });
  });

  it('AC-3: no report carries an actor id, whatever the events hold', async () => {
    await withSnapshot(async (db, client) => {
      const actor = await insertUser(client);
      const W = { from: new Date('2095-01-01T00:00:00Z'), to: new Date('2095-01-31T00:00:00Z') };
      for (let i = 0; i < 3; i += 1) await insertEvent(client, { actor, occurredAt: new Date('2095-01-10T00:00:00Z') });

      const reports = [
        await funnelReport(db, W),
        await revenueReport(db, W),
        await supplyDemandReport(db, W),
        await providerPerformanceReport(db, W, { limit: 100, offset: 0 }),
        await matchingFairnessReport(db, W),
        await retentionReport(db, W),
        await serviceTrendsReport(db, W),
      ];
      expect((reports[0] as Awaited<ReturnType<typeof funnelReport>>).stages[0]!.count).toBe(3);
      const serialized = JSON.stringify(reports);
      expect(serialized).not.toContain(actor);
      const keys = new Set<string>();
      const collect = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') {
          for (const [key, inner] of Object.entries(value)) {
            keys.add(key);
            collect(inner);
          }
        }
      };
      collect(reports);
      for (const key of keys) expect(key).not.toMatch(/actor|user|email|phone|contact|score|fraud|signal|^q$|query|text/i);
    });
  });
});
