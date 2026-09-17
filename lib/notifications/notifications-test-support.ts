/**
 * Spec 026 — shared fixtures for this domain's integration suites. Writes only to the isolated `*_test`
 * database Vitest points `DATABASE_URL` at (test/db-reset.ts); never the developer's own.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { vi } from 'vitest';
import { getDb } from '@/lib/db';
import type { CategoryChannelMap, NotificationCategory, OutboundChannel } from '@/lib/types/notifications';
import type { ChannelAdapterSet, ChannelOutcome, ChannelResult } from './channels';
import { defaultCategoryChannelMap } from './defaults';
import { queryRows } from './sql';

export { isDatabaseReachable } from '@/lib/db/test-support';

export async function createUser(): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO users (email) VALUES (${`notif-${randomUUID()}@example.test`}) RETURNING id`,
  );
  return row!.id;
}

/** Writes a preference row directly (bypassing the API) with the given overrides and optional consent. */
export async function setPreferences(
  userId: string,
  overrides: Partial<Record<NotificationCategory, Partial<Record<OutboundChannel, boolean>>>>,
  options: { consent?: boolean } = {},
): Promise<CategoryChannelMap> {
  const map = defaultCategoryChannelMap();
  for (const [category, channels] of Object.entries(overrides)) {
    Object.assign(map[category as NotificationCategory], channels);
  }
  await getDb().execute(sql`
    INSERT INTO notification_preferences (user_id, categories, marketing_consent_at, marketing_consent_source)
    VALUES (${userId}, ${JSON.stringify(map)}::jsonb, ${options.consent ? sql`clock_timestamp()` : sql`NULL`},
            ${options.consent ? 'account_settings' : null})
    ON CONFLICT (user_id) DO UPDATE
      SET categories = EXCLUDED.categories, marketing_consent_at = EXCLUDED.marketing_consent_at,
          marketing_consent_source = EXCLUDED.marketing_consent_source, version = notification_preferences.version + 1
  `);
  return map;
}

export interface DeliveryRow {
  id: string;
  channel: OutboundChannel;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  delivered_at: string | null;
  provider_reference: string | null;
  failure_code: string | null;
  skip_reason: string | null;
}

export async function deliveriesFor(notificationId: string): Promise<DeliveryRow[]> {
  return queryRows<DeliveryRow>(
    getDb(),
    sql`SELECT id, channel, status, attempts, next_attempt_at, delivered_at, provider_reference, failure_code, skip_reason
          FROM notification_deliveries WHERE notification_id = ${notificationId}
         ORDER BY array_position(ARRAY['push','email','sms'], channel)`,
  );
}

export async function notificationCount(userId: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM notifications WHERE recipient_user_id = ${userId}`);
  return row!.n;
}

/** Makes every queued delivery of a notification due NOW (skipping the backoff wait). */
export async function makeDue(notificationId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE notification_deliveries SET next_attempt_at = clock_timestamp() - interval '1 second'
     WHERE notification_id = ${notificationId} AND status IN ('pending','retrying') AND next_attempt_at IS NOT NULL
  `);
}

/** A scripted adapter set: each channel returns its outcomes in order (the last one repeats). */
export function scriptedAdapters(script: Partial<Record<OutboundChannel, ChannelOutcome[]>>): {
  adapters: ChannelAdapterSet;
  calls: Array<{ channel: OutboundChannel; notificationId: string }>;
} {
  const calls: Array<{ channel: OutboundChannel; notificationId: string }> = [];
  const adapters: ChannelAdapterSet = {};
  for (const [channel, outcomes] of Object.entries(script) as Array<[OutboundChannel, ChannelOutcome[]]>) {
    let index = 0;
    adapters[channel] = {
      channel,
      async deliver(input): Promise<ChannelResult> {
        calls.push({ channel, notificationId: input.notificationId });
        const outcome = outcomes[Math.min(index, outcomes.length - 1)]!;
        index += 1;
        return outcome === 'delivered'
          ? { outcome, providerReference: `test_${randomUUID()}` }
          : { outcome, providerReference: null, failureCode: outcome === 'failed' ? 'rejected' : undefined };
      },
    };
  }
  return { adapters, calls };
}

/** Captures structured JSON log lines written through console.log / console.error. */
export function captureLogs(): { events: () => Array<Record<string, unknown>>; restore: () => void } {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
  const error = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)));
  return {
    events: () =>
      lines.flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}
