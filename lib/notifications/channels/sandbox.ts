/**
 * Spec 026 §3 — the sandbox channel adapters (AC-10).
 *
 * STATED PLAINLY: this sends nothing. It contacts no network and claims no vendor relationship. It
 * RECORDS each attempt in memory, and the `delivered` it returns means exactly "recorded in the sandbox
 * log" — every reference it issues is prefixed `sandbox_notification_`, so a stored reference is
 * self-describing. `resolveNotificationChannelAdapters()` refuses it under `NODE_ENV=production`, so a
 * production deployment without a real adapter fails loudly instead of claiming users were told.
 */
import { randomUUID } from 'node:crypto';
import type { OutboundChannel } from '@/lib/types/notifications';
import type { ChannelDeliveryInput, ChannelResult, NotificationChannelAdapter } from './types';

export const SANDBOX_NOTIFICATION_REFERENCE_PREFIX = 'sandbox_notification_';

export interface SandboxChannelRecord {
  channel: OutboundChannel;
  notificationId: string;
  recipientUserId: string;
  providerReference: string;
  recordedAt: string;
}

const records: SandboxChannelRecord[] = [];

/** A bounded in-memory log: a long-running dev server must not grow without limit. */
const MAX_RECORDS = 1000;

function sandboxAdapter(channel: OutboundChannel): NotificationChannelAdapter {
  return {
    channel,
    isSandbox: true,
    async deliver(input: ChannelDeliveryInput): Promise<ChannelResult> {
      const providerReference = `${SANDBOX_NOTIFICATION_REFERENCE_PREFIX}${randomUUID()}`;
      records.push({
        channel,
        notificationId: input.notificationId,
        recipientUserId: input.recipientUserId,
        providerReference,
        recordedAt: new Date().toISOString(),
      });
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
      // The title and body are deliberately NOT retained or logged (§9: never a title or body in logs).
      return { outcome: 'delivered', providerReference };
    },
  };
}

export function getSandboxChannelAdapters(): Record<OutboundChannel, NotificationChannelAdapter> {
  return { push: sandboxAdapter('push'), email: sandboxAdapter('email'), sms: sandboxAdapter('sms') };
}

/** What the sandbox recorded — the only evidence of a "delivery" it can honestly offer. */
export function getSandboxChannelRecords(): readonly SandboxChannelRecord[] {
  return records;
}

/** Test-only. */
export function resetSandboxChannelRecords(): void {
  records.length = 0;
}
