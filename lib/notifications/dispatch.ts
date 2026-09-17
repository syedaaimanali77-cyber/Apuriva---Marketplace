/**
 * Spec 026 §3 "Delivery, retry and escalation" (AC-6, AC-10) — `/api/v1/cron/notification-dispatch-sweep`.
 *
 * The existing Vercel Cron mechanism; no worker. Each due row is claimed in ITS OWN transaction with
 * `FOR UPDATE SKIP LOCKED` and its due-ness re-checked under the lock, so overlapping runs never attempt
 * the same row twice and one bad row never stops the rest. The in-app row is never touched here.
 *
 * Before calling an adapter the preference is RE-RESOLVED: a channel the user has since switched off, or
 * a promotion whose consent was withdrawn, is `skipped` rather than sent. A channel the configured
 * provider has no adapter for is `skipped` / `no_adapter` — an honest record that nothing was sent.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isCriticalCategory, type NotificationCategory, type OutboundChannel } from '@/lib/types/notifications';
import {
  NotificationChannelProviderUnavailable,
  resolveNotificationChannelAdapters,
  type ChannelAdapterSet,
  type ChannelResult,
} from './channels';
import { DISPATCH_SWEEP_BATCH_LIMIT } from './config';
import { loadStoredPreferences, promotionsAllowed, resolveOutboundChannels } from './preferences';
import { decideAfterAttempt, fallbackCandidates } from './retry';
import { queryRows, type Executor } from './sql';

export interface DispatchSweepResult {
  claimed: number;
  delivered: number;
  retrying: number;
  failed: number;
  skipped: number;
  fallbacksQueued: number;
  exhausted: number;
  providerUnavailable: boolean;
}

export interface DispatchSweepOptions {
  /** Test seam: an explicit adapter set instead of `resolveNotificationChannelAdapters()`. */
  adapters?: ChannelAdapterSet;
  /** Test seam: restrict the sweep to these delivery ids so parallel suites cannot claim each other's rows. */
  deliveryIds?: string[];
  limit?: number;
}

interface ClaimedRow {
  id: string;
  notification_id: string;
  channel: OutboundChannel;
  status: string;
  attempts: number;
  category: NotificationCategory;
  title: string;
  body: string;
  recipient_user_id: string;
  lifecycle_status: string;
}

function idFilter(ids: string[] | undefined) {
  if (!ids) return sql``;
  if (ids.length === 0) return sql`AND false`;
  return sql`AND d.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
}

async function skip(tx: Executor, id: string, reason: string): Promise<void> {
  await tx.execute(sql`
    UPDATE notification_deliveries
       SET status = 'skipped', skip_reason = ${reason}, next_attempt_at = NULL,
           version = version + 1, updated_at = clock_timestamp()
     WHERE id = ${id}
  `);
}

/** AC-6 fallback: the first channel AFTER `from` (push → email → sms) that is still enabled and not yet in flight. */
async function queueFallback(tx: Executor, row: ClaimedRow): Promise<OutboundChannel | null> {
  const prefs = await loadStoredPreferences(tx, row.recipient_user_id);
  const enabled = new Set(resolveOutboundChannels(row.category, prefs?.categories ?? null));
  for (const candidate of fallbackCandidates(row.channel)) {
    if (!enabled.has(candidate)) continue;
    const [existing] = await queryRows<{ status: string }>(
      tx,
      sql`SELECT status FROM notification_deliveries WHERE notification_id = ${row.notification_id} AND channel = ${candidate}`,
    );
    if (!existing) {
      await tx.execute(sql`
        INSERT INTO notification_deliveries (notification_id, channel, status, next_attempt_at)
        VALUES (${row.notification_id}, ${candidate}, 'pending', clock_timestamp())
        ON CONFLICT (notification_id, channel) DO NOTHING
      `);
      return candidate;
    }
    // Already delivered or still in flight: that channel IS the fallback. Only a dead one is passed over.
    if (existing.status !== 'failed' && existing.status !== 'skipped') return null;
  }
  return null;
}

async function processOne(id: string, adapters: ChannelAdapterSet, result: DispatchSweepResult): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [row] = await queryRows<ClaimedRow>(
      tx,
      sql`SELECT d.id, d.notification_id, d.channel, d.status, d.attempts,
                 n.category, n.title, n.body, n.recipient_user_id, u.lifecycle_status
            FROM notification_deliveries d
            JOIN notifications n ON n.id = d.notification_id
            JOIN users u ON u.id = n.recipient_user_id
           WHERE d.id = ${id} AND d.status IN ('pending','retrying')
             AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= clock_timestamp()
             FOR UPDATE OF d SKIP LOCKED`,
    );
    if (!row) return; // Claimed by an overlapping run, or no longer due.
    result.claimed += 1;

    if (row.lifecycle_status === 'deleted') {
      await skip(tx, row.id, 'account_deleted');
      result.skipped += 1;
      return;
    }

    const prefs = await loadStoredPreferences(tx, row.recipient_user_id);
    if (row.category === 'promotions' && !promotionsAllowed(prefs).allowed) {
      await skip(tx, row.id, 'consent_withdrawn');
      result.skipped += 1;
      return;
    }
    if (!resolveOutboundChannels(row.category, prefs?.categories ?? null).includes(row.channel)) {
      await skip(tx, row.id, 'preference_disabled');
      result.skipped += 1;
      return;
    }

    const adapter = adapters[row.channel];
    if (!adapter) {
      await skip(tx, row.id, 'no_adapter');
      result.skipped += 1;
      if (isCriticalCategory(row.category) && (await queueFallback(tx, row))) result.fallbacksQueued += 1;
      return;
    }

    let outcome: ChannelResult;
    try {
      outcome = await adapter.deliver({
        notificationId: row.notification_id,
        channel: row.channel,
        recipientUserId: row.recipient_user_id,
        title: row.title,
        body: row.body,
      });
    } catch (err) {
      // A thrown adapter call (timeout, network) tells us nothing about whether it sent: `unknown`.
      outcome = { outcome: 'unknown', providerReference: null, failureCode: err instanceof Error ? err.name : 'error' };
    }

    const attempts = row.attempts + 1;
    const decision = decideAfterAttempt(row.category, outcome.outcome, attempts);
    const reference = outcome.providerReference ?? null;
    const failureCode = outcome.outcome === 'delivered' ? null : (outcome.failureCode ?? outcome.outcome);

    if (decision.status === 'delivered') {
      await tx.execute(sql`
        UPDATE notification_deliveries
           SET status = 'delivered', attempts = ${attempts}, delivered_at = clock_timestamp(), next_attempt_at = NULL,
               provider_reference = ${reference}, failure_code = NULL, version = version + 1, updated_at = clock_timestamp()
         WHERE id = ${row.id}
      `);
      result.delivered += 1;
    } else if (decision.status === 'retrying' && decision.retryInMinutes !== null) {
      await tx.execute(sql`
        UPDATE notification_deliveries
           SET status = 'retrying', attempts = ${attempts},
               next_attempt_at = clock_timestamp() + make_interval(mins => ${decision.retryInMinutes}),
               provider_reference = COALESCE(${reference}, provider_reference), failure_code = ${failureCode},
               version = version + 1, updated_at = clock_timestamp()
         WHERE id = ${row.id}
      `);
      result.retrying += 1;
    } else {
      // Exhausted. `failed` for a definitive failure; an `unknown` stays `retrying` (never a guessed
      // terminal) but is no longer auto-claimed — it needs an operator, which the log below demands.
      const terminal = decision.status === 'failed';
      await tx.execute(sql`
        UPDATE notification_deliveries
           SET status = ${terminal ? 'failed' : 'retrying'}, attempts = ${attempts}, next_attempt_at = NULL,
               provider_reference = COALESCE(${reference}, provider_reference), failure_code = ${failureCode},
               version = version + 1, updated_at = clock_timestamp()
         WHERE id = ${row.id}
      `);
      if (terminal) result.failed += 1;
      else result.retrying += 1;
      if ('escalate' in decision && decision.escalate) {
        result.exhausted += 1;
        console.error(
          JSON.stringify({
            event: 'notification.delivery_exhausted',
            notificationId: row.notification_id,
            category: row.category,
            channel: row.channel,
            attempts,
            outcome: outcome.outcome,
          }),
        );
      }
      if ('fallback' in decision && decision.fallback && (await queueFallback(tx, row))) result.fallbacksQueued += 1;
    }

    console.log(
      JSON.stringify({
        event: 'notification.delivery_attempted',
        notificationId: row.notification_id,
        category: row.category,
        channel: row.channel,
        attempt: attempts,
        outcome: outcome.outcome,
      }),
    );
  });
}

export async function runNotificationDispatchSweep(options: DispatchSweepOptions = {}): Promise<DispatchSweepResult> {
  const result: DispatchSweepResult = {
    claimed: 0,
    delivered: 0,
    retrying: 0,
    failed: 0,
    skipped: 0,
    fallbacksQueued: 0,
    exhausted: 0,
    providerUnavailable: false,
  };

  let adapters: ChannelAdapterSet;
  try {
    adapters = options.adapters ?? resolveNotificationChannelAdapters();
  } catch (err) {
    if (!(err instanceof NotificationChannelProviderUnavailable)) throw err;
    // AC-10: fail LOUDLY and touch nothing — queued rows stay queued, and nothing is marked delivered.
    result.providerUnavailable = true;
    console.error(JSON.stringify({ event: 'notification.channel_provider_unavailable', message: err.message }));
    return result;
  }

  const due = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT d.id FROM notification_deliveries d
         WHERE d.status IN ('pending','retrying') AND d.next_attempt_at IS NOT NULL
           AND d.next_attempt_at <= clock_timestamp() ${idFilter(options.deliveryIds)}
         ORDER BY d.next_attempt_at ASC, d.id ASC
         LIMIT ${options.limit ?? DISPATCH_SWEEP_BATCH_LIMIT}`,
  );

  for (const { id } of due) {
    try {
      await processOne(id, adapters, result);
    } catch (err) {
      console.error(
        JSON.stringify({ event: 'notification.dispatch_item_failed', deliveryId: id, error: err instanceof Error ? err.name : 'error' }),
      );
    }
  }
  return result;
}
